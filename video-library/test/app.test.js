// Runs the real built Mac app (~/Applications/Video Studio.app) against a fake server, never the real one.
// It opens a Video Studio window for about a minute, so it only runs when asked:
//   RUN_APP_TESTS=1 node --test video-library/test/app.test.js
// Build the app first: scripts/build-studio-app.sh
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const BIN = path.join(__dirname, '.build', 'Video Studio Test.app', 'Contents', 'MacOS', 'VideoStudio');   // scripts/build-studio-app.sh --test
const skip = !process.env.RUN_APP_TESTS ? 'set RUN_APP_TESTS=1 (opens a window)' : !fs.existsSync(BIN) ? 'test app not built (scripts/build-studio-app.sh --test)' : false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake Studio server that records every request.
function fakeServer(port, { gates = 3 } = {}) {
  const hits = [];
  const state = { gates, commands: [], report: null };
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/__test/command')) {
      state.report = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      res.writeHead(200); return res.end(state.commands.shift() || '');
    }
    if (req.url === '/tokcheck') { state.tokens = (state.tokens || []).concat(req.headers['x-studio-token']); res.writeHead(204); return res.end(); }
    hits.push(req.url);
    if (req.url.startsWith('/api/studio/state')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ gates: Array.from({ length: state.gates }, (_, i) => ({ id: 'g' + i })) }));
    }
    if (req.url === '/slow') return setTimeout(() => { res.writeHead(200); res.end('slow'); }, 3000);
    if (req.url.startsWith('/studio')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      // Cancels its own navigation (to /slow) by starting another one, and taps an outside link that the
      // app hands to the browser: both are normal and must not restart the server.
      return res.end(`<!doctype html><title>fake studio</title><p>fake</p><script>
        fetch('/tokcheck', { method: 'POST', headers: { 'X-Studio-Token': window.__studioToken || 'none' } });
        if (!location.search) setTimeout(() => { location.href = '/slow'; setTimeout(() => { location.href = '/studio?after-cancel'; }, 150); }, 300);
      </script>`);
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ srv, hits, state, close: () => new Promise((r) => srv.close(r)) })));
}
function freePort() {
  return new Promise((resolve) => { const s = require('net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function launchApp(port, dir, bin = BIN) {
  const log = path.join(dir, 'launchctl.log');
  const fake = path.join(dir, 'launchctl');
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${log}'\n`); fs.chmodSync(fake, 0o755);
  const tokenFile = path.join(dir, 'token'); fs.writeFileSync(tokenFile, 'ab'.repeat(16) + '\n');
  const proc = spawn(bin, [], { env: { ...process.env, VIDEO_STUDIO_URL: `http://127.0.0.1:${port}`, VIDEO_STUDIO_LAUNCHCTL: fake, VIDEO_STUDIO_TOKEN_FILE: tokenFile }, stdio: 'ignore' });
  return { proc, kicks: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}
const badge = (pid) => {
  const out = execFileSync('lsappinfo', ['info', '-only', 'StatusLabel', String(pid)]).toString();
  const m = out.match(/"label"="([^"]*)"/); return m ? m[1] : null;
};
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); }
  throw new Error('timed out: ' + what);
}

