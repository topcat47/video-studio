// Studio routes: page + token, projects, gates (through the real studio-gate.sh), background runs with the
// stand-in claude (queue, gate → Approve/Notes → resume, paid flag, stop, failure, resume), spend ledger, guards.
// Run: node --test video-library/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const { startServer } = require('./harness');

let s;
test.before(async () => {
  s = await startServer({
    fixtures: ({ gen }) => {
      const p = path.join(gen, 'projects', 'cat-dj');
      fs.mkdirSync(path.join(p, 'renders', 'concept'), { recursive: true });
      fs.writeFileSync(path.join(p, 'shots.json'), JSON.stringify({ shots: [{ id: 's1', status: 'concept-ok' }, { id: 's2', status: 'planned' }] }));
      fs.writeFileSync(path.join(p, 'brief.md'), '# Brief\n- Concept: Cat DJ at a <rave>\n');
      fs.writeFileSync(path.join(p, 'log.md'), '| When | Shot | Job | Model | Credits | Approved by owner | Result |\n|---|---|---|---|---|---|---|\n| 2026-10-23 | s1 | job-1 | nano_banana_2_1 | 1.5 | yes | ok |\n');
      fs.writeFileSync(path.join(p, 'renders', 'concept', 's1.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
      fs.mkdirSync(path.join(gen, 'projects', 'Bad Name'));
      fs.writeFileSync(path.join(gen, 'projects', 'Bad Name', 'shots.json'), '{}');
      fs.mkdirSync(path.join(gen, 'projects', 'broken'));
      fs.writeFileSync(path.join(gen, 'projects', 'broken', 'shots.json'), '{oops');
    },
  });
});
test.after(async () => s && s.stop());

const state = async () => (await s.request('GET', '/api/studio/state')).json;
const run = async (id) => (await state()).runs.find((r) => r.id === id);
const waitStatus = (id, status, ms) => s.waitFor(async () => { const r = await run(id); return r && r.status === status && r; }, ms, `run ${id} → ${status}`);

test('studio page never contains the owner token (the Mac app supplies it) and is not cached', async () => {
  const r = await s.request('GET', '/studio');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.ok(!r.text.includes(s.token), 'anything on this Mac can fetch the page, so the token must not be in it');
  assert.ok(r.text.includes('content=""'));
  const mode = fs.statSync(path.join(s.lib, '.studio-token')).mode & 0o777;
  assert.equal(mode, 0o600, 'token file is private');
});

test('projects: summary, stage, credits, thumbnail; bad folders skipped', async () => {
  const st = await state();
  assert.equal(st.projects.length, 1);
  const p = st.projects[0];
  assert.equal(p.slug, 'cat-dj');
  assert.equal(p.title, 'Cat DJ at a <rave>');
  assert.equal(p.stage, 'Plan');
  assert.equal(p.shots, 2);
  assert.equal(p.credits, 1.5);
  assert.equal(p.thumb, path.join('renders', 'concept', 's1.png'));
  const t = await s.request('GET', `/api/studio/thumb?p=cat-dj&f=${encodeURIComponent(p.thumb)}`, { raw: true });
  assert.equal(t.status, 200);
  for (const q of ['p=cat-dj&f=../../video-library/.studio-token', 'p=..&f=x.png', 'p=cat-dj&f=brief.md']) {
    assert.equal((await s.request('GET', '/api/studio/thumb?' + q)).status, 404, q);
  }
});

test('write calls need the token and this origin', async () => {
  const body = JSON.stringify({ id: 'x:y', title: 't' });
  const cases = [
    [{}, 'no token'],
    [{ 'X-Studio-Token': 'f'.repeat(32) }, 'wrong token'],
    [{ 'X-Studio-Token': s.token.slice(0, 31) }, 'short token'],
    [{ 'X-Studio-Token': s.token, Origin: 'https://evil.example' }, 'foreign origin'],
  ];
  for (const [headers, what] of cases) {
    const r = await s.request('POST', '/api/studio/gate', { body, headers: { 'Content-Type': 'application/json', ...headers } });
    assert.equal(r.status, 403, what);
  }
  assert.equal((await s.studio('nope', {})).status, 404);
});

test('gates: studio-gate.sh opens (with notification) and clears; images limited to runs/ and projects/', async () => {
  const img = path.join(s.gen, 'projects', 'cat-dj', 'renders', 'concept', 's1.png');
  const out = execFileSync(path.join(s.gen, 'scripts', 'studio-gate.sh'),
    ['open', 'cat-dj:concepts', 'video', 'cat-dj', 'Approve the concept frames?', '', 'two frames', img, '/etc/hosts', 'video-library/.studio-token'],
    { env: { ...process.env, STUDIO_PORT: String(s.port) } }).toString();
  assert.match(out, /studio-gate: open cat-dj:concepts/);
  let g = (await state()).gates.find((x) => x.id === 'cat-dj:concepts');
  assert.ok(g);
  assert.equal(g.credits, null);
  assert.deepEqual(g.images, [img]);
  await s.waitFor(() => /display notification "Approve the concept frames\?" with title "Waiting for you · cat-dj"/.test(s.osascript()), 3000, 'notification');
  const f = await s.request('GET', '/api/studio/file?path=' + encodeURIComponent(img), { raw: true });
  assert.equal(f.status, 200);
  assert.equal((await s.request('GET', '/api/studio/file?path=' + encodeURIComponent(path.join(s.lib, '.studio-token')))).status, 404);
  assert.equal((await s.request('GET', '/api/studio/file?path=' + encodeURIComponent(s.gen + '/runs/../video-library/x.png'))).status, 404);
  // Re-opening the same id updates instead of duplicating.
  execFileSync(path.join(s.gen, 'scripts', 'studio-gate.sh'), ['open', 'cat-dj:concepts', 'video', 'cat-dj', 'Approve v2?'], { env: { ...process.env, STUDIO_PORT: String(s.port) } });
  const all = (await state()).gates.filter((x) => x.id === 'cat-dj:concepts');
  assert.equal(all.length, 1);
  assert.equal(all[0].title, 'Approve v2?');
  // A chat-session gate that no session is listening on: answering moves its conversation into the app,
  // which needs its transcript; with none to be found, the answer is refused.
  const ans = await s.studio('answer', { gateId: 'cat-dj:concepts', decision: 'approve' });
  assert.equal(ans.status, 404);
  assert.equal((await state()).gates[0].listening, false);
  execFileSync(path.join(s.gen, 'scripts', 'studio-gate.sh'), ['clear', 'cat-dj:concepts'], { env: { ...process.env, STUDIO_PORT: String(s.port) } });
  assert.equal((await state()).gates.length, 0);
});

test('gates: a video plays (Range) and a chat session\'s outside files are copied into runs/gate-media, never other files', async () => {
  const scratch = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gate-'));
  const vid = path.join(scratch, 'final.mp4'), secret = path.join(scratch, 'notes.txt');
  fs.writeFileSync(vid, Buffer.alloc(5000, 7)); fs.writeFileSync(secret, 'secret');
  execFileSync(path.join(s.gen, 'scripts', 'studio-gate.sh'), ['open', 'cat-dj:final', 'video', 'cat-dj', 'Approve the final?', '', '', vid, secret],
    { env: { ...process.env, STUDIO_PORT: String(s.port) } });
  const media = path.join(s.gen, 'runs', 'gate-media', 'cat-dj_final');
  const g = (await state()).gates.find((x) => x.id === 'cat-dj:final');
  assert.deepEqual(g.images, [path.join(media, '00-final.mp4')]);
  assert.deepEqual(fs.readdirSync(media), ['00-final.mp4']);   // the .txt was not copied
  const r = await s.request('GET', '/api/studio/file?path=' + encodeURIComponent(g.images[0]), { raw: true, headers: { Range: 'bytes=100-199' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], 'bytes 100-199/5000');
  assert.equal(r.headers['content-type'], 'video/mp4');
  execFileSync(path.join(s.gen, 'scripts', 'studio-gate.sh'), ['clear', 'cat-dj:final'], { env: { ...process.env, STUDIO_PORT: String(s.port) } });
  assert.equal(fs.existsSync(media), false);
  assert.equal(fs.existsSync(vid), true);   // the source stays
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('chat sessions: studio-gate.sh wait ends with the owner\'s Studio answer (approve, notes) or when the gate is cleared', async () => {
  const gate = (args) => execFileSync(path.join(s.gen, 'scripts', 'studio-gate.sh'), args, { env: { ...process.env, STUDIO_PORT: String(s.port) } }).toString();
  const wait = (id) => new Promise((resolve) => {
    const p = require('child_process').spawn(path.join(s.gen, 'scripts', 'studio-gate.sh'), ['wait', id], { env: { ...process.env, STUDIO_PORT: String(s.port) } });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', (code) => resolve({ code, out }));
  });
  gate(['open', 'chat:price', 'alpha', 'chat', 'Approve the swap?', '15']);
  const w1 = wait('chat:price');
  await s.waitFor(async () => (await state()).gates.find((g) => g.id === 'chat:price').listening, 8000, 'listening');
  // Only the Studio page itself may answer (a run token or a plain curl can't).
  assert.equal((await s.request('POST', '/api/studio/answer', { body: { gateId: 'chat:price', decision: 'approve' }, headers: { 'X-Studio-Token': s.token } })).status, 403);
  assert.equal((await s.studio('answer', { gateId: 'chat:price', decision: 'approve', text: 'go' })).status, 200);
  const r1 = await w1;
  assert.equal(r1.code, 0);
  assert.match(r1.out, /The owner APPROVED in the Studio: "Approve the swap\?" \(15 credits\)\. Their note: go/);
  assert.equal((await state()).gates.some((g) => g.id === 'chat:price'), false);
  gate(['open', 'chat:still', 'alpha', 'chat', 'Approve the still?']);
  const w2 = wait('chat:still');
  await s.waitFor(async () => (await state()).gates.find((g) => g.id === 'chat:still').listening, 8000, 'listening');
  assert.equal((await s.studio('answer', { gateId: 'chat:still', decision: 'notes', text: 'make it darker' })).status, 200);
  assert.match((await w2).out, /did NOT approve "Approve the still\?" yet\. Their notes from the Studio: make it darker/);
  gate(['open', 'chat:other', 'alpha', 'chat', 'Pick a clip']);
  const w3 = wait('chat:other');
  await new Promise((r) => setTimeout(r, 1000));
  gate(['clear', 'chat:other']);   // answered in the chat instead
  assert.match((await w3).out, /was cleared/);
});

test('studio-gate.sh never fails its caller when the Studio is down', () => {
  const r = spawnSync(path.join(s.gen, 'scripts', 'studio-gate.sh'), ['open', 'a:b', 'alpha', 'a', 'title'], { env: { ...process.env, STUDIO_PORT: '1' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout.toString(), /not reachable/);
  const bad = spawnSync(path.join(s.gen, 'scripts', 'studio-gate.sh'), ['open', 'only-one']);
  assert.equal(bad.status, 2);
});

test('start: validation; there is no Terminal mode (everything runs in the app)', async () => {
  assert.equal((await s.studio('start', { pipeline: 'rm', input: 'x' })).status, 400);
  assert.equal((await s.studio('start', { pipeline: 'alpha', input: '   ' })).status, 400);
  assert.equal((await s.studio('start', { pipeline: 'video', input: 'x'.repeat(1501) })).status, 400);
  const before = s.osascript();
  const t = await s.studio('start', { pipeline: 'alpha', input: 'https://x.com/a', mode: 'terminal' });
  assert.equal(t.status, 400);
  assert.equal(s.osascript().includes('tell application "Terminal"'), before.includes('tell application "Terminal"'), 'no Terminal window was opened');
  assert.equal((await s.studio('terminal', { run: 'x' })).status, 404, 'the Open in Terminal endpoint is gone');
});

test('background run: gate → Notes → new gate → Approve (paid) → finished', async () => {
  const st = await s.studio('start', { pipeline: 'alpha', input: 'GATE https://tiktok.com/x', mode: 'background' });
  assert.equal(st.status, 200, st.text);
  const id = st.json.run;
  const r1 = await waitStatus(id, 'waiting');
  assert.equal(r1.hasPending, false);
  const gate = (await state()).gates.find((g) => g.runId === id);
  assert.ok(gate, 'gate linked to the run');
  assert.equal(gate.credits, '1.5');
  assert.equal(gate.images.length, 1);
  let calls = s.claudeCalls().filter((c) => c.run === id);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('--session-id'));
  assert.equal(calls[0].paid, '0');
  assert.equal(calls[0].port, String(s.port));
  assert.ok(calls[0].args.includes('--settings'));
  assert.match(calls[0].prompt, /^\/alpha GATE/);

  assert.equal((await s.studio('answer', { gateId: gate.id, decision: 'notes', text: '' })).status, 400, 'notes need text');
  const n = await s.studio('answer', { gateId: gate.id, decision: 'notes', text: 'Make it tighter GATE' });
  assert.equal(n.status, 200, n.text);
  await waitStatus(id, 'waiting');
  calls = s.claudeCalls().filter((c) => c.run === id);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes('--resume'));
  assert.equal(calls[1].paid, '0', 'notes never unlock paid tools');
  assert.match(calls[1].prompt, /did NOT approve.*Make it tighter/);

  const again = await s.studio('answer', { gateId: gate.id, decision: 'approve' });
  assert.equal(again.status, 200, 'the run re-posted the same gate id, so it is open again');
  await waitStatus(id, 'finished');
  calls = s.claudeCalls().filter((c) => c.run === id);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].paid, '1', 'approving a priced gate unlocks paid tools for that turn');
  assert.match(calls[2].prompt, /APPROVED.*1\.5 credits/);
  assert.equal((await s.studio('answer', { gateId: gate.id, decision: 'approve' })).status, 404, 'answered gates cannot be answered twice');
  const log = await s.request('GET', '/api/studio/log?run=' + id);
  assert.equal(log.status, 200);
  assert.ok(log.json.events.some((e) => e.kind === 'you'));
  assert.ok(log.json.events.some((e) => e.kind === 'tool' && e.text.startsWith('higgsfield:balance')));
  assert.ok(log.json.events.some((e) => e.kind === 'result'));
  await s.waitFor(() => /Run finished/.test(s.osascript()), 3000, 'finished notification');
});

test('background runs: at most 2 at a time, the third queues; Stop works; queued runs can be stopped', async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await s.studio('start', { pipeline: 'video', input: 'SLOW idea ' + i, mode: 'background' })).json.run);
  await s.waitFor(async () => (await state()).runs.filter((r) => ids.includes(r.id) && r.status === 'running').length === 2, 8000, '2 running');
  await s.waitFor(async () => (await state()).runs.filter((r) => ids.includes(r.id) && r.toolCalls > 0).length === 2, 8000, 'both runs talking');
  const third = await run(ids[2]);
  assert.equal(third.status, 'queued');
  assert.equal((await s.studio('stop', { run: ids[2] })).status, 200);
  assert.equal((await run(ids[2])).status, 'stopped');
  await s.studio('stop', { run: ids[0] });
  await s.studio('stop', { run: ids[1] });
  // Stop shows at once; the process (and everything it started) is gone shortly after.
  assert.equal((await run(ids[0])).status, 'stopped');
  const early = await s.studio('resume', { run: ids[0] });
  assert.ok(early.status === 409 || early.status === 200, 'resume while the old process is exiting is refused or safe');
  if (early.status === 200) await waitStatus(ids[0], 'finished');   // it had exited already: resumed and finished
  await s.waitFor(async () => { const r = await run(ids[0]); return r.pid === null && r.status !== 'running' && r.status !== 'queued'; }, 8000, 'run 0 exited');
  await s.waitFor(async () => (await run(ids[1])).pid === null, 8000, 'run 1 exited');
  assert.equal((await run(ids[1])).status, 'stopped');
  // Two processes never share one session: no claude call for run 0 is still alive.
  // A stopped run can be resumed.
  assert.equal((await s.studio('resume', { run: ids[0], text: 'carry on' })).status, 200);
  await waitStatus(ids[0], 'finished');
  assert.match(s.claudeCalls().filter((c) => c.run === ids[0]).at(-1).prompt, /Continue where you left off\. The owner says: carry on/);
  assert.equal((await s.studio('resume', { run: 'nope' })).status, 404);
});

