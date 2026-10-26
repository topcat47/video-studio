#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json` in the Studio tests. It logs how it was called
// (args, STUDIO_* env, the prompt on stdin) and acts on a keyword in the prompt:
//   GATE  → posts a priced gate through the real scripts/studio-gate.sh, then ends the turn
//   FAIL  → reports an error result and exits 1
//   SLOW  → keeps working for 30 s (for Stop / queue tests)
//   anything else → finishes cleanly
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  if (process.env.BUFFER_JOB) return bufferJob(args);
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
    args, prompt, run: process.env.STUDIO_RUN_ID, paid: process.env.STUDIO_PAID, port: process.env.STUDIO_PORT, cwd: process.cwd(),
    runToken: process.env.STUDIO_RUN_TOKEN || null, ownerTokenInEnv: Object.values(process.env).some((v) => v === require('fs').readFileSync(require('path').join(process.cwd(), 'video-library', '.studio-token'), 'utf8').trim()),
  }) + '\n');
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  say({ type: 'system', subtype: 'init' });
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on: <b>' + prompt.slice(0, 60) + '</b>' },
    { type: 'tool_use', name: 'mcp__higgsfield-test__balance', input: {} }] } });
  if (/ORPHAN/.test(prompt)) {
    // Leaves a child holding the output pipe, then exits (like a backgrounded ffmpeg).
    require('child_process').spawn('sleep', ['20'], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();
    say({ type: 'result', result: 'left a child behind' });
    process.exit(0);
  }
  if (/EMOJI/.test(prompt)) {
    // Multi-byte characters split across two writes, as a pipe can deliver them.
    const line = Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Frame looks good 🐈‍⬛ ✓ é' }] } }) + '\n');
    const cut = line.indexOf(Buffer.from('🐈')) + 2;
    process.stdout.write(line.subarray(0, cut));
    return setTimeout(() => { process.stdout.write(line.subarray(cut)); say({ type: 'result', result: 'Done 🐈‍⬛' }); }, 200);
  }
  if (/SLOW/.test(prompt) && !/APPROVED|Continue/.test(prompt)) return setTimeout(() => { say({ type: 'result', result: 'slow done' }); }, 30000);
  if (/FAIL/.test(prompt) && !/Continue/.test(prompt)) { say({ type: 'result', result: 'it broke', is_error: true }); process.exit(1); }
  if (/OPTIONS/.test(prompt) && !/APPROVED/.test(prompt)) {
    // A single-pick question: A (12 cr, with a picture) or B (20 cr, recommended).
    const work = path.join(process.cwd(), 'runs', process.env.STUDIO_RUN_ID, 'work');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'still-a.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    execFileSync(path.join(process.cwd(), 'scripts', 'studio-gate.sh'),
      ['open', 'proj:pick', 'alpha', 'proj', 'Pick the still', '', 'A or B', '--option', 'A|Pet-sized|sits on the chair|' + path.join(work, 'still-a.png') + '|12',
        '--option', 'B*|His size|matches the source|', '--option', 'B|duplicate', '--option', 'C*|Second star|only one is recommended||3'], { stdio: 'ignore' });
    say({ type: 'result', result: 'Posted the options.' });
    return;
  }
  if (/GATE/.test(prompt) && !/APPROVED/.test(prompt)) {
    const work = path.join(process.cwd(), 'runs', process.env.STUDIO_RUN_ID, 'work');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'board.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    execFileSync(path.join(process.cwd(), 'scripts', 'studio-gate.sh'),
      ['open', 'proj:still', 'alpha', 'proj', 'Approve the still?', '1.5', 'one still', path.join(work, 'board.png')], { stdio: 'ignore' });
    say({ type: 'result', result: 'Posted the gate.' });
    return;
  }
  say({ type: 'result', result: 'All done.' });
});

