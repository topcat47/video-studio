// The Buffer section (/buffer, buffer.js) against a fake Buffer GraphQL API: connecting a key (checked, kept 0600,
// never returned), who may connect or refresh, one request per refresh, the rate-limit guard, matching posts to
// library cards, the "Not scheduled" list, errors, disconnecting, and keeping the key away from background runs.
// Run: node --test video-library/test/buffer.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('./harness');

const GOOD = 'good-key-123';
const fake = { calls: [], mode: 'ok' };
const CH = [
  { id: 'c1', name: 'alpha.cat', displayName: 'alpha.cat', service: 'tiktok', avatar: 'https://cdn.example/a.png', isQueuePaused: false, isDisconnected: false, timezone: 'America/New_York' },
  { id: 'c2', name: 'alphacat', displayName: 'Alpha Cat', service: 'twitter', avatar: 'javascript:alert(1)', isQueuePaused: true, isDisconnected: false, timezone: 'America/New_York' },
];
const node = (o) => ({ status: 'scheduled', createdAt: '2026-10-25T10:00:00Z', isCustomScheduled: false, schedulingType: 'automatic', assets: [], externalLink: null, ...o });

let bufferApi, s;
test.before(async () => {
  bufferApi = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      const q = JSON.parse(body).query; fake.calls.push({ auth: req.headers.authorization, q });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('RateLimit', '"15m";r=97;t=812, "24h";r=240;t=3000');
      if (req.headers.authorization !== `Bearer ${GOOD}`) { res.statusCode = 401; return res.end('{"errors":[{"message":"bad key"}]}'); }
      if (fake.mode === 'gqlerror' && /channels/.test(q)) return res.end(JSON.stringify({ errors: [{ message: 'Cannot query field "foo"' }] }));
      if (/organizations/.test(q)) return res.end(JSON.stringify({ data: { account: { organizations: [{ id: 'org1', name: 'Top cat' }] } } }));
      return res.end(JSON.stringify({ data: {
        channels: CH,
        scheduled: { edges: [
          { node: node({ id: 'p1', text: 'cat <b>check</b>', dueAt: '2026-10-26T14:07:00Z', channelId: 'c1', channelService: 'tiktok', assets: [{ type: 'video', source: 'https://cdn.example/v.mp4', thumbnail: 'https://cdn.example/t.jpg', mimeType: 'video/mp4' }] }) },
          { node: node({ id: 'p2', text: 'unmatched post', dueAt: '2026-10-26T16:11:00Z', channelId: 'c2', channelService: 'twitter', isCustomScheduled: true }) },
        ] },
        sent: { edges: [{ node: node({ id: 'p3', status: 'sent', text: 'live one', sentAt: '2026-10-24T12:00:00Z', dueAt: '2026-10-24T12:00:00Z', channelId: 'c2', channelService: 'twitter', externalLink: 'https://x.com/alphacat/status/9', metrics: [{ type: 'impressions', name: 'Impressions', value: 1234, unit: 'count' }] }) }] },
        drafts: { edges: [] },
      } }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => bufferApi.once('listening', r));
  s = await startServer({
    env: { BUFFER_API_URL: `http://127.0.0.1:${bufferApi.address().port}` },
    fixtures: ({ lib, gen }) => {
      for (const f of ['a - alpha-cat-swap.mp4', 'b - alpha-cat-swap.mp4', 'c - alpha-cat-swap.mp4', 'd - alpha-cat-swap.mp4']) fs.writeFileSync(path.join(gen, 'Alpha', f), '');
      fs.writeFileSync(path.join(gen, 'Beta', 'e - beta-cat-swap.mp4'), '');
      fs.writeFileSync(path.join(lib, 'labels.json'), JSON.stringify({
        // "Missing": on X @alphacat by the sent post's link, not on TikTok.
        'alpha/d - alpha-cat-swap.mp4': { posts: [{ account: 'x:alphacat', status: 'posted', url: 'https://x.com/alphacat/status/9' }] },
        // A Betacat video on TikTok and queued on X, missing on Instagram.
        'beta/e - beta-cat-swap.mp4': { posts: [{ account: 'tiktok:beta_cat_fun', status: 'posted', url: 'https://www.tiktok.com/@beta_cat_fun/video/1' }, { account: 'x:betacatfun', status: 'queued', at: '2026-10-27T15:00:00Z' }] },
        // Matched by caption on the same account → not "Not scheduled".
        'alpha/a - alpha-cat-swap.mp4': { approved: true, approvedAt: '2026-10-25T09:00:00Z', posts: [{ account: 'tiktok:alpha.cat', status: 'queued', caption: 'Cat  <b>check</b>' }] },
        // Approved, never posted anywhere → listed.
        'alpha/b - alpha-cat-swap.mp4': { approved: true, approvedAt: '2026-10-25T08:00:00Z', description: 'Alpha Cat rates a burger' },
        // Not approved → not listed.
        'alpha/c - alpha-cat-swap.mp4': { description: 'draft' },
      }));
    },
  });
});
test.after(async () => { if (s) await s.stop(); bufferApi && bufferApi.close(); });

const state = async () => (await s.request('GET', '/api/buffer/state')).json;
const owner = (p, body) => s.request('POST', '/api/buffer/' + p, { body, headers: { 'X-Studio-Token': s.token, Origin: s.base } });

test('buffer: page is served; not connected until a key is added; refresh needs a key', async () => {
  const page = await s.request('GET', '/buffer', { raw: true });
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>Buffer · Video Studio<\/title>/);
  assert.doesNotMatch(page.text, /on(click|error|load)=/, 'no inline handlers');
  const st = await state();
  assert.equal(st.connected, false);
  assert.deepEqual(st.scheduled, []);
  assert.equal((await owner('refresh')).status, 400);
  assert.equal(fake.calls.length, 0, 'nothing sent to Buffer without a key');
});

