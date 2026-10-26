// "Schedule on Buffer" for the Buffer section's Not scheduled videos.
//
// The official Buffer API only takes videos by public URL, so posting goes through Buffer's own composer in the
// owner's Chrome, like the owner does by hand. Two short `claude -p` jobs, never a Studio run:
//   caption   (the modal opens): NO tools; writes an X caption and a TikTok caption in the account's voice.
//   schedule  (only the owner's Schedule / Save as draft click in the app): Claude in Chrome opens Buffer's composer
//             for each chosen account, uploads the prepared video, types the owner's caption, turns on the
//             AI-generated label, and saves a draft or adds it to the queue. Never "share now".
// The Buffer page reports every step and the final check (the new post read back from Buffer) to
// /api/buffer/schedule/progress with a one-time token; nothing counts as scheduled without that report.
// scripts/buffer-chrome-guard.py (BUFFER_JOB=schedule) keeps the job inside Buffer and away from any other post.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const CLAUDE_BIN = process.env.STUDIO_CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');
const PORT = Number(process.env.STUDIO_PORT || 4420);
const BUFFER_ORIGIN = 'https://publish.buffer.com';
const UPLOAD_DIR = path.join(os.tmpdir(), 'vstudio-buffer-upload');   // Chrome can't upload from ~/Desktop
const MAX_UPLOAD = 9.5 * 1024 * 1024;                                    // Buffer's composer takes up to 10 MB
const TIMEOUT_MS = { caption: 4 * 60e3, schedule: 15 * 60e3 };
// Which accounts a video can go to, by its library folder (its brand in studio.config.json), and the voice each
// network's caption is written in (Instagram only while Buffer has it connected).
const { BRANDS } = require('./config');
const BRAND = Object.fromEntries(BRANDS.map((b) => [b.key, b.accounts]));
const VOICE_DEFAULT = { x: 'In the character\'s voice from its characters/<name>/character.md. Under 280 characters, short lines, at most one emoji, no hashtags; cut profanity.',
  tiktok: 'A short TikTok caption in the character\'s voice: one or two short lines, no hashtags, at most one emoji.' };
const VOICE = Object.fromEntries(BRANDS.map((b) => [b.key, { x: b.voice.x || VOICE_DEFAULT.x, tiktok: b.voice.tiktok || VOICE_DEFAULT.tiktok }]));

