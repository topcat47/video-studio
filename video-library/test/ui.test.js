// Automated UI tests for both pages, run inside the real Mac app's WebKit (no manual browser checks).
// A throwaway server with sample data sits behind a small proxy that adds the app's test channel
// (/__test/command, /__test/result) and passes everything else through with this server's Host/Origin.
//   RUN_APP_TESTS=1 node --test video-library/test/ui.test.js     (opens a test window for ~1-2 min)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { startServer, makeVideo } = require('./harness');

const BIN = path.join(__dirname, '.build', 'Video Studio Test.app', 'Contents', 'MacOS', 'VideoStudio');   // scripts/build-studio-app.sh --test
const skip = !process.env.RUN_APP_TESTS ? 'set RUN_APP_TESTS=1 (opens a window)' : !fs.existsSync(BIN) ? 'test app not built (scripts/build-studio-app.sh --test)' : false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ID = 'alpha/alphaclips - alpha-cat-swap.mp4';
let s, px, app, tmp, appOut = '';

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); }
  throw new Error('timed out: ' + what);
}
const freePort = () => new Promise((resolve) => { const t = net.createServer().listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => resolve(p)); }); });

function proxy(port, target) {
  const st = { commands: [], report: null, results: {}, log: [] };
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/__test/command')) {
      st.report = Object.fromEntries(new URL(req.url, 'http://x').searchParams); st.lastPoll = Date.now(); st.polls = (st.polls || 0) + 1;
      const cmd = st.commands.shift() || '';
      if (cmd) st.log.push(new Date().toISOString().slice(11, 23) + ' sent ' + cmd.slice(0, 50));
      res.writeHead(200); return res.end(cmd);
    }
    if (req.url.startsWith('/__test/result')) {
      let b = ''; req.on('data', (c) => (b += c));
      return req.on('end', () => { st.results[new URL(req.url, 'http://x').searchParams.get('id')] = JSON.parse(b || '{}'); res.writeHead(204); res.end(); });
    }
    const headers = { ...req.headers, host: `127.0.0.1:${target}` };
    if (headers.origin) headers.origin = `http://127.0.0.1:${target}`;
    const up = http.request({ host: '127.0.0.1', port: target, path: req.url, method: req.method, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ st, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) })));
}

// Run async JS in the page (inside the app) and return its value.
let seq = 0;
async function page(js, ms = 45000) {
  const id = String(++seq);
  px.st.commands.push(`eval:${id}:${js}`);
  const r = await until(() => px.st.results[id], ms, 'page eval ' + js.slice(0, 60) + ` (page: ${px.st.report && px.st.report.url} "${px.st.report && px.st.report.title}", queued: ${px.st.commands.length}, last poll ${Date.now() - px.st.lastPoll} ms ago, open dialog: "${px.st.report && px.st.report.sheet}", polls ${px.st.polls})\n` + px.st.log.slice(-6).join('\n') + '\napp: ' + appOut.slice(-800));
  if (r.error) throw new Error('page error: ' + r.error + '\n' + js);
  return r.value;
}
async function go(p, title) {
  px.st.commands.push(`js:location.href=${JSON.stringify(p)}`);
  // Compare path + hash as given (the library adds #/videos/all to a bare "/").
  const at = () => { const u = new URL(px.st.report.url); return p.includes('#') ? u.pathname + u.hash === p : u.pathname === p; };
  await until(() => px.st.report && px.st.report.url && at() && (!title || title.test(px.st.report.title)), 15000, 'load ' + p);
  await sleep(800);
}
// Each test opens its own page, so any one can run alone.
async function on(p, title) {
  if (px.st.report && px.st.report.url && new URL(px.st.report.url).pathname === p) {
    // Start every library test on All videos (the address remembers the last tab across a reload).
    if (p === '/') { px.st.commands.push("js:history.replaceState(null, '', '/#/videos/all')"); await sleep(400); }
    px.st.commands.push('reload'); await sleep(300);
    await until(() => px.st.report && title.test(px.st.report.title), 15000, 'reload ' + p); await sleep(1200); return;
  }
  await go(p, title);
}
async function resize(w, h) { px.st.commands.push(`resize:${w},${h}`); await sleep(800); }