test('a failing run is marked failed and notifies; resume restarts it', async () => {
  const id = (await s.studio('start', { pipeline: 'beta', input: 'FAIL clip', mode: 'background' })).json.run;
  const r = await waitStatus(id, 'failed');
  assert.equal(r.isError, true);
  await s.waitFor(() => /Run failed/.test(s.osascript()), 3000, 'failed notification');
  assert.equal((await s.studio('resume', { run: id })).status, 200);
  await waitStatus(id, 'finished');
});

test('a missing claude binary fails the run instead of crashing the server', async () => {
  const bad = await startServer();
  try {
    await bad.restart({ STUDIO_CLAUDE_BIN: '/nonexistent/claude' });
    const r = await bad.studio('start', { pipeline: 'alpha', input: 'x', mode: 'background' });
    assert.equal(r.status, 200);
    const failed = await bad.waitFor(async () => {
      const rr = (await bad.request('GET', '/api/studio/state')).json.runs.find((x) => x.id === r.json.run);
      return rr && rr.status === 'failed' && rr;
    }, 8000, 'run failed');
    assert.match(failed.lastResult, /Could not start claude/);
    assert.equal(failed.started, false, 'no session was created, so a retry starts fresh (--session-id), not --resume');
    assert.ok(bad.alive(), bad.output());
  } finally {
    await bad.stop();
  }
});

test('after a restart: "running" runs come back as interrupted, queued ones start by themselves', async () => {
  const mk = (id, extra) => {
    fs.mkdirSync(path.join(s.gen, 'runs', id, 'work'), { recursive: true });
    fs.writeFileSync(path.join(s.gen, 'runs', id, 'run.json'), JSON.stringify({ id, createdAt: '2026-01-01', title: id, sessionId: crypto.randomUUID(), ...extra }));
  };
  mk('9999999999-aaaaaa', { status: 'running', pid: 1, started: true });
  mk('9999999999-bbbbbb', { status: 'queued', queuedAt: '2026-01-01', started: true, pending: { message: 'The owner APPROVED in the Studio: "x". Continue.', paid: true } });
  await s.restart();
  const r = await run('9999999999-aaaaaa');
  assert.equal(r.status, 'interrupted');
  assert.equal(r.pid, null);
  await waitStatus('9999999999-bbbbbb', 'finished');
  const call = s.claudeCalls().find((c) => c.run === '9999999999-bbbbbb');
  assert.equal(call.paid, '1');
  assert.ok(call.args.includes('--resume'));
});

test('spend ledger: spend.sh rows are totalled per project and today', async () => {
  const sh = path.join(s.gen, 'scripts', 'spend.sh');
  execFileSync(sh, ['cat-dj', 'video', 'job-1', 'nano_banana_2_1', '1.5']);
  execFileSync(sh, ['cat-dj', 'video', 'job-2', 'hf_mult_replace_object', '12', 'note, with comma']);
  execFileSync(sh, ['alphaclips', 'alpha', 'job-3', 'x', '30']);
  assert.equal(spawnSync(sh, ['p', 's', 'j', 'm', 'ten']).status, 2, 'credits must be numeric');
  const sp = (await state()).spend;
  assert.equal(sp.total, 43.5);
  assert.equal(sp.today, 43.5);
  assert.equal(sp.jobs, 3);
  assert.deepEqual(sp.byProject, { 'cat-dj': 13.5, alphaclips: 30 });
});

