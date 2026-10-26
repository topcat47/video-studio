// Runs the real built Mac app against the REAL library server (read-only), through a small proxy that
// forwards GETs to 127.0.0.1:4420, refuses every write, and can play "server down" on cue. Nothing is
// changed on the real server: no POST ever reaches it, and launchctl is a stand-in that only logs.
//   RUN_APP_TESTS=1 node --test video-library/test/app-real.test.js     (opens a window for ~40 s)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const REAL = 4420;
const BIN = path.join(__dirname, '.build', 'Video Studio Test.app', 'Contents', 'MacOS', 'VideoStudio');   // scripts/build-studio-app.sh --test
const realUp = () => new Promise((r) => http.get(`http://127.0.0.1:${REAL}/api/studio/state`, (res) => { res.resume(); r(res.statusCode === 200); }).on('error', () => r(false)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); }
  throw new Error('timed out: ' + what);
}

function proxy(port) {
  const st = { down: false, commands: [], report: null, hits: [], writesRefused: 0 };
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/__test/command')) {
      st.report = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      const cmd = st.commands.shift() || '';
      if (cmd === 'reload') st.downAfterReply = true;
      res.writeHead(200); res.end(cmd);
      if (st.downAfterReply) { st.down = true; st.downAfterReply = false; }
      return;
    }
    if (st.down) return req.socket.destroy();                 // like a server that isn't there
    st.hits.push(req.method + ' ' + req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { st.writesRefused++; st.writeTokens = (st.writeTokens || []).concat(req.headers['x-studio-token'] || ''); res.writeHead(403); return res.end('{"error":"read-only test"}'); }
    const headers = { ...req.headers, host: `127.0.0.1:${REAL}` }; delete headers.origin;
    const up = http.request({ host: '127.0.0.1', port: REAL, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ st, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) })));
}
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test('real Studio through the app: loads, badge matches, close/reopen, server down → error page → Try again', { skip: !process.env.RUN_APP_TESTS ? 'set RUN_APP_TESTS=1' : !fs.existsSync(BIN) ? 'test app not built (scripts/build-studio-app.sh --test)' : false, timeout: 90000 }, async (t) => {
  if (!(await realUp())) return t.skip('the real server is not running');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsapp-'));
  const port = await freePort();
  const px = await proxy(port);
  const log = path.join(dir, 'launchctl.log'), fake = path.join(dir, 'launchctl');
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${log}'\n`); fs.chmodSync(fake, 0o755);
  const kicks = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  const app = spawn(BIN, [], { env: { ...process.env, VIDEO_STUDIO_URL: `http://127.0.0.1:${port}`, VIDEO_STUDIO_LAUNCHCTL: fake }, stdio: 'ignore' });
  try {
    // 1. The real Studio page loads, and the Dock badge equals the real number of waiting approvals.
    await until(() => px.st.report && /Video Studio/.test(px.st.report.title), 15000, 'real Studio page loaded');
    const real = await new Promise((r) => http.get(`http://127.0.0.1:${REAL}/api/studio/state`, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => r(JSON.parse(b))); }));
    const want = real.gates.length ? String(real.gates.length) : '';
    await until(() => px.st.report.badge === want, 15000, `badge "${want}"`);

    // 1b. Layout: the page fills exactly the area below the toolbar (nothing under it), and a picture of the
    //     window is saved for a look (needs Screen Recording permission; skipped quietly without it).
    const [pTop, pBottom, cTop, cBottom] = px.st.report.layout.split(',').map(Number);
    assert.deepEqual([pTop, pBottom], [cTop, cBottom], `page ${pTop}-${pBottom} vs content area ${cTop}-${cBottom}`);
    if (process.env.APP_SHOT) {
      px.st.commands.push('snapshot:' + process.env.APP_SHOT);
      await until(() => fs.existsSync(process.env.APP_SHOT), 8000, 'window picture saved');
    }

    // 1c. The real page carries no token; the app supplies the real one to it (the write is refused by the proxy).
    const html = await new Promise((r) => http.get(`http://127.0.0.1:${REAL}/studio`, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => r(b)); }));
    const realToken = fs.readFileSync(path.join(__dirname, '..', '.studio-token'), 'utf8').trim();
    assert.ok(!html.includes(realToken), 'the real /studio page has no token in it');
    px.st.commands.push("js:fetch('/api/studio/gate/clear', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': window.__studioToken }, body: '{}' })");
    await until(() => px.st.writeTokens && px.st.writeTokens.length, 5000, 'probe write');
    assert.equal(px.st.writeTokens[0], realToken, 'the app gave the page the real token');
    px.st.writesRefused = 0; px.st.hits = px.st.hits.filter((h) => !h.startsWith('POST'));   // that probe was ours

    // 2. Close and reopen (the Dock click) with the real page loaded.
    for (let i = 0; i < 2; i++) {
      px.st.commands.push('close'); await until(() => px.st.report.visible === '0', 5000, 'closed');
      px.st.commands.push('reopen'); await until(() => px.st.report.visible === '1', 5000, 'reopened');
    }
    assert.equal(app.exitCode, null);

    // 3. The server "goes down" while you reload: one kickstart (no -k), error page after the wait.
    px.st.commands.push('reload');
    await until(() => kicks().length === 1, 10000, 'kickstart');
    assert.match(kicks()[0], new RegExp(`^kickstart gui/${process.getuid()}/[A-Za-z0-9.-]+\\.video-studio$`));
    await sleep(17000);
    px.st.down = false;                        // back up, but nothing reloads by itself
    await until(() => px.st.report && px.st.report.title === 'Studio unreachable', 5000, 'error page showing');
    // 4. Try again loads the real Studio.
    px.st.commands.push('tryagain');
    await until(() => /Video Studio/.test(px.st.report.title), 10000, 'Try again → real Studio');
    assert.equal(kicks().length, 1, 'no kickstart loop');
    assert.equal(px.st.writesRefused, 0, 'the app made no writes on its own');
    assert.ok(!px.st.hits.some((h) => !h.startsWith('GET') && !h.startsWith('HEAD')), 'read-only');
  } finally {
    app.kill(); await px.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