test.before(async () => {
  if (skip) return;
  s = await startServer({
    fixtures: ({ home, gen, lib }) => {
      makeVideo(path.join(gen, 'Alpha', 'alphaclips - alpha-cat-swap.mp4'));
      require('child_process').execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', path.join(home, 'video-studio', 'songs', 'theme.mp3')]);
      makeVideo(path.join(gen, 'Alpha', 'originals', 'alphaclips - 123.mp4'));
      makeVideo(path.join(gen, 'Beta', 'evil <img src=x onerror=window.__xss=1> name.mp4'));
      fs.writeFileSync(path.join(lib, 'labels.json'), JSON.stringify({
        'alpha/tweet - alpha-cat-swap.mp4': { original: path.join(gen, 'Alpha', 'originals', 'tweet - 999.png') },
        'songs/theme.mp3': { usedIn: [ID] },
        [ID]: { description: 'Alpha Cat <script>window.__xss=2</script> on a couch.', xQuote: 'Frame stays sharp',
          original: path.join(gen, 'Alpha', 'originals', 'alphaclips - 123.mp4') },
      }, null, 2));
      makeVideo(path.join(gen, 'Alpha', 'tweet - alpha-cat-swap.mp4'));
      require('child_process').execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:duration=0.1', '-frames:v', '1', path.join(gen, 'Alpha', 'originals', 'tweet - 999.png')]);
      fs.writeFileSync(path.join(lib, 'alpha-finds.json'), '[]');
      fs.writeFileSync(path.join(lib, 'beta-finds.json'), '[]');
      const p = path.join(gen, 'projects', 'cat-dj');
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 'shots.json'), JSON.stringify({ shots: [{ id: 's1', status: 'planned' }] }));
      fs.writeFileSync(path.join(p, 'brief.md'), '- Concept: Cat DJ <b>on a roof</b>\n');
    },
  });
  for (const a of ['x:alphacat', 'tiktok:beta_cat_fun', 'instagram:beta_cat_fun']) {
    await s.request('POST', '/api/post', { body: { id: ID, account: a, status: 'posted', at: '2026-10-22T19:41:00Z',
      caption: 'A long caption that goes on and on about the frame and the light', url: 'https://www.tiktok.com/@beta_cat_fun/video/7698013034085747990' } });
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vsapp-'));
  const port = await freePort();
  px = await proxy(port, s.port);
  app = spawn(BIN, [], { env: { ...process.env, VIDEO_STUDIO_URL: `http://127.0.0.1:${port}`, VIDEO_STUDIO_LAUNCHCTL: '/usr/bin/true',
    VIDEO_STUDIO_TOKEN_FILE: path.join(s.lib, '.studio-token'), VIDEO_STUDIO_DOWNLOADS: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', (d) => (appOut += d)); app.stderr.on('data', (d) => (appOut += d));
  await until(() => px.st.report && /Video Studio/.test(px.st.report.title), 15000, 'app started');
  await resize(1320, 860);
});
test.after(async () => {
  if (app) app.kill();
  if (px) await px.close();
  if (s) await s.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// ───────────── Library ─────────────
test('library: file names and descriptions from the server never run as code', { skip }, async () => {
  await on('/', /Videos/);
  const r = await page(`await new Promise(r => setTimeout(r, 800));
    return { xss: window.__xss || 0, tiles: document.querySelectorAll('.tile').length,
      nameShown: [...document.querySelectorAll('.tname')].some(t => t.textContent.includes('<img src=x')) };`);
  assert.deepEqual(r, { xss: 0, tiles: 3, nameShown: true });
});

test('library: review panel is a dialog; focus moves in, stays on the pressed button, and returns to the tile on Esc', { skip }, async () => {
  await on('/', /Videos/);
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms));
    const tile = [...document.querySelectorAll('.tile')].find(t => t.dataset.open === ${JSON.stringify(ID)});
    tile.focus(); tile.click(); await w(500);
    const rv = document.getElementById('review');
    const out = { open: !rv.hidden, role: rv.getAttribute('role'), modal: rv.getAttribute('aria-modal'), focusIn: rv.contains(document.activeElement) };
    out.scriptDescInert = rv.querySelector('.desc').textContent.includes('<script>') && !window.__xss;
    const b = rv.querySelector('[data-act=archive]'); b.focus(); b.click(); await w(600);
    out.focusAfterArchive = document.activeElement && document.activeElement.dataset.act;
    rv.querySelector('[data-act=archive]').click(); await w(500);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(400);
    out.closed = rv.hidden; out.focusBack = document.activeElement && document.activeElement.dataset.open;
    return out;`);
  assert.deepEqual(r, { open: true, role: 'dialog', modal: 'true', focusIn: true, scriptDescInert: true, focusAfterArchive: 'archive', closed: true, focusBack: ID });
});

test('library: Approve and Posted save; one click works right after leaving an unchanged editor; Enter opens the editor', { skip }, async () => {
  await on('/', /Videos/);
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms));
    const get = async () => (await fetch('/api/videos').then(r => r.json())).find(v => v.id === ${JSON.stringify(ID)});
    [...document.querySelectorAll('.tile')].find(t => t.dataset.open === ${JSON.stringify(ID)}).click(); await w(500);
    const rv = document.getElementById('review');
    rv.querySelector('[data-act=approved]').click(); await w(500);
    const approved = (await get()).approved;
    rv.querySelector('[data-act=approved]').click(); await w(500);
    const d = rv.querySelector('[data-act=editdesc]'); d.focus();
    d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await w(300);
    const editorOpen = !!rv.querySelector('textarea[data-role=desc]');
    const ta = rv.querySelector('textarea[data-role=desc]'), posted = rv.querySelector('[data-act=posted]');
    posted.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); await w(50);
    posted.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); posted.click(); await w(600);
    const postedNow = (await get()).posted;
    rv.querySelector('[data-act=posted]').click(); await w(500);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(300);
    return { approved, editorOpen, postedNow };`);
  assert.deepEqual(r, { approved: true, editorOpen: true, postedNow: true });
});

test('library: refused saves show why and undo the change (description, approve with its time)', { skip }, async () => {
  await on('/', /Videos/);
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms)); const alerts = []; window.alert = m => alerts.push(m);
    [...document.querySelectorAll('.tile')].find(t => t.dataset.open === ${JSON.stringify(ID)}).click(); await w(500);
    const rv = document.getElementById('review');
    const before = rv.querySelector('.desc').textContent;
    rv.querySelector('[data-act=editdesc]').click(); await w(200);
    const ta = rv.querySelector('textarea[data-role=desc]'); ta.value = 'x'.repeat(2500);
    ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); await w(800);
    const descBack = rv.querySelector('.desc').textContent === before;
    const real = window.fetch;
    window.fetch = (u, o) => (o && o.method === 'POST' && String(o.body).includes('"approved"')) ? Promise.resolve(new Response('{"error":"nope"}', { status: 500 })) : real(u, o);
    const v = videos.find(x => x.id === ${JSON.stringify(ID)}); const a0 = v.approved, t0 = v.approvedAt;
    rv.querySelector('[data-act=approved]').click(); await w(500);
    window.fetch = real;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(300);
    return { descBack, approveBack: v.approved === a0 && v.approvedAt === t0, alerts };`);
  assert.equal(r.descBack, true);
  assert.equal(r.approveBack, true);
  assert.deepEqual(r.alerts, ['Description not saved: bad description', 'Not saved: nope']);
});

test('library: focus stays on the same row\'s × and that row is the one removed', { skip }, async () => {
  await on('/', /Videos/);
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll('.tile')].find(t => t.dataset.open === ${JSON.stringify(ID)}).click(); await w(500);
    let xs = [...document.querySelectorAll('.rv-info [data-act=rmpost]')];
    const rows = xs.length; xs[1].focus(); xs[1].click(); await w(300);
    xs = [...document.querySelectorAll('.rv-info [data-act=rmpost]')];
    const focusIndex = xs.indexOf(document.activeElement), armed = xs[1].textContent;
    xs[1].click(); await w(600);
    const v = (await fetch('/api/videos').then(r => r.json())).find(x => x.id === ${JSON.stringify(ID)});
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(300);
    return { rows, focusIndex, armed, left: v.posts.map(p => p.account) };`);
  assert.deepEqual(r, { rows: 3, focusIndex: 1, armed: 'Remove?', left: ['x:alphacat', 'instagram:beta_cat_fun'] });
});

