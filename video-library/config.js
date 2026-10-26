// studio.config.json at the repo root (setup.sh writes it from studio.config.example.json; gitignored).
// Read once when the server starts: restart it after editing the file.
const fs = require('fs');
const path = require('path');

const ROOT = process.env.STUDIO_ROOT || path.resolve(__dirname, '..');
const CONFIG = (() => {
  try { const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'studio.config.json'), 'utf8')); return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; }
  catch { return {}; }
})();
const ACCOUNT = /^[a-z]+:[A-Za-z0-9._-]{1,40}$/;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A brand = one character's social presence: the library folder its videos are in (`subject`, the folder id), the
// accounts it posts on, the part of a Buffer handle that marks a channel as its own, and the voice Claude writes in.
const BRANDS = (Array.isArray(CONFIG.brands) ? CONFIG.brands : [])
  .filter((b) => b && typeof b.subject === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(b.subject))
  .map((b) => {
    const voice = b.voice && typeof b.voice === 'object' ? b.voice : {};
    const say = (k) => (typeof voice[k] === 'string' && voice[k].trim() ? voice[k].trim().slice(0, 1500) : '');
    return {
      key: b.subject,
      name: String(b.name || b.subject).slice(0, 60),
      handle: new RegExp(escapeRe(b.handle || b.subject), 'i'),
      accounts: (Array.isArray(b.accounts) ? b.accounts : []).filter((a) => ACCOUNT.test(String(a))),
      voice: { x: say('x'), tiktok: say('tiktok'), reply: say('reply') },
    };
  });

// Character swap skills: .claude/skills/<name>/SKILL.md with `character:` (and `folder:`) in its frontmatter.
const SKILLS_DIR = path.join(ROOT, '.claude', 'skills');
const SLUG = /^[a-z][a-z0-9-]{0,30}$/;
const RESERVED = new Set(['generations', 'content', 'songs']);
const expandPath = (p) => path.resolve(ROOT, String(p).replace(/^~(?=\/|$)/, require('os').homedir()));
function skillFrontmatter(name) {
  let text = ''; try { text = fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8'); } catch { return null; }
  const fm = (text.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
  return (k) => ((fm.match(new RegExp('^' + k + ':\\s*(.+)$', 'm')) || [])[1] || '').trim();
}
// Videos are sorted by subject into these folders, each with its own originals/: Other/ always, the config's
// `subjects` ({ id: "Folder" }), and the `folder:` of each character skill (id = the skill's name).
function subjects() {
  const out = { other: 'Other' };
  const add = (id, dir) => { if (SLUG.test(id) && !RESERVED.has(id) && typeof dir === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,40}$/.test(dir)) out[id] = dir; };
  for (const [id, dir] of Object.entries(CONFIG.subjects || {})) add(id, dir);
  let names = []; try { names = fs.readdirSync(SKILLS_DIR); } catch {}
  for (const n of names) { const f = SLUG.test(n) && skillFrontmatter(n); if (f && f('character') && f('folder')) add(n, f('folder')); }
  return out;
}
// Every library folder by id: the subjects, the top level ("generations", listed as Unsorted), the optional posted
// folder ("content") and the songs.
function folders(subj = subjects()) {
  return {
    ...Object.fromEntries(Object.entries(subj).map(([k, dir]) => [k, path.join(ROOT, dir)])),
    generations: ROOT,
    ...(CONFIG.postedDir ? { content: expandPath(CONFIG.postedDir) } : {}),
    songs: CONFIG.songsDir ? expandPath(CONFIG.songsDir) : path.join(ROOT, 'songs'),
  };
}

module.exports = { ROOT, CONFIG, BRANDS, SKILLS_DIR, SLUG, expandPath, skillFrontmatter, subjects, folders };