test('paid-guard hook: blocks paid Higgsfield calls unless priced or approved', () => {
  const guard = path.join(s.gen, 'scripts', 'studio-paid-guard.py');
  const call = (ev, paid) => spawnSync('python3', ['-I', guard], { input: JSON.stringify(ev), env: { ...process.env, STUDIO_PAID: paid ? '1' : '0' } });
  const HF = 'mcp__higgsfield-test__';
  assert.equal(call({ tool_name: HF + 'generate_video', tool_input: { model: 'x' } }).status, 2);
  assert.match(call({ tool_name: HF + 'generate_video', tool_input: {} }).stderr.toString(), /Blocked by the Studio/);
  assert.equal(call({ tool_name: HF + 'generate_video', tool_input: { get_cost: true } }).status, 0);
  assert.equal(call({ tool_name: HF + 'generate_image', tool_input: { params: '{"get_cost": true}' } }).status, 0);
  assert.equal(call({ tool_name: HF + 'generate_image', tool_input: { get_cost: 'true' } }).status, 2, 'only a real true counts');
  assert.equal(call({ tool_name: HF + 'generate_video', tool_input: {} }, true).status, 0);
  assert.equal(call({ tool_name: HF + 'balance', tool_input: {} }).status, 0);
  assert.equal(call({ tool_name: HF + 'media_upload', tool_input: {} }).status, 0);
  assert.equal(spawnSync('python3', ['-I', guard], { input: 'garbage' }).status, 2, 'unreadable input is blocked');
  assert.equal(call({ tool_name: HF + 'tiktok_prepare_publish', tool_input: {} }).status, 2, 'unknown or posting tools are blocked');
  assert.equal(call({ tool_name: HF + 'some_new_tool', tool_input: {} }).status, 2, 'a new tool name is not assumed free');
  assert.equal(call({ tool_name: HF + 'show_generations', tool_input: {} }).status, 0);
  assert.equal(call({ tool_name: HF + 'jobs_wait', tool_input: {} }).status, 0);
  assert.equal(call({ tool_name: HF + 'get_presets', tool_input: {} }).status, 0);
});

test('studio-cast images and missing files never crash the server', async () => {
  assert.equal((await s.request('GET', '/studio-cast/nobody')).status, 404);
  const r = await s.request('GET', '/studio-cast/beta-cat', { raw: true });   // file is absent in the test home
  assert.equal(r.status, 404);
  assert.ok(s.alive(), s.output());
  assert.equal((await s.request('GET', '/api/studio/log?run=nope')).status, 404);
  for (const body of ['{bad', 'null', '"str"', '[]']) await s.request('POST', '/api/studio/answer', { body, headers: { 'X-Studio-Token': s.token, 'Content-Type': 'application/json' } });
  assert.ok(s.alive(), s.output());
});

test('a run can post and clear its own gates but never answer, resume or stop as the owner', async () => {
  // Background runs have the token (studio-gate.sh reads it) but call with curl: no Origin header.
  const curl = (p, body) => s.request('POST', '/api/studio/' + p, { body, headers: { 'X-Studio-Token': s.token } });
  assert.equal((await curl('gate', { id: 'x:y', title: 'Approve?', credits: '99', runId: 'whatever' })).status, 200);
  assert.equal((await curl('answer', { gateId: 'x:y', decision: 'approve' })).status, 403, 'a run cannot approve a price');
  assert.equal((await curl('resume', { run: 'x' })).status, 403);
  assert.equal((await curl('stop', { run: 'x' })).status, 403);
  assert.equal((await curl('start', { pipeline: 'alpha', input: 'x' })).status, 403, 'a run cannot start more runs');
  assert.equal((await curl('gate/clear', { id: 'x:y' })).status, 200);
});

test('a second answer while the first is still queued is refused (the first is not lost)', async () => {
  // Fill both slots so the answered run has to queue.
  const slow = [];
  for (let i = 0; i < 2; i++) slow.push((await s.studio('start', { pipeline: 'video', input: 'SLOW hold ' + i, mode: 'background' })).json.run);
  const id = (await s.studio('start', { pipeline: 'alpha', input: 'GATE queued answer', mode: 'background' })).json.run;
  // It queues behind the slow ones; stop one slow run so it can reach its gate.
  await s.studio('stop', { run: slow[0] });
  await waitStatus(id, 'waiting');
  const g = (await state()).gates.find((x) => x.runId === id);
  await s.studio('start', { pipeline: 'video', input: 'SLOW hold again', mode: 'background' }).then((r) => slow.push(r.json.run));
  await s.waitFor(async () => (await state()).runs.filter((r) => r.status === 'running').length === 2, 8000, 'slots full');
  assert.equal((await s.studio('answer', { gateId: g.id, decision: 'approve' })).status, 200);
  assert.equal((await run(id)).status, 'queued');
  // The run re-posts nothing yet; a second gate answer for the run must not replace the queued one.
  await s.request('POST', '/api/studio/gate', { body: { id: 'other:gate', title: 'Other?', runId: id }, headers: { 'X-Studio-Token': s.token } });
  assert.equal((await s.studio('answer', { gateId: 'other:gate', decision: 'notes', text: 'redo' })).status, 409);
  await s.studio('gate/clear', { id: 'other:gate' });
  for (const r of slow) await s.studio('stop', { run: r });
  await waitStatus(id, 'finished', 10000);
  assert.equal(s.claudeCalls().filter((c) => c.run === id).at(-1).paid, '1', 'the queued approval was kept');
});

test('lookups keyed by user input ignore built-in names (constructor, __proto__)', async () => {
  for (const q of ['/video?id=constructor/a.mp4', '/thumb?id=toString/a.mp4', '/video?id=__proto__/a.mp4',
    '/find?s=constructor&id=1', '/api/finds?s=__proto__', '/studio-cast/constructor', '/studio-cast/__proto__']) {
    const r = await s.request('GET', q);
    assert.ok(r.status === 404, q + ' → ' + r.status);
  }
  assert.equal((await s.request('POST', '/api/finds/delete', { body: { s: 'constructor', id: 'x' } })).status, 404);
  assert.equal((await s.request('POST', '/api/post', { body: { id: 'x', account: 'constructor' } })).status, 404);
  assert.equal((await s.studio('start', { pipeline: 'constructor', input: 'x' })).status, 400);
  assert.ok(s.alive(), s.output());
});

test('folders and non-video files are never treated as videos (no trashing whole folders)', async () => {
  for (const id of ['generations/projects', 'generations/runs', 'generations/video-library', 'generations/CLAUDE.md', 'alpha/originals']) {
    assert.equal((await s.request('POST', '/api/trash', { body: { id } })).status, 404, id);
    assert.equal((await s.request('GET', '/video?id=' + encodeURIComponent(id))).status, 404, id);
    assert.equal((await s.request('POST', '/api/label', { body: { id, approved: true } })).status, 404, id);
  }
  assert.ok(fs.existsSync(path.join(s.gen, 'projects')));
  assert.doesNotMatch(s.osascript(), /Finder" to delete/);
});

test('spend "today" is the local day; malformed ledger rows are skipped', async () => {
  const csv = path.join(s.gen, 'spend.csv');
  const before = (await state()).spend;
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  fs.appendFileSync(csv, `${yesterday},old,alpha,j9,m,5,,\nnot,a,row\n,,,,,abc,,\n`);
  const after = (await state()).spend;
  assert.equal(after.total, before.total + 5);
  assert.equal(after.today, before.today, 'yesterday is not today');
  assert.equal(after.jobs, before.jobs + 1, 'only real rows count as jobs');
});

test('run log: only the tail is read and a cut-off first line is skipped', async () => {
  const id = (await s.studio('start', { pipeline: 'alpha', input: 'plain', mode: 'background' })).json.run;
  await waitStatus(id, 'finished');
  const log = path.join(s.gen, 'runs', id, 'log.jsonl');
  const filler = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(1000) }] } }) + '\n';
  fs.appendFileSync(log, filler.repeat(2500));   // ~2.6 MB
  const r = await s.request('GET', '/api/studio/log?run=' + id);
  assert.equal(r.status, 200);
  assert.equal(r.json.events.length, 150);
});

test('gate images: a symlink inside runs/ that points outside is refused', async () => {
  const dir = path.join(s.gen, 'runs', 'linktest', 'work'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(s.home, 'secret.png'), 'x');
  fs.symlinkSync(path.join(s.home, 'secret.png'), path.join(dir, 'evil.png'));
  assert.equal((await s.request('GET', '/api/studio/file?path=' + encodeURIComponent(path.join(dir, 'evil.png')))).status, 404);
});

test('parallel starts are all recorded in the session list', async () => {
  const file = path.join(s.lib, 'studio-sessions.json');
  const before = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).length : 0;
  const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => s.studio('start', { pipeline: 'alpha', input: 'https://x.com/p' + i, mode: 'background' })));
  assert.ok(rs.every((r) => r.status === 200));
  const after = JSON.parse(fs.readFileSync(path.join(s.lib, 'studio-sessions.json'), 'utf8'));
  assert.equal(after.length, before + 5);
  for (let i = 0; i < 5; i++) assert.ok(after.some((x) => x.input === 'https://x.com/p' + i), 'p' + i);
});