test('library: narrow windows: posted rows and the armed Delete never spill out; no sideways page scroll', { skip }, async () => {
  await on('/', /Videos/);
  for (const [w, h] of [[1000, 800], [375, 812]]) {
    await resize(w, h);
    const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.tile')].find(t => t.dataset.open === ${JSON.stringify(ID)}).click(); await w(500);
      const info = document.querySelector('.rv-info'); const right = Math.min(info.getBoundingClientRect().right, innerWidth) + 1;
      const over = () => [...info.querySelectorAll('*')].filter(e => e.offsetParent && e.getBoundingClientRect().right > right).length;
      const rowsOver = over();
      info.querySelector('[data-status=delete], [data-act=trash]').click(); await w(200);
      const armedOver = over();
      await w(3200);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(300);
      return { rowsOver, armedOver, pageScroll: document.documentElement.scrollWidth > innerWidth };`);
    assert.deepEqual(r, { rowsOver: 0, armedOver: 0, pageScroll: false }, `at ${w}px`);
  }
  await resize(1320, 860);
});

test('library: dark native controls, load failure message, delete by id after a reload swap', { skip }, async () => {
  await on('/', /Videos/);
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms));
    const scheme = getComputedStyle(document.documentElement).colorScheme;
    const real = window.fetch, keep = videos;
    window.fetch = () => Promise.reject(new Error('down')); videos = []; lastLoad = ''; await load(); window.fetch = real;
    const loadMsg = document.getElementById('grid').textContent.includes("isn't answering");
    videos = keep; lastLoad = ''; await load(); await w(300);
    const id = [...document.querySelectorAll('.tile')].map(t => t.dataset.open).find(x => x.startsWith('beta/'));
    [...document.querySelectorAll('.tile')].find(t => t.dataset.open === id).click(); await w(500);
    document.querySelector('.rv-info [data-status=delete], .rv-info [data-act=trash]').click(); await w(200);
    videos = videos.map(x => ({ ...x }));
    document.querySelector('.rv-info [data-status=delete], .rv-info [data-act=trash]').click(); await w(800);
    return { scheme, loadMsg, gone: !videos.some(x => x.id === id) && ![...document.querySelectorAll('.tile')].some(t => t.dataset.open === id) };`);
  assert.deepEqual(r, { scheme: 'dark', loadMsg: true, gone: true });
});