// Buffer comment jobs (video-library/buffer-comments.js), told apart by BUFFER_JOB:
//   collect → posts FAKE_BUFFER_COMMENTS (a JSON file) to the app as the Buffer page would
//   draft   → answers <reply>…</reply> (or nothing when the comment says NODRAFT)
//   send    → reports success, or a Buffer error for FAILSEND, or no report at all for SILENT
function bufferJob(args) {
  const job = process.env.BUFFER_JOB;
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ bufferJob: job, args, prompt, commentId: process.env.BUFFER_COMMENT_ID }) + '\n');
  // FAKE_BUFFER_DELAY_MS slows every job down, to look at the page's progress states by hand.
  const done = (result, isError) => setTimeout(() => { process.stdout.write(JSON.stringify({ type: 'result', result, is_error: !!isError }) + '\n'); process.exit(isError ? 1 : 0); }, Number(process.env.FAKE_BUFFER_DELAY_MS || 0));
  const token = (prompt.match(/token: "([0-9a-f]{32})"/) || [])[1];
  const port = (prompt.match(/localhost:(\d+)\/api\/buffer\/comments/) || [])[1];
  const report = (pathname, body) => new Promise((resolve) => {
    const req = require('http').request({ host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'content-type': 'text/plain', Origin: 'https://publish.buffer.com', Host: `localhost:${port}` } },
    (res) => { let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => resolve(res.statusCode + ' ' + t)); });
    req.on('error', (e) => resolve('error ' + e.message));
    req.end(JSON.stringify(body));
  });
  if (job === 'draft') {
    const said = (prompt.match(/<comment>([\s\S]*?)<\/comment>/) || [])[1] || '';
    return /NODRAFT/.test(said) ? done('I cannot help with that.') : done('Here you go: <reply>9.1, solid</reply>');
  }
  if (job === 'collect') {
    const comments = JSON.parse(fs.readFileSync(process.env.FAKE_BUFFER_COMMENTS, 'utf8'));
    return report('/api/buffer/comments/import', { token, comments, errors: [] }).then((r) => done('RESULT: done ' + r + '\nBROWSER: fake-browser-1234'));
  }
  if (job === 'send') {
    if (/SILENT/.test(prompt)) return done('RESULT: pending (gave up)');
    const result = /FAILSEND/.test(prompt)
      ? { data: { replyToComment: { __typename: 'NotFoundError', message: 'The comment was deleted or is not available' } } }
      : { data: { replyToComment: { __typename: 'ReplyToCommentSuccess', comment: { id: 'r-' + process.env.BUFFER_COMMENT_ID } } } };
    return report('/api/buffer/comments/sent', { token, result }).then((r) => done('RESULT: done ' + r));
  }
  if (job === 'caption') return done('<x>Big night at the diner.</x>\n<tiktok>9 out of 10 burger</tiktok>');
  if (job === 'schedule') {
    // Each account's block: its channel id, then the exact caption (a JSON string on its own line).
    const blocks = prompt.split(/\nACCOUNT \d+: /).slice(1).map((b) => ({ channelId: (b.match(/channels\/([^/]+)\/schedule/) || [])[1], caption: JSON.parse((b.match(/nothing added or changed:\n(".*")\n/) || [])[1] || '""') }));
    const sport = (prompt.match(/localhost:(\d+)\/api\/buffer\/schedule\/progress/) || [])[1];
    const stoken = (prompt.match(/token: "([0-9a-f]{32})"/) || [])[1];
    const step = (channelId, s, extra) => new Promise((resolve) => {
      const req = require('http').request({ host: '127.0.0.1', port: sport, path: '/api/buffer/schedule/progress', method: 'POST',
        headers: { 'content-type': 'text/plain', Origin: 'https://publish.buffer.com', Host: `localhost:${sport}` } }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', resolve); req.end(JSON.stringify({ token: stoken, channelId, step: s, ...extra }));
    });
    return (async () => {
      for (const b of blocks) {
        await step(b.channelId, 'composer');
        if (/FAILSCHED/.test(b.caption)) return done('@x: Buffer showed an error before saving');
        for (const s of ['uploaded', 'captioned', 'saved']) await step(b.channelId, s);
        if (/HALFSCHED/.test(b.caption)) return done('@x: lost the tab after saving');
        await step(b.channelId, 'check', { found: [{ id: 'bp-' + b.channelId, text: b.caption, dueAt: '2026-10-26T16:07:00Z', status: 'scheduled' }] });
      }
      done(blocks.map((b) => '@' + b.channelId + ': done').join('\n'));
    })();
  }
  done('unknown job', true);
}