test('projects are re-read only when their files change', async () => {
  const p = path.join(s.gen, 'projects', 'cache-me');
  fs.mkdirSync(path.join(p, 'renders', 'concept'), { recursive: true });
  fs.writeFileSync(path.join(p, 'shots.json'), JSON.stringify({ shots: [{ id: 's1', status: 'planned' }] }));
  const first = await state();
  assert.equal(first.projects.find((x) => x.slug === 'cache-me').stage, 'Plan');
  const reads = (await state()).projectReads;
  for (let i = 0; i < 3; i++) await state();
  assert.equal((await state()).projectReads, reads, 'nothing changed: nothing re-read');
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(path.join(p, 'shots.json'), JSON.stringify({ shots: [{ id: 's1', status: 'approved' }] }));
  const st = await state();
  assert.equal(st.projects.find((x) => x.slug === 'cache-me').stage, 'Edit', 'a changed shots.json shows at once');
  assert.ok(st.projectReads > reads);
  fs.writeFileSync(path.join(p, 'renders', 'concept', 'new.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.equal((await state()).projects.find((x) => x.slug === 'cache-me').thumb, path.join('renders', 'concept', 'new.png'), 'a new frame shows at once');
  fs.rmSync(p, { recursive: true });
  assert.ok(!(await state()).projects.some((x) => x.slug === 'cache-me'), 'a deleted project disappears');
});

test('runs get their own token: it posts and clears only their own gates, and never answers', async () => {
  const id = (await s.studio('start', { pipeline: 'alpha', input: 'GATE token check', mode: 'background' })).json.run;
  await waitStatus(id, 'waiting');
  const call = s.claudeCalls().filter((c) => c.run === id)[0];
  assert.match(call.runToken, /^[0-9a-f]{32}$/);
  assert.equal(call.ownerTokenInEnv, false, "the owner's token is not handed to runs");
  assert.ok(!JSON.stringify((await state()).runs).includes(call.runToken), 'run tokens are never shown by the API');
  const asRun = (p, body, extra = {}) => s.request('POST', '/api/studio/' + p, { body, headers: { 'X-Studio-Run-Token': call.runToken, ...extra } });
  // Posting a gate: always filed under its own run, whatever runId it claims.
  assert.equal((await asRun('gate', { id: 'mine:1', title: 'x', runId: 'someone-else' })).status, 200);
  assert.equal((await state()).gates.find((g) => g.id === 'mine:1').runId, id);
  // Owner actions are refused, even with a faked browser Origin.
  for (const p of ['answer', 'resume', 'stop', 'start', 'message']) {
    assert.equal((await asRun(p, { gateId: 'mine:1', decision: 'approve', run: id }, { Origin: s.base })).status, 403, p);
  }
  // It can't clear or take over a gate that isn't its own.
  await s.studio('gate', { id: 'owner:gate', title: 'owner' });
  await asRun('gate/clear', { id: 'owner:gate' });
  assert.ok((await state()).gates.some((g) => g.id === 'owner:gate'), 'still open');
  assert.equal((await asRun('gate', { id: 'owner:gate', title: 'hijack' })).status, 403);
  assert.equal((await s.request('POST', '/api/studio/gate', { body: { id: 'x', title: 'y' }, headers: { 'X-Studio-Run-Token': 'f'.repeat(32) } })).status, 403);
  await asRun('gate/clear', { id: 'mine:1' });
  await s.studio('gate/clear', { id: 'owner:gate' });
  const g = (await state()).gates.find((x) => x.runId === id);
  await s.studio('answer', { gateId: g.id, decision: 'approve' });
  await waitStatus(id, 'finished');
  // Run settings deny reading the owner's token file.
  const settings = JSON.parse(fs.readFileSync(path.join(s.lib, 'studio-run-settings.json'), 'utf8'));
  assert.ok(settings.permissions.deny.includes(`Read(/${path.join(s.lib, '.studio-token')})`));
  // Shell commands in runs are sandboxed: no token, no Anthropic (no second Claude), no way to switch it off.
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.sandbox.filesystem.denyRead, [path.join(s.lib, '.studio-token'), path.join(s.lib, '.buffer-key')]);
  assert.ok(settings.sandbox.network.deniedDomains.includes('*.anthropic.com') && settings.sandbox.network.deniedDomains.includes('claude.ai'));
  assert.ok(settings.sandbox.network.allowedDomains.includes('upload.higgsfield.ai'));
  assert.ok(!settings.sandbox.network.allowedDomains.some((d) => /anthropic|claude/.test(d)));
  // Runs can't change the app, the scripts, the skills or their own settings, by shell or by file tools.
  for (const p of [s.lib, path.join(s.gen, 'scripts'), path.join(s.gen, '.claude'), path.join(s.gen, '.mcp.json'), path.join(s.gen, 'CLAUDE.md')]) {
    assert.ok(settings.sandbox.filesystem.denyWrite.includes(p), 'sandbox denyWrite ' + p);
    assert.ok(settings.permissions.deny.includes(`Edit(/${path.extname(p) ? p : p + '/**'})`), 'Edit deny ' + p);
  }
  // Run tokens never reach disk.
  assert.ok(!fs.readFileSync(path.join(s.gen, 'runs', id, 'run.json'), 'utf8').includes(call.runToken));
});

test('paid guard fails closed: a crashing or missing guard blocks the call', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(s.lib, 'studio-run-settings.json'), 'utf8'));
  const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
  const guard = path.join(s.gen, 'scripts', 'studio-paid-guard.py');
  assert.ok(cmd.includes(guard));
  const ev = JSON.stringify({ tool_name: 'mcp__higgsfield-test__generate_video', tool_input: {} });
  const run = (c, paid) => spawnSync('/bin/sh', ['-c', c], { input: ev, env: { ...process.env, STUDIO_PAID: paid ? '1' : '0' } });
  assert.equal(run(cmd).status, 2, 'normal: blocked');
  assert.equal(run(cmd, true).status, 0, 'approved turn: allowed');
  const crash = path.join(s.home, 'crash.py'); fs.writeFileSync(crash, 'raise SystemExit(1)\n');
  const r1 = run(cmd.replace(guard, crash), true);
  assert.equal(r1.status, 2, 'a guard that exits 1 blocks, even on an approved turn');
  assert.match(r1.stderr.toString(), /paid guard failed/);
  const missing = cmd.replace(/'\/[^']*python3'/, "'/nonexistent/python3'");
  assert.notEqual(missing, cmd);
  assert.equal(run(missing, true).status, 2, 'no python: blocked');
  const boom = path.join(s.home, 'boom.py'); fs.writeFileSync(boom, fs.readFileSync(guard, 'utf8').replace('def main():', 'def main():\n    raise RuntimeError("bug")'));
  assert.equal(spawnSync('python3', ['-I', boom], { input: ev }).status, 2, 'an exception inside the guard blocks');
});

test('paid guard: a batch passes only if every job is a price check', () => {
  const guard = path.join(s.gen, 'scripts', 'studio-paid-guard.py');
  const call = (input) => spawnSync('python3', ['-I', guard], { input: JSON.stringify({ tool_name: 'mcp__x__generate_video_batch', tool_input: input }), env: { ...process.env, STUDIO_PAID: '0' } }).status;
  assert.equal(call({ jobs: [{ get_cost: true, model: 'a' }, { model: 'b' }] }), 2, 'one priced, one real: blocked');
  assert.equal(call({ jobs: [{ get_cost: true }, { get_cost: true }] }), 0);
  assert.equal(call({ get_cost: true, jobs: [{ model: 'a' }] }), 0, 'top-level price check');
  assert.equal(call({ jobs: [] }), 2);
  assert.equal(call({ params: '[{"get_cost": true}, {"model": "x"}]' }), 2);
  assert.equal(call({ model: 'x', extra: { get_cost: true } }), 2, 'a flag tucked next to real params is not a price check');
});

test('studio-gate.sh says so when the Studio refuses the gate', () => {
  const r = spawnSync(path.join(s.gen, 'scripts', 'studio-gate.sh'), ['open', 'a:b', 'alpha', 'a', 'title'], { env: { ...process.env, STUDIO_PORT: String(s.port), STUDIO_RUN_TOKEN: 'f'.repeat(32) } });
  assert.equal(r.status, 0);
  assert.match(r.stdout.toString(), /refused it \(HTTP 403\)/);
});

test('a run whose leftover child holds the output still finishes and frees its slot', async () => {
  const id = (await s.studio('start', { pipeline: 'video', input: 'ORPHAN', mode: 'background' })).json.run;
  const t0 = Date.now();
  await waitStatus(id, 'finished', 8000);
  assert.ok(Date.now() - t0 < 8000);
});

test('spend ledger: parallel first writes keep every row and one header', async () => {
  const csv = path.join(s.gen, 'spend.csv'); const keep = fs.existsSync(csv) ? fs.readFileSync(csv) : null;
  fs.rmSync(csv, { force: true });
  const { execFile } = require('child_process');
  await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((res, rej) =>
    execFile(path.join(s.gen, 'scripts', 'spend.sh'), ['p', 'alpha', 'job-' + i, 'm', '1'], (e) => (e ? rej(e) : res())))));
  const lines = fs.readFileSync(csv, 'utf8').trim().split('\n');
  assert.equal(lines.length, 13);
  assert.equal(lines.filter((l) => l.startsWith('when,')).length, 1);
  assert.equal(lines[0].startsWith('when,'), true);
  if (keep) fs.writeFileSync(csv, keep);
});

test('text split mid-character by the pipe arrives intact', async () => {
  const id = (await s.studio('start', { pipeline: 'alpha', input: 'EMOJI', mode: 'background' })).json.run;
  const r = await waitStatus(id, 'finished');
  assert.equal(r.lastText, 'Frame looks good 🐈‍⬛ ✓ é');
  assert.equal(r.lastResult, 'Done 🐈‍⬛');
});

test('Studio images are revalidated, not refetched; project cards get a small poster', async () => {
  const st = await state();
  const p = st.projects.find((x) => x.slug === 'cat-dj') || st.projects[0];
  if (p && p.thumb) {
    const t = await s.request('GET', `/api/studio/thumb?p=${p.slug}&f=${encodeURIComponent(p.thumb)}`, { raw: true });
    assert.equal(t.status, 200);
    assert.ok(t.headers.etag);
    const again = await s.request('GET', `/api/studio/thumb?p=${p.slug}&f=${encodeURIComponent(p.thumb)}`, { raw: true, headers: { 'If-None-Match': t.headers.etag } });
    assert.equal(again.status, 304);
  }
  const img = path.join(s.gen, 'runs', 'etagtest', 'work', 'board.png'); fs.mkdirSync(path.dirname(img), { recursive: true });
  require('child_process').execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:duration=0.1', '-frames:v', '1', img]);
  const f = await s.request('GET', '/api/studio/file?path=' + encodeURIComponent(img), { raw: true });
  assert.equal(f.status, 200); assert.equal(f.headers['cache-control'], 'no-cache');
  assert.equal((await s.request('GET', '/api/studio/file?path=' + encodeURIComponent(img), { raw: true, headers: { 'If-None-Match': f.headers.etag } })).status, 304);
  fs.utimesSync(img, new Date(), new Date(Date.now() + 5000));
  assert.equal((await s.request('GET', '/api/studio/file?path=' + encodeURIComponent(img), { raw: true, headers: { 'If-None-Match': f.headers.etag } })).status, 200, 'a changed file is sent again');
});