test('buffer: only the Studio app can connect a key (token AND our own page); a bad key is refused and not saved', async () => {
  const keyFile = path.join(s.lib, '.buffer-key');
  assert.equal((await s.request('POST', '/api/buffer/key', { body: { key: GOOD } })).status, 403, 'no token');
  assert.equal((await s.request('POST', '/api/buffer/key', { body: { key: GOOD }, headers: { 'X-Studio-Token': s.token } })).status, 403, 'token but no page Origin (a script or a run)');
  assert.equal((await s.request('POST', '/api/buffer/key', { body: { key: GOOD }, headers: { 'X-Studio-Token': s.token, Origin: 'http://evil.example' } })).status, 403);
  const bad = await owner('key', { key: 'wrong-key' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /did not accept/);
  assert.equal(fs.existsSync(keyFile), false);
});

test('buffer: a good key is checked, saved 0600, used as a Bearer token and never returned; data is matched to the library', async () => {
  fake.calls.length = 0;
  const r = await owner('key', { key: GOOD });
  assert.equal(r.status, 200);
  assert.equal(r.text.includes(GOOD), false, 'the key never comes back');
  const keyFile = path.join(s.lib, '.buffer-key');
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), GOOD);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.ok(fake.calls.every((c) => c.auth === `Bearer ${GOOD}`));
  // Check + organization + ONE combined query for channels, scheduled, sent and drafts.
  assert.equal(fake.calls.length, 3);
  assert.match(fake.calls[2].q, /channels[\s\S]*scheduled: posts[\s\S]*sent: posts[\s\S]*drafts: posts/);
  const st = r.json;
  assert.equal(st.connected, true);
  assert.equal(st.organization.name, 'Top cat');
  assert.deepEqual(st.channels.map((c) => c.account), ['tiktok:alpha.cat', 'x:alphacat']);
  assert.equal(st.channels[1].paused, true);
  assert.deepEqual(st.scheduled.map((p) => [p.id, p.video]), [['p1', 'alpha/a - alpha-cat-swap.mp4'], ['p2', null]]);
  assert.equal(st.scheduled[0].thumb, 'https://cdn.example/t.jpg');
  assert.equal(st.scheduled[1].custom, true);
  assert.equal(st.sent[0].link, 'https://x.com/alphacat/status/9');
  assert.deepEqual(st.sent[0].metrics, [{ name: 'Impressions', value: 1234, unit: 'count' }]);
  assert.deepEqual(st.unscheduled.map((u) => u.id), ['alpha/b - alpha-cat-swap.mp4']);
  assert.deepEqual(st.rate.map((x) => x.remaining), [97, 240]);
  // The state is public to the page but the key file is not reachable through any route.
  assert.equal((await s.request('GET', '/api/studio/file?path=' + encodeURIComponent(keyFile))).status, 404);
});

test('buffer: reading the page does not hit Buffer while the copy is fresh; Refresh is limited to once a minute', async () => {
  fake.calls.length = 0;
  await state(); await state();
  assert.equal(fake.calls.length, 0, 'fresh copy: no Buffer requests');
  assert.equal((await owner('refresh')).status, 429, 'refreshed less than a minute ago (by connecting)');
  assert.equal(fake.calls.length, 0);
});

test('buffer: "Missing" compares each brand only on its own networks, from Buffer\'s posts and the cards', async () => {
  const st = await state();
  const [alpha, beta] = st.missing;
  assert.deepEqual([alpha.name, beta.name], ['Alphacat', 'Betacat']);
  // Alphacat has no Instagram in Buffer: shown as no account, never counted as missing.
  assert.deepEqual(alpha.networks.map((n) => [n.network, n.accounts, n.connected]), [['tiktok', ['tiktok:alpha.cat'], true], ['x', ['x:alphacat'], true], ['instagram', [], false]]);
  const w = (b, id) => b.videos.find((v) => v.id === id);
  const a = w(alpha, 'alpha/a - alpha-cat-swap.mp4'), d = w(alpha, 'alpha/d - alpha-cat-swap.mp4');
  assert.deepEqual([a.where.tiktok.status, a.where.x.status, a.where.instagram.status], ['queued', 'missing', 'none']);
  assert.deepEqual(a.missing, ['x']);
  // Matched through Buffer's sent post (its link is under the card's "Where it's posted").
  assert.deepEqual([d.where.x.status, d.where.x.link, d.where.tiktok.status], ['posted', 'https://x.com/alphacat/status/9', 'missing']);
  assert.deepEqual(d.missing, ['tiktok']);
  // Videos not on any of the brand's accounts are not in it (b is only approved; e is Betacat's).
  assert.deepEqual(alpha.videos.map((v) => v.id).sort(), ['alpha/a - alpha-cat-swap.mp4', 'alpha/d - alpha-cat-swap.mp4']);
  assert.equal(alpha.unmatched, 1, 'the scheduled X post that matches no card');
  assert.deepEqual(beta.videos.map((v) => [v.id, v.missing]), [['beta/e - beta-cat-swap.mp4', ['instagram']]]);
  assert.equal(beta.videos[0].where.x.status, 'queued');
  const page = (await s.request('GET', '/buffer', { raw: true })).text;
  assert.match(page, /href="#missing" data-view="missing"/);
});

