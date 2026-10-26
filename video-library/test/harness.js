// Test harness: runs a copy of the real server.js against a throwaway home folder, on a spare port.
// Nothing touches the real library: HOME points at a temp dir with a copy of the repo layout (~/video-studio),
// `osascript` is a fake that only logs (no Terminal windows, notifications or Trash moves), and `claude`
// is a stand-in (test/fake-claude.js) whose behaviour each test picks with a word in its prompt.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const APP = path.resolve(__dirname, '..');            // video-library/
const HUB = path.resolve(APP, '..');                  // the repo root

// The studio.config.json each test server gets.
const TEST_CONFIG = (gen, lib) => ({
  agent: 'local.test.video-studio',
  higgsfieldMcp: 'mcp__higgsfield-test',
  accounts: { 'tiktok:alpha.cat': 'TikTok @alpha.cat', 'x:alphacat': 'X @alphacat', 'tiktok:beta_cat_fun': 'TikTok @beta_cat_fun',
    'x:betacatfun': 'X @betacatfun', 'instagram:beta_cat_fun': 'Instagram @beta_cat_fun', 'tiktok:old_account': 'TikTok @old_account (old)' },
  brands: [
    { subject: 'alpha', name: 'Alphacat', handle: 'alpha', accounts: ['tiktok:alpha.cat', 'x:alphacat'],
      voice: { x: "Someone's voice: deadpan: dry and sure of itself.", tiktok: 'one short lowercase line.', reply: 'Tiny and lowercase, often a rating like "8.7, certified good cat".' } },
    { subject: 'beta', name: 'Betacat', handle: 'beta', accounts: ['tiktok:beta_cat_fun', 'x:betacatfun', 'instagram:beta_cat_fun'] },
  ],
  finds: { alpha: { label: '🎙 Someone', list: 'alpha-finds.json', dir: path.join(lib, 'alpha-finds') },
    beta: { label: '🥊 Beta Person', list: 'beta-finds.json', dir: path.join(gen, 'Beta', 'originals') } },
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// A tiny real video (1 s, 64x64, with audio) for streaming, thumbnails and listing.
function makeVideo(file) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', file]);
}

async function startServer({ fixtures, env: extraEnv } = {}) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vstest-'));
  const gen = path.join(home, 'video-studio');
  const lib = path.join(gen, 'video-library');
  const bin = path.join(home, 'bin');
  for (const d of [lib, bin, path.join(gen, 'scripts'), path.join(gen, 'projects'), path.join(gen, 'Alpha', 'originals'),
    path.join(gen, 'Beta', 'originals'), path.join(gen, 'Other', 'originals'), path.join(gen, 'characters', 'alpha-cat'),
    path.join(gen, 'characters', 'beta-cat'), path.join(gen, 'songs'), path.join(gen, '.claude', 'skills', 'alpha'), path.join(gen, '.claude', 'skills', 'beta')]) fs.mkdirSync(d, { recursive: true });
  for (const f of ['server.js', 'config.js', 'buffer.js', 'buffer-comments.js', 'buffer-schedule.js', 'index.html', 'studio.html', 'buffer.html', 'link-original.js']) fs.copyFileSync(path.join(APP, f), path.join(lib, f));
  for (const f of ['studio-gate.sh', 'spend.sh', 'studio-paid-guard.py', 'buffer-chrome-guard.py']) {
    fs.copyFileSync(path.join(HUB, 'scripts', f), path.join(gen, 'scripts', f));
    fs.chmodSync(path.join(gen, 'scripts', f), 0o755);
  }
  fs.writeFileSync(path.join(lib, 'settings.json'), JSON.stringify({ newSince: 0 }));
  fs.writeFileSync(path.join(lib, 'labels.json'), '{}');
  // Two starring characters with their swap skills (folders Alpha/ and Beta/), their accounts and brands, and a
  // finds list each: the shape setup and /setup produce, with test names.
  fs.writeFileSync(path.join(gen, 'studio.config.json'), JSON.stringify(TEST_CONFIG(gen, lib), null, 2));
  for (const [skill, slug, who, folder] of [['alpha', 'alpha-cat', 'Someone', 'Alpha'], ['beta', 'beta-cat', 'Beta Person', 'Beta']]) {
    fs.writeFileSync(path.join(gen, '.claude', 'skills', skill, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: Turn ${who} into ${slug} in a video.\ncharacter: ${slug}\nswaps: ${who}\nfolder: ${folder}\n---\n\n# /${skill}: ${who} → ${slug}\n\n## 1. Map\nswap-mapper\n`);
    fs.writeFileSync(path.join(gen, 'characters', slug, 'character.md'), `# ${slug === 'alpha-cat' ? 'Alpha Cat' : 'Beta Cat'}\n\n**Role:** main\n`);
  }
  const osaLog = path.join(home, 'osascript.log');
  fs.writeFileSync(path.join(bin, 'osascript'), `#!/bin/sh\nprintf '%s\\n---\\n' "$*" >> '${osaLog}'\n`);
  fs.chmodSync(path.join(bin, 'osascript'), 0o755);
  fs.writeFileSync(path.join(bin, 'open'), '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(bin, 'open'), 0o755);
  if (fixtures) fixtures({ home, gen, lib });

  const port = await freePort();
  const env = { HOME: home, PATH: `${bin}:/opt/homebrew/bin:/usr/bin:/bin`, STUDIO_PORT: String(port),
    STUDIO_CLAUDE_BIN: path.join(__dirname, 'fake-claude.js'), FAKE_CLAUDE_LOG: path.join(home, 'claude-calls.jsonl'), ...extraEnv };
  const proc = spawn(process.execPath, [path.join(lib, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', (d) => (output += d));
  proc.stderr.on('data', (d) => (output += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start:\n' + output)), 8000);
    const check = () => (output.includes('running at') ? (clearTimeout(t), resolve()) : setTimeout(check, 50));
    proc.on('exit', (c) => reject(new Error(`server exited ${c}:\n${output}`)));
    check();
  });
  const token = fs.readFileSync(path.join(lib, '.studio-token'), 'utf8').trim();
  const base = `http://127.0.0.1:${port}`;

  const request = (method, p, { body, headers = {}, raw = false } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(base + p, { method, headers: { ...(data && { 'Content-Type': 'application/json' }), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks); let json = null;
        if (!raw) try { json = JSON.parse(buf.toString()); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json, text: buf.toString() });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  const studio = (p, body, extra = {}) => request('POST', '/api/studio/' + p,
    { body, headers: { 'X-Studio-Token': token, Origin: base, ...extra } });

  const h = {
    home, gen, lib, port, base, token, proc, request, studio, env,
    output: () => output,
    alive: () => h.proc.exitCode === null && h.proc.signalCode === null,
    // Restart the server on the same data (and port), like the LaunchAgent does after a crash or reboot.
    async restart(extraEnv = {}) {
      if (h.proc.exitCode === null) { h.proc.kill('SIGTERM'); await new Promise((r) => h.proc.once('exit', r)); }
      output = '';
      h.proc = spawn(process.execPath, [path.join(lib, 'server.js')], { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
      h.proc.stdout.on('data', (d) => (output += d));
      h.proc.stderr.on('data', (d) => (output += d));
      await h.waitFor(() => output.includes('running at'), 8000, 'restart');
    },
    osascript: () => (fs.existsSync(osaLog) ? fs.readFileSync(osaLog, 'utf8') : ''),
    claudeCalls: () => (fs.existsSync(env.FAKE_CLAUDE_LOG) ? fs.readFileSync(env.FAKE_CLAUDE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []),
    async waitFor(fn, ms = 8000, what = 'condition') {
      const end = Date.now() + ms;
      while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
      throw new Error('timed out waiting for ' + what + '\nserver output:\n' + output);
    },
    async stop() {
      if (h.proc.exitCode === null) { h.proc.kill('SIGTERM'); await new Promise((r) => h.proc.once('exit', r)); }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
  return h;
}

module.exports = { startServer, makeVideo, APP, HUB };
