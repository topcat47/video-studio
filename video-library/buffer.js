// The Buffer section (/buffer): what is queued, sent and drafted on the owner's Buffer channels, matched to the
// library's cards, plus the approved videos not scheduled anywhere yet. Read-only towards Buffer: it never creates,
// edits or deletes a post.
//
// Buffer's API (https://api.buffer.com, GraphQL, personal key as a Bearer token) allows only 100 requests per 15 min
// and 250 a day, so one refresh is ONE request (channels + scheduled + sent + drafts, aliased), cached on disk and
// repeated at most every 30 minutes on its own, or on the owner's Refresh (not more than once a minute).
// The key lives in .buffer-key (mode 0600, gitignored); no response ever contains it.
const fs = require('fs');
const path = require('path');

const API = process.env.BUFFER_API_URL || 'https://api.buffer.com';
const STALE_MS = 30 * 60 * 1000;
const MIN_GAP_MS = 60 * 1000;
// labels.json "Where it's posted" accounts are <network>:<handle>; Buffer calls X "twitter".
const NETWORK = { twitter: 'x', x: 'x', tiktok: 'tiktok', instagram: 'instagram', threads: 'threads', youtube: 'youtube',
  facebook: 'facebook', linkedin: 'linkedin', bluesky: 'bluesky', mastodon: 'mastodon', pinterest: 'pinterest' };
// "Missing": each brand's videos compared across its own networks only. An account belongs to a brand by its handle,
// so a channel the brand connects later is picked up from Buffer's list on its own. Brands: studio.config.json.
const { BRANDS } = require('./config');
const BRAND_NETS = ['tiktok', 'x', 'instagram'];
const RANK = { draft: 1, queued: 2, posted: 3 };

