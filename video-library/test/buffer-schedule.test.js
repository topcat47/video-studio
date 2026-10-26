// "Schedule on Buffer" (buffer-schedule.js) with a fake Buffer API and the fake claude: who may start it; which
// accounts a video can go to; captions written with NO tools; a draft or a schedule made only by the owner's click,
// with exactly the chosen accounts and captions; live steps; the post read back from Buffer before it counts;
// a real schedule recorded under "Where it's posted"; failures vs "check Buffer"; and the guard's schedule mode.
// Run: node --test video-library/test/buffer-schedule.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { startServer, makeVideo } = require('./harness');

const KEY = 'good-key-123';
const ALPHA = 'alpha/a - alpha-cat-swap.mp4', BETA = 'beta/t - beta-cat-swap.mp4', DRAFTY = 'alpha/d - alpha-cat-swap.mp4';
let api, s, log;
test.before(async () => {
  api = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== `Bearer ${KEY}`) { res.statusCode = 401; return res.end('{}'); }
      if (/organizations/.test(JSON.parse(b).query)) return res.end(JSON.stringify({ data: { account: { organizations: [{ id: 'org1', name: 'Top cat' }] } } }));
      const ch = (id, name, service, disc) => ({ id, name, displayName: name, service, avatar: '', isQueuePaused: false, isDisconnected: !!disc, timezone: 'UTC' });
      res.end(JSON.stringify({ data: { channels: [ch('cx', 'alphacat', 'twitter'), ch('ct', 'alpha.cat', 'tiktok'), ch('tx', 'betacatfun', 'twitter'), ch('tt', 'beta_cat_fun', 'tiktok'), ch('ti', 'beta_cat_fun', 'instagram', true)],
        scheduled: { edges: [] }, sent: { edges: [] }, drafts: { edges: [] } } }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => api.once('listening', r));
  s = await startServer({
    env: { BUFFER_API_URL: `http://127.0.0.1:${api.address().port}`, BUFFER_COLLECT_EVERY_MIN: '0' },
    fixtures: ({ gen, lib }) => {
      fs.mkdirSync(path.join(gen, 'Beta'), { recursive: true });
      makeVideo(path.join(gen, 'Alpha', 'a - alpha-cat-swap.mp4'));
      makeVideo(path.join(gen, 'Alpha', 'd - alpha-cat-swap.mp4'));
      makeVideo(path.join(gen, 'Beta', 't - beta-cat-swap.mp4'));
      makeVideo(path.join(gen, 'Alpha', 'n - alpha-cat-swap.mp4'));
      fs.writeFileSync(path.join(lib, 'labels.json'), JSON.stringify({
        [ALPHA]: { approved: true, description: 'Alpha Cat rates a burger', xQuote: 'cheese is a risk' },
        [DRAFTY]: { approved: true, description: 'Alpha Cat at the gym' },
        [BETA]: { approved: true, description: 'Betacat says wake up' },
        'alpha/n - alpha-cat-swap.mp4': { description: 'not approved' },
      }));
    },
  });
  log = path.join(s.home, 'claude-calls.jsonl');
});
test.after(async () => { if (s) await s.stop(); api && api.close(); });

const owner = (p, body) => s.request('POST', '/api/buffer/' + p, { body, headers: { 'X-Studio-Token': s.token, Origin: s.base } });
const sched = async (id) => (await s.request('GET', '/api/buffer/schedule?ids=' + encodeURIComponent(id))).json.videos[0];
const jobs = (kind) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []).filter((j) => j.bufferJob === kind);
const waitState = (id, want) => s.waitFor(async () => { const v = await sched(id); return want.includes(v.state) && v; }, 10000, `${id} → ${want}`);
const labels = () => JSON.parse(fs.readFileSync(path.join(s.lib, 'labels.json'), 'utf8'));

test('schedule: only the Studio app can start it, only for approved videos, only once Buffer is connected', async () => {
  for (const p of ['schedule/captions', 'schedule/start']) {
    assert.equal((await s.request('POST', '/api/buffer/' + p, { body: { id: ALPHA } })).status, 403, p + ' without token');
    assert.equal((await s.request('POST', '/api/buffer/' + p, { body: { id: ALPHA }, headers: { 'X-Studio-Token': s.token } })).status, 403, p + ' from a script');
  }
  assert.equal((await owner('schedule/captions', { id: ALPHA })).status, 409, 'Buffer not connected yet');
  assert.equal((await owner('key', { key: KEY })).status, 200);
  assert.equal((await owner('schedule/captions', { id: 'alpha/n - alpha-cat-swap.mp4' })).status, 404, 'not approved');
  assert.equal((await owner('schedule/captions', { id: 'alpha/../x.mp4' })).status, 404);
});