test('a run with an open gate is always listed, even beyond the 20 newest', async () => {
  const old = '0001010000-oldrun';
  fs.mkdirSync(path.join(s.gen, 'runs', old, 'work'), { recursive: true });
  fs.writeFileSync(path.join(s.gen, 'runs', old, 'run.json'), JSON.stringify({ id: old, status: 'waiting', createdAt: '2000-01-01T00:00:00Z', title: 'old', sessionId: crypto.randomUUID(), started: true }));
  for (let i = 0; i < 21; i++) {
    const id = `999999${String(i).padStart(4, '0')}-filler`;
    fs.mkdirSync(path.join(s.gen, 'runs', id), { recursive: true });
    fs.writeFileSync(path.join(s.gen, 'runs', id, 'run.json'), JSON.stringify({ id, status: 'finished', createdAt: new Date(Date.now() + i * 1000).toISOString(), title: 'f', sessionId: crypto.randomUUID() }));
  }
  await s.restart();
  await s.studio('gate', { id: 'old:gate', title: 'Old run gate', runId: old });
  const st = await state();
  assert.ok(st.runs.some((r) => r.id === old), 'the gate\'s run is in the list');
  await s.studio('gate/clear', { id: 'old:gate' });
  // The fillers are dated in the future; take them away so later tests' runs are the newest again.
  for (let i = 0; i < 21; i++) fs.rmSync(path.join(s.gen, 'runs', `999999${String(i).padStart(4, '0')}-filler`), { recursive: true, force: true });
  await s.restart();
});

test('steps: a chat session reports its step (history kept); a run\'s step falls back to the state.json in its work folder', async () => {
  const gate = (args) => spawnSync(path.join(s.gen, 'scripts', 'studio-gate.sh'), args, { env: { ...process.env, STUDIO_PORT: String(s.port) } }).stdout.toString();
  gate(['step', 'alpha-xyz', 'alpha', 'mapped']);
  gate(['step', 'alpha-xyz', 'alpha', 'planned', 'four shots']);
  let c = (await state()).chats.find((x) => x.project === 'alpha-xyz');
  assert.ok(c, 'listed as a chat session');
  assert.equal(c.step, 'planned');
  assert.equal(c.steps.length, 12);
  assert.deepEqual(c.history.map((h) => h.step), ['mapped', 'planned']);
  assert.match(gate(['step', 'alpha-xyz', 'nope', 'x']), /refused/);
  const id = (await s.studio('start', { pipeline: 'beta', input: 'plain steps', mode: 'background' })).json.run;   // any status will do
  fs.mkdirSync(path.join(s.gen, 'runs', id, 'work', 'beta-abc'), { recursive: true });
  fs.writeFileSync(path.join(s.gen, 'runs', id, 'work', 'beta-abc', 'state.json'), JSON.stringify({ stage: 'built' }));
  const r = await run(id);
  assert.equal(r.step, 'built');
  assert.equal(r.steps[r.steps.map((x) => x.key).indexOf('built')].label, 'Inputs built');
});

test('messages: the owner messages a finished run (it replies, never paid); a message to a waiting run withdraws its gate; while running it waits for the turn', async () => {
  const id = (await s.studio('start', { pipeline: 'alpha', input: 'plain chat', mode: 'background' })).json.run;
  await waitStatus(id, 'finished', 40000);   // earlier tests may still hold both slots with 30 s runs
  // Only the Studio page itself may message a run.
  assert.equal((await s.request('POST', '/api/studio/message', { body: { run: id, text: 'hi' }, headers: { 'X-Studio-Token': s.token } })).status, 403);
  assert.equal((await s.studio('message', { run: id, text: '' })).status, 400);
  assert.equal((await s.studio('message', { run: id, text: 'make the captions bigger' })).status, 200);
  await s.waitFor(async () => (await run(id)).turns === 2 && (await run(id)).status === 'finished', 8000, 'second turn');
  const call = s.claudeCalls().filter((x) => x.run === id).pop();
  assert.match(call.prompt, /message from the Studio: "make the captions bigger"/);
  assert.match(call.prompt, /not an approval/);
  assert.equal(call.paid, '0');
  const log = (await s.request('GET', '/api/studio/log?run=' + id)).json.events.filter((e) => e.kind === 'you').map((e) => e.text);
  assert.deepEqual(log.slice(-1), ['make the captions bigger'], 'the conversation shows what you wrote, not the wrapper');

  const g = (await s.studio('start', { pipeline: 'alpha', input: 'GATE https://x.com/a', mode: 'background' })).json.run;
  await waitStatus(g, 'waiting');
  assert.equal((await state()).gates.filter((x) => x.runId === g).length, 1);
  assert.equal((await s.studio('message', { run: g, text: 'why that clip?' })).status, 200);
  await s.waitFor(async () => (await state()).gates.every((x) => x.runId !== g), 8000, 'gate withdrawn');
  await waitStatus(g, 'finished');

  const slow = (await s.studio('start', { pipeline: 'alpha', input: 'SLOW one', mode: 'background' })).json.run;
  await waitStatus(slow, 'running');
  const m = await s.studio('message', { run: slow, text: 'after this' });
  assert.equal(m.json.status, 'after-turn');
  assert.deepEqual((await run(slow)).inbox, ['after this']);
  await s.studio('stop', { run: slow });
  await waitStatus(slow, 'stopped');
  assert.equal((await run(slow)).status, 'stopped', 'a stopped run does not pick up its message');
});

test('in progress: one entry per video (chat session + its gate + its steps; a run joins its video by its gate\'s project; /video projects from shots.json); filed videos drop off', async () => {
  const gate = (args, env = {}) => spawnSync(path.join(s.gen, 'scripts', 'studio-gate.sh'), args, { env: { ...process.env, STUDIO_PORT: String(s.port), ...env } }).stdout.toString();
  gate(['step', 'vid-a', 'alpha', 'test-run']);
  gate(['open', 'vid-a:test', 'alpha', 'vid-a', 'Approve the test?', '15']);
  let v = (await state()).videos.find((x) => x.key === 'vid-a');
  assert.ok(v, 'the video is listed');
  assert.equal(v.status, 'waiting');
  assert.equal(v.gates.length, 1);
  assert.deepEqual(v.sessions.map((x) => x.kind), ['chat']);
  assert.equal(v.step, 'test-run');
  assert.equal((await state()).videos[0].key, 'vid-a', 'waiting on you sorts first');
  const dj = (await state()).videos.find((x) => x.key === 'cat-dj');
  assert.ok(dj, 'a /video project is a video in progress');
  assert.equal(dj.pipeline, 'video');
  assert.equal(dj.steps.length, 9);
  // A background run that posts a gate for project vid-b is listed under vid-b, not on its own.
  const id = (await s.studio('start', { pipeline: 'alpha', input: 'GATE https://x.com/b', mode: 'background' })).json.run;
  await waitStatus(id, 'waiting', 40000);
  const g = (await state()).gates.find((x) => x.runId === id);
  const vb = (await state()).videos.find((x) => x.key === g.project);
  assert.ok(vb && vb.sessions.some((x) => x.id === id), 'the run sits under its video');
  assert.ok(!(await state()).videos.some((x) => x.key === 'run-' + id), 'and not as a card of its own');
  await s.studio('gate/clear', { id: g.id });
  assert.ok((await state()).videos.find((x) => x.key === g.project).sessions.some((x) => x.id === id), 'it stays under its video after the gate is answered');
  // Filed and nothing open: it leaves In progress (it is in the Library now).
  gate(['clear', 'vid-a:test']);
  gate(['step', 'vid-a', 'alpha', 'filed']);
  assert.ok(!(await state()).videos.some((x) => x.key === 'vid-a'), 'a filed video drops off');
});

test('steps without a report: a "blocked-…" stage is shown as stuck on its step; a chat session that never reported is guessed from its question', async () => {
  const gate = (args) => spawnSync(path.join(s.gen, 'scripts', 'studio-gate.sh'), args, { env: { ...process.env, STUDIO_PORT: String(s.port) } }).stdout.toString();
  gate(['step', 'zz-stuck-test', 'beta', 'blocked-download']);
  let c = (await state()).chats.find((x) => x.project === 'zz-stuck-test');
  assert.equal(c.step, 'mapped');
  assert.match(c.stepNote, /^Stuck: download/);
  gate(['open', 'zz-guess-test:test-result', 'alpha', 'zz-guess-test', 'Test result: approve the full run?']);
  c = (await state()).chats.find((x) => x.project === 'zz-guess-test');
  assert.ok(c.step, 'a step is guessed');
  assert.match(c.stepNote, /guessed from its question/);
  const v = (await state()).videos.find((x) => x.key === 'zz-guess-test');
  assert.equal(v.step, c.step, 'the video card carries it');
  gate(['clear', 'zz-guess-test:test-result']);
});

test('a chat session\'s frame is found by project name only: a path-shaped name finds nothing', async () => {
  for (const p of ['../../etc', '..', '/etc/hosts', 'a/b', '']) {
    assert.equal((await s.request('GET', '/api/studio/scratch-frame?project=' + encodeURIComponent(p))).status, 404, p);
  }
});

test('continue in the Studio: a chat session\'s conversation is resumed as a background run in its own folder; busy, unknown or already-moved sessions are refused', async () => {
  const gate = (args) => spawnSync(path.join(s.gen, 'scripts', 'studio-gate.sh'), args, { env: { ...process.env, STUDIO_PORT: String(s.port) } }).stdout.toString();
  gate(['step', 'zz-adopt', 'alpha', 'test-run']);
  gate(['open', 'zz-adopt:final', 'alpha', 'zz-adopt', 'Approve the final?']);
  const sid = crypto.randomUUID(), dir = path.join(s.home, '.claude', 'projects', '-fake-project');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sid + '.jsonl');
  fs.writeFileSync(file, [JSON.stringify({ type: 'assistant', cwd: s.gen, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'scripts/studio-gate.sh open zz-adopt:final alpha zz-adopt "Approve the final?"' } }] } }), ''].join('\n'));
  // Only the Studio page may move a conversation; a path-shaped name is refused.
  assert.equal((await s.request('POST', '/api/studio/adopt', { body: { project: 'zz-adopt' }, headers: { 'X-Studio-Token': s.token } })).status, 403);
  assert.equal((await s.studio('adopt', { project: '../x' })).status, 400);
  assert.equal((await s.studio('adopt', { project: 'zz-nobody' })).status, 404);
  // Its transcript changed just now: it is still working.
  assert.equal((await s.studio('adopt', { project: 'zz-adopt' })).status, 409);
  const old = new Date(Date.now() - 5 * 60e3); fs.utimesSync(file, old, old);
  const r = await s.studio('adopt', { project: 'zz-adopt' });
  assert.equal(r.status, 200);
  const id = r.json.run;
  await waitStatus(id, 'finished', 40000);
  const call = s.claudeCalls().filter((x) => x.run === id).pop();
  assert.ok(call.args.includes('--resume') && call.args.includes(sid), 'the same conversation is resumed');
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(s.gen), 'in its own folder');
  assert.match(call.prompt, /moved this conversation into the Video Studio/);
  assert.match(call.prompt, /You were waiting on: "Approve the final\?"/);
  assert.equal(call.paid, '0');
  const st = await state();
  assert.ok(!st.gates.some((g) => g.id === 'zz-adopt:final'), 'its chat-only gate is withdrawn');
  assert.ok(st.videos.find((v) => v.key === 'zz-adopt').sessions.some((x) => x.id === id), 'the run sits under the same video');
  assert.equal((await s.studio('adopt', { project: 'zz-adopt' })).status, 409, 'already moved');
});