module.exports = function bufferSection({ dir, sendJson, readBody, readLabels, resolveId, studioAuthorized, fromStudioPage, atomicWrite }) {
  const KEY_FILE = path.join(dir, '.buffer-key');
  const CACHE_FILE = path.join(dir, '.buffer-cache.json');
  let cache = (() => { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; } })();
  let inFlight = null, lastTry = 0;

  const readKey = () => { try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; } };
  function saveCache() { try { atomicWrite(CACHE_FILE, JSON.stringify(cache)); } catch {} }

  // "15m";r=97;t=812, "24h";r=240;t=3000  →  [{ name, remaining, resetIn }]
  function parseRate(h) {
    if (!h) return null;
    return String(h).split(',').map((part) => {
      const name = (part.match(/"([^"]+)"/) || [])[1] || part.split(';')[0].trim();
      const r = part.match(/\br=(\d+)/), t = part.match(/\bt=(\d+)/);
      return { name, remaining: r ? +r[1] : null, resetIn: t ? +t[1] : null };
    }).filter((x) => x.remaining !== null);
  }

  async function gql(key, query) {
    const res = await fetch(API, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query }),
    });
    const rate = parseRate(res.headers.get('ratelimit'));
    let body = null; try { body = await res.json(); } catch {}
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('Buffer refused the API key (it may have expired or been replaced): add a new one.'), { rate, auth: true });
    if (res.status === 429) throw Object.assign(new Error(`Buffer's rate limit is used up; it resets in ${res.headers.get('retry-after') || 'a few'} seconds.`), { rate });
    if (!res.ok) throw Object.assign(new Error(`Buffer answered HTTP ${res.status}`), { rate });
    if (body && body.errors && body.errors.length) throw Object.assign(new Error('Buffer: ' + body.errors.map((e) => e.message).join('; ')), { rate });
    return { data: (body && body.data) || {}, rate };
  }

  const POST = 'id text status dueAt sentAt createdAt channelId channelService externalLink isCustomScheduled schedulingType assets { type source thumbnail mimeType }';
  async function fetchAll(key) {
    let org = cache.organization;
    if (!org) {
      const { data } = await gql(key, 'query { account { organizations { id name } } }');
      const orgs = (data.account && data.account.organizations) || [];
      if (!orgs.length) throw new Error('This Buffer account has no organization.');
      org = { id: String(orgs[0].id), name: String(orgs[0].name || '') };
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(org.id)) throw new Error('Unexpected organization id from Buffer.');
    const o = JSON.stringify(org.id);
    const { data, rate } = await gql(key, `query {
      channels(input: { organizationId: ${o} }) { id name displayName service avatar isQueuePaused isDisconnected timezone }
      scheduled: posts(first: 100, input: { organizationId: ${o}, filter: { status: [scheduled] }, sort: [{ field: dueAt, direction: asc }] }) { edges { node { ${POST} } } }
      sent: posts(first: 60, input: { organizationId: ${o}, filter: { status: [sent] }, sort: [{ field: dueAt, direction: desc }] }) { edges { node { ${POST} metrics { type name value unit } } } }
      drafts: posts(first: 50, input: { organizationId: ${o}, filter: { status: [draft] }, sort: [{ field: createdAt, direction: desc }] }) { edges { node { ${POST} } } }
    }`);
    const nodes = (k) => ((data[k] && data[k].edges) || []).map((e) => e.node).filter(Boolean);
    return { organization: org, channels: data.channels || [], scheduled: nodes('scheduled'), sent: nodes('sent'), drafts: nodes('drafts'), rate };
  }

  function refresh() {
    const key = readKey();
    if (!key || inFlight) return inFlight;
    lastTry = Date.now();
    inFlight = fetchAll(key).then((d) => {
      cache = { ...d, fetchedAt: new Date().toISOString(), error: null };
      saveCache();
    }).catch((err) => {
      cache = { ...cache, error: err.message, errorAt: new Date().toISOString(), ...(err.rate ? { rate: err.rate } : {}) };
      if (err.auth) cache.organization = null;
      saveCache();
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  // ── Matching Buffer posts to the library's cards ──
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  function accountOf(ch) { return ch ? `${NETWORK[String(ch.service).toLowerCase()] || String(ch.service).toLowerCase()}:${String(ch.name || '').replace(/^@/, '').toLowerCase()}` : ''; }
  function view() {
    const labels = readLabels();
    const channels = (cache.channels || []).map((c) => ({ id: c.id, name: c.name, displayName: c.displayName || c.name, service: c.service,
      avatar: c.avatar, paused: !!c.isQueuePaused, disconnected: !!c.isDisconnected, timezone: c.timezone, account: accountOf(c) }));
    const byId = Object.fromEntries(channels.map((c) => [c.id, c]));
    // Every "Where it's posted" entry on a card, keyed by account + post link and account + caption.
    const byLink = new Map(), byCaption = new Map();
    for (const [id, l] of Object.entries(labels)) {
      if (id.startsWith('songs/') || !l || !Array.isArray(l.posts)) continue;
      for (const p of l.posts) {
        const acct = String(p.account || '').toLowerCase();
        if (p.url) byLink.set(acct + ' ' + String(p.url).replace(/\/+$/, ''), id);
        if (p.caption) byCaption.set(acct + ' ' + norm(p.caption), id);
      }
    }
    const matched = new Set();
    const shape = (p) => {
      const ch = byId[p.channelId], acct = ch ? ch.account : '';
      const video = (p.externalLink && byLink.get(acct + ' ' + String(p.externalLink).replace(/\/+$/, ''))) || (p.text && byCaption.get(acct + ' ' + norm(p.text))) || null;
      if (video) matched.add(video);
      const a = (p.assets || [])[0];
      return { id: p.id, status: p.status, text: p.text || '', dueAt: p.dueAt || null, sentAt: p.sentAt || null, createdAt: p.createdAt || null,
        channelId: p.channelId, custom: !!p.isCustomScheduled, reminder: p.schedulingType === 'notification', link: p.externalLink || null,
        thumb: a ? a.thumbnail || null : null, kind: a ? String(a.type || '').toLowerCase() : 'text',
        metrics: (p.metrics || []).map((m) => ({ name: m.name || m.type, value: m.value, unit: m.unit || '' })), video };
    };
    const scheduled = (cache.scheduled || []).map(shape), sent = (cache.sent || []).map(shape), drafts = (cache.drafts || []).map(shape);
    // Approved videos with no post anywhere: not in Buffer (as far as we can match) and no "Where it's posted" entry.
    // Only videos still on disk: a video moved to the Trash keeps its labels (so Put Back restores them) but leaves this list.
    const unscheduled = Object.entries(labels)
      .filter(([id, l]) => !id.startsWith('songs/') && l && l.approved && !matched.has(id) && !(Array.isArray(l.posts) && l.posts.length) && (!resolveId || resolveId(id)))
      .map(([id, l]) => ({ id, name: id.split('/').slice(1).join('/'), description: l.description || '', approvedAt: l.approvedAt || null }))
      .sort((a, b) => String(b.approvedAt || '').localeCompare(String(a.approvedAt || '')));
    return { connected: !!readKey(), fetchedAt: cache.fetchedAt || null, refreshing: !!inFlight, error: cache.error || null,
      organization: cache.organization || null, rate: cache.rate || null, channels, scheduled, sent, drafts, unscheduled,
      missing: missingByBrand(labels, channels, byId, { scheduled, sent, drafts }) };
  }

  // For every video already queued or posted on one of a brand's accounts: where it is on each of the brand's networks
  // (posted, queued, draft only, missing, or no account there), from the card's "Where it's posted" and Buffer's posts.
  function missingByBrand(labels, channels, byId, posts) {
    const on = {};   // video id → account → { status, link, at }
    const mark = (id, account, status, link, at) => {
      const acct = String(account || '').toLowerCase();
      if (!id || !acct || !RANK[status]) return;
      const v = Object.hasOwn(on, id) ? on[id] : (on[id] = {});
      const cur = Object.hasOwn(v, acct) ? v[acct] : null;
      if (!cur || RANK[status] > RANK[cur.status]) v[acct] = { status, link: link || null, at: at || null };
      else if (RANK[status] === RANK[cur.status]) { cur.link = cur.link || link || null; if (at && !(cur.at > at)) cur.at = at; }
    };
    for (const [id, l] of Object.entries(labels)) {
      if (id.startsWith('songs/') || !l || !Array.isArray(l.posts)) continue;
      for (const p of l.posts) mark(id, p.account, p.status === 'posted' ? 'posted' : 'queued', /^https?:\/\//i.test(p.url || '') ? p.url : null, p.at);
    }
    const kind = { scheduled: 'queued', sent: 'posted', drafts: 'draft' };
    for (const [k, list] of Object.entries(posts)) {
      for (const p of list) { const ch = byId[p.channelId]; if (p.video && ch) mark(p.video, ch.account, kind[k], p.link, p.sentAt || p.dueAt || p.createdAt); }
    }
    const allAccounts = new Set([...channels.map((c) => c.account), ...Object.values(on).flatMap((v) => Object.keys(v))]);
    return BRANDS.map((b) => {
      const mine = new Set(b.accounts);
      for (const a of allAccounts) if (b.handle.test(a.split(':').slice(1).join(':'))) mine.add(a);
      const networks = BRAND_NETS.map((network) => {
        const accounts = [...mine].filter((a) => a.split(':')[0] === network).sort();
        const chs = channels.filter((c) => accounts.includes(c.account));
        return { network, accounts, inBuffer: chs.length > 0, connected: chs.some((c) => !c.disconnected) };
      });
      const videos = Object.entries(on)
        .filter(([id, v]) => (!resolveId || resolveId(id)) && Object.hasOwn(labels, id) && Object.entries(v).some(([a, x]) => mine.has(a) && x.status !== 'draft'))
        .map(([id, v]) => {
          const where = {}; let last = '';
          for (const n of networks) {
            const hits = n.accounts.filter((a) => Object.hasOwn(v, a)).map((a) => ({ account: a, ...v[a] }));
            const best = hits.sort((x, y) => RANK[y.status] - RANK[x.status])[0];
            where[n.network] = best || { status: n.accounts.length ? 'missing' : 'none', account: n.accounts[0] || null };
            if (best && best.at && best.at > last) last = best.at;
          }
          return { id, name: id.split('/').slice(1).join('/'), description: labels[id].description || '', where, last: last || null,
            missing: networks.filter((n) => ['missing', 'draft'].includes(where[n.network].status)).map((n) => n.network) };
        })
        .sort((x, y) => (y.missing.length > 0) - (x.missing.length > 0) || String(y.last || '').localeCompare(String(x.last || '')));
      // Buffer posts on this brand's channels that match no card can't be compared (shown as a count on the page).
      const unmatched = [...posts.scheduled, ...posts.sent].filter((p) => !p.video && byId[p.channelId] && mine.has(byId[p.channelId].account)).length;
      return { key: b.key, name: b.name, networks, videos, unmatched };
    });
  }

  // Comments (collected through Chrome, answered with Claude, sent only on the owner's approval): buffer-comments.js.
  const comments = require('./buffer-comments')({ dir, sendJson, readBody, studioAuthorized, fromStudioPage, atomicWrite, getData: view });
  // "Schedule on Buffer" for Not scheduled videos (through Buffer's composer in Chrome): buffer-schedule.js.
  const schedule = require('./buffer-schedule')({ dir, sendJson, readBody, readLabels, resolveId, studioAuthorized, fromStudioPage, atomicWrite,
    getData: view, jobSettings: path.join(dir, '.buffer-job-settings.json'), getBrowser: comments.browser });

  async function handle(req, res, url) {
    if (url.pathname === '/api/buffer/comments' || url.pathname.startsWith('/api/buffer/comments/')) return comments.handle(req, res, url);
    if (url.pathname === '/api/buffer/schedule' || url.pathname.startsWith('/api/buffer/schedule/')) return schedule.handle(req, res, url);
    if (req.method === 'GET' && url.pathname === '/api/buffer/state') {
      // Refreshes on its own only when the copy is old (at most every 30 min), and never more than once a minute.
      const age = Date.now() - Date.parse(cache.fetchedAt || 0);
      if (readKey() && !inFlight && !(age < STALE_MS) && Date.now() - lastTry > MIN_GAP_MS) refresh();
      return sendJson(res, 200, view());
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/buffer/')) {
      // Same layers as the Studio's owner actions: the token, and the request must come from our own page.
      if (!studioAuthorized(req) || !fromStudioPage(req)) return sendJson(res, 403, { error: 'Only the Video Studio app can do that' });
      const body = await readBody(req);
      if (url.pathname === '/api/buffer/refresh') {
        if (!readKey()) return sendJson(res, 400, { error: 'Add your Buffer API key first' });
        if (Date.now() - lastTry < MIN_GAP_MS && !inFlight) return sendJson(res, 429, { error: 'Refreshed less than a minute ago; Buffer only allows a few requests.' });
        await refresh();
        return sendJson(res, 200, view());
      }
      if (url.pathname === '/api/buffer/key') {
        const key = String(body.key || '').trim();
        if (!key) {   // disconnect
          try { fs.unlinkSync(KEY_FILE); } catch {}
          cache = {}; try { fs.unlinkSync(CACHE_FILE); } catch {}
          return sendJson(res, 200, view());
        }
        if (key.length > 4096 || /\s/.test(key)) return sendJson(res, 400, { error: 'That does not look like a Buffer API key' });
        // Check it with Buffer before keeping it.
        try { await gql(key, 'query { account { organizations { id name } } }'); }
        catch (err) { return sendJson(res, 400, { error: err.auth ? 'Buffer did not accept that key.' : err.message }); }
        fs.writeFileSync(KEY_FILE, key + '\n', { mode: 0o600 }); fs.chmodSync(KEY_FILE, 0o600);
        cache = {}; lastTry = 0;
        await refresh();
        return sendJson(res, 200, view());
      }
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  // Reports from the Buffer page in Chrome (cross-origin, one-time job tokens).
  const fromBufferPage = (req, res, url) => (url.pathname.startsWith('/api/buffer/schedule/') ? schedule.fromBufferPage(req, res) : comments.fromBufferPage(req, res, url));
  return { handle, fromBufferPage };
};