test('schedule: a Alpha video goes to @alphacat and @alpha.cat; a Beta video to Betacat\'s accounts, never a disconnected one', async () => {
  assert.deepEqual((await sched(ALPHA)).targets.map((t) => t.account), ['x:alphacat', 'tiktok:alpha.cat']);
  assert.deepEqual((await sched(BETA)).targets.map((t) => t.account), ['x:betacatfun', 'tiktok:beta_cat_fun'], 'Instagram is disconnected in Buffer');
  assert.equal((await sched(ALPHA)).firstDone, false, 'the first run defaults to a draft');
});

test('schedule: captions are written with NO tools, one for X and one for TikTok', async () => {
  const r = await owner('schedule/captions', { id: ALPHA, note: 'mention the cheese' });
  assert.equal(r.json.state, 'captioning', 'the modal shows Writing at once');
  const v = await waitState(ALPHA, ['captioned']);
  assert.deepEqual(v.captions, { x: 'Big night at the diner.', tiktok: '9 out of 10 burger', instagram: '9 out of 10 burger' });
  const job = jobs('caption').pop();
  assert.ok(job.args.includes('--tools=') && job.args.includes('--strict-mcp-config') && !job.args.includes('--chrome'));
  assert.match(job.prompt, /Someone's voice: deadpan/);
  assert.match(job.prompt, /cheese is a risk/, 'the saved X quote as a starting point');
  assert.match(job.prompt, /mention the cheese/);
  assert.equal(jobs('schedule').length, 0, 'writing captions never posts');
});

test('schedule: the owner\'s choices are checked (an account, a caption each, X under 280)', async () => {
  assert.equal((await owner('schedule/start', { id: ALPHA, accounts: [], captions: { x: 'a', tiktok: 'b' } })).status, 400);
  assert.equal((await owner('schedule/start', { id: ALPHA, accounts: ['x:alphacat'], captions: { x: '' } })).status, 400);
  assert.equal((await owner('schedule/start', { id: ALPHA, accounts: ['x:alphacat'], captions: { x: 'x'.repeat(281) } })).status, 400);
  assert.equal((await owner('schedule/start', { id: ALPHA, accounts: ['instagram:beta_cat_fun'], captions: { instagram: 'a' } })).status, 400, 'not one of this video\'s accounts');
  assert.equal(jobs('schedule').length, 0);
});

test('schedule: Save as draft fills Buffer\'s composer for exactly the chosen accounts, checks each in Buffer, records nothing', async () => {
  const r = await owner('schedule/start', { id: DRAFTY, mode: 'draft', accounts: ['x:alphacat', 'tiktok:alpha.cat'], captions: { x: 'gym day.', tiktok: '9 out of 10 gym' } });
  assert.equal(r.status, 200);
  assert.ok(['preparing', 'working'].includes(r.json.state), 'the modal shows progress at once');
  const v = await waitState(DRAFTY, ['drafted']);
  assert.deepEqual(v.posts.map((p) => [p.account, p.step, p.postId]), [['x:alphacat', 'done', 'bp-cx'], ['tiktok:alpha.cat', 'done', 'bp-ct']]);
  assert.equal(v.firstDone, true);
  const job = jobs('schedule').pop();
  assert.ok(job.args.includes('--chrome') && job.args.includes('--settings') && job.args.includes('--allowedTools=mcp__claude-in-chrome__*'));
  assert.match(job.prompt, /Click "Save Draft"/);
  assert.match(job.prompt, /NEVER schedule or publish/);
  assert.doesNotMatch(job.prompt, /Add to Queue/);
  assert.match(job.prompt, /channels\/cx\/schedule[\s\S]*"gym day\."[\s\S]*channels\/ct\/schedule[\s\S]*"9 out of 10 gym"/);
  assert.match(job.prompt, /vstudio-buffer-upload\/[0-9a-f]{12}\.mp4/, 'a copy outside ~/Desktop for Chrome to upload');
  assert.equal(labels()[DRAFTY].posts, undefined, 'a draft is not a post');
});

test('schedule: Add to queue makes a real schedule and records it under "Where it\'s posted"', async () => {
  await owner('schedule/start', { id: ALPHA, mode: 'schedule', accounts: ['x:alphacat'], captions: { x: 'Big night at the diner.', tiktok: 'unused' } });
  const v = await waitState(ALPHA, ['scheduled']);
  assert.deepEqual(v.posts.map((p) => p.account), ['x:alphacat'], 'only the chosen account');
  const job = jobs('schedule').pop();
  assert.match(job.prompt, /Add to Queue/);
  assert.match(job.prompt, /NEVER choose "Share Now", "Publish Now" or "Now"/);
  await s.waitFor(() => (labels()[ALPHA].posts || []).length === 1, 5000, 'recorded');
  assert.deepEqual(labels()[ALPHA].posts.map((p) => [p.account, p.status, p.caption, p.at]), [['x:alphacat', 'queued', 'Big night at the diner.', '2026-10-26T16:07:00.000Z']]);
  // Now it has a post, so it leaves "Not scheduled".
  assert.equal((await s.request('GET', '/api/buffer/state')).json.unscheduled.some((u) => u.id === ALPHA), false);
});

test('schedule: a failure before anything was saved is safe to retry; one after saving needs the owner to check Buffer', async () => {
  await owner('schedule/start', { id: BETA, mode: 'draft', accounts: ['x:betacatfun'], captions: { x: 'FAILSCHED one' } });
  const f = await waitState(BETA, ['failed']);
  assert.match(f.error, /error before saving/);
  await owner('schedule/start', { id: BETA, mode: 'draft', accounts: ['x:betacatfun'], captions: { x: 'HALFSCHED two' } });
  const u = await waitState(BETA, ['unclear']);
  assert.match(u.error, /may already be in Buffer/);
  assert.equal((await owner('schedule/start', { id: BETA, mode: 'draft', accounts: ['x:betacatfun'], captions: { x: 'three' } })).status, 409);
  assert.equal((await owner('schedule/start', { id: BETA, mode: 'draft', accounts: ['x:betacatfun'], captions: { x: 'three' }, confirmUnclear: true })).status, 200);
  await waitState(BETA, ['drafted']);
});

test('schedule: only the Buffer page with the running job\'s token can report progress', async () => {
  const p = (origin, token) => s.request('POST', '/api/buffer/schedule/progress', { body: { token, channelId: 'cx', step: 'saved' }, headers: { Origin: origin } });
  assert.equal((await p('https://publish.buffer.com', 'f'.repeat(32))).status, 403);
  assert.equal((await p('https://evil.example', 'f'.repeat(32))).status, 403);
});

test('buffer-chrome-guard schedule mode: composer clicks and typing on Buffer, only the prepared upload, no scripts that change Buffer', () => {
  const guard = path.join(__dirname, '..', '..', 'scripts', 'buffer-chrome-guard.py');
  const file = '/tmp/vstudio-buffer-upload/abc123abc123.mp4';
  const run = (tool, input) => spawnSync('python3', ['-I', guard], { input: JSON.stringify({ tool_name: tool, tool_input: input }), env: { ...process.env, BUFFER_JOB: 'schedule', BUFFER_UPLOAD_FILE: file } }).status;
  const c = (n) => 'mcp__claude-in-chrome__' + n;
  assert.equal(run(c('computer'), { action: 'left_click', coordinate: [1, 2] }), 0);
  assert.equal(run(c('form_input'), { value: 'caption' }), 0);
  assert.equal(run(c('file_upload'), { paths: [file], ref: 'r1' }), 0);
  assert.equal(run(c('file_upload'), { paths: ['/Users/me/Desktop/secret.mov'], ref: 'r1' }), 2, 'any other file');
  assert.equal(run(c('file_upload'), { paths: [file + '/../../etc/passwd'], ref: 'r1' }), 2);
  assert.equal(run(c('navigate'), { url: 'https://evil.example/' }), 2);
  assert.equal(run(c('javascript_tool'), { text: '__vsReport("uploaded")' }), 0);
  assert.equal(run(c('javascript_tool'), { text: 'fetch(graph, { body: "mutation { deletePost(id: 1) }" })' }), 2);
  assert.equal(run('Bash', { command: 'ls' }), 2);
});