test('characters: create (folder, card, roster row), edit the card, add photos (first one becomes the main photo, never overwritten), only from the Studio page', async () => {
  const chars = path.join(s.gen, 'characters');
  fs.mkdirSync(chars, { recursive: true });
  fs.writeFileSync(path.join(chars, 'README.md'), '# Characters\n\n## Roster\n\n| Character | Folder | Role | Swaps out | Skill | Library folder | Source photo |\n|---|---|---|---|---|---|---|\n| Bowtie cat | `bowtie-cat/` | bench | — | — | `Other/` | `IMG_1.JPG` |\n\n## Rules\n');
  // Only the Studio page may change characters (a token without the page's Origin is refused).
  assert.equal((await s.request('POST', '/api/studio/character/new', { body: { name: 'Pizza cat' }, headers: { 'X-Studio-Token': s.token } })).status, 403);
  const made = await s.studio('character/new', { name: 'Pizza cat', role: 'bench', look: 'Orange tabby, green eyes', accessory: 'a pizza-slice hat' });
  assert.equal(made.status, 200);
  assert.equal(made.json.slug, 'pizza-cat');
  assert.equal((await s.studio('character/new', { name: 'Pizza Cat' })).status, 409, 'no second folder with the same name');
  const md = fs.readFileSync(path.join(chars, 'pizza-cat', 'character.md'), 'utf8');
  assert.match(md, /^# Pizza cat/);
  assert.match(md, /\*\*Role:\*\* bench/);
  assert.match(md, /Orange tabby, green eyes/);
  assert.match(fs.readFileSync(path.join(chars, 'README.md'), 'utf8'), /\| Pizza cat \| `pizza-cat\/` \| bench \|[^\n]*\n\n## Rules/, 'a roster row at the end of the table');
  let list = (await s.request('GET', '/api/studio/characters')).json.characters;
  assert.ok(list.some((c) => c.slug === 'pizza-cat' && c.role === 'bench' && !c.photo));
  // Photos: raw upload; the first becomes the main photo; a second with the same name gets -2.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a70000000049454e44ae426082', 'hex');
  const up = (name) => s.request('POST', '/api/studio/character/photo?slug=pizza-cat&name=' + encodeURIComponent(name), { body: png.toString('latin1'), headers: { 'X-Studio-Token': s.token, Origin: s.base, 'Content-Type': 'image/png' } });
  assert.equal((await up('photo.png')).json.file, 'photo.png');
  assert.equal((await up('photo.png')).json.file, 'photo-2.png');
  assert.equal((await up('notes.txt')).status, 400);
  let c = (await s.request('GET', '/api/studio/character?slug=pizza-cat')).json;
  assert.equal(c.source, 'photo.png');
  assert.deepEqual(c.images, ['photo.png', 'photo-2.png']);
  assert.match(fs.readFileSync(path.join(chars, 'README.md'), 'utf8'), /\| Pizza cat \| `pizza-cat\/` \| bench \|.*\| `photo\.png` \|/);
  assert.equal((await s.studio('character/source', { slug: 'pizza-cat', file: 'photo-2.png' })).status, 200);
  assert.equal((await s.request('GET', '/api/studio/character?slug=pizza-cat')).json.source, 'photo-2.png');
  // Edit the card.
  assert.equal((await s.studio('character/save', { slug: 'pizza-cat', md: '# Pizza cat\n\n**Role:** main\n' })).status, 200);
  assert.equal((await s.request('GET', '/api/studio/character?slug=pizza-cat')).json.role, 'main');
  assert.equal((await s.studio('character/save', { slug: 'pizza-cat', md: '   ' })).status, 400);
  // Only its own top-level photos are served; names cannot leave the folder.
  assert.equal((await s.request('GET', '/api/studio/character-file?slug=pizza-cat&f=photo.png&full=1', { raw: true })).status, 200);
  for (const [slug, f] of [['pizza-cat', '../README.md'], ['pizza-cat', 'character.md'], ['..', 'README.md'], ['../characters', 'x.png']]) {
    assert.equal((await s.request('GET', `/api/studio/character-file?slug=${encodeURIComponent(slug)}&f=${encodeURIComponent(f)}`)).status, 404, slug + '/' + f);
  }
  assert.equal((await s.studio('character/save', { slug: '../video-library', md: 'x' })).status, 404);
});

test('character skills: a SKILL.md with `character:` (made in a chat session) shows on its character and is a Studio start button that runs as /<name>; the page can no longer make or delete skills', async () => {
  const chars = path.join(s.gen, 'characters');
  fs.mkdirSync(chars, { recursive: true });
  if (!fs.existsSync(path.join(chars, 'README.md'))) fs.writeFileSync(path.join(chars, 'README.md'), '# Characters\n\n## Roster\n\n| Character | Folder | Role | Swaps out | Skill | Library folder | Source photo |\n|---|---|---|---|---|---|---|\n\n## Rules\n');
  assert.equal((await s.studio('character/new', { name: 'Taco cat', look: 'Black cat with a taco shell hat' })).status, 200);
  fs.mkdirSync(path.join(s.gen, '.claude', 'skills', 'taco'), { recursive: true });
  fs.writeFileSync(path.join(s.gen, '.claude', 'skills', 'taco', 'SKILL.md'), '---\nname: taco\ndescription: Turn Elon Musk into Taco cat\ncharacter: taco-cat\nswaps: Elon Musk\n---\n# /taco\n');
  const c = (await s.request('GET', '/api/studio/character?slug=taco-cat')).json;
  assert.equal(c.skill.name, 'taco');
  assert.equal(c.skill.deletable, undefined, 'nothing to delete from the page');
  const st = await state();
  assert.ok(st.starts.some((x) => x.id === 'taco' && x.label === 'Taco cat' && x.target === 'Elon Musk'));
  const run = await s.studio('start', { pipeline: 'taco', input: 'https://x.com/someone/1', mode: 'background' });
  assert.equal(run.status, 200);
  await waitStatus(run.json.run, 'finished', 40000);
  assert.match(s.claudeCalls().filter((x) => x.run === run.json.run).pop().prompt, /^\/taco https:\/\/x\.com\/someone\/1/);
  assert.equal((await state()).runs.find((r) => r.id === run.json.run).steps.length, 12, 'a swap skill has the swap steps');
  // "Make it a skill" and "Delete skill" were removed from the Studio (2026-10-25).
  assert.equal((await s.studio('character/skill', { slug: 'taco-cat', name: 'taco2', target: 'x' })).status, 404);
  assert.equal((await s.studio('character/skill/delete', { name: 'taco' })).status, 404);
  assert.ok(fs.existsSync(path.join(s.gen, '.claude', 'skills', 'taco', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(s.gen, '.claude', 'skills', 'taco2')));
});

test('answering or messaging a chat session started outside the app moves it in, with the answer (an Approve on a priced question enables paid tools)', async () => {
  const gate = (args) => spawnSync(path.join(s.gen, 'scripts', 'studio-gate.sh'), args, { env: { ...process.env, STUDIO_PORT: String(s.port) } }).stdout.toString();
  const transcript = (project) => {
    const sid = crypto.randomUUID(), dir = path.join(s.home, '.claude', 'projects', '-fake-' + project);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, sid + '.jsonl');
    fs.writeFileSync(f, JSON.stringify({ type: 'assistant', cwd: s.gen, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `scripts/studio-gate.sh open ${project}:q alpha ${project} "x"` } }] } }) + '\n');
    const old = new Date(Date.now() - 5 * 60e3); fs.utimesSync(f, old, old);
    return sid;
  };
  gate(['open', 'zz-ans:q', 'alpha', 'zz-ans', 'Approve the full run?', '30']);
  const sid = transcript('zz-ans');
  const r = await s.studio('answer', { gateId: 'zz-ans:q', decision: 'approve', text: 'go ahead' });
  assert.equal(r.status, 200);
  assert.equal(r.json.moved, true);
  await waitStatus(r.json.run, 'finished', 40000);
  const call = s.claudeCalls().filter((x) => x.run === r.json.run).pop();
  assert.ok(call.args.includes(sid), 'the same conversation');
  assert.match(call.prompt, /moved this conversation into the Video Studio/);
  assert.match(call.prompt, /The owner APPROVED it in the Studio\. Their note: go ahead/);
  assert.equal(call.paid, '1', 'an Approve on a priced question is the approval');
  assert.ok(!(await state()).gates.some((g) => g.id === 'zz-ans:q'));
  // A message moves it in too (no approval: paid tools stay off).
  gate(['open', 'zz-msg:q', 'alpha', 'zz-msg', 'Pick a clip']);
  transcript('zz-msg');
  const m = await s.studio('message', { project: 'zz-msg', text: 'use the second one' });
  assert.equal(m.status, 200);
  await waitStatus(m.json.run, 'finished', 40000);
  const mc = s.claudeCalls().filter((x) => x.run === m.json.run).pop();
  assert.match(mc.prompt, /The owner sent a message from the Studio: "use the second one"/);
  assert.equal(mc.paid, '0');
});