test('library: coming back to the window does not restart a playing video (no redraw when nothing changed)', { skip }, async () => {
  await on('/', /Videos/);
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll('.tile')].find(t => t.dataset.open === ${JSON.stringify(ID)}).click(); await w(600);
    const v = document.querySelector('#review video[data-role=conv]'); v.muted = true; v.loop = true;
    await v.play().catch(() => {}); await w(300);
    const tile = document.querySelector('.tile');
    window.dispatchEvent(new Event('focus')); await w(1200);
    const out = { sameVideo: v.isConnected, stillPlaying: !v.paused, sameTiles: tile.isConnected };
    v.pause(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(300);
    return out;`);
  assert.deepEqual(r, { sameVideo: true, stillPlaying: true, sameTiles: true });
});

test('library: a picture original shows as a picture (no "Original missing", no Play both)', { skip }, async () => {
  await on('/', /Videos/);
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll('.tile')].find(t => t.dataset.open === 'alpha/tweet - alpha-cat-swap.mp4').click(); await w(800);
    const img = document.querySelector('#review img[data-role=orig-img]');
    const out = { img: !!img, loaded: !!img && img.complete && img.naturalWidth > 0, missing: document.getElementById('review').textContent.includes('missing'),
      playBoth: !!document.querySelector('#review [data-act=both]'),
      tilePill: [...document.querySelectorAll('.tile')].find(t => t.dataset.open === 'alpha/tweet - alpha-cat-swap.mp4').textContent.includes('Original missing') };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(300);
    return out;`);
  assert.deepEqual(r, { img: true, loaded: true, missing: false, playBoth: false, tilePill: false });
});

test('library: ← / → keep working after a tick takes the video out of the tab; / stays in the panel; Delete moves to the next video', { skip }, async () => {
  await on('/', /Videos/);
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms)); const out = {};
    document.querySelector('[data-tab=unposted]').click(); await w(400);
    const first = document.querySelector('.tile'); first.click(); await w(600);
    const rv = document.getElementById('review');
    const id0 = rv.querySelector('.rv').dataset.id;
    rv.querySelector('[data-act=posted]').click(); await w(700);
    out.posStillShown = !!rv.querySelector('.rv-pos');
    out.nextEnabled = !rv.querySelector('[data-nav="1"]').disabled;
    rv.querySelector('[data-nav="1"]').click(); await w(500);
    out.moved = rv.querySelector('.rv').dataset.id !== id0;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true })); await w(200);
    out.slashStayed = document.activeElement !== document.getElementById('q');
    rv.querySelector('[data-nav="-1"]').click(); await w(500);
    rv.querySelector('[data-act=posted]').click(); await w(500);   // undo the tick
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(300);
    document.querySelector('[data-tab=all]').click(); await w(400);
    // Delete opens the next video instead of dropping you back to the grid
    const ids = [...document.querySelectorAll('.tile')].map(t => t.dataset.open);
    const victim = ids.find(x => x.startsWith('beta/'));
    [...document.querySelectorAll('.tile')].find(t => t.dataset.open === victim).click(); await w(500);
    rv.querySelector('[data-status=delete], [data-act=trash]').click(); await w(200);
    rv.querySelector('[data-status=delete], [data-act=trash]').click(); await w(900);
    out.afterDeleteOpen = !rv.hidden && rv.querySelector('.rv').dataset.id !== victim;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(300);
    // sidebar keeps focus on the pressed tab
    const tabBtn = document.querySelector('[data-tab=posted]'); tabBtn.focus(); tabBtn.click(); await w(400);
    out.tabFocus = document.activeElement && document.activeElement.dataset.tab;
    document.querySelector('[data-tab=all]').click(); await w(300);
    out.searchLabel = document.getElementById('q').getAttribute('aria-label');
    return out;`);
  assert.deepEqual(r, { posStillShown: true, nextEnabled: true, moved: true, slashStayed: true, afterDeleteOpen: true, tabFocus: 'posted', searchLabel: 'Search videos' });
});

test('library: Copy tells the truth; picker refreshes, shows errors and its cap; honest empty states; transcribing note from the transcriber; "No preview" posters', { skip }, async () => {
  await on('/', /Videos/);
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms)); const out = {};
    [...document.querySelectorAll('.tile')].find(t => t.dataset.open === ${JSON.stringify(ID)}).click(); await w(600);
    const rv = document.getElementById('review');
    // Copy: success and failure both reported as they happened
    const realCopy = copyText;
    copyText = async () => true; rv.querySelector('[data-act=copyquote]').click(); await w(200);
    out.copyOk = rv.querySelector('[data-act=copyquote]').textContent;
    await w(1600);
    copyText = async () => false; rv.querySelector('[data-act=copyquote]').click(); await w(200);
    out.copyFail = rv.querySelector('[data-act=copyquote]').textContent;
    copyText = realCopy; await w(1600);
    // Picker: fetched fresh each time it opens; an error is shown; the 80 cap is announced
    const realFetch = window.fetch; let calls = 0;
    window.fetch = (u, o) => { if (String(u).includes('/api/candidates')) { calls++; return calls === 1 ? Promise.resolve(new Response('[]')) : calls === 2 ? Promise.resolve(new Response('{"error":"x"}', { status: 500 }))
      : Promise.resolve(new Response(JSON.stringify(Array.from({ length: 95 }, (_, i) => ({ path: '/x/' + i + '.mp4', name: 'clip' + i + '.mp4', dir: '~', size: 1, modified: 0 }))))); } return realFetch(u, o); };
    const pick = () => rv.querySelector('[data-act=pick]') || rv.querySelector('.missing [data-act=pick]');
    const openPicker = async () => { const b = rv.querySelector('[data-act=pick]'); if (b) { b.click(); await w(500); } };
    // The original is linked, so the picker opens from the "change" control; use the act directly
    picking = null; videos.find(v => v.id === ${JSON.stringify(ID)}).originalExists = false; render(); await w(200);
    await openPicker(); out.firstFetch = calls;
    await openPicker(); await openPicker(); out.errorShown = rv.textContent.includes("Couldn't list files");
    await openPicker(); await openPicker(); out.capShown = rv.textContent.includes('Showing 80 of 95'); out.fetchedEachTime = calls >= 3;
    window.fetch = realFetch; picking = null; lastLoad = ''; await load(); await w(300);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(300);
    // Empty states
    view = 'songs'; $('#q').value = 'zzzz-nothing'; render(); out.songsEmpty = document.getElementById('grid').textContent.trim();
    $('#q').value = ''; view = 'videos'; tab = 'approved'; const keepV = videos; videos = videos.map(v => ({ ...v, approved: false })); render();
    out.approvedEmpty = document.getElementById('grid').textContent.includes('Nothing approved here yet'); videos = keepV; tab = 'all'; render();
    // Transcribing note follows the transcriber, not every video without a transcript
    transcribeStatus = { current: 'a.mp4', waiting: 2 }; $('#q').value = 'alpha'; render();
    out.transcribing = (document.querySelector('.searchinfo') || {}).textContent.includes('still transcribing 3 videos');
    transcribeStatus = { current: null, waiting: 0 }; render();
    out.noFalseNote = !document.querySelector('.searchinfo').textContent.includes('still transcribing');
    $('#q').value = ''; render(); await w(200);
    // A poster that fails to load shows "No preview"
    const img = document.querySelector('.tile .poster img.main'); img.src = '/thumb?id=alpha/does-not-exist.mp4'; await w(800);
    out.broken = img.classList.contains('broken') && getComputedStyle(img.closest('.poster'), '::after').content.includes('No preview');
    return out;`, 60000);
  assert.deepEqual(r, { copyOk: 'Copied ✓', copyFail: 'Copy failed', firstFetch: 1, errorShown: true, capShown: true, fetchedEachTime: true,
    songsEmpty: 'No songs match.', approvedEmpty: true, transcribing: true, noFalseNote: true, broken: true });
});

