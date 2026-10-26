// Library routes: listing, cards (labels), posts, streaming, thumbnails, finds, and the server staying up.
// Run: node --test video-library/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, makeVideo } = require('./harness');

let s;
test.before(async () => {
  s = await startServer({
    fixtures: ({ gen, lib }) => {
      makeVideo(path.join(gen, 'Alpha', 'alphaclips - alpha-cat-swap.mp4'));
      makeVideo(path.join(gen, 'Alpha', 'originals', 'alphaclips - 123.mp4'));
      makeVideo(path.join(gen, 'Beta', 'a <img src=x onerror=alert(1)> name.mp4'));
      fs.writeFileSync(path.join(gen, 'Alpha', 'notes.txt'), 'not a video');
      fs.mkdirSync(path.join(lib, 'alpha-finds'));
      makeVideo(path.join(lib, 'alpha-finds', 'kick - 1.mp4'));
      fs.writeFileSync(path.join(lib, 'alpha-finds.json'), JSON.stringify([{ id: 'k1', file: 'kick - 1.mp4', title: 'one' }, { id: 'k2', url: 'https://youtube.com/x' }]));
      fs.writeFileSync(path.join(lib, 'beta-finds.json'), '[]');
    },
  });
});
test.after(async () => s && s.stop());

const ID = 'alpha/alphaclips - alpha-cat-swap.mp4';
const local = () => ({ Origin: s.base });