test('step previews and takes: a step keeps the files it made (a chat session\'s are copied into runs/), a question\'s pictures land on the step it was asked at, /video steps show the project\'s own files; Redo from a step starts a new take, never paid', async () => {
  const gate = (args) => spawnSync(path.join(s.gen, 'scripts', 'studio-gate.sh'), args, { env: { ...process.env, STUDIO_PORT: String(s.port) } }).stdout.toString();
  const scratch = path.join(s.home, 'scratch-take'); fs.mkdirSync(scratch, { recursive: true });
  const png = (n) => { const f = path.join(scratch, n); fs.writeFileSync(f, Buffer.from('89504e470d0a1a0a', 'hex')); return f; };
  gate(['step', 'zz-take', 'alpha', 'mapped', 'four shots', png('sheet.png'), path.join(s.lib, '.studio-token')]);
  gate(['open', 'zz-take:plan', 'alpha', 'zz-take', 'Approve the plan?', '', 'plan', png('plan.png')]);
  gate(['step', 'zz-take', 'alpha', 'planned']);
  let v = (await state()).videos.find((x) => x.key === 'zz-take');
  assert.equal(v.take, 1);
  assert.deepEqual(v.history.map((h) => [h.step, h.take]), [['mapped', 1], ['planned', 1]]);
  const mapped = v.media['1'].mapped;
  assert.equal(mapped.length, 2, 'the step\'s own file and the picture of the question asked at that step');
  assert.ok(mapped.every((f) => f.startsWith(path.join(s.gen, 'runs') + path.sep)), 'copied where the Studio can show them');
  assert.ok(mapped.some((f) => f.includes(path.join('runs', 'step-media', 'zz-take'))));
  assert.ok(!JSON.stringify(v.media).includes('studio-token'), 'only pictures and videos are copied');
  assert.equal(v.media['1'].planned, undefined);
  assert.equal((await s.request('GET', '/api/studio/file?path=' + encodeURIComponent(mapped[0]), { raw: true })).status, 200);

  // Redo: owner-only, never the first step, only known steps.
  assert.equal((await s.request('POST', '/api/studio/redo', { body: { project: 'zz-take', step: 'planned' }, headers: { 'X-Studio-Token': s.token } })).status, 403);
  assert.equal((await s.studio('redo', { project: 'zz-take', step: 'mapped' })).status, 400);
  assert.equal((await s.studio('redo', { project: 'zz-take', step: 'nope' })).status, 400);
  assert.equal((await s.studio('redo', { project: '../x', step: 'planned' })).status, 400);
  // A chat session is moved into the app with the redo; a take is only recorded when that worked.
  assert.equal((await s.studio('redo', { project: 'cat-dj', step: 'Concepts' })).status, 404, 'no chat session to move');
  assert.equal((await state()).videos.find((x) => x.key === 'cat-dj').take, 1);
  const sid = crypto.randomUUID(), dir = path.join(s.home, '.claude', 'projects', '-fake-zz-take');
  fs.mkdirSync(dir, { recursive: true });
  const tf = path.join(dir, sid + '.jsonl');
  fs.writeFileSync(tf, JSON.stringify({ type: 'assistant', cwd: s.gen, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'scripts/studio-gate.sh open zz-take:plan alpha zz-take "x"' } }] } }) + '\n');
  const old = new Date(Date.now() - 5 * 60e3); fs.utimesSync(tf, old, old);
  const r = await s.studio('redo', { project: 'zz-take', step: 'planned', text: 'tighter crop' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.take, r.json.moved], [2, true]);
  await waitStatus(r.json.run, 'finished', 40000);
  const call = s.claudeCalls().filter((x) => x.run === r.json.run).pop();
  assert.ok(call.args.includes(sid), 'the same conversation');
  assert.match(call.prompt, /Redo from this step.*"Shot plan" as take 2/);
  assert.match(call.prompt, /tighter crop/);
  assert.match(call.prompt, /take-2\//);
  assert.match(call.prompt, /never delete, move or overwrite/);
  assert.equal(call.paid, '0', 'a redo is not an approval');
  v = (await state()).videos.find((x) => x.key === 'zz-take');
  assert.equal(v.take, 2);
  assert.deepEqual(v.takes.map((t) => [t.take, t.from, t.note]), [[2, 'planned', 'tighter crop']]);
  assert.equal(v.step, 'mapped', 'back at the last step it keeps');
  assert.ok(!(await state()).gates.some((g) => g.id === 'zz-take:plan'), 'its open question is withdrawn');
  gate(['step', 'zz-take', 'alpha', 'planned', 'new plan', png('plan2.png')]);
  v = (await state()).videos.find((x) => x.key === 'zz-take');
  assert.equal(v.history.pop().take, 2, 'steps after the redo belong to take 2');
  assert.equal(v.media['2'].planned.length, 1);
  assert.equal(v.media['1'].mapped.length, 2, 'take 1 keeps its files');

  // A background run: redo while it works is refused; at a question, the question is withdrawn and the run told.
  const slow = (await s.studio('start', { pipeline: 'alpha', input: 'SLOW redo', mode: 'background' })).json.run;
  await waitStatus(slow, 'running', 40000);
  assert.equal((await s.studio('redo', { project: 'zz-slow', run: slow, step: 'planned' })).status, 409);
  await s.studio('stop', { run: slow });
  await waitStatus(slow, 'stopped');
  const g = (await s.studio('start', { pipeline: 'alpha', input: 'GATE redo', mode: 'background' })).json.run;
  await waitStatus(g, 'waiting', 40000);
  const rr = await s.studio('redo', { project: 'proj', run: g, step: 'test-run' });
  assert.deepEqual([rr.status, rr.json.moved, rr.json.take], [200, false, 2]);
  await s.waitFor(async () => (await state()).gates.every((x) => x.runId !== g), 8000, 'gate withdrawn');
  await s.waitFor(async () => { const x = await run(g); return x.turns === 2 && x.status !== 'running' && x.status !== 'queued'; }, 40000, 'redo turn');
  const gc = s.claudeCalls().filter((x) => x.run === g).pop();
  assert.match(gc.prompt, /"Test swap" as take 2/);
  assert.equal(gc.paid, '0');
  assert.equal((await run(g)).step, 'test-approved');

  // /video: each step shows the project's own files from shots.json.
  const sj = path.join(s.gen, 'projects', 'cat-dj', 'shots.json'), before = fs.readFileSync(sj, 'utf8');
  fs.writeFileSync(sj, JSON.stringify({ shots: [{ id: 's1', status: 'concept-ok', concept: 'renders/concept/s1.png' }, { id: 's2', status: 'planned', concept: '../../video-library/.studio-token' }] }));
  v = (await state()).videos.find((x) => x.key === 'cat-dj');
  assert.deepEqual(v.media['1'].Concepts, [path.join(s.gen, 'projects', 'cat-dj', 'renders', 'concept', 's1.png')]);
  assert.equal(v.history.slice(-1)[0].step, 'Plan', 'its stage history is written down');
  fs.writeFileSync(sj, before);
});

test('skills page: lists the pipeline skills with their steps and helpers; only the Studio page saves one, from the version it read, keeping its header; the old version is kept in .skill-history', async () => {
  const dir = path.join(s.gen, '.claude', 'skills', 'alpha'), agents = path.join(s.gen, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'swap-mapper.md'), '---\nname: swap-mapper\n---\n');
  fs.writeFileSync(path.join(agents, 'editor.md'), '---\nname: editor\n---\n');
  const md = '---\nname: alpha\ndescription: Turn Alpha into the alpha cat.\ncharacter: alpha-cat\nfolder: Alpha\n---\n\n# /alpha: Alpha → alpha cat\n\nIntro.\n\n## 1. Map\n\nThe swap-mapper maps it.\n\n## 2. Plan\n\nPlan it.\n';
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
  const list = (await s.request('GET', '/api/studio/skills')).json.skills, alpha = list.find((k) => k.name === 'alpha');
  assert.ok(alpha && !('md' in alpha), 'the list leaves the text out');
  assert.equal(alpha.title, '/alpha: Alpha → alpha cat');
  assert.equal(alpha.steps.length, 12);
  assert.deepEqual(alpha.agents, ['swap-mapper'], 'only the helpers its text names');
  assert.equal(alpha.sections, 2);
  const k = (await s.request('GET', '/api/studio/skill?name=alpha')).json;
  assert.equal(k.md, md);
  assert.equal((await s.request('GET', '/api/studio/skill?name=run-videoapp')).status, 404, 'only skills the Studio starts');
  assert.equal((await s.request('GET', '/api/studio/skill?name=..')).status, 404);
  const edited = md.replace('Plan it.', 'Plan it carefully.');
  // Not from the page (a script with the token, or a run) → refused.
  assert.equal((await s.request('POST', '/api/studio/skill/save', { body: { name: 'alpha', md: edited, version: k.version }, headers: { 'X-Studio-Token': s.token } })).status, 403);
  assert.equal((await s.studio('skill/save', { name: 'alpha', md: 'no header', version: k.version })).status, 400);
  assert.equal((await s.studio('skill/save', { name: 'alpha', md: edited.replace('name: alpha', 'name: beta'), version: k.version })).status, 400);
  assert.equal((await s.studio('skill/save', { name: 'alpha', md: edited, version: 'stale' })).status, 409);
  const ok = await s.studio('skill/save', { name: 'alpha', md: edited, version: k.version });
  assert.equal(ok.status, 200);
  assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), edited);
  const hist = path.join(s.gen, '.skill-history', 'alpha');
  assert.deepEqual(fs.readdirSync(hist).map((f) => fs.readFileSync(path.join(hist, f), 'utf8')), [md]);
  assert.equal((await s.studio('skill/save', { name: 'alpha', md: edited + 'x', version: k.version })).status, 409, 'the old version can no longer save');
  assert.equal((await s.request('GET', '/api/studio/skill?name=alpha')).json.version, ok.json.version);
});