test('library: each tab is its own page (address, title, sidebar mark, Back/Forward, reload keeps it, bad address → All)', { skip }, async () => {
  await on('/', /Videos/);
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms)); const out = {};
    const cur = () => [location.hash, document.title.split(' — ')[0], [...document.querySelectorAll('[aria-current="page"]')].map(b => b.dataset.view || b.dataset.tab || b.dataset.folder).join('+')].join(' | ');
    out.start = cur();
    document.querySelector('[data-tab=approved]').click(); await w(300); out.approved = cur();
    document.querySelector('[data-folder=alpha]').click(); await w(300); out.alpha = cur();
    document.querySelector('[data-view=songs]').click(); await w(300); out.songs = cur();
    document.querySelector('[data-view=beta]').click(); await w(300); out.beta = cur();
    history.back(); await w(400); out.back1 = cur();
    history.back(); await w(400); out.back2 = cur();
    history.forward(); await w(400); out.forward = cur();
    out.onlyVideosGrid = !!document.querySelector('.tile') === false;
    return out;`);
  assert.deepEqual(r, {
    start: '#/videos/all | Videos · All | videos+all+all',
    approved: '#/videos/approved | Videos · Approved | videos+approved+all',
    alpha: '#/videos/approved/alpha | Videos · Approved · Alpha | videos+approved+alpha',
    songs: '#/songs | Songs | songs',
    beta: '#/finds/beta | Beta Person finds | beta',
    back1: '#/songs | Songs | songs',
    back2: '#/videos/approved/alpha | Videos · Approved · Alpha | videos+approved+alpha',
    forward: '#/songs | Songs | songs',
    onlyVideosGrid: true,
  });
  // A reload keeps the page; an unknown address falls back to All videos.
  px.st.commands.push("js:history.replaceState(null, '', '/#/videos/posted/beta')"); await sleep(300);
  px.st.commands.push('reload'); await sleep(2500);
  const kept = await page(`return [location.hash, document.querySelector('[data-tab].active').dataset.tab, document.querySelector('[data-folder].active').dataset.folder].join(' ');`);
  assert.equal(kept, '#/videos/posted/beta posted beta');
  px.st.commands.push("js:history.replaceState(null, '', '/#/nonsense/x')"); await sleep(300);
  px.st.commands.push('reload'); await sleep(2500);
  const fallback = await page(`return [document.querySelector('[data-view].active').dataset.view, document.querySelector('[data-tab].active').dataset.tab].join(' ');`);
  assert.equal(fallback, 'videos all');
  // A song's "Used in" chip goes to the Videos page with that video open (one history step back to Songs).
  const chip = await page(`const w = ms => new Promise(r => setTimeout(r, ms));
    document.querySelector('[data-view=songs]').click(); await w(400);
    document.querySelector('a[data-goto]').click(); await w(700);
    const out = { hash: location.hash, open: document.querySelector('#review .rv') && document.querySelector('#review .rv').dataset.id, search: document.getElementById('q').value };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(300);
    history.back(); await w(500); out.back = location.hash;
    document.getElementById('q').value = ''; go({ view: 'videos', tab: 'all' }); await w(300);
    return out;`);
  assert.deepEqual(chip, { hash: '#/videos/all', open: ID, search: 'alphaclips - alpha-cat-swap.mp4', back: '#/songs' });
});

test('library: a cancelled press still lets the page redraw', { skip }, async () => {
  await on('/', /Videos/);
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll('.tile')].find(t => t.dataset.open === ${JSON.stringify(ID)}).click(); await w(500);
    document.querySelector('.rv-info [data-act=editdesc]').click(); await w(200);
    const ta = document.querySelector('textarea[data-role=desc]');
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); await w(300);
    const waits = !!document.querySelector('textarea[data-role=desc]');
    document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true })); await w(300);
    const redrawn = !document.querySelector('textarea[data-role=desc]');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(300);
    return { waits, redrawn };`);
  assert.deepEqual(r, { waits: true, redrawn: true });
});