test('app loads the Studio, shows waiting approvals on the Dock and ignores cancelled loads', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsapp-'));
  const port = await freePort();
  const f = await fakeServer(port, { gates: 3 });
  const app = launchApp(port, dir);
  try {
    await until(() => f.hits.includes('/studio'), 10000, 'app requests /studio');
    await until(() => f.hits.some((h) => h.startsWith('/api/studio/state')), 10000, 'badge poll');
    await until(() => badge(app.proc.pid) === '3', 5000, 'Dock badge "3"');
    await until(() => f.state.tokens && f.state.tokens.length, 5000, 'page used the token');
    assert.equal(f.state.tokens[0], 'ab'.repeat(16), 'the app hands its token to its own page');
    await until(() => f.hits.includes('/studio?after-cancel'), 10000, 'page navigated after cancelling /slow');
    await sleep(1500);
    assert.deepEqual(app.kicks(), [], 'a cancelled navigation must not touch launchctl');
    f.state.gates = 0;
    await until(() => badge(app.proc.pid) === null, 15000, 'Dock badge cleared');
    assert.equal(app.proc.exitCode, null, 'app still running');
  } finally {
    app.proc.kill(); await f.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real app ignores test settings: launched with them, it never talks to the given server', { skip: !process.env.RUN_APP_TESTS ? 'set RUN_APP_TESTS=1' : false }, async () => {
  const REAL = path.join(os.homedir(), 'Applications', 'Video Studio.app', 'Contents', 'MacOS', 'VideoStudio');
  if (!fs.existsSync(REAL)) return;
  const port = await freePort();
  const f = await fakeServer(port);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsapp-'));
  const app = launchApp(port, dir, REAL);
  try {
    await sleep(6000);
    assert.deepEqual(f.hits, [], 'no request reached the other server');
    assert.equal(f.state.report, null, 'no test channel');
    assert.deepEqual(app.kicks(), []);
  } finally {
    app.proc.kill(); await f.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server down at launch: one kickstart without -k, then the app loads once the server answers', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsapp-'));
  const port = await freePort();
  const app = launchApp(port, dir);
  let f;
  try {
    await until(() => app.kicks().length === 1, 10000, 'kickstart called');
    assert.match(app.kicks()[0], new RegExp(`^kickstart gui/${process.getuid()}/[A-Za-z0-9.-]+\\.video-studio$`));
    await sleep(3000);                       // the "server" comes up a few seconds later, like a launchd restart
    f = await fakeServer(port);
    await until(() => f.hits.includes('/studio'), 15000, 'app loads /studio after the server comes up');
    assert.equal(app.kicks().length, 1, 'only one kickstart');
  } finally {
    app.proc.kill(); if (f) await f.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server never comes back: error page after the wait, no kickstart loop, "Try again" works once it is back', { skip, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsapp-'));
  const port = await freePort();
  const app = launchApp(port, dir);
  let f;
  try {
    await sleep(22000);                      // 15 s wait + the error page
    assert.equal(app.kicks().length, 1, 'kickstart once, not in a loop: ' + app.kicks().join(' | '));
    assert.equal(app.proc.exitCode, null, 'app still running');
    f = await fakeServer(port);
    await until(() => f.state.report, 5000, 'app reports in');
    assert.equal(f.state.report.title, 'Studio unreachable', 'the error page is showing');
    await sleep(1500);
    assert.ok(!f.hits.some((h) => h.startsWith('/studio')), 'nothing reloads by itself');
    f.state.commands.push('tryagain');
    await until(() => f.hits.some((h) => h.startsWith('/studio')), 5000, '"Try again" loads the Studio');
    await until(() => f.state.report && f.state.report.title === 'fake studio', 5000, 'Studio page showing');
    assert.equal(app.kicks().length, 1);
  } finally {
    app.proc.kill(); if (f) await f.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('closing the window keeps the app running, and reopening it (a Dock click) brings the window back', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsapp-'));
  const port = await freePort();
  const f = await fakeServer(port);
  const app = launchApp(port, dir);
  try {
    await until(() => f.state.report && f.state.report.visible === '1', 10000, 'window visible');
    for (let round = 0; round < 3; round++) {          // several times: a released window would crash here
      f.state.commands.push('close');
      await until(() => f.state.report.visible === '0', 5000, 'window closed');
      assert.equal(app.proc.exitCode, null, 'app keeps running with no window');
      f.state.commands.push('reopen');
      await until(() => f.state.report.visible === '1', 5000, 'window back after reopen');
    }
    assert.equal(app.proc.exitCode, null);
    assert.deepEqual(app.kicks(), []);
  } finally {
    app.proc.kill(); await f.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('links, frames and downloads: outside links and new windows go to the browser, frames load in place, downloads are named safely', { skip, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsapp-'));
  const dl = path.join(dir, 'downloads'); fs.mkdirSync(dl);
  const port = await freePort(), port2 = await freePort();
  // An "outside" site on the IPv6 loopback: not 127.0.0.1/localhost, so the app treats it as external.
  const outside = []; const ext = http.createServer((req, res) => { outside.push(req.url); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<p>embed</p><script>fetch("http://127.0.0.1:' + port + '/frametok?t=" + (window.__studioToken || "none"))</script>'); });
  await new Promise((r) => ext.listen(port2, '::1', r));
  const st = { commands: [], report: null, hits: [] };
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/__test/command')) { st.report = Object.fromEntries(new URL(req.url, 'http://x').searchParams); res.writeHead(200); return res.end(st.commands.shift() || ''); }
    st.hits.push(req.url);
    if (req.url.startsWith('/api/studio/state')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"gates":[]}'); }
    if (req.url === '/clip') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': "attachment; filename*=UTF-8''clip.mp4" }); return res.end(Buffer.alloc(1000)); }
    if (req.url === '/readme') { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="README"' }); return res.end('hi'); }
    if (req.url === '/broken') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="broken.mp4"', 'Content-Length': '100000' }); res.write(Buffer.alloc(10)); return setTimeout(() => res.destroy(), 200); }
    if (req.url.startsWith('/studio')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><title>links</title>
        <iframe src="http://[::1]:${port2}/embed" width=200 height=100></iframe>
        <a id="out" href="http://[::1]:${port2}/outside-link">outside</a>
        <a id="blank" href="/gate-image.png" target="_blank">image</a>
        <a id="clip" href="/clip">clip</a><a id="readme" href="/readme">readme</a><a id="broken" href="/broken">broken</a>`);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const app = spawn(BIN, [], { env: { ...process.env, VIDEO_STUDIO_URL: `http://127.0.0.1:${port}`, VIDEO_STUDIO_LAUNCHCTL: '/usr/bin/true', VIDEO_STUDIO_DOWNLOADS: dl }, stdio: 'ignore' });
  const click = (id) => st.commands.push(`js:document.getElementById('${id}').click()`);
  try {
    await until(() => st.report && st.report.title === 'links', 10000, 'page loaded');
    await until(() => outside.includes('/embed'), 5000, 'the frame loads in place');
    await until(() => st.hits.some((h) => h.startsWith('/frametok')), 5000, 'frame reported');
    assert.ok(st.hits.includes('/frametok?t=none'), 'an embedded page from elsewhere never gets the token');
    click('out'); click('blank');
    await until(() => st.report.opened.includes(`[::1]:${port2}/outside-link`) && st.report.opened.includes('/gate-image.png'), 5000, 'both handed to the browser');
    assert.ok(!outside.includes('/outside-link'), 'the outside link did not load inside the app');
    assert.ok(!st.hits.includes('/gate-image.png'), 'the new-window link did not replace the page');
    assert.equal(st.report.title, 'links', 'still on the same page');
    click('clip'); await until(() => st.report.downloads === '1', 5000, 'download 1');
    click('clip'); await until(() => st.report.downloads === '2', 5000, 'download 2');
    click('readme'); await until(() => st.report.downloads === '3', 5000, 'download 3');
    click('readme'); await until(() => st.report.downloads === '4', 5000, 'download 4');
    assert.deepEqual(fs.readdirSync(dl).sort(), ['README', 'README 2', 'clip 2.mp4', 'clip.mp4']);
    click('broken'); await until(() => st.report.alert === 'Download failed', 8000, 'failure alert');
    assert.equal(app.exitCode, null);
  } finally {
    app.kill(); srv.closeAllConnections(); await new Promise((r) => srv.close(r)); ext.closeAllConnections(); await new Promise((r) => ext.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
