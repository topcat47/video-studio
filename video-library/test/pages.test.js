// Static checks on the two pages: their scripts compile, every POST the pages make goes to a route the
// server has, and nothing the server sends is put into the page without escaping in the obvious spots.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { APP } = require('./harness');

const page = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
// The server's routes, including the Buffer section's (buffer.js, buffer-comments.js handle /api/buffer/*).
const server = ['server.js', 'buffer.js', 'buffer-comments.js'].map((f) => fs.readFileSync(path.join(APP, f), 'utf8')).join('\n');

for (const f of ['index.html', 'studio.html']) {
  test(`${f}: scripts compile`, () => {
    const list = scripts(page(f));
    assert.ok(list.length > 0);
    for (const src of list) assert.doesNotThrow(() => new vm.Script(src, { filename: f }));
  });

  test(`${f}: every API route it calls exists on the server`, () => {
    const routes = new Set([...page(f).matchAll(/['"`](\/api\/[a-z/-]+)/g)].map((m) => m[1]));
    assert.ok(routes.size > 0);
    for (const r of routes) assert.ok(server.includes(`'${r}'`) || server.includes(`'${r.replace(/\/$/, '')}`), `${f} calls ${r}, which server.js doesn't handle`);
  });
}

test('studio.html carries the token placeholder the server fills in', () => {
  assert.equal(page('studio.html').split('__STUDIO_TOKEN__').length, 2);
});

test('studio.html escapes everything it builds from server data', () => {
  const src = scripts(page('studio.html')).join('\n');
  // Fields that come from gates, runs and projects must go through esc() when put into HTML strings.
  for (const field of ['g.title', 'g.detail', 'g.project', 'r.title', 'p.title', 'p.slug', 'e.text', 'r.lastResult', 'r.lastText']) {
    const raw = new RegExp(`\\+ ${field.replace('.', '\\.')}(?![\\w.])`, 'g');
    assert.equal((src.match(raw) || []).length, 0, `${field} is concatenated into HTML without esc()`);
  }
});

test('index.html has no inline handlers built from data', () => {
  assert.doesNotMatch(page('index.html'), /on(click|error|load)=\$\{/);
});

// WCAG contrast of the page's own colour tokens (AA: 4.5:1 for text).
function lum(hex) {
  const c = hex.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const token = (css, name) => (css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`)) || [])[1];

test('library: secondary text colours meet AA contrast on the page backgrounds', () => {
  const css = page('index.html');
  for (const fg of ['text', 'muted', 'dim']) for (const bg of ['bg', 'side', 'panel']) {
    const r = ratio(token(css, fg), token(css, bg));
    assert.ok(r >= 4.5, `--${fg} on --${bg}: ${r.toFixed(2)}:1`);
  }
});

test('studio: text on the accent fills meets AA in light and dark mode', () => {
  const css = page('studio.html');
  const [light, dark] = [css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)')), css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))];
  for (const [name, part] of [['light', light], ['dark', dark]]) {
    const r = ratio(token(part, 'accent-ink'), token(part, 'accent'));
    assert.ok(r >= 4.5, `${name}: --accent-ink on --accent ${r.toFixed(2)}:1`);
  }
});

test('docs match the app: /run-videoapp starts without -k first; CLAUDE.md names the Archive toggle, read-only browser tab and protected paths', () => {
  const hub = path.join(APP, '..');
  const skill = fs.readFileSync(path.join(hub, '.claude', 'skills', 'run-videoapp', 'SKILL.md'), 'utf8');
  const claude = fs.readFileSync(path.join(hub, 'CLAUDE.md'), 'utf8');
  assert.ok(skill.indexOf('kickstart gui/') >= 0 && skill.indexOf('kickstart gui/') < skill.indexOf('kickstart -k'), 'plain kickstart comes before -k');
  assert.match(skill, /curl -s -m \d+/, 'the health check has a timeout');
  assert.match(skill, /open -a "Video Studio"/);
  assert.match(claude, /read-only in a browser/);
  assert.match(claude, /"Archive" toggle/);
  assert.match(claude, /Runs also can't change `video-library\/`, `scripts\/`, `\.claude\/`/);
  assert.match(claude, /\[credits\] \["<short detail>"\] \[image …\]/);
  assert.doesNotMatch(claude, /folder menu filters/);
});