// ───────────── Studio ─────────────
test('studio: three sidebar pages, Studio, In progress and Characters (address, title, only its section, sidebar mark, Back/Forward); old tabs land on In progress; data escaped; no Terminal mode', { skip }, async () => {
  await on('/studio', /Video Studio/);
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms));
    const vis = () => ['new', 'progress', 'characters'].filter(id => !document.getElementById(id).hidden);
    const mark = () => document.querySelector('.navlist a[aria-current="page"]').getAttribute('href');
    location.hash = ''; await w(400);
    const out = { start: vis().join(), startMark: mark(), startH1: document.getElementById('pageTitle').textContent };
    out.nav = [...document.querySelectorAll('.navlist a')].map(a => a.getAttribute('href')).join(' ');   // no Projects, no Library link
    out.old = [];
    for (const h of ['#waiting', '#runs', '#projects']) { location.hash = h; await w(400); out.old.push([vis().join(), location.hash].join('|')); }
    document.querySelector('.navlist a[href="#new"]').click(); await w(500);
    document.querySelector('.navlist a[href="#progress"]').click(); await w(500);
    out.progress = [vis().join(), mark(), document.getElementById('pageTitle').textContent, document.title.includes('In progress'), location.hash].join('|');
    out.noBanner = !document.getElementById('banner');
    history.back(); await w(500); out.back = vis().join();
    history.forward(); await w(500); out.forward = vis().join();
    out.escaped = document.getElementById('videoList').textContent.includes('<b>on a roof</b>');
    location.hash = '#new'; await w(400);
    out.noTerminalMode = !document.querySelector('input[name="mode"]');
    out.hasToken = !!window.__studioToken;
    return out;`);
  assert.deepEqual(r, {
    start: 'new', startMark: '#new', startH1: 'Studio', nav: '#new #progress #characters',
    old: ['progress|#progress', 'progress|#progress', 'progress|#progress'],
    progress: 'progress|#progress|In progress|true|#progress',
    noBanner: true, back: 'new', forward: 'progress', escaped: true, noTerminalMode: true, hasToken: true });
});

test('studio: background run through the page: gate with image, notes clear the box, selection survives refresh, approve finishes', { skip, timeout: 90000 }, async () => {
  await on('/studio', /Video Studio/);
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms)); const out = {};
    location.hash = '#new'; await w(300);
    document.querySelector('.pipe[data-p=alpha]').click();
    document.getElementById('input').value = 'GATE https://tiktok.com/x';
    document.getElementById('startForm').requestSubmit();
    for (let i = 0; i < 20 && !document.querySelector('#startMsg a[href="#progress"]'); i++) await w(150);
    out.followLink = !!document.querySelector('#startMsg a[href="#progress"]');
    location.hash = '#progress'; await w(300);
    // The list card only says it needs your answer; the question and the answer box are on the video's page.
    let link = null; for (let i = 0; i < 60 && !link; i++) { await w(250); link = document.querySelector('.vcard.wait .vlink'); }
    out.cardSays = link.textContent.includes('Needs your answer') && !link.querySelector('[data-approve], textarea');
    link.click(); await w(800);
    let gate = null; for (let i = 0; i < 40 && !gate; i++) { await w(250); gate = document.querySelector('#dGates [data-approve]'); }
    out.gate = !!gate; const card = () => document.getElementById('runDetail');
    out.img = !!card().querySelector('#dGates .imgs img');
    const ta = card().querySelector('#dGates textarea'); ta.value = 'make it darker GATE'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-notes]').click();
    await w(7000);
    const ta2 = card().querySelector('#dGates textarea'); out.boxEmpty = ta2 ? ta2.value === '' : 'no gate';
    const strong = card().querySelector('#dGates strong'); const range = document.createRange(); range.selectNodeContents(strong);
    getSelection().removeAllRanges(); getSelection().addRange(range); await w(5600);
    out.selectionKept = getSelection().toString().length > 0;
    card().querySelector('#dGates [data-approve]').click();
    let st; for (let i = 0; i < 60; i++) { await w(250); st = document.querySelector('#dHead .pill').textContent; if (st === 'Finished') break; }
    out.final = st; out.gatesLeft = card().querySelectorAll('[data-approve]').length;
    return out;`, 80000);
  assert.deepEqual(r, { followLink: true, cardSays: true, gate: true, img: true, boxEmpty: true, selectionKept: true, final: 'Finished', gatesLeft: 0 });
});

