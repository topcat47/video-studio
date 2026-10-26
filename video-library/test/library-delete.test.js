// The Library's bulk "Delete permanently" (/api/videos/delete-forever) and the page's selection, Un-approve, filters
// and date sorter. Erasing can't be undone, so: only the Studio app (token AND its own page) may do it; only videos in
// Beta/, Alpha/, Other/ or Unsorted; never songs or originals; a song's "Used in" forgets the erased video.
// Run: node --test video-library/test/library-delete.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./harness');

let s;
const P = {};
test.before(async () => {
  s = await startServer({
    fixtures: ({ gen, lib, home }) => {
      P.a = path.join(gen, 'Alpha', 'a - alpha-cat-swap.mp4');
      P.b = path.join(gen, 'Beta', 'b - beta-cat-swap.mp4');
      P.c = path.join(gen, 'Other', 'c - keep.mp4');
      P.orig = path.join(gen, 'Alpha', 'originals', 'a - 123.mp4');
      P.song = path.join(home, 'video-studio', 'songs', 'beat.mp3');
      for (const f of Object.values(P)) fs.writeFileSync(f, 'x');
      fs.writeFileSync(path.join(lib, 'labels.json'), JSON.stringify({
        'alpha/a - alpha-cat-swap.mp4': { approved: true, description: 'a', original: P.orig },
        'beta/b - beta-cat-swap.mp4': { description: 'b' },
        'other/c - keep.mp4': { description: 'c' },
        'songs/beat.mp3': { usedIn: ['alpha/a - alpha-cat-swap.mp4', 'other/c - keep.mp4'] },
      }));
    },
  });
});
test.after(async () => s && s.stop());

const del = (ids, headers) => s.request('POST', '/api/videos/delete-forever', { body: { ids }, headers });
const labels = () => JSON.parse(fs.readFileSync(path.join(s.lib, 'labels.json'), 'utf8'));

test('delete-forever: refused without the Studio app (no token, or a script/run with the token but no page Origin)', async () => {
  assert.equal((await del(['alpha/a - alpha-cat-swap.mp4'])).status, 403);
  assert.equal((await del(['alpha/a - alpha-cat-swap.mp4'], { 'X-Studio-Token': s.token })).status, 403);
  assert.equal((await del(['alpha/a - alpha-cat-swap.mp4'], { 'X-Studio-Token': s.token, Origin: 'http://evil.example' })).status, 403);
  assert.ok(fs.existsSync(P.a), 'nothing erased');
});

test('delete-forever: erases exactly the chosen videos and their cards; songs, originals and unknown ids are refused', async () => {
  const r = await del(['alpha/a - alpha-cat-swap.mp4', 'beta/b - beta-cat-swap.mp4', 'songs/beat.mp3', 'alpha/originals/a - 123.mp4', 'alpha/nope.mp4'],
    { 'X-Studio-Token': s.token, Origin: s.base });
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, 2);
  assert.deepEqual(r.json.results.map((x) => [x.id, x.ok]), [
    ['alpha/a - alpha-cat-swap.mp4', true], ['beta/b - beta-cat-swap.mp4', true], ['songs/beat.mp3', false], ['alpha/originals/a - 123.mp4', false], ['alpha/nope.mp4', false]]);
  assert.equal(fs.existsSync(P.a), false);
  assert.equal(fs.existsSync(P.b), false);
  assert.ok(fs.existsSync(P.c), 'not chosen: kept');
  assert.ok(fs.existsSync(P.orig), 'the original stays');
  assert.ok(fs.existsSync(P.song), 'songs are never deleted here');
  const l = labels();
  assert.equal(l['alpha/a - alpha-cat-swap.mp4'], undefined);
  assert.equal(l['beta/b - beta-cat-swap.mp4'], undefined);
  assert.deepEqual(l['songs/beat.mp3'].usedIn, ['other/c - keep.mp4']);
  assert.equal(l['other/c - keep.mp4'].description, 'c');
  const list = (await s.request('GET', '/api/videos')).json.map((v) => v.id);
  assert.ok(!list.includes('alpha/a - alpha-cat-swap.mp4') && list.includes('other/c - keep.mp4'));
});

test('delete-forever: an empty or oversized request deletes nothing', async () => {
  const h = { 'X-Studio-Token': s.token, Origin: s.base };
  assert.equal((await del([], h)).status, 400);
  assert.equal((await del(Array.from({ length: 501 }, (_, i) => 'other/x' + i + '.mp4'), h)).status, 400);
  assert.ok(fs.existsSync(P.c));
});

test('library page: checkboxes, selection bar, confirm box, Un-approve, filters and date sorter are there', async () => {
  const page = (await s.request('GET', '/', { raw: true })).text;
  for (const t of ['data-sel=', 'Delete permanently', "This can't be undone", 'forever', "fetch('/api/videos/delete-forever'", "'X-Studio-Token': TOKEN",
    'Un-approve', 'Un-approving…', 'Not posted anywhere', 'This week', 'Newest first', 'Oldest first', 'id="filters"', 'id="delDlg"'])
    assert.ok(page.includes(t), t);
});