test('buffer: a video moved to the Trash leaves "Not scheduled" (its labels stay for Put Back); the page asks before deleting', async () => {
  const file = path.join(s.gen, 'Alpha', 'b - alpha-cat-swap.mp4');
  assert.deepEqual((await state()).unscheduled.map((u) => u.id), ['alpha/b - alpha-cat-swap.mp4']);
  // The page's Delete calls the library's own /api/trash (here osascript is a logger, so the move is simulated).
  assert.equal((await s.request('POST', '/api/trash', { body: { id: 'alpha/b - alpha-cat-swap.mp4' } })).status, 200);
  assert.match(s.osascript(), /Finder" to delete \(POSIX file ".*b - alpha-cat-swap\.mp4" as alias\)/);
  const keep = fs.readFileSync(file);
  fs.unlinkSync(file);   // what Finder does
  assert.deepEqual((await state()).unscheduled, []);
  assert.ok(JSON.parse(fs.readFileSync(path.join(s.lib, 'labels.json'), 'utf8'))['alpha/b - alpha-cat-swap.mp4'].approved, 'labels kept');
  fs.writeFileSync(file, keep);   // "Put Back"
  assert.deepEqual((await state()).unscheduled.map((u) => u.id), ['alpha/b - alpha-cat-swap.mp4']);
  const page = (await s.request('GET', '/buffer', { raw: true })).text;
  for (const t of ['Delete this video?', 'Move to Trash', 'Put Back', 'Moving to Trash…', "fetch('/api/trash'"]) assert.ok(page.includes(t), t);
});

test('buffer: Unapprove (after "Are you sure?") takes a video off "Not scheduled"; approving it again brings it back', async () => {
  const id = 'alpha/b - alpha-cat-swap.mp4';
  assert.deepEqual((await state()).unscheduled.map((u) => u.id), [id]);
  // The page's Unapprove sends the library's own label change.
  assert.equal((await s.request('POST', '/api/label', { body: { id, approved: false } })).status, 200);
  assert.deepEqual((await state()).unscheduled, []);
  assert.ok(fs.existsSync(path.join(s.gen, 'Alpha', 'b - alpha-cat-swap.mp4')), 'the video stays');
  assert.equal((await s.request('POST', '/api/label', { body: { id, approved: true } })).status, 200);
  assert.deepEqual((await state()).unscheduled.map((u) => u.id), [id]);
  const page = (await s.request('GET', '/buffer', { raw: true })).text;
  for (const t of ['Are you sure you want to unapprove?', 'data-unapprove=', 'Unapproving…', 'approved: false']) assert.ok(page.includes(t), t);
});

test('buffer: a Buffer error is shown and the last good copy is kept; disconnect deletes the key and the copy', async () => {
  // Make the copy stale on disk and restart, so the next page read refreshes on its own.
  const cacheFile = path.join(s.lib, '.buffer-cache.json');
  const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); c.fetchedAt = '2000-01-01T00:00:00Z'; fs.writeFileSync(cacheFile, JSON.stringify(c));
  await s.restart();
  fake.mode = 'gqlerror'; fake.calls.length = 0;
  await state();
  await s.waitFor(async () => (await state()).error, 5000, 'error');
  const st = await state();
  assert.match(st.error, /Cannot query field "foo"/);
  assert.equal(st.scheduled.length, 2, 'last good copy kept');
  assert.equal(fake.calls.length, 1, 'one request per refresh');
  fake.mode = 'ok';
  const off = await owner('key', { key: '' });
  assert.equal(off.status, 200);
  assert.equal(off.json.connected, false);
  assert.equal(fs.existsSync(path.join(s.lib, '.buffer-key')), false);
  assert.equal(fs.existsSync(cacheFile), false);
});

test('buffer: background runs cannot read the Buffer key (sandbox denyRead + Read deny rule)', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(s.lib, 'studio-run-settings.json'), 'utf8'));
  const key = path.join(s.lib, '.buffer-key');
  assert.ok(settings.sandbox.filesystem.denyRead.includes(key));
  assert.ok(settings.permissions.deny.includes(`Read(/${key})`));
});