test('studio: a run has no Open in Terminal; a run page\'s conversation keeps its place through redraws and follows when at the bottom', { skip, timeout: 90000 }, async () => {
  await on('/studio', /Video Studio/);
  // Make the finished run's log long on disk so it can scroll.
  const runId = (await s.studio('start', { pipeline: 'alpha', input: 'plain log test', mode: 'background' })).json.run;
  await until(async () => (await s.request('GET', '/api/studio/state')).json.runs.find((x) => x.id === runId).status === 'finished', 15000, 'run finished');
  const lines = Array.from({ length: 80 }, (_, i) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'step ' + i }] } })).join('\n') + '\n';
  fs.appendFileSync(path.join(s.gen, 'runs', runId, 'log.jsonl'), lines);
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms)); const id = ${JSON.stringify(runId)}; const out = {};
    const post = (p, b) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': window.__studioToken }, body: JSON.stringify(b) }).then(r => r.json());
    location.hash = '#progress/' + id;   // a run's id opens its video's page, on that run
    await w(5500);
    out.noTerminal = !document.querySelector('[data-term]') && !document.getElementById('runDetail').textContent.includes('Open in Terminal');
    const lg = document.getElementById('dConvo'); out.scrollable = lg.scrollHeight > lg.clientHeight;
    lg.scrollTop = 40;
    await post('/api/studio/start', { pipeline: 'alpha', input: 'another', mode: 'background' }); await w(6000);
    out.kept = lg.scrollTop;
    // New output arrives (as from a message), and you were at the bottom: it follows.
    lg.scrollTop = lg.scrollHeight;
    await post('/api/studio/message', { run: id, text: 'and one more' }); await w(7000);
    out.follows = lg.scrollHeight - lg.scrollTop - lg.clientHeight < 40;
    return out;`, 60000);
  assert.deepEqual(r, { noTerminal: true, scrollable: true, kept: 40, follows: true });
});

test('studio: the refresh keeps images and focus; a plain browser tab (no token) is read-only', { skip }, async () => {
  await on('/studio', /Video Studio/);
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms)); const out = {};
    const tok = window.__studioToken;
    await fetch('/api/studio/gate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': tok }, body: JSON.stringify({ id: 'ui-focus:q', project: 'ui-focus', title: 'Focus test', runId: null }) });
    await w(5600);
    location.hash = '#progress/ui-focus'; await w(5600);
    const img = document.querySelector('#runDetail img');
    const btn = document.querySelector('#dGates [data-notes="ui-focus:q"]'); btn.focus();
    await w(5600);
    out.sameImage = !img || img.isConnected;
    out.focusKept = document.activeElement && document.activeElement.dataset.notes === 'ui-focus:q';
    // The same page in a frame gets no token (the app hands it only to the main page): read-only.
    const f = document.createElement('iframe'); f.src = '/studio'; f.style.cssText = 'width:900px;height:600px;position:fixed;left:-2000px'; document.body.append(f);
    await new Promise(r => f.onload = r); await w(1500);
    const d = f.contentDocument;
    out.readOnly = d.body.classList.contains('readonly') && getComputedStyle(d.getElementById('startBtn')).pointerEvents === 'none' && d.getElementById('startMsg').textContent.includes('Read-only');
    f.remove();
    await fetch('/api/studio/gate/clear', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': tok }, body: JSON.stringify({ id: 'ui-focus:q' }) });
    return out;`);
  assert.deepEqual(r, { sameImage: true, focusKept: true, readOnly: true });
});