test('index page and video list', async () => {
  const page = await s.request('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /<html/i);
  const list = await s.request('GET', '/api/videos');
  assert.equal(list.status, 200);
  const ids = list.json.map((v) => v.id).sort();
  assert.deepEqual(ids, ['alpha/alphaclips - alpha-cat-swap.mp4', 'beta/a <img src=x onerror=alert(1)> name.mp4']);
  const v = list.json.find((x) => x.id === ID);
  assert.equal(v.archived, false);
  assert.equal(v.approved, false);
  assert.equal(v.posted, false);
});

test('label: description, source link, X quote, approval round-trip', async () => {
  const r = await s.request('POST', '/api/label', { headers: local(), body: { id: ID, description: '  Alpha Cat on a couch.  ',
    sourceUrl: 'https://www.tiktok.com/@alphaclips/video/123', xQuote: 'Frame stays sharp 🐈‍⬛', approved: true } });
  assert.equal(r.status, 200, r.text);
  const v = (await s.request('GET', '/api/videos')).json.find((x) => x.id === ID);
  assert.equal(v.description, 'Alpha Cat on a couch.');
  assert.equal(v.sourceUrl, 'https://www.tiktok.com/@alphaclips/video/123');
  assert.equal(v.approved, true);
  assert.ok(v.approvedAt);
  const off = await s.request('POST', '/api/label', { headers: local(), body: { id: ID, approved: false } });
  assert.equal(off.status, 200);
  assert.equal((await s.request('GET', '/api/videos')).json.find((x) => x.id === ID).approved, false);
});

test('label: rejects bad input', async () => {
  const bad = [
    { id: 'alpha/../../etc/passwd', note: 'x' },
    { id: 'alpha/missing.mp4', note: 'x' },
    { id: ID, status: 'weird' },
    { id: ID, approved: 'yes' },
    { id: ID, sourceUrl: 'javascript:alert(1)' },
    { id: ID, description: 'x'.repeat(2001) },
    { id: ID, usedIn: ['alpha/nope.mp4'] },
    { id: ID, original: '/etc/hosts' },
  ];
  for (const body of bad) {
    const r = await s.request('POST', '/api/label', { headers: local(), body });
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} → ${r.status}`);
  }
});

test('label: links an original from <Subject>/originals', async () => {
  const orig = path.join(s.gen, 'Alpha', 'originals', 'alphaclips - 123.mp4');
  const r = await s.request('POST', '/api/label', { headers: local(), body: { id: ID, original: orig } });
  assert.equal(r.status, 200, r.text);
  const v = (await s.request('GET', '/api/videos')).json.find((x) => x.id === ID);
  assert.equal(v.originalExists, true);
  const o = await s.request('GET', '/video?id=' + encodeURIComponent(ID) + '&which=original', { raw: true, headers: { Range: 'bytes=0-9' } });
  assert.equal(o.status, 206);
});

test('labels file is never left half-written or wiped by a bad read', async () => {
  const before = JSON.parse(fs.readFileSync(path.join(s.lib, 'labels.json'), 'utf8'));
  assert.ok(before[ID], 'card exists');
  // Many parallel writes must all land and leave valid JSON.
  await Promise.all(Array.from({ length: 25 }, (_, i) =>
    s.request('POST', '/api/label', { headers: local(), body: { id: ID, note: 'n' + i } })));
  const after = JSON.parse(fs.readFileSync(path.join(s.lib, 'labels.json'), 'utf8'));
  assert.equal(after[ID].description, 'Alpha Cat on a couch.');
  assert.match(after[ID].note, /^n\d+$/);
  // A corrupt labels.json must not be treated as empty and overwritten (that would wipe every card).
  fs.writeFileSync(path.join(s.lib, 'labels.json'), '{"broken": ');
  const r = await s.request('POST', '/api/label', { headers: local(), body: { id: ID, note: 'after corruption' } });
  assert.ok(r.status >= 500, 'write refused while labels.json is unreadable, got ' + r.status);
  assert.equal(fs.readFileSync(path.join(s.lib, 'labels.json'), 'utf8'), '{"broken": ', 'corrupt file left for repair');
  fs.writeFileSync(path.join(s.lib, 'labels.json'), JSON.stringify(after, null, 2));
});

test('posts: queue then post on the same entry, then remove', async () => {
  const q = await s.request('POST', '/api/post', { headers: local(), body: { id: ID, account: 'x:alphacat', status: 'queued', at: '2026-10-24T10:00:00Z', caption: 'hi' } });
  assert.equal(q.status, 200, q.text);
  const p = await s.request('POST', '/api/post', { headers: local(), body: { id: ID, account: 'x:alphacat', status: 'posted', url: 'https://x.com/alphacat/status/1' } });
  assert.equal(p.json.posts.length, 1);
  assert.equal(p.json.posts[0].status, 'posted');
  assert.equal(p.json.posts[0].caption, 'hi');
  const bad = await s.request('POST', '/api/post', { headers: local(), body: { id: ID, account: 'x:someoneelse', status: 'posted' } });
  assert.equal(bad.status, 400);
  const rm = await s.request('POST', '/api/post', { headers: local(), body: { id: ID, account: 'x:alphacat', url: 'https://x.com/alphacat/status/1', remove: true } });
  assert.equal(rm.json.posts.length, 0);
});

test('video streaming: full, ranges, suffix range, bad range, download name', async () => {
  const q = '/video?id=' + encodeURIComponent(ID);
  const full = await s.request('GET', q, { raw: true });
  assert.equal(full.status, 200);
  const size = full.body.length;
  assert.equal(Number(full.headers['content-length']), size);
  const part = await s.request('GET', q, { raw: true, headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.body.length, 10);
  assert.deepEqual(part.body, full.body.subarray(10, 20));
  const open = await s.request('GET', q, { raw: true, headers: { Range: 'bytes=100-' } });
  assert.equal(open.body.length, size - 100);
  const suffix = await s.request('GET', q, { raw: true, headers: { Range: 'bytes=-50' } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(suffix.body, full.body.subarray(size - 50), 'bytes=-50 is the LAST 50 bytes');
  const past = await s.request('GET', q, { raw: true, headers: { Range: `bytes=${size + 10}-` } });
  assert.equal(past.status, 416);
  const dl = await s.request('GET', q + '&download=1', { raw: true });
  assert.match(dl.headers['content-disposition'], /^attachment; filename\*=UTF-8''alphaclips%20-%20alpha-cat-swap\.mp4$/);
  assert.equal((await s.request('GET', '/video?id=alpha/../Alpha/x.mp4')).status, 404);
  assert.equal((await s.request('GET', '/video?id=alpha/notes.txt')).status, 404, 'non-video files are not served');
});

test('thumbnails are made and cached', async () => {
  const t = await s.request('GET', '/thumb?id=' + encodeURIComponent(ID), { raw: true });
  assert.equal(t.status, 200);
  assert.equal(t.headers['content-type'], 'image/jpeg');
  assert.equal(t.body.subarray(0, 2).toString('hex'), 'ffd8');
});

test('finds: list, play, thumb, delete keeps a copy', async () => {
  const list = await s.request('GET', '/api/finds?s=alpha');
  assert.equal(list.json.length, 2);
  assert.equal((await s.request('GET', '/find?s=alpha&id=k1', { raw: true, headers: { Range: 'bytes=0-3' } })).status, 206);
  assert.equal((await s.request('GET', '/find?s=alpha&id=k1&kind=thumb', { raw: true })).status, 200);
  assert.equal((await s.request('GET', '/find?s=alpha&id=k2', { raw: true })).status, 404);
  assert.equal((await s.request('GET', '/api/finds?s=nope')).status, 404);
  const del = await s.request('POST', '/api/finds/delete', { headers: local(), body: { s: 'alpha', id: 'k2' } });
  assert.equal(del.status, 200);
  assert.equal((await s.request('GET', '/api/finds?s=alpha')).json.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.lib, 'alpha-finds-removed.json'), 'utf8'))[0].id, 'k2');
});

test('songs, accounts, candidates, transcribe status answer', async () => {
  assert.deepEqual((await s.request('GET', '/api/songs')).json, []);
  assert.ok((await s.request('GET', '/api/accounts')).json['x:alphacat']);
  const c = await s.request('GET', '/api/candidates');
  assert.ok(c.json.some((x) => x.name === 'alphaclips - 123.mp4'));
  assert.equal((await s.request('GET', '/api/transcribe-status')).status, 200);
});

test('trash and reveal go through Finder (osascript / open), never rm', async () => {
  const id = 'beta/a <img src=x onerror=alert(1)> name.mp4';
  const r = await s.request('POST', '/api/trash', { headers: local(), body: { id } });
  assert.equal(r.status, 200);
  assert.match(s.osascript(), /tell application "Finder" to delete/);
  assert.ok(fs.existsSync(path.join(s.gen, 'Beta', 'a <img src=x onerror=alert(1)> name.mp4')), 'the fake Finder did not delete it; the server must not either');
  assert.equal((await s.request('POST', '/api/reveal', { headers: local(), body: { id } })).status, 200);
});

test('other websites cannot change the library (CSRF)', async () => {
  // A page on another site can send a "simple" cross-site POST (text/plain, no preflight). The browser
  // always adds its Origin; the server must refuse anything that isn't this app.
  for (const [route, body] of [['/api/label', { id: ID, approved: true }], ['/api/trash', { id: ID }],
    ['/api/post', { id: ID, account: 'x:alphacat', status: 'posted' }], ['/api/finds/delete', { s: 'alpha', id: 'k1' }], ['/api/reveal', { id: ID }]]) {
    const r = await s.request('POST', route, { body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' } });
    assert.equal(r.status, 403, route + ' from another site → ' + r.status);
  }
  assert.equal((await s.request('GET', '/api/videos')).json.find((x) => x.id === ID).approved, false);
  // Skills and scripts (curl, no Origin) keep working.
  assert.equal((await s.request('POST', '/api/label', { body: { id: ID, note: 'from curl' } })).status, 200);
});

test('DNS-rebinding guard: requests for another host name are refused', async () => {
  const r = await s.request('GET', '/studio', { headers: { Host: 'evil.example:' + s.port } });
  assert.equal(r.status, 403);
  assert.doesNotMatch(r.text, new RegExp(s.token), 'token never served to a foreign host');
  assert.equal((await s.request('GET', '/api/videos', { headers: { Host: 'localhost:' + s.port } })).status, 200);
});

test('malformed requests never take the server down', async () => {
  await s.request('POST', '/api/label', { headers: local(), body: '{not json' });
  await s.request('POST', '/api/label', { headers: local(), body: 'null' });
  await s.request('POST', '/api/label', { headers: local(), body: '[1,2]' });
  await s.request('POST', '/api/post', { headers: local(), body: { id: ID, account: 'x:alphacat', status: 'queued', at: 12 } });
  await s.request('GET', '/video?id=');
  await s.request('GET', '/video?id=%E0%A4%A');
  await s.request('GET', '/thumb?id=alpha/missing.mp4');
  await s.request('GET', '/find?s=beta&id=nope');
  const big = await s.request('POST', '/api/label', { headers: local(), body: '{"id":"' + 'x'.repeat(3_000_000) + '"}' });
  assert.ok(big.status === 413 || big.status === 404, 'oversized body refused, got ' + big.status);
  assert.ok(s.alive(), 'server still running:\n' + s.output());
  assert.equal((await s.request('GET', '/api/videos')).status, 200);
});

test('thumbnails: many at once all succeed, at most 3 ffmpeg jobs run together, same file twice is safe', async () => {
  for (let i = 0; i < 8; i++) makeVideo(path.join(s.gen, 'Other', `bulk-${i}.mp4`));
  const ids = Array.from({ length: 8 }, (_, i) => `other/bulk-${i}.mp4`);
  const rs = await Promise.all([...ids, ids[0], ids[0]].map((id) => s.request('GET', '/thumb?id=' + encodeURIComponent(id), { raw: true })));
  for (const r of rs) { assert.equal(r.status, 200); assert.equal(r.body.subarray(0, 2).toString('hex'), 'ffd8'); assert.equal(r.body.subarray(-2).toString('hex'), 'ffd9', 'complete JPEG'); }
  const st = await s.request('GET', '/api/transcribe-status');
  assert.ok(st.json.thumbsPeak <= 3 && st.json.thumbsPeak >= 1, 'peak ' + st.json.thumbsPeak);
});

test('link-original.js links through the running app (no lost saves) and copies into originals/', async () => {
  const { execFileSync, spawnSync } = require('child_process');
  makeVideo(path.join(s.gen, 'Other', 'linked - swap.mp4'));
  const src = path.join(s.home, 'Downloads'); fs.mkdirSync(src, { recursive: true });
  makeVideo(path.join(src, 'creator - 555.mp4'));
  await s.request('POST', '/api/label', { body: { id: 'other/linked - swap.mp4', description: 'keep me' } });
  const env = { ...process.env, HOME: s.home, STUDIO_PORT: String(s.port) };
  const out = execFileSync(process.execPath, [path.join(s.lib, 'link-original.js'), path.join(s.gen, 'Other', 'linked - swap.mp4'), path.join(src, 'creator - 555.mp4')], { env }).toString();
  assert.match(out, /Linked other\/linked - swap\.mp4/);
  const v = (await s.request('GET', '/api/videos')).json.find((x) => x.id === 'other/linked - swap.mp4');
  assert.equal(v.description, 'keep me');
  assert.equal(v.original, path.join(s.gen, 'Other', 'originals', 'creator - 555.mp4'));
  assert.equal(v.originalExists, true);
  assert.ok(fs.existsSync(path.join(src, 'creator - 555.mp4')), 'the source is never moved');
  // App down + corrupt labels.json: refuses instead of wiping it.
  const labels = path.join(s.lib, 'labels.json'); const good = fs.readFileSync(labels, 'utf8');
  fs.writeFileSync(labels, '{"broken":');
  const r = spawnSync(process.execPath, [path.join(s.lib, 'link-original.js'), path.join(s.gen, 'Other', 'linked - swap.mp4'), path.join(src, 'creator - 555.mp4')], { env: { ...env, STUDIO_PORT: '1' } });
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(labels, 'utf8'), '{"broken":');
  fs.writeFileSync(labels, good);
});

test('a file still being written is sent at exactly its announced length', async () => {
  const f = path.join(s.gen, 'Other', 'growing.mp4');
  fs.copyFileSync(path.join(s.gen, 'Alpha', 'alphaclips - alpha-cat-swap.mp4'), f);
  fs.appendFileSync(f, Buffer.alloc(4_000_000));
  const http = require('http');
  const res = await new Promise((resolve, reject) => {
    http.get(s.base + '/video?id=' + encodeURIComponent('other/growing.mp4'), (r) => {
      let n = 0, grown = false;
      r.on('data', (c) => { n += c.length; if (!grown) { grown = true; fs.appendFileSync(f, Buffer.alloc(2_000_000)); } });
      r.on('end', () => resolve({ declared: Number(r.headers['content-length']), got: n }));
    }).on('error', reject);
  });
  assert.equal(res.got, res.declared);
});

test('transcripts: a tool failure stores nothing and is retried; silent videos get ""; sound tags are dropped', async () => {
  const { execFileSync } = require('child_process');
  const t = await startServer({ fixtures: ({ home, gen }) => {
    fs.mkdirSync(path.join(home, '.cache', 'whisper-models'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cache', 'whisper-models', 'ggml-base.en.bin'), 'model');
    // Fake whisper-cli: fails while ~/whisper-fail exists, otherwise writes <-of>.txt.
    fs.writeFileSync(path.join(home, 'bin', 'whisper-cli'), `#!/bin/sh
[ -f '${home}/whisper-fail' ] && exit 1
while [ $# -gt 0 ]; do [ "$1" = "-of" ] && out="$2"; shift; done
printf ' [Music] hello   world (laughs) ' > "$out.txt"
`);
    fs.chmodSync(path.join(home, 'bin', 'whisper-cli'), 0o755);
    fs.writeFileSync(path.join(home, 'whisper-fail'), '');
    makeVideo(path.join(gen, 'Alpha', 'talks.mp4'));
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(gen, 'Alpha', 'silent.mp4')]);
  } });
  try {
    await t.restart({ STUDIO_TRANSCRIPT_RETRY_MS: '500' });
    const get = async (n) => (await t.request('GET', '/api/videos')).json.find((v) => v.name === n).transcript;
    await get('talks.mp4');                                    // listing queues them
    await t.waitFor(async () => (await get('silent.mp4')) === '', 8000, 'silent video → ""');
    await t.waitFor(async () => { const st = await t.request('GET', '/api/transcribe-status'); return !st.json.current && st.json.waiting === 0; }, 8000, 'queue idle');
    assert.equal(await get('talks.mp4'), null, 'whisper failed: nothing stored');
    fs.rmSync(path.join(t.home, 'whisper-fail'));
    await new Promise((r) => setTimeout(r, 700));             // past the retry delay
    await t.waitFor(async () => (await get('talks.mp4')) === 'hello world', 8000, 'retried and transcribed');
  } finally {
    await t.stop();
  }
});

test('an original can be a picture: linked, listed as a picture, served as an image, with a thumbnail', async () => {
  const { execFileSync } = require('child_process');
  makeVideo(path.join(s.gen, 'Alpha', 'tweet - alpha-cat-swap.mp4'));
  const png = path.join(s.gen, 'Alpha', 'originals', 'tweet - 999.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:duration=0.1', '-frames:v', '1', png]);
  const id = 'alpha/tweet - alpha-cat-swap.mp4';
  assert.equal((await s.request('POST', '/api/label', { body: { id, original: png } })).status, 200);
  const v = (await s.request('GET', '/api/videos')).json.find((x) => x.id === id);
  assert.equal(v.originalExists, true);
  assert.equal(v.originalIsImage, true);
  const img = await s.request('GET', '/video?id=' + encodeURIComponent(id) + '&which=original', { raw: true });
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.equal(img.body.subarray(1, 4).toString(), 'PNG');
  const th = await s.request('GET', '/thumb?id=' + encodeURIComponent(id) + '&which=original', { raw: true });
  assert.equal(th.status, 200);
  assert.equal(th.body.subarray(0, 2).toString('hex'), 'ffd8');
  assert.ok((await s.request('GET', '/api/candidates')).json.some((c) => c.name === 'tweet - 999.png'), 'pictures can be picked as originals');
  assert.equal((await s.request('POST', '/api/label', { body: { id, original: path.join(s.gen, 'Alpha', 'originals', 'notes.txt') } })).status, 400, 'other file types still refused');
});