module.exports = function bufferSchedule({ dir, sendJson, readBody, readLabels, resolveId, studioAuthorized, fromStudioPage, atomicWrite, getData, jobSettings, getBrowser }) {
  const hub = path.dirname(dir);
  const FILE = path.join(dir, 'buffer-schedule.json');
  let db = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } })();
  db.videos = db.videos || {}; db.firstDone = !!db.firstDone;
  for (const v of Object.values(db.videos)) {
    if (v.state === 'captioning') Object.assign(v, { state: 'caption-failed', error: 'The app restarted while writing captions. Try again.' });
    if (['preparing', 'working'].includes(v.state)) Object.assign(v, { state: 'unclear', error: 'The app restarted while this was being scheduled. Check Buffer before trying again.' });
  }
  const save = () => { try { atomicWrite(FILE, JSON.stringify(db)); } catch {} };
  save();
  const jobs = new Map();
  const rec = (id) => (Object.hasOwn(db.videos, id) ? db.videos[id] : (db.videos[id] = { state: 'idle' }));
  const brandOf = (id) => String(id).split('/')[0];

  // The channels this video can go to, from Buffer's own list (connected ones only).
  function targetsFor(id) {
    const want = BRAND[brandOf(id)] || [];
    return (getData().channels || []).filter((c) => want.includes(c.account) && !c.disconnected)
      .map((c) => ({ account: c.account, channelId: c.id, name: c.name, service: c.service, network: c.account.split(':')[0] }));
  }

  function run(kind, prompt, env, onDone) {
    const token = crypto.randomBytes(16).toString('hex');
    const args = ['-p', '--output-format', 'json', '--no-session-persistence'];
    if (kind === 'schedule') args.push('--chrome', '--settings', jobSettings, '--allowedTools=mcp__claude-in-chrome__*');
    else args.push('--strict-mcp-config', '--tools=');
    const job = { kind, token, videoId: env.BUFFER_VIDEO_ID, reported: null, steps: [] };
    let out = '', proc;
    try { proc = spawn(CLAUDE_BIN, args, { cwd: hub, env: { ...process.env, BUFFER_JOB: kind, ...env }, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (err) { onDone({ ok: false, text: 'Could not start Claude: ' + err.message }, job); return job; }
    jobs.set(token, job);
    proc.stdout.on('data', (d) => { out += d; if (out.length > 2e6) out = out.slice(-1e6); });
    proc.stderr.on('data', (d) => { out += d; });
    proc.stdin.on('error', () => {});
    proc.stdin.end(prompt(token));
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, TIMEOUT_MS[kind]);
    proc.on('close', (code) => {
      clearTimeout(timer); jobs.delete(token);
      let r = null; try { r = JSON.parse(out.trim().split('\n').pop()); } catch {}
      onDone({ ok: code === 0 && !(r && r.is_error), text: String((r && typeof r.result === 'string' ? r.result : out.trim().slice(-800)) || '') }, job);
    });
    proc.on('error', (err) => { clearTimeout(timer); jobs.delete(token); onDone({ ok: false, text: 'Could not start Claude: ' + err.message }, job); });
    return job;
  }
  const jobFor = (token) => {
    const t = String(token || '');
    for (const j of jobs.values()) if (j.kind === 'schedule' && j.token.length === t.length && crypto.timingSafeEqual(Buffer.from(j.token), Buffer.from(t))) return j;
    return null;
  };

  // ── Captions ──
  function startCaptions(id, note) {
    const l = readLabels()[id] || {}, v = rec(id), brand = brandOf(id);
    const voice = VOICE[brand] || VOICE_DEFAULT;
    Object.assign(v, { state: 'captioning', error: null, note: note || '' });
    save();
    run('caption', () => `Write two captions for posting this video on our parody cat accounts.

The video: ${JSON.stringify(id.split('/').slice(1).join('/'))}
What happens in it: ${JSON.stringify(l.description || '(no description)')}
${l.xQuote ? `Its saved X quote (a good starting point): ${JSON.stringify(l.xQuote)}\n` : ''}${note ? `The owner's direction: ${JSON.stringify(note)}\n` : ''}
X caption: ${voice.x}
TikTok caption: ${voice.tiktok}
Rules: it's a parody cat account, never claim to be a real person; follow the off-limits topics in CLAUDE.md.

Answer with only the two captions: <x>…</x> and <tiktok>…</tiktok>.`, { BUFFER_VIDEO_ID: id }, (res) => {
      const cur = rec(id); if (cur.state !== 'captioning') return;
      const x = (res.text.match(/<x>([\s\S]*?)<\/x>/i) || [])[1], t = (res.text.match(/<tiktok>([\s\S]*?)<\/tiktok>/i) || [])[1];
      if (res.ok && x && t) Object.assign(cur, { state: 'captioned', captions: { x: x.trim(), tiktok: t.trim(), instagram: t.trim() }, error: null });
      else Object.assign(cur, { state: 'caption-failed', error: 'Claude did not write the captions: ' + res.text.replace(/\s+/g, ' ').slice(0, 200) });
      save();
    });
  }

  // ── Preparing the file (free, local) ──
  function prepare(id) {
    return new Promise((resolve, reject) => {
      const src = resolveId(id); if (!src) return reject(new Error('The video file is not there any more'));
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const out = path.join(UPLOAD_DIR, crypto.createHash('sha1').update(id).digest('hex').slice(0, 12) + '.mp4');
      if (fs.statSync(src).size <= MAX_UPLOAD) { fs.copyFileSync(src, out); return resolve(out); }
      execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], (err, so) => {
        const secs = parseFloat(so) || 0; if (err || !secs) return reject(new Error('Could not read the video length'));
        // Fit under 9.5 MB: video bitrate = budget minus 128k audio, never below 600k.
        const kbps = Math.max(600, Math.floor((MAX_UPLOAD * 8 / 1000) / secs * 0.95) - 128);
        execFile('ffmpeg', ['-v', 'error', '-y', '-i', src, '-c:v', 'libx264', '-preset', 'medium', '-b:v', kbps + 'k', '-maxrate', kbps + 'k', '-bufsize', (2 * kbps) + 'k',
          '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], { timeout: 10 * 60e3 }, (e2) => {
          if (e2) return reject(new Error('Could not shrink the video for Buffer'));
          resolve(out);
        });
      });
    });
  }

  // ── Schedule (only from the owner's click) ──
  async function startSchedule(id, picks, mode) {
    const v = rec(id), posts = picks.map((p) => ({ ...p, step: 'waiting' }));
    Object.assign(v, { state: 'preparing', mode, posts, error: null, startedAt: new Date().toISOString() });
    save();
    let file;
    try { file = await prepare(id); }
    catch (err) { Object.assign(v, { state: 'failed', error: err.message }); save(); return; }
    v.state = 'working'; save();
    // One ready-made script per account: it gives the Buffer page __vsReport(step) and __vsCheck() for that channel,
    // so the job never edits a script itself.
    const org = JSON.stringify(getData().organization.id);
    const setup = (token, p) => `window.__vsReport = (step) => fetch("http://localhost:${PORT}/api/buffer/schedule/progress", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ token: "${token}", channelId: ${JSON.stringify(p.channelId)}, step }) }).then((r) => r.status);
window.__vsCheck = () => { window.__vs = "pending"; (async () => {
  const q = \`{ posts(first: 5, input: { organizationId: ${org}, filter: { channelIds: [${JSON.stringify(p.channelId)}], status: [${mode === 'draft' ? 'draft' : 'scheduled'}] }, sort: [{ field: createdAt, direction: desc }] }) { edges { node { id text dueAt status } } } }\`;
  const r = await fetch("https://graph.buffer.com/?_o=GetPosts", { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-buffer-client-id": "webapp-publishing" }, body: JSON.stringify({ query: q }) });
  const j = await r.json(); const found = ((j.data && j.data.posts && j.data.posts.edges) || []).map((e) => e.node);
  const res = await fetch("http://localhost:${PORT}/api/buffer/schedule/progress", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ token: "${token}", channelId: ${JSON.stringify(p.channelId)}, step: "check", found }) });
  window.__vs = "done " + res.status;
})().catch((e) => { window.__vs = "error " + e.message; }); return "started"; }; "ready"`;
    const browser = getBrowser && getBrowser();
    const label = (p) => `${p.network === 'x' ? 'X' : p.network === 'tiktok' ? 'TikTok' : 'Instagram'} @${p.name}`;
    run('schedule', (token) => `You ${mode === 'draft' ? 'save a DRAFT' : 'schedule a post'} in Buffer for the owner, who approved exactly this in the video app. Use only the Claude in Chrome tools.
${browser ? `Select the Chrome browser with deviceId ${browser} (select_browser).` : 'If more than one Chrome browser is connected, use the one where Buffer is signed in.'}
The video file to upload: ${file}

${posts.map((p, i) => `ACCOUNT ${i + 1}: ${label(p)}
1. Open https://publish.buffer.com/channels/${p.channelId}/schedule (use ONE tab for all accounts). If it shows a login page, stop and answer "NOT SIGNED IN".
2. Run this JavaScript in that tab (it only prepares two helpers and returns "ready"):
${setup(token, p)}
3. Run  __vsReport("composer")  then click "New Post" (the composer opens with only ${label(p)} selected). If a "Resume Unfinished Post?" dialog appears, start a new post WITHOUT discarding anything; if you can't, stop and answer "RESUME DIALOG".
4. Upload the video file with file_upload to the composer's hidden input named file-upload-input (find it). Wait until the upload has finished. Run  __vsReport("uploaded")
5. Click into the composer's text box (find it by reference) and type exactly this caption, nothing added or changed:
${JSON.stringify(p.caption)}
Turn on the "AI-Generated" switch if the composer shows one. Run  __vsReport("captioned")
6. ${mode === 'draft' ? 'Click "Save Draft" (left of the scheduling button). NEVER schedule or publish.' : 'Add it to the queue with Buffer\'s default scheduling button ("Add to Queue" / "Schedule Post" with Next Available, the next free slot). NEVER choose "Share Now", "Publish Now" or "Now".'} Run  __vsReport("saved")
7. Run  __vsCheck()  and then read  window.__vs  until it is no longer "pending".`).join('\n\n')}

Never click anything outside the composer, never touch other posts, drafts or settings, and never run any other script. If something goes wrong, stop and say what. Final answer: one line per account, "@name: done" or "@name: <what went wrong>".`,
    { BUFFER_VIDEO_ID: id, BUFFER_UPLOAD_FILE: file, BUFFER_SCHEDULE_CHANNELS: posts.map((p) => p.channelId).join(',') }, (res, job) => {
      const cur = rec(id); if (cur.state !== 'working') return;
      const done = cur.posts.filter((p) => p.step === 'done').length;
      if (done === cur.posts.length) {
        cur.state = mode === 'draft' ? 'drafted' : 'scheduled'; cur.finishedAt = new Date().toISOString();
        if (mode === 'draft') db.firstDone = true;
      } else {
        const sure = cur.posts.every((p) => p.step === 'waiting' || p.step === 'composer');   // nothing was saved in Buffer yet
        Object.assign(cur, { state: sure ? 'failed' : 'unclear',
          error: (/NOT SIGNED IN/.test(res.text) ? 'Chrome is not signed in to Buffer.' : /RESUME DIALOG/.test(res.text) ? 'Buffer showed "Resume Unfinished Post?"; clear it in Buffer, then try again.' : res.text.replace(/\s+/g, ' ').slice(0, 300)) +
            (sure ? '' : ' Some posts may already be in Buffer: check its Drafts / Queue before trying again.') });
      }
      save();
    });
  }

  // From the Buffer page: one step of one account, or the final check (the new post read back from Buffer).
  function progress(body) {
    const job = jobFor(body.token);
    if (!job) return { code: 403, body: { error: 'not a running schedule' } };
    const v = rec(job.videoId), p = (v.posts || []).find((x) => x.channelId === String(body.channelId));
    if (!p) return { code: 404, body: { error: 'not one of the chosen accounts' } };
    const step = String(body.step || '');
    if (step === 'check') {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const hit = (Array.isArray(body.found) ? body.found : []).find((n) => n && norm(n.text) === norm(p.caption));
      if (hit) {
        Object.assign(p, { step: 'done', postId: String(hit.id || ''), dueAt: hit.dueAt || null });
        // A real schedule goes on the card's "Where it's posted" (the owner's rule); a draft does not.
        if (v.mode !== 'draft') recordPost(job.videoId, p);
      } else Object.assign(p, { step: 'not-found' });
    } else if (['composer', 'uploaded', 'captioned', 'saved'].includes(step)) p.step = step;
    else return { code: 400, body: { error: 'unknown step' } };
    save();
    return { code: 200, body: { ok: true } };
  }
  function recordPost(id, p) {
    const body = JSON.stringify({ id, account: p.account, status: 'queued', ...(p.dueAt && { at: p.dueAt }), caption: p.caption });
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/post', method: 'POST', headers: { 'content-type': 'application/json', host: `localhost:${PORT}` } }, (res) => res.resume());
    req.on('error', () => {}); req.end(body);
  }

  // ── HTTP ──
  function view(id) {
    const v = Object.hasOwn(db.videos, id) ? db.videos[id] : { state: 'idle' };
    return { id, ...v, targets: targetsFor(id), firstDone: db.firstDone };
  }
  const cors = (res) => { res.setHeader('Access-Control-Allow-Origin', BUFFER_ORIGIN); res.setHeader('Vary', 'Origin'); };
  async function fromBufferPage(req, res) {
    if (req.method === 'OPTIONS') {
      cors(res); res.setHeader('Access-Control-Allow-Methods', 'POST'); res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Private-Network', 'true'); res.writeHead(204); return res.end();
    }
    if (req.method !== 'POST' || (req.headers.origin && req.headers.origin !== BUFFER_ORIGIN)) return sendJson(res, 403, { error: 'refused' });
    let body; try { body = await readBody(req); } catch { return sendJson(res, 413, { error: 'too large' }); }
    const r = progress(body);
    cors(res); return sendJson(res, r.code, r.body);
  }
  async function handle(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/buffer/schedule') {
      const ids = String(url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 200);
      return sendJson(res, 200, { firstDone: db.firstDone, videos: ids.map(view) });
    }
    if (req.method !== 'POST') return sendJson(res, 404, { error: 'not found' });
    if (!studioAuthorized(req) || !fromStudioPage(req)) return sendJson(res, 403, { error: 'Only the Video Studio app can do that' });
    const body = await readBody(req);
    const id = String(body.id || '');
    if (!resolveId(id) || !readLabels()[id] || !readLabels()[id].approved) return sendJson(res, 404, { error: 'That video is not an approved video any more' });
    if (!getData().organization) return sendJson(res, 409, { error: 'Connect Buffer (API key) first' });
    const v = rec(id);
    const busy = ['captioning', 'preparing', 'working'].includes(v.state);
    if (url.pathname === '/api/buffer/schedule/captions') {
      if (busy) return sendJson(res, 409, { error: 'Busy with this video' });
      startCaptions(id, String(body.note || '').slice(0, 500).trim());
      return sendJson(res, 200, view(id));
    }
    if (url.pathname === '/api/buffer/schedule/start') {
      // The ONLY way a post is made: the owner's click in the app, with the accounts and captions they chose.
      if (busy) return sendJson(res, 409, { error: 'Already working on this video' });
      if (v.state === 'unclear' && body.confirmUnclear !== true) return sendJson(res, 409, { error: 'Check Buffer first: some posts may already be there' });
      const mode = body.mode === 'schedule' ? 'schedule' : 'draft';
      const targets = targetsFor(id), want = Array.isArray(body.accounts) ? body.accounts.map(String) : [];
      const caps = body.captions && typeof body.captions === 'object' ? body.captions : {};
      const picks = targets.filter((t) => want.includes(t.account)).map((t) => ({ ...t, caption: String(caps[t.network] || '').trim().slice(0, 2200) }));
      if (!picks.length) return sendJson(res, 400, { error: 'Pick at least one account' });
      if (picks.some((p) => !p.caption)) return sendJson(res, 400, { error: 'Every chosen account needs a caption' });
      if (picks.some((p) => p.network === 'x' && p.caption.length > 280)) return sendJson(res, 400, { error: 'The X caption is over 280 characters' });
      startSchedule(id, picks, mode);
      return sendJson(res, 200, view(id));
    }
    if (url.pathname === '/api/buffer/schedule/reset') {
      if (busy) return sendJson(res, 409, { error: 'Busy with this video' });
      delete db.videos[id]; save();
      return sendJson(res, 200, view(id));
    }
    return sendJson(res, 404, { error: 'not found' });
  }
  return { handle, fromBufferPage };
};