test('studio: a video\'s page shows its step tracker and conversation, and a message you send reaches the run and its reply shows', { skip, timeout: 90000 }, async () => {
  await on('/studio', /Video Studio/);
  const id = (await s.studio('start', { pipeline: 'alpha', input: 'plain page test', mode: 'background' })).json.run;
  await until(async () => (await s.request('GET', '/api/studio/state')).json.runs.find((x) => x.id === id).status === 'finished', 40000, 'run finished');
  fs.mkdirSync(path.join(s.gen, 'runs', id, 'work', 'alpha-ui'), { recursive: true });
  fs.writeFileSync(path.join(s.gen, 'runs', id, 'work', 'alpha-ui', 'state.json'), JSON.stringify({ stage: 'test-approved' }));
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms)); const id = ${JSON.stringify(id)}; const out = {};
    location.hash = '#progress'; await w(5600);
    const card = document.querySelector('#videoList .vlink[href="#progress/' + encodeURIComponent('run-' + id) + '"]'); out.card = !!card;
    out.cardStep = card ? card.querySelector('.stepline').textContent : '';
    card.click(); await w(800);
    out.hash = location.hash; out.listHidden = document.getElementById('listView').hidden;
    out.h1 = document.getElementById('pageTitle').textContent;
    out.now = document.querySelector('.stepper .now .mk + span').firstChild.textContent; out.done = document.querySelectorAll('.stepper .done').length;
    for (let i = 0; i < 20 && !document.querySelector('#dConvo .bub'); i++) await w(250);
    out.firstBubble = document.querySelector('#dConvo .bub.me').textContent.includes('plain page test');
    document.getElementById('sayText').value = 'louder please'; document.getElementById('sayForm').requestSubmit();
    let mine = null; for (let i = 0; i < 60 && !mine; i++) { await w(250); mine = [...document.querySelectorAll('#dConvo .bub.me')].find(b => b.textContent.includes('louder please')); }
    out.sent = !!mine;
    let reply = null; for (let i = 0; i < 60 && !reply; i++) { await w(250); reply = [...document.querySelectorAll('#dConvo .bub.them')].find(b => b.textContent.includes('message from the Studio')); }
    out.reply = !!reply;
    return out;`, 80000);
  if (process.env.APP_SHOT) { px.st.commands.push('snapshot:' + process.env.APP_SHOT); await until(() => fs.existsSync(process.env.APP_SHOT), 8000, 'window picture'); }
  const back = await page(`document.querySelector('#runDetail .back').click(); await new Promise(r => setTimeout(r, 600)); return [location.hash, document.getElementById('listView').hidden, document.getElementById('pageTitle').textContent].join('|');`);
  assert.deepEqual(r, { card: true, cardStep: 'Step 4 of 12 · Test approved', hash: '#progress/run-' + id, listHidden: true, h1: '/alpha plain page test',
    now: 'Test approved', done: 3, firstBubble: true, sent: true, reply: true });
  assert.equal(back, '#progress|false|In progress');
});

test('studio: a step opens to show what it made; Redo from this step asks first, keeps a half-written note through the refresh, and shows why it could not start', { skip, timeout: 90000 }, async () => {
  const gate = (args) => require('child_process').spawnSync(path.join(s.gen, 'scripts', 'studio-gate.sh'), args, { env: { ...process.env, STUDIO_PORT: String(s.port) } });
  const work = path.join(s.gen, 'runs', 'ui-steps'); fs.mkdirSync(work, { recursive: true });
  const png = path.join(work, 'sheet.png'); fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  gate(['step', 'zz-ui-steps', 'alpha', 'mapped', 'four shots', png]);
  gate(['step', 'zz-ui-steps', 'alpha', 'planned']);
  await on('/studio', /Video Studio/);
  const r = await page(`const w = ms => new Promise(r => setTimeout(r, ms)); const out = {};
    location.hash = '#progress/zz-ui-steps'; await w(1500);
    const btn = (k) => document.querySelector('#dSteps button[data-stepsel="' + k + '"]');
    out.steps = document.querySelectorAll('#dSteps .stepper > li').length;
    out.mini = !!btn('mapped').querySelector('img.smini');
    btn('mapped').click(); await w(400);
    out.panel = document.querySelector('.steppanel strong').textContent;
    out.img = document.querySelectorAll('.steppanel .imgs img').length;
    out.expanded = btn('mapped').getAttribute('aria-expanded');
    out.firstRedo = !!document.querySelector('.steppanel button[data-redo]');
    btn('planned').click(); await w(400);
    out.empty = document.querySelector('.steppanel .why').textContent;
    document.querySelector('.steppanel button[data-redo]').click(); await w(400);
    out.ask = document.querySelector('.redoask strong').textContent;
    const ta = document.querySelector('.redoask textarea'); ta.focus(); ta.value = 'tighter'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    await w(5600);
    out.kept = document.querySelector('.redoask textarea').value;
    document.querySelector('.redoask button[data-redo-go]').click(); await w(1500);
    out.err = (document.querySelector('.redoask .act-err') || {}).textContent || '';
    document.querySelector('.redoask button[data-redo-cancel]').click(); await w(400);
    out.closed = !document.querySelector('.redoask');
    return out;`, 60000);
  assert.deepEqual(r, { steps: 12, mini: true, panel: 'Step 1 · Video mapped', img: 1, expanded: 'true', firstRedo: false,
    empty: 'No pictures or videos were saved for this step.', ask: 'Start take 2 from “Shot plan”?', kept: 'tighter',
    err: 'Could not find that chat session\'s conversation. Answer it in its chat window.', closed: true });
  assert.equal((await s.request('GET', '/api/studio/state')).json.videos.find((v) => v.key === 'zz-ui-steps').take, 1, 'nothing started');
});

test('studio: narrow windows: a short bar at 720 px, nothing sideways at 375 px', { skip }, async () => {
  await on('/studio', /Video Studio/);
  const out = {};
  for (const [w, h] of [[720, 900], [375, 812]]) {
    await resize(w, h);
    out[w] = await page(`scrollTo(0, 0); await new Promise(r => setTimeout(r, 300)); const n = document.querySelector('nav.side');
      return { navPos: getComputedStyle(n).position, short: n.getBoundingClientRect().height < 200,  sideways: document.documentElement.scrollWidth > innerWidth };`);
  }
  await resize(1320, 860);
  assert.deepEqual(out, { 720: { navPos: 'static', short: true, sideways: false }, 375: { navPos: 'static', short: true, sideways: false } });
});