test('step conversations: every line a run prints is stamped with its time, every log event has one, and a message about a step reaches the run as written (its system prompt says what the tag means)', async () => {
  const id = (await s.studio('start', { pipeline: 'alpha', input: 'plain step chat', mode: 'background' })).json.run;
  await waitStatus(id, 'finished', 40000);
  const lines = fs.readFileSync(path.join(s.gen, 'runs', id, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.filter((l) => l.type === 'assistant' || l.type === 'result').every((l) => /^\d{4}-\d\d-\d\dT/.test(l._at)), 'stamped');
  assert.equal((await s.studio('message', { run: id, text: '[Step 2 · Shot plan] why 4 shots?' })).status, 200);
  await s.waitFor(async () => (await run(id)).turns === 2 && (await run(id)).status === 'finished', 8000, 'second turn');
  const call = s.claudeCalls().filter((x) => x.run === id).pop();
  assert.match(call.prompt, /"\[Step 2 · Shot plan\] why 4 shots\?"/);
  assert.match(call.args[call.args.indexOf('--append-system-prompt') + 1], /starts with \[Step N · <step name>\] is about that step/);
  const events = (await s.request('GET', '/api/studio/log?run=' + id)).json.events;
  assert.ok(events.length && events.every((e) => e.at), 'every event has a time');
  assert.equal(events.filter((e) => e.kind === 'you').pop().text, '[Step 2 · Shot plan] why 4 shots?');
});

test('options: a question can offer single-pick options (one recommended, each with its own price); Approve must name one, pays exactly that option\'s price, and the run, the waiting chat and the step history all get the pick', async () => {
  const id = (await s.studio('start', { pipeline: 'alpha', input: 'OPTIONS pick test', mode: 'background' })).json.run;
  await waitStatus(id, 'waiting', 40000);
  const gate = (await s.request('GET', '/api/studio/state')).json.gates.find((g) => g.id === 'proj:pick');
  assert.deepEqual(gate.options.map((o) => [o.id, o.label, o.recommended, o.credits]), [['A', 'Pet-sized', false, '12'], ['B', 'His size', true, null], ['C', 'Second star', false, '3']],
    'a repeated id is dropped and only the first star counts');
  assert.match(gate.options[0].image, /runs\/.*\/work\/still-a\.png$/);
  assert.equal(gate.options[1].image, null);
  assert.equal((await s.studio('answer', { gateId: 'proj:pick', decision: 'approve' })).status, 400, 'Approve has to name an option');
  assert.equal((await s.studio('answer', { gateId: 'proj:pick', decision: 'approve', choice: 'Z' })).status, 400);
  assert.equal((await s.studio('answer', { gateId: 'proj:pick', decision: 'approve', choice: 'A', text: 'tighter crop' })).status, 200);
  await s.waitFor(async () => (await run(id)).turns === 2 && (await run(id)).status !== 'queued' && (await run(id)).status !== 'running', 8000, 'second turn');
  const call = s.claudeCalls().filter((x) => x.run === id).pop();
  assert.match(call.prompt, /APPROVED in the Studio: "Pick the still" \(12 credits\)\. They picked option A \("Pet-sized"\)\. Their note: tighter crop/);
  assert.match(call.prompt, /with that option only/);
  assert.equal(call.paid, '1', 'option A has a price, so the turn may pay for it');
  const after = JSON.parse(fs.readFileSync(path.join(s.gen, 'video-library', 'studio-gates.json'), 'utf8')).filter((g) => g.id === 'proj:pick').pop();
  assert.equal(after.choice, 'A');

  // A chat window listening with `wait`: the answer names the option, and a free option enables nothing paid.
  const post = (body) => s.request('POST', '/api/studio/gate', { body, headers: { 'X-Studio-Token': s.token } });
  assert.equal((await post({ id: 'chatpick:still', pipeline: 'beta', project: 'chatpick', title: 'Which still?', credits: '9',
    options: [{ id: 'A', label: 'Calm' }, { id: 'B', label: 'Loud', recommended: true, credits: '0.5' }, { id: 'bad id', label: 'x' }] })).status, 200);
  await s.request('GET', '/api/studio/gate?id=chatpick:still');   // it is listening
  assert.equal((await s.studio('answer', { gateId: 'chatpick:still', decision: 'approve', choice: 'B' })).status, 200);
  const g2 = (await s.request('GET', '/api/studio/gate?id=chatpick:still')).json;
  assert.deepEqual([g2.answer, g2.choice, g2.choiceLabel, g2.credits], ['approved', 'B', 'Loud', '0.5'], 'the option\'s own price, not the question\'s');
  const out = require('child_process').spawnSync(path.join(s.gen, 'scripts', 'studio-gate.sh'), ['wait', 'chatpick:still'], { env: { ...process.env, STUDIO_PORT: String(s.port) }, encoding: 'utf8' }).stdout;
  assert.match(out, /APPROVED in the Studio: "Which still\?" \(0\.5 credits\)\. They picked option B \("Loud"\); go ahead with that option only\./);
  // Notes never need an option; a question without options approves as before.
  assert.equal((await post({ id: 'chatpick:notes', pipeline: 'beta', project: 'chatpick', title: 'Which?', options: [{ id: 'A', label: 'One' }] })).status, 200);
  await s.request('GET', '/api/studio/gate?id=chatpick:notes');
  assert.equal((await s.studio('answer', { gateId: 'chatpick:notes', decision: 'notes', text: 'neither, try a third' })).status, 200);
  assert.equal((await post({ id: 'chatpick:plain', pipeline: 'beta', project: 'chatpick', title: 'Plain?' })).status, 200);
  await s.request('GET', '/api/studio/gate?id=chatpick:plain');
  assert.equal((await s.studio('answer', { gateId: 'chatpick:plain', decision: 'approve' })).status, 200);
});

test('finished videos close their sessions (a run whose swap reached the 1080p finish is marked done, leaves the lists, refuses messages and resumes); cards get a readable title and a kind · source subtitle', async () => {
  const t = await startServer({ env: { STUDIO_SWEEP_MS: '300' } });
  try {
    const st = async () => (await t.request('GET', '/api/studio/state')).json;
    const start = async (input) => {
      const id = (await t.studio('start', { pipeline: 'alpha', input, mode: 'background' })).json.run;
      await t.waitFor(async () => (await st()).runs.find((r) => r.id === id).status === 'finished', 20000, 'finished');
      return id;
    };
    const done = await start('plain done video'), open = await start('plain open video');
    const work = (id, state) => { const d = path.join(t.gen, 'runs', id, 'work', 'alpha-x'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(state)); };
    work(open, { stage: 'built', source: { url: 'https://www.instagram.com/reels/AbC/', uploader_id: 'someone' }, screen: { notes: 'Topic: Halloween as a test for a wife (more). Other' } });
    const card = (await st()).videos.find((v) => v.key === 'run-' + open);
    assert.deepEqual([card.title, card.subtitle], ['Halloween as a test for a wife', 'Alpha Cat swap · @someone on Instagram']);
    work(done, { stage: 'hd' });
    await t.waitFor(async () => !(await st()).runs.some((r) => r.id === done), 8000, 'closed');
    const rec = JSON.parse(fs.readFileSync(path.join(t.gen, 'runs', done, 'run.json'), 'utf8'));
    assert.equal(rec.status, 'done'); assert.ok(rec.closed);
    assert.equal((await t.studio('message', { run: done, text: 'one more thing' })).status, 409);
    assert.equal((await t.studio('resume', { run: done })).status, 409);
    await new Promise((r) => setTimeout(r, 800));
    assert.ok((await st()).runs.some((r) => r.id === open && r.status === 'finished'), 'a video still in progress keeps its session');
  } finally { await t.stop(); }
});

test('a swap\'s page shows its original: the video its state.json names (inside its own folder, a video only) plays from /api/studio/original, with the post link', async () => {
  const { makeVideo } = require('./harness');
  const id = (await s.studio('start', { pipeline: 'beta', input: 'plain original test', mode: 'background' })).json.run;
  await waitStatus(id, 'finished', 40000);
  const dir = path.join(s.gen, 'runs', id, 'work', 'beta-orig'); fs.mkdirSync(path.join(dir, 'dl'), { recursive: true });
  makeVideo(path.join(dir, 'dl', 'src.mp4'));
  const write = (file) => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ stage: 'planned', source: { url: 'https://www.tiktok.com/@a/video/1', uploader_id: 'a', file } }));
  const video = async () => (await s.request('GET', '/api/studio/state')).json.videos.find((v) => v.key === 'run-' + id);
  write('dl/src.mp4');
  let v = await video();
  assert.deepEqual(v.original, { video: '/api/studio/original?key=' + encodeURIComponent('run-' + id), url: 'https://www.tiktok.com/@a/video/1', from: '@a on TikTok' });
  const r = await s.request('GET', v.original.video, { raw: true, headers: { Range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  for (const bad of ['../../../../video-library/.studio-token', 'state.json', 'dl/missing.mp4']) {
    write(bad);
    v = await video();
    assert.equal(v.original.video, null, bad);
    assert.equal((await s.request('GET', '/api/studio/original?key=' + encodeURIComponent('run-' + id))).status, 404, bad);
  }
  assert.equal((await s.request('GET', '/api/studio/original?key=constructor')).status, 404);
});

test('an old swap with no notes on disk finds its original by name only when exactly one file in that subject\'s originals/ has that handle', async () => {
  const { makeVideo } = require('./harness');
  const orig = path.join(s.gen, 'Alpha', 'originals');
  makeVideo(path.join(orig, 'OnlyOne - abc123.mp4'));
  makeVideo(path.join(orig, 'twice - 1.mp4')); makeVideo(path.join(orig, 'twice - 2.mp4'));
  const post = (project) => s.request('POST', '/api/studio/gate', { body: { id: project + ':q', pipeline: 'alpha', project, title: 'Approve?' }, headers: { 'X-Studio-Token': s.token } });
  await post('gta6-onlyone'); await post('gta6-twice');
  const vids = (await s.request('GET', '/api/studio/state')).json.videos;
  const one = vids.find((v) => v.key === 'gta6-onlyone'), two = vids.find((v) => v.key === 'gta6-twice');
  assert.equal(one.original.byName, true);
  assert.equal((await s.request('GET', one.original.video, { raw: true, headers: { Range: 'bytes=0-9' } })).status, 206);
  assert.equal(two.original, null, 'two files with that handle: no guess');
});
