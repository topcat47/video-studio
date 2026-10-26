// Video Studio: the video library and the Studio, a local server with no dependencies.
// Run by the LaunchAgent setup.sh installs (http://localhost:4420); never start a second copy by hand.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pipeline } = require('stream');

const PORT = Number(process.env.STUDIO_PORT) || 4420;
// The folder this repo was cloned into (the server lives in its video-library/).
// studio.config.json (config.js): subject folders, songs, social accounts and brands, finds lists, the Higgsfield MCP name.
const { ROOT: GENERATIONS, CONFIG, BRANDS } = require('./config');
const { expandPath, SLUG, SKILLS_DIR, skillFrontmatter } = require('./config');
// Videos are sorted by subject into these folders (config.js: Other/, the config's `subjects`, each character
// skill's `folder:`), each with its own originals/. Read at start: restart the server after adding a skill.
const SUBJECTS = require('./config').subjects();
const FOLDERS = require('./config').folders(SUBJECTS);
// Where originals (the source clips before conversion) can live.
const SOURCE_DIRS = [
  ...Object.keys(SUBJECTS).flatMap((k) => [path.join(FOLDERS[k], 'originals'), FOLDERS[k]]),
  path.join(FOLDERS.generations, 'originals'),
  FOLDERS.generations,
  ...(FOLDERS.content ? [FOLDERS.content] : []),
  ...(Array.isArray(CONFIG.sourceDirs) ? CONFIG.sourceDirs : ['~/Downloads']).map(expandPath),
];
const LABELS_FILE = path.join(__dirname, 'labels.json');
// The app only shows videos whose file was CREATED after settings.newSince (ms).
// Creation time survives renames and moves, so old videos stay hidden even if renamed.
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
function newSince() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).newSince || 0; } catch { return 0; }
}
const THUMBS_DIR = path.join(__dirname, '.thumbs');
// Speech-to-text transcripts (whisper.cpp), one .txt per video, made in the background.
const TRANSCRIPTS_DIR = path.join(__dirname, '.transcripts');
const WHISPER_MODEL = path.join(os.homedir(), '.cache', 'whisper-models', 'ggml-base.en.bin');
const FLAGGED_FILE = FOLDERS.content ? path.join(FOLDERS.content, 'WHY-FLAGGED.md') : null;
// Candidate-clip lists ("finds"): sources worth swapping, not generations. Each has its list, the folder
// holding the clips' local copies, and a file that keeps removed clips so they can be restored by hand.
// From the config's `finds`: { id: { label, list: "<id>-finds.json", dir: "<folder of the clips>" } }.
const FINDS = Object.fromEntries(Object.entries(CONFIG.finds || {}).filter(([id, f]) => SLUG.test(id) && f && /^[a-z0-9-]+\.json$/.test(String(f.list || id + '-finds.json')))
  .map(([id, f]) => { const list = String(f.list || id + '-finds.json');
    return [id, { label: String(f.label || id), list, dir: f.dir ? expandPath(f.dir) : path.join(__dirname, id + '-finds'), removed: list.replace(/\.json$/, '-removed.json') }]; }));
const FIRST_FINDS = Object.keys(FINDS)[0] || '';
const readFinds = (s) => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, FINDS[s].list), 'utf8')); } catch { return []; }
};
const own = (obj, key) => (typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg']);
// An original can also be a picture (a still swap made from a photo, a poster, a tweet screenshot).
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MIME = { '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
// posted is its own checkbox; status is your opinion of the video.
const STATUSES = ['ok', 'dislike', 'delete'];
// Social accounts a video can be queued or posted on ("Where it's posted" on each card).
// From the config's `accounts`: { "tiktok:<handle>": "TikTok @<handle>", "x:<handle>": "X @<handle>", … }.
const ACCOUNTS = Object.fromEntries(Object.entries(CONFIG.accounts || {}).filter(([k, v]) => /^[a-z]+:[A-Za-z0-9._-]{1,40}$/.test(k) && typeof v === 'string'));
const POST_STATES = ['queued', 'posted'];

function readLabels() {
  try { return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8')); } catch { return {}; }
}
// For read-modify-write: a missing file is {}, but an unreadable one throws, so a corrupt labels.json is
// left for repair instead of being overwritten with one card (that would wipe every description and link).
function readLabelsForWrite() {
  let text;
  try { text = fs.readFileSync(LABELS_FILE, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('labels.json is not an object');
  return data;
}
function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function writeLabels(labels) {
  atomicWrite(LABELS_FILE, JSON.stringify(labels, null, 2));
}

// Parse the "| Video | Reason |" table in WHY-FLAGGED.md into { basename: reason }.
function readFlagged() {
  const out = {};
  try {
    for (const line of fs.readFileSync(FLAGGED_FILE, 'utf8').split('\n')) {
      const m = line.match(/^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|$/);
      if (m && m[1] !== 'Video' && !/^-+$/.test(m[1])) out[m[1]] = m[2];
    }
  } catch {}
  return out;
}

// When a video was made. Names often carry the real date: TikTok downloads are
// "20261004-<id>" (post date) and Higgsfield outputs are "hf_20261009_…" (generation date).
// File times are only the download/move time, so prefer the name; fall back to mtime.
function madeAt(name, mtimeMs) {
  const m = name.match(/^(?:hf_)?(20\d{2})(\d{2})(\d{2})[-_]/);
  if (!m) return mtimeMs;
  const named = new Date(+m[1], +m[2] - 1, +m[3]);
  const mtime = new Date(mtimeMs);
  // Same calendar day: keep the precise file time for ordering within the day.
  if (named.toDateString() === mtime.toDateString()) return mtimeMs;
  return named.setHours(12);
}

function listVideos() {
  const labels = readLabels();
  const since = newSince();
  const flagged = readFlagged();
  // Which songs each video uses (from the songs' "Used in" lists), for search.
  const songsByVideo = {};
  for (const [key, l] of Object.entries(labels)) {
    if (!key.startsWith('songs/')) continue;
    for (const vid of l.usedIn || []) (songsByVideo[vid] ||= []).push(key.slice(6).replace(/\.[^.]+$/, ''));
  }
  const videos = [];
  for (const [folder, dir] of Object.entries(FOLDERS)) {
    if (folder === 'songs') continue;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!VIDEO_EXT.has(path.extname(name).toLowerCase())) continue;
      let stat; try { stat = fs.statSync(path.join(dir, name)); } catch { continue; }
      if (!stat.isFile()) continue;
      const id = `${folder}/${name}`;
      const label = labels[id] || {};
      videos.push({
        id, folder, name,
        size: stat.size,
        modified: stat.mtimeMs,
        made: madeAt(name, stat.mtimeMs),
        // Anything in the posted folder was already used; generations start unposted.
        // Older labels stored posted/unposted in status; read those as the checkbox.
        posted: typeof label.posted === 'boolean' ? label.posted
          : label.status === 'posted' ? true : label.status === 'unposted' ? false
          : folder === 'content',
        // Finished and signed off by the owner (the ✅ Approved section). Only set on the owner's say-so.
        approved: label.approved === true,
        approvedAt: label.approvedAt || null,
        status: STATUSES.includes(label.status) ? label.status : 'ok',
        note: label.note || '',
        description: label.description || '',
        // Ready-to-post X quote written from the video's audio (CLAUDE.md rule).
        xQuote: label.xQuote || '',
        // Where the source clip was found online (X post, YouTube…), to copy and share.
        sourceUrl: label.sourceUrl || '',
        // Where it's queued/posted: [{ account, status, at, caption, url }].
        posts: Array.isArray(label.posts) ? label.posts : [],
        transcript: transcriptFor(path.join(dir, name), stat),
        songs: songsByVideo[id] || [],
        flagged: flagged[path.basename(name, path.extname(name))] || null,
        original: label.original || null,
        // Archive/Unarchive in the app overrides the date rule for that one video.
        archived: typeof label.archived === 'boolean' ? label.archived : stat.birthtimeMs < since,
        originalExists: !!(label.original && allowedSource(label.original)),
        originalIsImage: !!(label.original && IMAGE_EXT.has(path.extname(label.original).toLowerCase())),
      });
    }
  }
  // New videos get transcribed first, then the archive.
  for (const v of [...videos].sort((a, b) => a.archived - b.archived)) {
    if (v.transcript === null) queueTranscript(path.join(FOLDERS[v.folder], v.name));
  }
  return videos.sort((a, b) => b.made - a.made || b.name.localeCompare(a.name));
}

// Transcripts are keyed by size + mtime, which survive renames and moves (no re-transcribing).
function transcriptPath(stat) {
  return path.join(TRANSCRIPTS_DIR, `${stat.size}-${Math.round(stat.mtimeMs)}.txt`);
}
// The transcript text, '' for a video with no speech, or null if it isn't made yet.
function transcriptFor(file, stat) {
  try { return fs.readFileSync(transcriptPath(stat), 'utf8'); } catch { return null; }
}

const transcriptQueue = [];
const queued = new Set();
let transcribing = null;
function queueTranscript(file) {
  if (!fs.existsSync(WHISPER_MODEL)) return;
  let key; try { const st = fs.statSync(file); key = `${file}|${st.size}|${st.mtimeMs}`; } catch { return; }
  if (queued.has(key)) return;
  queued.add(key);
  transcriptQueue.push(file);
  if (!transcribing) nextTranscript();
}

function nextTranscript() {
  const file = transcriptQueue.shift();
  if (!file) { transcribing = null; return; }
  transcribing = file;
  let stat;
  try { stat = fs.statSync(file); } catch { return nextTranscript(); }
  const out = transcriptPath(stat);
  const tmp = path.join(os.tmpdir(), `vl-${process.pid}-${Date.now()}`);
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const done = (text) => {
    for (const f of [tmp + '.wav', tmp + '.txt']) fs.rm(f, { force: true }, () => {});
    // null = the tools failed (missing ffmpeg/whisper-cli, a file still being written): write nothing, so
    // the video is tried again on a later listing instead of being stored as "no speech" for good.
    if (text !== null) {
      // Drop whisper's sound tags ([Music], (laughs), [BLANK_AUDIO]) and squash whitespace.
      const clean = text.replace(/\[[^\]]*\]|\([^)]*\)|♪/g, ' ').replace(/\s+/g, ' ').trim();
      try { atomicWrite(out, clean); console.log(`Transcribed ${path.basename(file)} (${clean.split(' ').filter(Boolean).length} words)`); }
      catch (err) { console.error('transcript write failed', err.message); }
    } else {
      setTimeout(() => queued.delete(`${file}|${stat.size}|${stat.mtimeMs}`), Number(process.env.STUDIO_TRANSCRIPT_RETRY_MS) || 10 * 60 * 1000);   // retry later
    }
    nextTranscript();
  };
  // 16 kHz mono WAV is what whisper.cpp expects; a video with no audio track just gets ''.
  execFile('ffmpeg', ['-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', tmp + '.wav'], (err, _o, stderr) => {
    if (err) return done(err.code === 'ENOENT' || !/does not contain any stream|Output file #0 does not contain/.test(String(stderr)) ? null : '');
    execFile('whisper-cli', ['-m', WHISPER_MODEL, '-f', tmp + '.wav', '-nt', '-np', '-otxt', '-of', tmp],
      { maxBuffer: 1 << 24 }, (err2) => {
        if (err2) return done(null);
        let text = '';
        try { text = fs.readFileSync(tmp + '.txt', 'utf8'); } catch {}
        done(text);
      });
  });
}

// Resolve an id like "other/foo.mp4" or "generations/foo.mp4" to a real path, refusing anything outside the folders.
function resolveId(id) {
  if (typeof id !== 'string') return null;
  const [folder, ...rest] = id.split('/');
  const dir = own(FOLDERS, folder);
  const name = rest.join('/');
  if (!dir || !name || name.includes('/') || name.startsWith('.') || name.includes('\0')) return null;
  const ext = path.extname(name).toLowerCase();
  if (!(folder === 'songs' ? AUDIO_EXT : VIDEO_EXT).has(ext)) return null;
  const file = path.join(dir, name);
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

// An original must be an existing video directly inside one of SOURCE_DIRS.
function allowedSource(file) {
  const ext = typeof file === 'string' ? path.extname(file).toLowerCase() : '';
  if (!VIDEO_EXT.has(ext) && !IMAGE_EXT.has(ext)) return null;
  const abs = path.resolve(file);
  if (!SOURCE_DIRS.includes(path.dirname(abs)) || !fs.existsSync(abs)) return null;
  return abs;
}

function listCandidates() {
  const out = [];
  for (const dir of SOURCE_DIRS) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const ext = path.extname(name).toLowerCase();
      if (name.startsWith('.') || (!VIDEO_EXT.has(ext) && !IMAGE_EXT.has(ext))) continue;
      const file = path.join(dir, name);
      let stat; try { stat = fs.statSync(file); } catch { continue; }
      out.push({ path: file, name, dir: dir.replace(os.homedir(), '~'), modified: stat.mtimeMs, size: stat.size });
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

// The file a request is about: the conversion itself, or its linked original (?which=original).
function targetFile(url) {
  const id = url.searchParams.get('id');
  if (url.searchParams.get('which') !== 'original') return resolveId(id);
  if (!resolveId(id)) return null;
  return allowedSource((readLabels()[id] || {}).original);
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// JSON object bodies only (anything else reads as {}), at most 1 MB.
class TooLarge extends Error {}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    const onData = (c) => {
      data += c;
      if (data.length > 1_000_000) { req.off('data', onData); req.resume(); data = ''; reject(new TooLarge()); }
    };
    req.on('data', onData);
    req.on('end', () => {
      let v; try { v = JSON.parse(data || '{}'); } catch { v = {}; }
      resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    });
    req.on('error', reject);
  });
}
// Images the Studio shows are revalidated, not refetched: same file (size + mtime) → 304.
function etagOf(file) { try { const st = fs.statSync(file); return `"${st.size}-${Math.round(st.mtimeMs)}"`; } catch { return '"0"'; } }
function notModified(req, res, file) {
  if (req.headers['if-none-match'] && req.headers['if-none-match'] === etagOf(file)) { res.writeHead(304, { ETag: etagOf(file) }); res.end(); return true; }
  return false;
}
// Pipe a file to the response; a missing file or a client that hangs up never crashes the server.
function sendFile(res, file, headers, opts) {
  // Read exactly the announced length, even if the file is still growing (a download in progress).
  if (!opts && headers['Content-Length'] !== undefined) opts = { start: 0, end: Math.max(0, headers['Content-Length'] - 1) };
  const rs = fs.createReadStream(file, opts);
  rs.once('open', () => { if (!res.headersSent) res.writeHead(200, headers); pipeline(rs, res, () => {}); });
  rs.once('error', () => { if (!res.headersSent) sendJson(res, 404, { error: 'not found' }); else res.destroy(); });
}

// Stream a video with Range support so the browser can seek.
// Song length via ffprobe, cached per file + mtime so the list stays fast.
const durations = new Map();
function duration(file, mtimeMs) {
  const key = `${file}|${mtimeMs}`;
  if (durations.has(key)) return Promise.resolve(durations.get(key));
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], (err, out) => {
      const secs = err ? null : parseFloat(out) || null;
      durations.set(key, secs);
      resolve(secs);
    });
  });
}

async function listSongs() {
  const labels = readLabels();
  let names = [];
  try { names = fs.readdirSync(FOLDERS.songs); } catch {}
  const songs = await Promise.all(names
    .filter((n) => !n.startsWith('.') && AUDIO_EXT.has(path.extname(n).toLowerCase()))
    .map(async (name) => {
      const file = path.join(FOLDERS.songs, name);
      let stat; try { stat = fs.statSync(file); } catch { return null; }
      const id = `songs/${name}`;
      const label = labels[id] || {};
      return {
        id, name, size: stat.size, modified: stat.mtimeMs,
        duration: await duration(file, stat.mtimeMs),
        note: label.note || '',
        usedIn: (label.usedIn || []).filter((v) => resolveId(v)),
      };
    }));
  return songs.filter(Boolean).sort((a, b) => b.modified - a.modified);
}

function streamVideo(req, res, file) {
  let size; try { size = fs.statSync(file).size; } catch { return sendJson(res, 404, { error: 'not found' }); }
  const type = own(MIME, path.extname(file).toLowerCase()) || 'video/mp4';
  const range = req.headers.range && req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
  if (!range || (!range[1] && !range[2])) {
    return sendFile(res, file, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  }
  // "bytes=-N" is a suffix range: the last N bytes.
  const start = range[1] ? parseInt(range[1], 10) : Math.max(0, size - parseInt(range[2], 10));
  const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), size - 1) : size - 1;
  if (start >= size || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  const rs = fs.createReadStream(file, { start, end });
  rs.once('error', () => { if (!res.headersSent) sendJson(res, 404, { error: 'not found' }); else res.destroy(); });
  rs.once('open', () => {
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    });
    pipeline(rs, res, () => {});
  });
}

// Make (once) and cache a JPG poster frame with ffmpeg, keyed by file name + size + mtime.
const thumbsInFlight = new Map();
// At most 3 ffmpeg poster jobs at once (a fresh grid asks for ~100 thumbnails together).
let thumbSlots = 3; const thumbWaiters = [];
const thumbSlot = () => (thumbSlots > 0 ? (thumbSlots--, Promise.resolve()) : new Promise((r) => thumbWaiters.push(r)));
const thumbDone = () => { const next = thumbWaiters.shift(); if (next) next(); else thumbSlots++; };
let thumbsRunning = 0, thumbsPeak = 0;   // for the tests
function thumbnail(file) {
  const { size, mtimeMs } = fs.statSync(file);
  const key = crypto.createHash('sha1').update(`${file}|${size}|${mtimeMs}`).digest('hex');
  const out = path.join(THUMBS_DIR, key + '.jpg');
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (thumbsInFlight.has(out)) return thumbsInFlight.get(out);
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
  const tmp = path.join(THUMBS_DIR, `${key}.${process.pid}.tmp.jpg`);
  const job = thumbSlot().then(() => new Promise((resolve, reject) => {
    thumbsRunning++; thumbsPeak = Math.max(thumbsPeak, thumbsRunning);
    // A picture has no 0.5 s mark: take its only frame.
    const seek = IMAGE_EXT.has(path.extname(file).toLowerCase()) ? [] : ['-ss', '0.5'];
    execFile('ffmpeg', ['-y', ...seek, '-i', file, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '4', tmp], (err) => {
      thumbsRunning--; thumbDone();
      thumbsInFlight.delete(out);
      if (err || !fs.existsSync(tmp)) { fs.rm(tmp, { force: true }, () => {}); return reject(err || new Error('no frame')); }
      fs.renameSync(tmp, out); resolve(out);
    });
  }));
  thumbsInFlight.set(out, job);
  return job;
}

// Move to the macOS Trash via Finder, so "Put Back" still works.
function moveToTrash(file) {
  return new Promise((resolve, reject) => {
    const script = `tell application "Finder" to delete (POSIX file ${JSON.stringify(file)} as alias)`;
    execFile('osascript', ['-e', script], (err) => (err ? reject(err) : resolve()));
  });
}


// ---------- Studio: projects, gates and the session launcher (2026-10-23) ----------
// The Studio page (/studio) lists /video projects, open approval gates from every pipeline,
// and starts new Claude Code sessions, which always run inside the app (background runs). Write calls need the Studio token: the page
// gets it injected, skills read it from .studio-token (scripts/studio-gate.sh), and other web
// pages can't, since a custom header forces a CORS preflight this server never answers.
const PROJECTS = path.join(GENERATIONS, 'projects');
const TOKEN_FILE = path.join(__dirname, '.studio-token');
const GATES_FILE = path.join(__dirname, 'studio-gates.json');
const SESSIONS_FILE = path.join(__dirname, 'studio-sessions.json');
const STUDIO_TOKEN = (() => {
  try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (/^[0-9a-f]{32}$/.test(t)) return t; } catch {}
  const t = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  return t;
})();
const PIPELINES = { video: '/video' };   // built in; character skills are added by pipelines()
// Character swap skills (made from .claude/skills/swap-template/ when the owner adds a character): SKILL.md with
// `character: <slug>` (and `swaps: <who>`, `folder: <Subject>`) in its frontmatter. Each one is a start button on the Studio page.
const BUILTIN_SKILLS = {};
const SKILL_NAME = /^[a-z][a-z0-9-]{1,30}$/;
function listSkills() {
  let names = []; try { names = fs.readdirSync(SKILLS_DIR); } catch {}
  const out = [];
  for (const n of names) {
    if (!SKILL_NAME.test(n)) continue;
    let text = ''; try { text = fs.readFileSync(path.join(SKILLS_DIR, n, 'SKILL.md'), 'utf8'); } catch { continue; }
    const fm = (text.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
    const field = (k) => ((fm.match(new RegExp('^' + k + ':\\s*(.+)$', 'm')) || [])[1] || '').trim();
    const character = field('character') || BUILTIN_SKILLS[n] || null;
    out.push({ name: n, character, description: field('description').slice(0, 300), target: field('swaps') || null, builtIn: !!BUILTIN_SKILLS[n] });
  }
  return out;
}
// Every pipeline the Studio can start: /video and each swap skill that has a character.
function pipelines() {
  const p = { ...PIPELINES };
  for (const k of listSkills()) if (k.character && !own(p, k.name)) p[k.name] = '/' + k.name;
  return p;
}
// The Skills page: each pipeline skill's SKILL.md, the steps it reports, and the helpers it hands work to. The owner
// edits it in place; a save names the version it started from, so a change made meanwhile (a chat session) is not lost.
const SKILL_HISTORY = path.join(GENERATIONS, '.skill-history');
function skillVersion(md) { return crypto.createHash('sha1').update(md).digest('hex').slice(0, 16); }
function readSkill(name) {
  if (!SKILL_NAME.test(name) || !own(pipelines(), name)) return null;
  const file = path.join(SKILLS_DIR, name, 'SKILL.md');
  let md, st; try { md = fs.readFileSync(file, 'utf8'); st = fs.statSync(file); } catch { return null; }
  const k = listSkills().find((x) => x.name === name) || {}, c = k.character ? readCharacterLite(k.character) : null;
  let agents = []; try { agents = fs.readdirSync(path.join(GENERATIONS, '.claude', 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)); } catch {}
  const desc = (((md.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '').match(/^description:\s*(.+)$/m) || [])[1] || '';
  return { name, command: '/' + name, title: ((md.match(/^# (.+)$/m) || [])[1] || '/' + name).trim(), description: desc.trim(),
    character: c ? { slug: c.slug, name: c.name, photo: c.photo ? `/api/studio/character-file?slug=${encodeURIComponent(c.slug)}&f=${encodeURIComponent(c.photo)}` : null } : null,
    steps: stepInfo(name, null).steps, agents: agents.filter((a) => (a.includes('-') ? new RegExp('\\b' + a + '\\b') : new RegExp('`' + a + '`')).test(md)),
    sections: (md.match(/^## .+$/gm) || []).length, md, version: skillVersion(md), updated: st.mtime.toISOString() };
}
function saveSkill(name, md, version) {
  const k = readSkill(name);
  if (!k) throw Object.assign(new Error('No such skill'), { code: 404 });
  md = String(md || '').replace(/\r\n/g, '\n');
  if (md.length > 300000) throw Object.assign(new Error('That is too long for a skill'), { code: 400 });
  const fm = (md.match(/^---\n([\s\S]*?)\n---\n/) || [])[1];
  if (!fm || !new RegExp('^name:\\s*' + name + '\\s*$', 'm').test(fm) || !/^description:\s*\S/m.test(fm))
    throw Object.assign(new Error('Keep the header block at the top (between the --- lines) with its name: ' + name + ' and description: lines'), { code: 400 });
  if (String(version || '') !== k.version) throw Object.assign(new Error('This skill was changed somewhere else since you opened it. Reload it, then make your change again.'), { code: 409 });
  if (!md.endsWith('\n')) md += '\n';
  if (md === k.md) return k.version;
  // The version it replaces goes to .skill-history/<name>/ (the newest 20 are kept).
  const dir = path.join(SKILL_HISTORY, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '.md'), k.md);
  for (const old of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().slice(0, -20)) fs.rmSync(path.join(dir, old), { force: true });
  atomicWrite(path.join(SKILLS_DIR, name, 'SKILL.md'), md);
  return skillVersion(md);
}
const STAGES = ['planned', 'concept-ok', 'blocked', 'blockout-ok', 'animatic-ok', 'priced', 'generating', 'generated', 'approved', 'placed'];
const STAGE_NAMES = ['Plan', 'Concepts', 'Blender', 'Blender', 'Animatic', 'Generate', 'Generate', 'Review', 'Edit', 'Final'];
// The steps each pipeline goes through, in order: a run's page shows them as its progress. A swap reports its
// stage with `studio-gate.sh step` (the same names its state.json uses); a /video project's comes from shots.json.
const SWAP_STEPS = [['mapped', 'Video mapped'], ['planned', 'Shot plan'], ['built', 'Inputs built'], ['test-approved', 'Test approved'],
  ['test-run', 'Test swap'], ['reviewed', 'Test reviewed'], ['rest-approved', 'Full run approved'], ['run', 'Full swap'],
  ['assembled', 'Assembled'], ['filed', 'Filed in library'], ['approved', 'Final approved'], ['hd', '1080p finish']];
const VIDEO_STEPS = ['Brief', 'Plan', 'Concepts', 'Blender', 'Animatic', 'Generate', 'Review', 'Edit', 'Final'].map((x) => [x, x]);
const PIPELINE_STEPS = { video: VIDEO_STEPS };   // every character skill is a swap: SWAP_STEPS
const STEPS_FILE = path.join(__dirname, 'studio-steps.json');
// "Redo from this step": every redo starts a new take of the video (take 1 is the first try). project → [{ take, from, at, note }]
const TAKES_FILE = path.join(__dirname, 'studio-takes.json');
// A /video project's stage comes from shots.json, so the server writes down when it changes (its step history).
const VIDEO_STAGES_FILE = path.join(__dirname, 'studio-video-stages.json');

const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const localOrigin = (o) => o === `http://localhost:${PORT}` || o === `http://127.0.0.1:${PORT}`;
function studioAuthorized(req) {
  const origin = req.headers.origin;
  if (origin && !localOrigin(origin)) return false;
  const t = Buffer.from(String(req.headers['x-studio-token'] || ''));
  const want = Buffer.from(STUDIO_TOKEN);
  return t.length === want.length && crypto.timingSafeEqual(t, want);
}
// Answering for the owner (approve, notes, resume, stop, messages) must come from the Studio page itself.
// Background runs hold the token too (scripts/studio-gate.sh reads it) but call with curl, which sends no
// Origin, so a run can post and clear its gates but never approve its own (or another run's) price.
const fromStudioPage = (req) => localOrigin(req.headers.origin);
function readJsonFile(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJsonFile(file, data) { atomicWrite(file, JSON.stringify(data, null, 2)); }
// The Buffer section (/buffer and /api/buffer/*) lives in buffer.js.
const bufferSection = require('./buffer')({ dir: __dirname, sendJson, readBody, readLabels, resolveId, studioAuthorized, fromStudioPage, atomicWrite });
function notify(title, text) {
  const script = `display notification ${JSON.stringify(String(text).slice(0, 200))} with title ${JSON.stringify(String(title).slice(0, 80))} sound name "Glass"`;
  execFile('osascript', ['-e', script], () => {});
}
function latestImage(dir) {
  let best = null;
  const walk = (d, depth) => {
    let names = []; try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const f = path.join(d, n); let st; try { st = fs.statSync(f); } catch { continue; }
      if (st.isDirectory() && depth < 2) walk(f, depth + 1);
      else if (/\.(png|jpe?g)$/i.test(n) && (!best || st.mtimeMs > best.t)) best = { f, t: st.mtimeMs };
    }
  };
  for (const sub of ['review', 'renders/concept', 'renders/frames']) walk(path.join(dir, sub), 0);
  return best && path.relative(dir, best.f);
}
function projectSummary(slug) {
  const dir = path.join(PROJECTS, slug);
  const shots = readJsonFile(path.join(dir, 'shots.json'), null);
  if (!shots) return null;
  let title = slug, concept = '';
  try { const m = fs.readFileSync(path.join(dir, 'brief.md'), 'utf8').match(/^- Concept:\s*(.+)$/m); if (m && m[1].trim()) concept = m[1].trim(); } catch {}
  if (typeof shots.title === 'string' && shots.title.trim()) title = shots.title.trim().slice(0, 80);
  else if (concept) title = shortTitle(concept).title;
  let credits = 0;
  try { for (const row of fs.readFileSync(path.join(dir, 'log.md'), 'utf8').split('\n')) { const c = row.split('|'); if (c.length > 6) { const v = parseFloat(c[5]); if (!isNaN(v)) credits += v; } } } catch {}
  const list = Array.isArray(shots.shots) ? shots.shots : [];
  const idx = list.length ? Math.min(...list.map((x) => Math.max(0, STAGES.indexOf(x.status)))) : -1;
  const counts = {}; for (const x of list) counts[x.status] = (counts[x.status] || 0) + 1;
  let mtime = 0; try { mtime = fs.statSync(path.join(dir, 'shots.json')).mtimeMs; } catch {}
  return { concept, slug, title, shots: list.length, stage: idx < 0 ? 'Brief' : (shots.final ? 'Final' : STAGE_NAMES[idx]),
    stageIndex: shots.final ? 8 : Math.max(0, idx + 1), stageCount: 9, counts, final: shots.final || null, approved: !!shots.approved,
    credits: Math.round(credits * 10) / 10, thumb: latestImage(dir), updated: mtime };
}
// The Studio asks every 5 s; re-read a project only when its files changed (shots.json, brief.md,
// log.md, or the folders its thumbnail comes from), and at least once a minute.
const projectCache = new Map();
let projectReads = 0;   // for the tests
function projectKey(slug) {
  const dir = path.join(PROJECTS, slug);
  const m = (f) => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; } };
  return ['shots.json', 'brief.md', 'log.md', 'review', 'renders/concept', 'renders/frames'].map(m).join('|');
}
function cachedSummary(slug) {
  const key = projectKey(slug), hit = projectCache.get(slug);
  if (hit && hit.key === key && Date.now() - hit.at < 60_000) return hit.value;
  projectReads++;
  const value = projectSummary(slug);
  projectCache.set(slug, { key, at: Date.now(), value });
  return value;
}
function listProjects() {
  let names = []; try { names = fs.readdirSync(PROJECTS); } catch {}
  for (const slug of projectCache.keys()) if (!names.includes(slug)) projectCache.delete(slug);
  return names.filter((n) => /^[a-z0-9][a-z0-9-]*$/.test(n)).map(cachedSummary).filter(Boolean).sort((a, b) => b.updated - a.updated);
}
function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }


// ---------- Studio Phase 2: background runs (2026-10-23) ----------
// A run = one `claude -p` session working in runs/<id>/, resumable by its session id. It stops at every gate
// (scripts/studio-gate.sh with STUDIO_RUN_ID set) and the owner's Approve / Notes resumes it. Paid Higgsfield
// tools are blocked by scripts/studio-paid-guard.py unless the turn was started by an Approve on a priced gate.
const { spawn } = require('child_process');
const RUNS_DIR = path.join(GENERATIONS, 'runs');
const SPEND_CSV = path.join(GENERATIONS, 'spend.csv');
const RUN_SETTINGS = path.join(__dirname, 'studio-run-settings.json');
const CLAUDE_BIN = process.env.STUDIO_CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');
const MAX_RUNS = 2;
// The Higgsfield MCP's tool prefix in `claude -p` (config `higgsfieldMcp`, one name or a list; /setup finds it).
const HF_SERVERS = [].concat(CONFIG.higgsfieldMcp || 'mcp__claude_ai_Higgsfield').map(String).filter((x) => /^mcp__[A-Za-z0-9_-]+$/.test(x));
const HF = HF_SERVERS[0] || 'mcp__claude_ai_Higgsfield';
const hfName = (name) => HF_SERVERS.reduce((n, h) => n.replace(h + '__', 'higgsfield:'), String(name));
const ALLOWED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Agent', 'Task', 'Skill', 'TodoWrite',
  ...HF_SERVERS, 'mcp__higgsfield-use-blender', 'mcp__filmcraft-headless', 'mcp__effectcraft-headless', 'mcp__photocraft-headless'];
fs.mkdirSync(RUNS_DIR, { recursive: true });
// The paid guard must fail closed: Claude Code only blocks on exit 2, so a missing python3 (127) or a crash
// (1) would otherwise let a paid call through. Anything but a clean 0 becomes 2.
const PYTHON = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].find((p) => fs.existsSync(p)) || 'python3';
const GUARD = path.join(GENERATIONS, 'scripts', 'studio-paid-guard.py');
const guardCommand = (guard = GUARD) => `/bin/sh -c ${shellQuote(`${shellQuote(PYTHON)} -I ${shellQuote(guard)}; s=$?; [ $s -eq 0 ] && exit 0; [ $s -eq 2 ] || echo "Studio paid guard failed (exit $s): blocking this call." >&2; exit 2`)}`;
// Background runs' shell commands run in Claude Code's sandbox (owner's choice, 2026-10-24): they can't read the
// owner's Studio token, can't reach Anthropic (so they can't start a second, unguarded Claude), and only reach the
// sites the pipelines use. The model can't switch it off (allowUnsandboxedCommands: false). If a download is
// blocked, add its site to RUN_SITES.
const RUN_SITES = [
  'upload.higgsfield.ai', 'cdn.higgsfield.ai', '*.higgsfield.ai', '*.cloudfront.net',          // Higgsfield uploads and results
  '*.tiktok.com', '*.tiktokcdn.com', '*.tiktokcdn-us.com', '*.tiktokv.com', '*.byteoversea.com', '*.ibyteimg.com',
  '*.youtube.com', 'youtu.be', '*.googlevideo.com', '*.ytimg.com', '*.ggpht.com',
  'x.com', '*.x.com', 'twitter.com', '*.twitter.com', '*.twimg.com',
  '*.instagram.com', '*.cdninstagram.com', '*.fbcdn.net', 'kick.com', '*.kick.com',
];
const RUN_BLOCKED_SITES = ['*.anthropic.com', 'anthropic.com', '*.claude.ai', 'claude.ai', '*.claude.com', 'claude.com'];
// What a run may never change, by any tool: the app itself (server, pages, token, its own settings), the
// scripts (paid guard, gate script), the skills/agents/rules and the MCP config. Otherwise a run could rewrite
// the Studio page to steal the token, or remove its own sandbox and guard for the next turn.
const RUN_PROTECTED = [__dirname, path.join(GENERATIONS, 'scripts'), path.join(GENERATIONS, '.claude'),
  path.join(GENERATIONS, '.mcp.json'), path.join(GENERATIONS, 'CLAUDE.md'), path.join(GENERATIONS, 'studio.config.json'), path.join(GENERATIONS, 'setup.sh'),
  path.join(GENERATIONS, '.git')];
function runSettings() {
  const token = path.join(__dirname, '.studio-token');
  const secrets = [token, path.join(__dirname, '.buffer-key')];   // the owner's Studio token and Buffer API key
  const tree = (p) => (path.extname(p) ? p : p + '/**');
  return {
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: secrets, denyWrite: RUN_PROTECTED },
      network: { allowLocalBinding: true, allowedDomains: RUN_SITES, deniedDomains: RUN_BLOCKED_SITES },
    },
    // Runs post gates with their own STUDIO_RUN_TOKEN; they never need the owner's token. Edit rules cover
    // every file-editing tool (Write, Edit, MultiEdit, NotebookEdit).
    permissions: { deny: [...secrets.map((f) => `Read(/${f})`), ...RUN_PROTECTED.map((p) => `Edit(/${tree(p)})`)] },
    hooks: { PreToolUse: [{ matcher: `(${HF_SERVERS.join('|')})__.*`, hooks: [{ type: 'command', command: guardCommand() }] }] },
  };
}
fs.writeFileSync(RUN_SETTINGS, JSON.stringify(runSettings(), null, 2));

function studioFileAllowed(f) {
  // Pictures and videos (a test result or a final the owner should watch before approving).
  const inside = (r) => (r.startsWith(RUNS_DIR + path.sep) || r.startsWith(PROJECTS + path.sep)) && /\.(png|jpe?g|gif|webp|mp4|mov|m4v|webm)$/i.test(r);
  const r = path.resolve(String(f));
  if (!inside(r)) return false;
  // A symlink inside runs/ or projects/ must not lead outside them.
  try { return inside(fs.realpathSync(r)); } catch { return true; }   // not there yet: the path check stands
}
const runs = new Map();
// Chat-session gates that a `studio-gate.sh wait` is polling (every 3 s), by gate id → last poll time.
const gatePolls = new Map();
const listening = (id) => Date.now() - (gatePolls.get(id) || 0) < 15000;
// A run's current step: the newest `studio-gate.sh step` it posted, else the stage in a state.json in its work folder.
function workStage(r) {
  let best = null;
  const look = (d, depth) => {
    let names = []; try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < 2 && !e.name.startsWith('.')) look(f, depth + 1);
      else if (e.name === 'state.json') { let st; try { st = fs.statSync(f); } catch { continue; } if (!best || st.mtimeMs > best.t) best = { f, t: st.mtimeMs }; }
    }
  };
  look(path.join(RUNS_DIR, r.id, 'work'), 0);
  const stage = best && (readJsonFile(best.f, {}) || {}).stage;
  return stage ? { step: String(stage), at: new Date(best.t).toISOString() } : null;
}
function stepInfo(pipeline, entry, history) {
  const list = PIPELINE_STEPS[pipeline] || (pipeline && pipeline !== 'video' ? SWAP_STEPS : []);
  const n = entry ? normalizeStep(pipeline, entry.step) : null;
  return { steps: list.map(([key, label]) => ({ key, label })), step: n ? n.step : null, stepAt: entry ? entry.at : null,
    stepNote: [n && n.note, entry && entry.how].filter(Boolean).join(' · ') || null, history: history || [] };
}
// A stage a swap's state.json can hold that is not one of the steps: "blocked-download" is stuck before step 1.
function normalizeStep(pipeline, raw) {
  const step = String(raw || ''), keys = (PIPELINE_STEPS[pipeline] || (pipeline && pipeline !== 'video' ? SWAP_STEPS : [])).map(([k]) => k);
  if (!step || keys.includes(step) || pipeline === 'video') return { step };
  const m = step.match(/^blocked-?(.*)$/);
  if (m) {
    const at = /download|map/.test(m[1]) ? 'mapped' : /test/.test(m[1]) ? 'test-run' : /run|swap/.test(m[1]) ? 'run' : keys.find((k) => m[1].includes(k)) || null;
    return { step: at || step, note: 'Stuck' + (m[1] ? ': ' + m[1].replace(/-/g, ' ') : '') };
  }
  return { step };
}
// Takes: a redo from a step starts take 2, 3… of the same video; the steps before it are kept as they are.
function takesOf(project) { const t = own(readJsonFile(TAKES_FILE, {}), project); return Array.isArray(t) ? t : []; }
function currentTake(project) { const t = takesOf(project); return t.length ? t[t.length - 1].take : 1; }
const fileList = (list) => (Array.isArray(list) ? list.map((x) => path.resolve(GENERATIONS, String(x))).filter(studioFileAllowed).slice(0, 12) : []);
// A /video project's stage history, written down each time its shots.json stage changes.
function videoStageHistory(p) {
  const all = readJsonFile(VIDEO_STAGES_FILE, {}), list = Array.isArray(own(all, p.slug)) ? all[p.slug] : [];
  const last = list[list.length - 1];
  if (last && last.step === p.stage) return list;
  const next = [...list, { step: p.stage, at: new Date(p.updated || Date.now()).toISOString(), take: currentTake(p.slug) }].slice(-60);
  writeJsonFile(VIDEO_STAGES_FILE, { ...all, [p.slug]: next });
  return next;
}
// What each step made, per take ({ take: { step: [files] } }): the files a session attached when it reported the
// step, the pictures and videos of the questions it asked while at that step, and a /video project's own files.
function stepMedia(history, gates, project) {
  const out = {}, seen = new Set();
  const add = (take, step, files) => {
    for (const f of files || []) {
      const k = take + '|' + step + '|' + f;
      if (seen.has(k) || !fs.existsSync(f)) continue;
      seen.add(k); ((out[take] = out[take] || {})[step] = out[take][step] || []).push(f);
    }
  };
  const sorted = [...history].sort((a, b) => (a.at < b.at ? -1 : 1));
  for (const h of sorted) add(h.take || 1, h.step, h.files);
  for (const g of [...gates].sort((a, b) => (a.at < b.at ? -1 : 1))) {
    const at = sorted.filter((h) => h.at <= g.at).pop() || sorted[0];   // asked just before its first step was reported
    if (at && g.images && g.images.length) add(at.take || 1, at.step, g.images);
  }
  if (project) {
    const dir = path.join(PROJECTS, project.slug), shots = readJsonFile(path.join(dir, 'shots.json'), {}), take = currentTake(project.slug);
    const rel = (f) => (f ? [path.resolve(dir, String(f))].filter(studioFileAllowed) : []);
    for (const s of Array.isArray(shots.shots) ? shots.shots : []) {
      add(take, 'Concepts', rel(s.concept)); add(take, 'Blender', [...rel(s.start), ...rel(s.end)]); add(take, 'Animatic', rel(s.animatic));
      add(take, 'Generate', [].concat(...(Array.isArray(s.results) ? s.results : []).map((x) => rel(typeof x === 'string' ? x : x && (x.file || x.path))))); add(take, 'Review', rel(s.approved_result));
    }
    add(take, 'Final', rel(shots.final));
  }
  for (const t of Object.values(out)) for (const k of Object.keys(t)) t[k] = t[k].slice(-12);
  return out;
}
// Each step's questions (per take): what was asked while the video was at that step, and how the owner answered.
function stepQuestions(history, gates) {
  const out = {}, sorted = [...history].sort((a, b) => (a.at < b.at ? -1 : 1));
  for (const g of [...gates].sort((a, b) => (a.at < b.at ? -1 : 1))) {
    const at = sorted.filter((h) => h.at <= g.at).pop() || sorted[0];   // asked just before its first step was reported
    if (!at) continue;
    const t = (out[at.take || 1] = out[at.take || 1] || {});
    (t[at.step] = t[at.step] || []).push({ at: g.at, title: g.title || '', detail: g.detail || '', credits: g.credits || null,
      cleared: g.cleared || null, answer: g.answer || null, note: g.note || '', options: g.options || [], choice: g.choice || null, id: g.id });
  }
  for (const t of Object.values(out)) for (const k of Object.keys(t)) t[k] = t[k].slice(-12);
  return out;
}
// A chat session's step when it never reported one: the stage in its own state.json (its scratchpad folder is
// named after the project), else a guess from the question it is asking. Re-read at most every 15 s.
const CLAUDE_TMP = `/private/tmp/claude-${process.getuid ? process.getuid() : ''}`;
// Claude Code names a session's folders after its working folder, every non-alphanumeric character a dash.
const FOLDER_TAG = path.basename(GENERATIONS).replace(/[^A-Za-z0-9]/g, '-');
const scratchCache = new Map();
// Every chat session's scratchpad folder for this project (claude-<uid>/<this folder or a worktree>/<session>/scratchpad/<project>).
function scratchDirs(project) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project) || project.includes('..')) return [];
  const out = [];
  let tops = []; try { tops = fs.readdirSync(CLAUDE_TMP); } catch {}
  for (const t of tops) {
    if (!t.includes(FOLDER_TAG)) continue;
    let sess = []; try { sess = fs.readdirSync(path.join(CLAUDE_TMP, t)); } catch { continue; }
    for (const id of sess) { const d = path.join(CLAUDE_TMP, t, id, 'scratchpad', project); try { if (fs.statSync(d).isDirectory()) out.push(d); } catch {} }
  }
  return out;
}
function scratchLookup(project) {
  const hit = scratchCache.get(project); if (hit && Date.now() - hit.at < 15000) return hit.value;
  let state = null, image = null;
  for (const d of scratchDirs(project)) {
    const f = path.join(d, 'state.json');
    try { const st = fs.statSync(f); if (!state || st.mtimeMs > state.t) state = { f, t: st.mtimeMs }; } catch {}
    const walk = (dir, depth) => {
      let names = []; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of names) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 3 && e.name !== 'venv') walk(p, depth + 1); continue; }
        if (!/\.(png|jpe?g|webp)$/i.test(e.name)) continue;
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (!image || st.mtimeMs > image.t) image = { f: p, t: st.mtimeMs };
      }
    };
    walk(d, 0);
  }
  const j = state && readJsonFile(state.f, null);
  const value = { stage: j && j.stage ? { step: String(j.stage), at: new Date(state.t).toISOString(), how: j.blocker ? String(j.blocker).slice(0, 160) : null } : null,
    image: image && image.f };
  scratchCache.set(project, { at: Date.now(), value });
  return value;
}
const scratchStage = (project) => scratchLookup(project).stage;   // a bad name finds no folders, so null
function guessStep(pipeline, g) {
  if (!g || pipeline === 'video') return null;
  const t = (g.id.split(':').slice(1).join(':') + ' ' + g.title).toLowerCase();
  const step = /download|reel .*sign in|airdrop/.test(t) ? 'mapped'
    : /fix|v[2-9]\b|redo|re-?roll|round|revis/.test(t) ? 'run'
    : /final|approved tab|approve it for/.test(t) ? 'approved'
    : /full run|\brest\b|rest of/.test(t) ? 'rest-approved'
    : /test.?(result|review)|result/.test(t) ? 'reviewed'
    : /test|still|preview|hero/.test(t) ? 'test-approved'
    : /plan|pick|which clip/.test(t) ? 'planned' : null;
  return step ? { step, at: g.at, how: 'guessed from its question' } : null;
}
// Everything the Runs page lists: background runs (with their step) and chat sessions that posted a gate or a step.
function sessionList(gates) {
  const steps = readJsonFile(STEPS_FILE, []);
  const projects = listProjects();
  const videoStep = (slug) => { const p = projects.find((x) => x.slug === slug); return p ? { step: p.stage === 'Final' ? 'Final' : p.stage, at: new Date(p.updated).toISOString() } : null; };
  const runList = [...runs.values()].filter((r) => !r.closed).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const gateRuns = new Set(gates.map((g) => g.runId).filter(Boolean));
  // The 20 newest, plus every run still in play (running, queued, waiting) or with an open gate.
  const live = (r) => ['running', 'queued', 'waiting'].includes(r.status);
  const out = runList.filter((r, i) => i < 20 || gateRuns.has(r.id) || live(r)).map((r) => {
    const posted = steps.filter((x) => x.runId === r.id).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    // /video: the project's own stage (shots.json) wins; swaps: what it posted, else its state.json.
    const entry = posted ? (r.pipeline === 'video' && videoStep(posted.project)) || posted : workStage(r);
    return { ...publicRun(r), kind: 'run', project: posted ? posted.project : r.project || null, ...stepInfo(r.pipeline, entry, posted && posted.history) };
  });
  const chats = new Map();
  const day = Date.now() - 24 * 3600e3;
  for (const x of steps) if (!x.runId && Date.parse(x.at) > day) chats.set(x.project, { project: x.project, pipeline: x.pipeline, entry: x, updated: x.at });
  for (const g of gates) if (!g.runId && g.project) {   // a gate with no project is its own video, with no chat session
    const c = chats.get(g.project) || { project: g.project, pipeline: (g.pipeline || '').replace('/', ''), entry: null, updated: g.at };
    if (g.at > c.updated) c.updated = g.at; chats.set(g.project, c);
  }
  const chatList = [...chats.values()].map((c) => {
    const gate = gates.find((g) => !g.runId && g.project === c.project);
    const entry = c.pipeline === 'video' ? (videoStep(c.project) || c.entry) : c.entry || scratchStage(c.project) || guessStep(c.pipeline, gate);
    return { kind: 'chat', id: 'chat-' + c.project, project: c.project, pipeline: c.pipeline, title: c.project,
      status: gate ? 'waiting' : 'chat', updatedAt: c.updated, ...stepInfo(c.pipeline, entry, c.entry && c.entry.history) };
  }).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return { runs: out, chats: chatList };
}
// The newest picture a run made (its frames, sheets, stills), for its video's card.
function latestRunImage(id) {
  let best = null;
  const walk = (d, depth) => {
    let names = []; try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (e.name.startsWith('.')) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(f, depth + 1); continue; }
      if (!/\.(png|jpe?g|webp)$/i.test(e.name)) continue;
      let st; try { st = fs.statSync(f); } catch { continue; }
      if (!best || st.mtimeMs > best.t) best = { f, t: st.mtimeMs };
    }
  };
  walk(path.join(RUNS_DIR, id, 'work'), 0);
  return best && best.f;
}
// The In progress tab: one entry per video being made, swap or original, keyed by the <project> name its sessions
// use for gates and steps (projects/<slug> for /video). Each carries its sessions (background runs and chat
// sessions), its open gates, its step, latest frame and credits. A video drops off once it is filed / approved
// and nothing about it is still open; a run that never named its project is its own entry until it does.
const SWAP_DONE = new Set(['filed', 'approved', 'hd']);
// A card's title and subtitle. Title: what the video is about (a /video project's title or concept; a swap's topic or
// first spoken line from its state.json; else its latest question, "GTA VI edit v4: …" → "GTA VI edit"). Subtitle: the
// kind and the source ("Bowtie Cat swap · @someone on Instagram"). The project key stays on the video's page.
function shortTitle(text) {
  let t = String(text || '').replace(/^\s*\([^)]*\)\s*/, '').trim();
  const cut = t.search(/[,;:]|\s[—–-]\s/), rest = cut >= 12 ? t.slice(cut + 1).replace(/^[\s—–-]+/, '').trim() : '';
  if (cut >= 12) t = t.slice(0, cut).trim();
  if (t.length > 70) t = t.slice(0, 68).replace(/\s+\S*$/, '') + '…';
  return { title: t.charAt(0).toUpperCase() + t.slice(1), rest: rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : '' };
}
const PLATFORMS = [[/instagram\.com/, 'Instagram'], [/tiktok\.com/, 'TikTok'], [/(^|\.)(x|twitter)\.com/, 'X'], [/youtu\.?be/, 'YouTube'], [/kick\.com/, 'Kick']];
function swapState(v) {
  let best = null;
  const take = (f) => { let st; try { st = fs.statSync(f); } catch { return; } if (!best || st.mtimeMs > best.t) best = { f, t: st.mtimeMs }; };
  for (const x of v.sessions) {
    if (x.kind === 'run') { const look = (d, depth) => { let names = []; try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of names) { const f = path.join(d, e.name); if (e.isDirectory() && depth < 2 && !e.name.startsWith('.')) look(f, depth + 1); else if (e.name === 'state.json') take(f); } };
      look(path.join(RUNS_DIR, x.id, 'work'), 0); }
  }
  if (v.project) for (const d of scratchDirs(v.project)) take(path.join(d, 'state.json'));
  const st = best ? readJsonFile(best.f, null) : null;
  return st && typeof st === 'object' ? Object.assign(st, { __dir: path.dirname(best.f) }) : null;
}
// A swap's original clip: the file its state.json names as source.file, only inside that state's own folder and
// only a video. Served (with seeking) by /api/studio/original?key=<video key>.
const originalFiles = new Map();   // video key → absolute path, refreshed with every In progress listing
function originalOf(st) {
  const f = st && st.source && typeof st.source === 'object' && typeof st.source.file === 'string' && st.source.file !== 'None' ? path.resolve(st.__dir, st.source.file) : null;
  if (!f || !f.startsWith(st.__dir + path.sep) || !VIDEO_EXT.has(path.extname(f).toLowerCase())) return null;
  try { const real = fs.realpathSync(f), dir = fs.realpathSync(st.__dir); return real.startsWith(dir + path.sep) && fs.statSync(real).isFile() ? real : null; } catch { return null; }
}
function cardTitle(v, p, vGates) {
  const ch = v.pipeline && v.pipeline !== 'video' ? readCharacterLite(((listSkills().find((k) => k.name === v.pipeline) || {}).character) || '') : null;
  const kind = v.pipeline === 'video' || p ? 'Original video' : (ch ? ch.name.replace(/\s*\(.*\)\s*$/, '') + ' swap' : v.pipeline ? '/' + v.pipeline : '');
  if (p) { const t = p.concept ? shortTitle(p.concept) : null; return { title: p.title, subtitle: [kind, t && t.title === p.title ? t.rest : ''].filter(Boolean).join(' · ') }; }
  const st = v.pipeline && v.pipeline !== 'video' ? swapState(v) : null, src = (st && typeof st.source === 'object' && st.source) || {};
  const real = (x) => x && x !== 'None' && x !== 'null' ? String(x) : '';
  const handle = real(src.uploader_id) || real(st && st.handle), url = real(src.url), postId = real(src.post_id);
  const platform = (PLATFORMS.find(([re]) => { try { return re.test(new URL(url).hostname); } catch { return false; } }) || [])[1] || '';
  const topic = st && st.screen && typeof st.screen.notes === 'string' ? (st.screen.notes.match(/Topic:\s*([^.(;]+)/) || [])[1] : '';
  const said = st && Array.isArray(st.shots) && st.shots[0] && typeof st.shots[0].said === 'string' ? st.shots[0].said.trim() : '';
  const asked = [...vGates].reverse().map((g) => String(g.title || '').split(/[:?]/)[0].replace(/\s+v\d+$/i, '').trim()).find((x) => x && x.length <= 48) || '';
  let title = topic ? shortTitle(topic).title : said ? '“' + (said.length > 60 ? said.slice(0, 58).replace(/\s+\S*$/, '') + '…' : said) + '”' : asked;
  if (!title) title = String(v.key).replace(new RegExp('^(run|video|' + Object.keys(pipelines()).join('|') + ')-'), '').replace(/[-_]+/g, ' ');
  const from = handle ? '@' + handle + (platform ? ' on ' + platform : '') : platform ? platform + (postId ? ' post ' + postId : '') : '';
  // No notes on disk (an old chat session's scratchpad is gone): a file in that subject's originals/ whose handle
  // ("<handle> - <post id>.mp4") is exactly one word of the project name, and only when exactly one file matches.
  let file = originalOf(st), byName = false;
  if (!file && !st && v.project) {
    const words = new Set(String(v.project).toLowerCase().split(/[-_]+/).filter((w) => w.length >= 4 && w !== v.pipeline && !['video', 'swap', ...Object.keys(pipelines())].includes(w)));
    const dir = path.join(GENERATIONS, SUBJECTS[v.pipeline] || 'Other', 'originals');
    let names = []; try { names = fs.readdirSync(dir); } catch {}
    const hits = names.filter((n) => VIDEO_EXT.has(path.extname(n).toLowerCase()) && n.includes(' - ') && words.has(n.split(' - ')[0].toLowerCase()));
    if (hits.length === 1) { file = path.join(dir, hits[0]); byName = true; }
  }
  if (file) originalFiles.set(v.key, file); else originalFiles.delete(v.key);
  const original = file || url ? { video: file ? '/api/studio/original?key=' + encodeURIComponent(v.key) : null, url: /^https?:\/\//.test(url) ? url : null, from, ...(byName ? { byName: true } : {}) } : null;
  return { title, subtitle: [kind, from].filter(Boolean).join(' · '), original };
}
function videoList(gates, { runs: runItems, chats } = sessionList(gates), finished = null) {
  const projects = listProjects(), spend = spendSummary(), allGates = readJsonFile(GATES_FILE, []);
  const vids = new Map(), runKey = {};
  const get = (key, seed) => {
    if (!vids.has(key)) vids.set(key, { key, project: seed.project || null, title: seed.title || key, pipeline: seed.pipeline || '', sessions: [], gates: [], updatedAt: seed.updatedAt || '' });
    const v = vids.get(key); if (seed.updatedAt && seed.updatedAt > v.updatedAt) v.updatedAt = seed.updatedAt; return v;
  };
  for (const p of projects) get(p.slug, { project: p.slug, title: p.title, pipeline: 'video', updatedAt: new Date(p.updated).toISOString() }).projectInfo = p;
  for (const r of runItems) {
    const proj = r.project || ((gates.find((g) => g.runId === r.id) || {}).project) || null;
    const key = proj || 'run-' + r.id; runKey[r.id] = key;
    const v = get(key, { project: proj, title: proj || r.title, pipeline: r.pipeline, updatedAt: r.updatedAt || r.createdAt });
    v.sessions.push(r); if (!v.pipeline) v.pipeline = r.pipeline;
  }
  for (const c of chats) { const v = get(c.project, { project: c.project, title: c.project, pipeline: c.pipeline, updatedAt: c.updatedAt }); v.sessions.push(c); if (!v.pipeline) v.pipeline = c.pipeline; }
  for (const g of gates) { const key = (g.runId && runKey[g.runId]) || g.project || 'gate-' + g.id; get(key, { project: g.project || null, title: g.project || g.title, pipeline: (g.pipeline || '').replace('/', ''), updatedAt: g.at }).gates.push(g); }
  const live = (x) => ['running', 'queued', 'waiting'].includes(x.status);
  const out = [];
  for (const v of vids.values()) {
    v.sessions.sort((a, b) => ((a.updatedAt || a.createdAt || '') < (b.updatedAt || b.createdAt || '') ? 1 : -1));
    // Its step: a /video project's stage from shots.json; a swap's newest reported step across its sessions.
    const p = v.projectInfo;
    const lead = v.sessions.filter((x) => x.step).sort((a, b) => ((a.stepAt || '') < (b.stepAt || '') ? 1 : -1))[0];
    const history = p ? videoStageHistory(p) : [].concat(...v.sessions.map((x) => x.history || [])).sort((a, b) => (a.at < b.at ? -1 : 1));
    Object.assign(v, stepInfo(v.pipeline, p ? { step: p.stage, at: new Date(p.updated).toISOString() } : lead ? { step: lead.step, at: lead.stepAt } : null, history));
    if (!p && lead && lead.stepNote) v.stepNote = lead.stepNote;
    // Each step's pictures and videos (per take), and the takes a redo started.
    const ids = new Set(v.sessions.map((x) => x.id));
    const vGates = allGates.filter((g) => (v.project && g.project === v.project) || (g.runId && ids.has(g.runId)));
    v.media = stepMedia(history, vGates, p);
    v.questions = stepQuestions(history, vGates);
    Object.assign(v, cardTitle(v, p, vGates));
    v.takes = v.project ? takesOf(v.project) : [];
    v.take = v.project ? currentTake(v.project) : 1;
    // Its picture: the /video project's latest frame, else the newest picture from a gate or a run's work folder.
    let thumb = null;
    if (p && p.thumb) thumb = `/api/studio/thumb?p=${encodeURIComponent(p.slug)}&f=${encodeURIComponent(p.thumb)}`;
    else {
      const img = [...v.gates].reverse().flatMap((g) => g.images || []).find((f) => /\.(png|jpe?g|webp)$/i.test(f)) ||
        v.sessions.filter((x) => x.kind === 'run').map((x) => latestRunImage(x.id)).find(Boolean);
      if (img) thumb = '/api/studio/file?path=' + encodeURIComponent(img);
      else if (v.project && v.sessions.some((x) => x.kind === 'chat') && scratchLookup(v.project).image) thumb = '/api/studio/scratch-frame?project=' + encodeURIComponent(v.project);
    }
    v.thumb = thumb;
    v.credits = (v.project && spend.byProject[v.project]) || (p ? p.credits : 0) || 0;
    v.status = v.gates.length ? 'waiting' : v.sessions.some((x) => x.status === 'running') ? 'running' : v.sessions.some((x) => x.status === 'queued') ? 'queued'
      : (v.sessions[0] && v.sessions[0].status) || 'idle';
    const done = p ? (p.approved || !!p.final) : SWAP_DONE.has(v.step);
    const stale = !v.gates.length && !v.sessions.some(live) && Date.now() - Date.parse(v.updatedAt || 0) > 7 * 86400e3 && !p;
    // Finished for good: the last step is done (a swap's 1080p finish, a /video final the owner approved), nothing is
    // open and nothing is working. Its runs are closed by closeFinishedRuns.
    if (finished && (p ? !!p.approved : v.step === 'hd') && !v.gates.length && !v.sessions.some((x) => ['running', 'queued'].includes(x.status))) finished.push(v);
    if ((done && !v.gates.length && !v.sessions.some(live)) || stale) continue;
    delete v.projectInfo;
    if (p) v.shots = p.shots;
    out.push(v);
  }
  const rank = (v) => (v.status === 'waiting' ? 0 : v.status === 'running' ? 1 : v.status === 'queued' ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b) || (a.updatedAt < b.updatedAt ? 1 : -1));
}
function runFile(id) { return path.join(RUNS_DIR, id, 'run.json'); }
// Run tokens stay in memory only: on disk another run could read them and post gates as this run.
function saveRun(r) { const { proc, killTimer, runToken, ...rest } = r; writeJsonFile(runFile(r.id), rest); }
function publicRun(r) {
  const { proc, killTimer, pending, runToken, ...rest } = r;
  return { ...rest, hasPending: !!pending };
}
(function loadRuns() {
  let names = []; try { names = fs.readdirSync(RUNS_DIR); } catch {}
  for (const n of names) {
    const r = readJsonFile(runFile(n), null); if (!r) continue;
    if (r.status === 'running') { r.status = 'interrupted'; r.pid = null; }   // the server restarted under it
    runs.set(r.id, r);
  }
})();
setImmediate(() => pump());   // runs queued before a restart (e.g. an Approve) start again
// A question's options (single pick): { id: 'B', label, why, image, credits, recommended }. At most one is
// recommended; an option's own price (if any) replaces the question's when the owner approves that option.
function gateOptions(list) {
  if (!Array.isArray(list)) return [];
  const out = [], seen = new Set();
  for (const o of list.slice(0, 8)) {
    const id = String((o && o.id) || '').trim();
    if (!/^[A-Za-z0-9]{1,3}$/.test(id) || seen.has(id.toUpperCase())) continue;
    seen.add(id.toUpperCase());
    const image = o.image ? path.resolve(GENERATIONS, String(o.image)) : null;
    const credits = o.credits == null || String(o.credits).trim() === '' ? null : String(o.credits).trim().slice(0, 20);
    out.push({ id, label: String(o.label || id).slice(0, 80), why: String(o.why || '').slice(0, 300), image: image && studioFileAllowed(image) ? image : null,
      credits, recommended: !!o.recommended && !out.some((x) => x.recommended) });
  }
  return out;
}
// What an Approve means on a question: the option picked (if it has options) and the price that approval covers.
function gateApproval(g, choice) {
  const opts = g.options || [];
  if (!opts.length) return { ok: true, choice: null, credits: g.credits || null, what: '' };
  const o = opts.find((x) => x.id === String(choice || ''));
  if (!o) return { ok: false };
  const credits = o.credits != null ? o.credits : g.credits || null;
  return { ok: true, choice: o.id, credits, what: ` They picked option ${o.id} ("${o.label}").` };
}
function systemPromptFor(r) {
  return [
    `You are running in the background, started from the Video Studio (run ${r.id}). There is no chat: the owner reads and answers in the Studio.`,
    `- Never call AskUserQuestion and never wait for input. Wherever the skill says to stop and ask the owner (a plan, a price, a still, a shot, a result, a final), post the gate with scripts/studio-gate.sh open <project>:<gate> <pipeline> <project> "<the full question>" [credits or ""] "<short detail>" [image or video paths…] (attach the result or final video itself when asking about one: it plays in the Studio), then end your turn with a two-line summary. The owner's answer arrives as your next message.`,
    `- Work in ${path.join(RUNS_DIR, r.id, 'work')} (use it as WORK / instead of the session scratchpad), so the Studio can show your boards and sheets. Put every image the owner should look at inside it and pass those paths to the gate.`,
    `- Paid Higgsfield tools are blocked unless the message that started this turn says the owner APPROVED a price; price checks with get_cost: true always work. Right after submitting any paid job, run scripts/spend.sh <project> <skill> <job id> <model> <credits>.`,
    `- When the question is a choice (still A or B, which idea, which take), add one --option "<id>[*]|<name>|<why>|<picture or video>|<credits>" per choice to the gate (* = the one you recommend, at most one; give each option its own price when they differ). The owner clicks one and Approve; the answer names the option and approves exactly its price. Continue with that option only.`,
    `- SendUserFile and the browser are not available here: show things through gate images.`,
    `- When the last step is done (a swap's 1080p finish after the owner's approval, a /video final the owner approved), report that step, clear any gate you still have open, give a short final report and end your turn. Do not start anything new: the Studio then closes this session for good.`,
    `- A message from the owner that starts with [Step N · <step name>] is about that step of this video: answer about that step (what you did there and why). If it asks to change a step that is already done, say that it takes "Redo from this step" in the Studio; do not redo it yourself.`,
    `- When you report a step (scripts/studio-gate.sh step <project> <pipeline> <step> "<note>" [file …]), attach the pictures and videos that step made (contact sheets, plan boards, reels, the test result, pieces, the assembled video), so the owner can open the step and see them.`,
    ...(r.adoptedFrom ? [`- This conversation started in a chat window and was moved into the Studio. Your earlier files stay where they were (read them there); put new boards, frames and results for the owner in the work folder above.`] : []),
  ].join('\n');
}
function launch(r, message, paid, owner) {
  const first = !r.started;
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--settings', RUN_SETTINGS,
    '--allowedTools', ALLOWED_TOOLS.join(','), '--append-system-prompt', systemPromptFor(r)];
  args.push(...(first ? ['--session-id', r.sessionId] : ['--resume', r.sessionId]));
  fs.mkdirSync(path.join(RUNS_DIR, r.id, 'work'), { recursive: true });
  const logStream = fs.createWriteStream(path.join(RUNS_DIR, r.id, 'log.jsonl'), { flags: 'a' });
  logStream.on('error', () => {});
  const log = { write: (d) => { if (!logStream.writableEnded) logStream.write(d); }, end: () => logStream.end() };
  log.write(JSON.stringify({ type: 'studio', at: new Date().toISOString(), message, paid, owner: owner || null }) + '\n');
  // Its own process group, so Stop ends claude and everything it started (ffmpeg, python, curl…).
  if (!r.runToken) r.runToken = crypto.randomBytes(16).toString('hex');
  // Rewrite the run settings before every turn, so they are always the server's own.
  fs.writeFileSync(RUN_SETTINGS, JSON.stringify(runSettings(), null, 2));
  // A conversation taken over from a chat session resumes in its own folder (a worktree), where its transcript lives.
  const proc = spawn(CLAUDE_BIN, args, { cwd: r.cwd && (r.cwd === GENERATIONS || r.cwd.startsWith(GENERATIONS + path.sep)) ? r.cwd : GENERATIONS, detached: true,
    env: { ...process.env, STUDIO_RUN_ID: r.id, STUDIO_RUN_TOKEN: r.runToken, STUDIO_PAID: paid ? '1' : '0', STUDIO_PORT: String(PORT) } });
  Object.assign(r, { proc, pid: proc.pid || null, status: 'running', turnStartedAt: new Date().toISOString(), paidThisTurn: !!paid, pending: null, isError: false, lastResult: null });
  r.turns = (r.turns || 0) + 1;
  saveRun(r);
  let finished = false, buf = '';
  const finish = (code, failure) => {
    if (finished) return; finished = true;
    clearTimeout(r.killTimer);
    if (buf) { log.write(buf + '\n'); buf = ''; }
    log.end();
    if (r.proc !== proc) return;               // a newer turn owns the run now
    r.proc = null; r.pid = null; r.updatedAt = new Date().toISOString(); r.exitCode = code;
    if (failure) { r.lastResult = failure; r.isError = true; }
    if (r.status === 'stopped') { /* owner stopped it */ }
    else if (readJsonFile(GATES_FILE, []).some((g) => g.runId === r.id && !g.cleared)) r.status = 'waiting';
    else if (code !== 0 || r.isError) { r.status = 'failed'; notify('Run failed · ' + r.title, (r.lastResult || 'see the run log').slice(0, 150)); }
    else { r.status = 'finished'; notify('Run finished · ' + r.title, (r.lastResult || '').slice(0, 150)); }
    if (r.status !== 'stopped' && r.inbox && r.inbox.length) queueMessages(r);
    saveRun(r); pump();
  };
  proc.on('error', (err) => {
    log.write(JSON.stringify({ type: 'stderr', text: `could not start claude (${CLAUDE_BIN}): ${err.message}` }) + '\n');
    finish(null, `Could not start claude: ${err.message}`);
  });
  proc.stdin.on('error', () => {});
  proc.stdin.end(message);
  proc.stdout.setEncoding('utf8');
  // Each line is stamped with the time it arrived ("_at"), so the Studio can file what was said under the step it was at.
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i; while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let ev; try { ev = JSON.parse(line); } catch { log.write(line + '\n'); continue; }
      log.write(ev && typeof ev === 'object' && !Array.isArray(ev) && line.trim().length > 2 ? '{"_at":"' + new Date().toISOString() + '",' + line.trim().slice(1) + '\n' : line + '\n');
      // The session exists once claude reports anything; until then a retry must create it, not --resume it.
      if (!r.started) { r.started = true; saveRun(r); }
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const c of ev.message.content) {
          if (c.type === 'text' && c.text.trim()) r.lastText = c.text.trim().slice(0, 400);
          if (c.type === 'tool_use') { r.toolCalls = (r.toolCalls || 0) + 1; r.lastTool = hfName(c.name); }
        }
        r.updatedAt = new Date().toISOString();
      }
      if (ev.type === 'result') { r.lastResult = String(ev.result || '').slice(0, 2000); r.isError = !!ev.is_error; }
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { log.write(JSON.stringify({ type: 'stderr', text: d }) + '\n'); });
  proc.on('close', (code) => finish(code));
  // 'close' waits for every holder of the output pipes; a leftover child (ffmpeg, curl) could keep the run
  // "running" for good. Once claude itself has exited, finish shortly after and end what it left behind.
  proc.on('exit', (code) => setTimeout(() => {
    if (!finished) { try { process.kill(-proc.pid, 'SIGTERM'); } catch {} finish(code); }
  }, 2000));
}
// Your messages to a run (from its page). They never approve anything: paid tools stay blocked, and a gate it
// was waiting at is withdrawn, so it posts it again after replying.
function queueMessages(r) {
  const texts = r.inbox; r.inbox = [];
  const said = texts.map((t) => `"${t}"`).join(' and then ');
  const gates = readJsonFile(GATES_FILE, []), open = gates.filter((g) => g.runId === r.id && !g.cleared);
  if (open.length) { for (const g of open) Object.assign(g, { cleared: new Date().toISOString(), answer: 'message' }); writeJsonFile(GATES_FILE, gates); }
  r.pending = { message: `The owner sent you a message from the Studio: ${said}. Reply to it (your reply shows on the run's page). This is not an approval: nothing new is approved and paid tools stay blocked. If you were waiting at a gate, post that gate again once you have replied.`,
    paid: false, owner: texts.join('\n\n') };
  r.status = 'queued'; r.queuedAt = new Date().toISOString();
}
// What a run is told when the owner presses "Redo from this step". The earlier take is never touched.
function redoMessage(pipeline, n, label, key, prevKey, note) {
  const said = note ? ` Their notes for this take: "${note}".` : '';
  const how = pipeline === 'video'
    ? `In projects/<slug>/shots.json, set the shots back to the stage before "${label}" and continue the /video skill from "${label}". Never overwrite a render, result or final: this take's files get new -v${n} names.`
    : `Make a new folder take-${n}/ in your work folder. Copy (cp -c) or reuse the files of the steps before "${label}" as they are, write a state.json there with stage "${prevKey}", and continue the skill from step "${label}" (${key}) in that folder. Report each step with scripts/studio-gate.sh step as usual and attach the files each step makes. This take's final gets a -v${n} name.`;
  return `The owner pressed "Redo from this step" in the Studio: redo this video from step "${label}" as take ${n}.${said} Keep everything from the earlier take exactly as it is: never delete, move or overwrite its files. ${how} This is not an approval: nothing new is approved and paid tools stay blocked. Every paid step in this take posts its priced gate first and waits for the owner. If you were waiting at a gate, it was withdrawn.`;
}
function stopRun(r) {
  r.status = 'stopped';
  const pid = r.proc && r.proc.pid;
  if (!pid) return;
  const kill = (sig) => { try { process.kill(-pid, sig); } catch { try { r.proc && r.proc.kill(sig); } catch {} } };
  kill('SIGTERM');
  r.killTimer = setTimeout(() => kill('SIGKILL'), 5000);
}
function pump() {
  const active = [...runs.values()].filter((r) => r.status === 'running').length;
  let free = MAX_RUNS - active;
  const queued = [...runs.values()].filter((r) => r.status === 'queued').sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : 1));
  for (const r of queued) { if (free-- <= 0) break; const p = r.pending || { message: r.firstMessage, paid: false, owner: r.firstMessage }; launch(r, p.message, p.paid, p.owner); }
}
// When a video's process is complete (see videoList), its background runs are closed: marked done, never resumed,
// messaged or redone, and gone from the Studio's lists. Their files stay in runs/<id>/. Checked every 30 s and
// right after a step is reported.
function closeFinishedRuns() {
  const gates = readJsonFile(GATES_FILE, []).filter((g) => !g.cleared), finished = [];
  try { videoList(gates, sessionList(gates), finished); } catch { return; }
  for (const v of finished) for (const x of v.sessions) {
    const r = x.kind === 'run' && runs.get(x.id);
    if (!r || r.closed || r.proc || ['running', 'queued'].includes(r.status)) continue;
    Object.assign(r, { closed: new Date().toISOString(), status: 'done', inbox: [], pending: null });
    saveRun(r);
  }
}
setInterval(closeFinishedRuns, Number(process.env.STUDIO_SWEEP_MS) || 30000).unref();
const closedError = (r) => r && r.closed ? 'This video is done, so its session is closed.' : null;
// "Continue in the Studio": find the chat session that posted this project's gates. Its transcript is the
// ~/.claude/projects/*/<session id>.jsonl that ran `studio-gate.sh open <project>:` most often (recent ones only).
const TRANSCRIPTS = path.join(os.homedir(), '.claude', 'projects');
function findChatSession(project) {
  return new Promise((resolve) => {
    const needle = `studio-gate.sh open ${project}:`, files = [], since = Date.now() - 3 * 86400e3;
    let dirs = []; try { dirs = fs.readdirSync(TRANSCRIPTS); } catch {}
    for (const d of dirs) {
      let names = []; try { names = fs.readdirSync(path.join(TRANSCRIPTS, d)); } catch { continue; }
      for (const n of names) {
        if (!/^[0-9a-f-]{36}\.jsonl$/.test(n)) continue;
        const f = path.join(TRANSCRIPTS, d, n);
        try { if (fs.statSync(f).mtimeMs > since) files.push(f); } catch {}
      }
    }
    if (!files.length) return resolve(null);
    // -H: name the file even when only one is searched (else grep prints a bare count).
    execFile('grep', ['-c', '-H', '-F', '--', needle, ...files], { maxBuffer: 1 << 20 }, (err, out) => { try {
      const hits = String(out || '').split('\n').map((l) => { const i = l.lastIndexOf(':'); return { f: l.slice(0, i), n: +l.slice(i + 1) }; })
        .filter((h) => h.n > 0).sort((a, b) => b.n - a.n);
      if (!hits.length) return resolve(null);
      const f = hits[0].f, sessionId = path.basename(f, '.jsonl');
      // Its working folder: the cwd its transcript records (read from the end, where the newest lines are).
      let cwd = null;
      try {
        const size = fs.statSync(f).size, fd = fs.openSync(f, 'r'), buf = Buffer.alloc(Math.min(size, 400000));
        fs.readSync(fd, buf, 0, buf.length, size - buf.length); fs.closeSync(fd);
        for (const line of buf.toString('utf8').split('\n').reverse()) { try { const j = JSON.parse(line); if (j.cwd) { cwd = j.cwd; break; } } catch {} }
      } catch {}
      resolve({ file: f, sessionId, cwd, mtime: fs.statSync(f).mtimeMs });
    } catch { resolve(null); } });
  });
}
// ── Characters (the Studio's Characters page): each characters/<slug>/ holds character.md, its photos and its
// kit; characters/README.md has the roster. The skills read these same files, so the page edits them in place.
const CHARACTERS = path.join(GENERATIONS, 'characters');
const ROSTER = path.join(CHARACTERS, 'README.md');
const CHAR_SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;
const CHAR_ROLES = ['main', 'bench', 'ai-character', 'unassigned'];
const cutouts = new Map();   // slug → { running, error } for "Make grey cutout"
const charDir = (slug) => (CHAR_SLUG.test(String(slug || '')) ? path.join(CHARACTERS, slug) : null);
function readCharacter(slug, full) {
  const dir = charDir(slug); if (!dir) return null;
  let md; try { md = fs.readFileSync(path.join(dir, 'character.md'), 'utf8'); } catch { return null; }
  const name = ((md.match(/^#\s+(.+)$/m) || [])[1] || slug).trim();
  const role = ((md.match(/\*\*Role:\*\*\s*([a-z-]+)/i) || [])[1] || '').toLowerCase();
  const source = (md.match(/\*\*Source photo:\*\*\s*`([^`]+)`/) || [])[1] || null;
  let images = []; try { images = fs.readdirSync(dir).filter((f) => !f.startsWith('.') && !/\.tmp\./.test(f) && IMAGE_EXT.has(path.extname(f).toLowerCase())); } catch {}
  images.sort((a, b) => (a === source ? -1 : b === source ? 1 : a.localeCompare(b)));
  const photo = source && images.includes(source) ? source : images[0] || null;
  const grey = images.includes(`${slug}_grey.png`) ? `${slug}_grey.png` : images.find((f) => /_grey\.png$/.test(f)) || null;
  const c = cutouts.get(slug) || {};
  const skill = listSkills().find((k) => k.character === slug) || null;
  return { slug, name, role, skill, source: source && images.includes(source) ? source : null, photo, grey, images, cutting: !!c.running, cutoutError: c.error || null, ...(full ? { md } : {}) };
}
// Name and photo only (no skill lookup), for the Studio's start buttons.
function readCharacterLite(slug) {
  const dir = charDir(slug); if (!dir) return null;
  let md; try { md = fs.readFileSync(path.join(dir, 'character.md'), 'utf8'); } catch { return null; }
  const name = ((md.match(/^#\s+(.+)$/m) || [])[1] || slug).trim();
  const source = (md.match(/\*\*Source photo:\*\*\s*`([^`]+)`/) || [])[1] || null;
  let photo = null; try { photo = source && fs.existsSync(path.join(dir, source)) ? source : fs.readdirSync(dir).find((f) => IMAGE_EXT.has(path.extname(f).toLowerCase())) || null; } catch {}
  return { slug, name, photo };
}
function listCharacters() {
  let names = []; try { names = fs.readdirSync(CHARACTERS); } catch {}
  const order = { main: 0, 'ai-character': 1, bench: 2, unassigned: 3 };
  return names.map((n) => readCharacter(n)).filter(Boolean).sort((a, b) => (order[a.role] ?? 4) - (order[b.role] ?? 4) || a.name.localeCompare(b.name));
}
// The photo a character's cards and cutout use: rewrite its **Source photo:** line (and the roster's photo cell).
function setSourcePhoto(slug, file) {
  const f = path.join(charDir(slug), 'character.md');
  let md = fs.readFileSync(f, 'utf8');
  const line = `**Source photo:** \`${file}\` (this folder).`;
  md = /\*\*Source photo:\*\*.*$/m.test(md) ? md.replace(/\*\*Source photo:\*\*.*$/m, line) : md.replace(/^(#\s+.+\n)/m, `$1\n${line}\n`);
  atomicWrite(f, md);
  try {
    const r = fs.readFileSync(ROSTER, 'utf8').split('\n');
    const i = r.findIndex((l) => l.startsWith('|') && l.includes(`\`${slug}/\``));
    if (i >= 0) { const cells = r[i].split('|'); cells[cells.length - 2] = ` \`${file}\` `; r[i] = cells.join('|'); atomicWrite(ROSTER, r.join('\n')); }
  } catch {}
}
function newCharacter({ name, role, look, accessory, notes }) {
  name = String(name || '').replace(/[\r\n|`*#]+/g, ' ').trim().slice(0, 60);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!name || !CHAR_SLUG.test(slug)) throw new Error('Give it a name (letters or numbers)');
  role = CHAR_ROLES.includes(role) ? role : 'bench';
  const dir = charDir(slug);
  if (fs.existsSync(dir)) throw Object.assign(new Error(`There is already a character folder called ${slug}`), { code: 409 });
  const clean = (x, n) => String(x || '').replace(/\r/g, '').trim().slice(0, n);
  look = clean(look, 600); accessory = clean(accessory, 300); notes = clean(notes, 1000);
  const md = [`# ${name}`, '',
    `**Role:** ${role}${role === 'bench' ? ' (no skill yet). Videos go in `Other/` until it gets its own swap skill.' : ''}`,
    '**Source photo:** none yet (add one on its Characters page in the Studio).', '',
    '## Look (put in every prompt)', `- ${look || 'Describe exactly what it looks like: coat, colours, build, eyes.'}`,
    `- Signature accessory: ${accessory || 'none'}. No human parts (see \`../README.md\`).`, '',
    '## Notes', `- ${notes || 'Added in the Video Studio on ' + new Date().toLocaleDateString('en-CA') + '.'}`, ''].join('\n');
  fs.mkdirSync(dir);
  atomicWrite(path.join(dir, 'character.md'), md);
  // A row at the end of the roster table, like the README's "Adding a character" says.
  try {
    const r = fs.readFileSync(ROSTER, 'utf8').split('\n');
    const head = r.findIndex((l) => /^##\s+Roster/.test(l));
    let last = -1; for (let i = head + 1; i < r.length && head >= 0; i++) { if (r[i].startsWith('|')) last = i; else if (last >= 0) break; }
    if (last >= 0) { r.splice(last + 1, 0, `| ${name} | \`${slug}/\` | ${role} | — | — | \`Other/\` | — |`); atomicWrite(ROSTER, r.join('\n')); }
  } catch {}
  return slug;
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); reject(new TooLarge()); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// Move a chat session's conversation into the app as a background run (the same conversation, resumed in its own
// folder). With an answer, your Approve or notes on its open question go along with it (an Approve on a priced
// question enables paid tools for that turn, as for any run); with a note, your message does.
async function adoptChat(project, { answer, note, redo } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project)) return { status: 400, json: { error: 'Unknown video' } };
  const found = await findChatSession(project);
  if (!found) return { status: 404, json: { error: 'Could not find that chat session\'s conversation. Answer it in its chat window.' } };
  if (!found.cwd || !(found.cwd === GENERATIONS || found.cwd.startsWith(GENERATIONS + path.sep))) return { status: 409, json: { error: 'That session works outside this folder, so the Studio cannot take it over.' } };
  if ([...runs.values()].some((r) => r.sessionId === found.sessionId)) return { status: 409, json: { error: 'The Studio already has this conversation.' } };
  if (Date.now() - found.mtime < 90000) return { status: 409, json: { error: 'That session is working right now. Wait until it is waiting on you, then try again.' } };
  const gates = readJsonFile(GATES_FILE, []), open = gates.filter((g) => !g.runId && g.project === project && !g.cleared);
  const steps = readJsonFile(STEPS_FILE, []), lastStep = steps.filter((x) => x.project === project).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  const pipeline = (lastStep && lastStep.pipeline) || (open[0] && String(open[0].pipeline || '').replace('/', '')) || 'video';
  const r = createRunRecord(own(pipelines(), pipeline) ? pipeline : 'video', project);
  Object.assign(r, { sessionId: found.sessionId, started: true, project, cwd: found.cwd, title: project, adoptedFrom: found.file });
  const q = open[open.length - 1];
  note = String(note || '').slice(0, 2000).trim();
  const approve = answer && answer.decision === 'approve', ansNote = answer ? String(answer.text || '').slice(0, 2000).trim() : '';
  const pick = answer && q && approve ? gateApproval(q, answer.choice) : { ok: true, choice: null, credits: q ? q.credits : null, what: '' };
  if (!pick.ok) return { status: 400, json: { error: 'Pick one of the options first' } };
  for (const g of open) Object.assign(g, { cleared: new Date().toISOString(), answer: answer && g === q ? (approve ? 'approved' : 'notes') : 'moved', note: answer && g === q ? ansNote : g.note, choice: answer && g === q ? pick.choice : null });
  if (open.length) writeJsonFile(GATES_FILE, gates);
  const cr = q && q.credits ? ` (${q.credits} credits)` : '', pcr = pick.credits ? ` (${pick.credits} credits)` : '';
  let next, paid = false, owner;
  if (answer && q && approve) {
    next = ` You were waiting on: "${q.title}"${pcr}. The owner APPROVED it in the Studio.${pick.what}${ansNote ? ' Their note: ' + ansNote : ''} Continue the skill from that question${pick.choice ? ' with that option only' : ''}.${pick.credits ? ' Paid Higgsfield tools are enabled for this turn, for exactly what was approved.' : ''}`;
    paid = !!pick.credits; owner = 'Approved' + (pick.choice ? ' option ' + pick.choice : '') + pcr + (ansNote ? ': ' + ansNote : '');
  } else if (answer && q) {
    next = ` You were waiting on: "${q.title}"${cr}. The owner did NOT approve it yet. Their notes from the Studio: ${ansNote} Revise as the skill says, then post a new gate. Paid tools stay blocked.`;
    owner = 'Notes: ' + ansNote;
  } else if (redo) {
    next = ' ' + redo.message; owner = redo.owner;
  } else {
    next = (q ? ` You were waiting on: "${q.title}"${cr}. Post that question again now as a gate (scripts/studio-gate.sh open, the same id, with its pictures or videos from your work folder) and end your turn.` : ' Tell the owner in one or two lines where things stand, then end your turn.') +
      (note ? ` The owner sent a message from the Studio: "${note}". Reply to it.` : '') + ' Nothing new is approved: paid tools stay blocked until the owner approves a priced gate.';
    owner = note || 'Moved this conversation into the Studio';
  }
  r.pending = { message: `The owner moved this conversation into the Video Studio app. From now on you are a background run there (${r.id}); your old chat window is no longer used, and the owner reads and answers you on the video's page.${next}`, paid, owner };
  r.status = 'queued'; r.queuedAt = new Date().toISOString(); runs.set(r.id, r); saveRun(r); pump();
  return { status: 200, json: { ok: true, run: r.id, moved: true } };
}
function createRunRecord(pipeline, input) {
  const id = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 12) + '-' + crypto.randomBytes(3).toString('hex');
  const r = { id, sessionId: crypto.randomUUID(), pipeline, input, title: `${pipelines()[pipeline] || '/' + pipeline} ${input}`.slice(0, 80),
    status: 'queued', createdAt: new Date().toISOString(), queuedAt: new Date().toISOString(), started: false,
    firstMessage: `${pipelines()[pipeline] || '/' + pipeline} ${input}`, turns: 0 };
  fs.mkdirSync(path.join(RUNS_DIR, id, 'work'), { recursive: true });
  return r;
}
function createRun(pipeline, input) {
  const r = createRunRecord(pipeline, input);
  runs.set(r.id, r); saveRun(r); pump(); return r;
}
function spendSummary() {
  let rows = []; try { rows = fs.readFileSync(SPEND_CSV, 'utf8').trim().split('\n').slice(1); } catch {}
  // spend.sh stamps rows in UTC; "today" is the owner's local day.
  const localDay = (d) => d.toLocaleDateString('en-CA');
  const today = localDay(new Date()); let total = 0, todayTotal = 0, jobs = 0; const byProject = {};
  for (const line of rows) {
    const c = line.split(','); const v = parseFloat(c[5]); if (isNaN(v)) continue;
    jobs++; total += v; if (localDay(new Date(c[0])) === today) todayTotal += v; byProject[c[1]] = (byProject[c[1]] || 0) + v;
  }
  const r1 = (x) => Math.round(x * 10) / 10;
  return { total: r1(total), today: r1(todayTotal), jobs, byProject: Object.fromEntries(Object.entries(byProject).map(([k, v]) => [k, r1(v)])) };
}

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (err) {
    if (err instanceof TooLarge) { if (!res.headersSent) { res.setHeader('Connection', 'close'); sendJson(res, 413, { error: 'request too large' }); } return; }
    console.error(new Date().toISOString(), req.method, req.url, err && err.stack || err);
    if (!res.headersSent) sendJson(res, 500, { error: 'server error: ' + String(err && err.message || err) });
    else res.destroy();
  }
});
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));
process.on('uncaughtException', (err) => console.error('uncaughtException', err));

async function handle(req, res) {
  // Only this machine's names: a website whose DNS points at 127.0.0.1 (DNS rebinding) gets nothing.
  if (!LOCAL_HOSTS.has(String(req.headers.host || '').toLowerCase())) return sendJson(res, 403, { error: 'unknown host' });
  // The Buffer page in the owner's Chrome reports collected comments and sent replies here, cross-origin, with a
  // one-time job token (buffer-comments.js checks it); that is the only exception to the same-origin rule below.
  if (/^\/api\/buffer\/(comments\/(import|sent)|schedule\/progress)(\?|$)/.test(req.url)) return bufferSection.fromBufferPage(req, res, new URL(req.url, `http://localhost:${PORT}`));
  // Writes from a browser must come from this app's own pages. Another website can send a cross-site POST
  // without a preflight (text/plain), but the browser always stamps its Origin on it. curl from the skills
  // and scripts sends no Origin and keeps working.
  if (req.method === 'POST' && req.headers.origin !== undefined && !localOrigin(req.headers.origin)) {
    return sendJson(res, 403, { error: 'cross-site request refused' });
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return sendFile(res, path.join(__dirname, 'index.html'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  }
  if (req.method === 'GET' && url.pathname === '/api/songs') {
    return sendJson(res, 200, await listSongs());
  }
  // Finds routes take ?s=<finds id> (the config's `finds`); /api/finds/sections lists them.
  const finds = own(FINDS, url.searchParams.get('s') || FIRST_FINDS);
  if (req.method === 'GET' && url.pathname === '/api/finds/sections') {
    return sendJson(res, 200, Object.entries(FINDS).map(([id, f]) => ({ id, label: f.label })));
  }
  if (req.method === 'GET' && url.pathname === '/api/finds') {
    // Candidate clips: YouTube links, or clips with a local copy in the section's folder. Not generations.
    if (!finds) return sendJson(res, 404, { error: 'unknown section' });
    return sendJson(res, 200, readFinds(url.searchParams.get('s') || FIRST_FINDS));
  }
  if (req.method === 'GET' && url.pathname === '/find') {
    // Play a clip's local copy (?kind=thumb for a still frame).
    if (!finds) return sendJson(res, 404, { error: 'unknown section' });
    const clip = readFinds(url.searchParams.get('s') || FIRST_FINDS).find((c) => c.id === url.searchParams.get('id'));
    const file = clip && clip.file && path.join(finds.dir, path.basename(clip.file));
    if (!file || !fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
    if (url.searchParams.get('kind') !== 'thumb') return streamVideo(req, res, file);
    try {
      const jpg = await thumbnail(file);
      return sendFile(res, jpg, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
    } catch {
      return sendJson(res, 500, { error: 'thumbnail failed' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/finds/delete') {
    // Drop a clip from the list (the video file stays); keep it in the removed file so it can be restored by hand.
    const { id, s = FIRST_FINDS } = await readBody(req);
    if (!own(FINDS, s)) return sendJson(res, 404, { error: 'unknown section' });
    const file = path.join(__dirname, FINDS[s].list);
    const list = readFinds(s);
    const clip = list.find((c) => c.id === id);
    if (!clip) return sendJson(res, 404, { error: 'not found' });
    const removedFile = path.join(__dirname, FINDS[s].removed);
    let removed = [];
    try { removed = JSON.parse(fs.readFileSync(removedFile, 'utf8')); } catch {}
    writeJsonFile(removedFile, [...removed, clip]);
    writeJsonFile(file, list.filter((c) => c.id !== id));
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/videos') {
    return sendJson(res, 200, listVideos());
  }
  if (req.method === 'GET' && url.pathname === '/api/transcribe-status') {
    return sendJson(res, 200, { current: transcribing && path.basename(transcribing), waiting: transcriptQueue.length, thumbsPeak });
  }
  if (req.method === 'GET' && url.pathname === '/api/candidates') {
    return sendJson(res, 200, listCandidates());
  }
  if (req.method === 'GET' && url.pathname === '/video') {
    const file = targetFile(url);
    if (!file) return sendJson(res, 404, { error: 'not found' });
    if (url.searchParams.has('download')) {
      // Save under the file's real name instead of playing in the browser.
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);
    }
    return streamVideo(req, res, file);
  }
  if (req.method === 'GET' && url.pathname === '/thumb') {
    const file = targetFile(url);
    if (!file) return sendJson(res, 404, { error: 'not found' });
    try {
      const jpg = await thumbnail(file);
      return sendFile(res, jpg, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
    } catch {
      return sendJson(res, 500, { error: 'thumbnail failed' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/label') {
    const { id, status, note, original, posted, approved, usedIn, archived, description, xQuote, sourceUrl } = await readBody(req);
    if (!resolveId(id)) return sendJson(res, 404, { error: 'not found' });
    if (status !== undefined && !STATUSES.includes(status)) return sendJson(res, 400, { error: 'bad status' });
    if (usedIn !== undefined && !(Array.isArray(usedIn) && usedIn.every((v) => resolveId(v)))) {
      return sendJson(res, 400, { error: 'bad usedIn' });
    }
    if (description !== undefined && (typeof description !== 'string' || description.length > 2000)) {
      return sendJson(res, 400, { error: 'bad description' });
    }
    if (xQuote !== undefined && (typeof xQuote !== 'string' || xQuote.length > 2000)) {
      return sendJson(res, 400, { error: 'bad xQuote' });
    }
    if (sourceUrl !== undefined && !(sourceUrl === '' || (typeof sourceUrl === 'string' && sourceUrl.length <= 500
      && /^https?:\/\/[^\s]+$/.test(sourceUrl.trim())))) {
      return sendJson(res, 400, { error: 'bad sourceUrl' });
    }
    if (archived !== undefined && typeof archived !== 'boolean') return sendJson(res, 400, { error: 'bad archived' });
    if (posted !== undefined && typeof posted !== 'boolean') return sendJson(res, 400, { error: 'bad posted' });
    if (approved !== undefined && typeof approved !== 'boolean') return sendJson(res, 400, { error: 'bad approved' });
    if (note !== undefined && (typeof note !== 'string' || note.length > 2000)) return sendJson(res, 400, { error: 'bad note' });
    if (original !== undefined && original !== null && original !== '' && !allowedSource(original)) return sendJson(res, 400, { error: 'original not allowed' });
    const labels = readLabelsForWrite();
    labels[id] = {
      ...labels[id],
      ...(status !== undefined && { status }),
      ...(posted !== undefined && { posted }),
      ...(approved !== undefined && { approved, approvedAt: approved ? new Date().toISOString() : null }),
      ...(usedIn !== undefined && { usedIn }),
      ...(archived !== undefined && { archived }),
      ...(note !== undefined && { note }),
      ...(description !== undefined && { description: description.trim() }),
      ...(xQuote !== undefined && { xQuote: xQuote.trim() }),
      ...(sourceUrl !== undefined && { sourceUrl: sourceUrl.trim() }),
      ...(original !== undefined && { original: original ? allowedSource(original) : null }),
    };
    writeLabels(labels);
    return sendJson(res, 200, { ok: true });
  }
  // What the pages need from studio.config.json: the subject folders, finds sections, brands and the app's name.
  if (req.method === 'GET' && url.pathname === '/api/config') {
    return sendJson(res, 200, { name: typeof CONFIG.name === 'string' ? CONFIG.name.slice(0, 60) : 'Video Studio',
      subjects: Object.entries(SUBJECTS).map(([id, folder]) => ({ id, folder, character: (listSkills().find((k) => k.name === id) || {}).character || null })),
      posted: !!FOLDERS.content, songs: FOLDERS.songs.replace(os.homedir(), '~'),
      finds: Object.entries(FINDS).map(([id, f]) => ({ id, label: f.label })),
      brands: BRANDS.map((b) => ({ key: b.key, name: b.name, accounts: b.accounts })) });
  }
  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    return sendJson(res, 200, ACCOUNTS);
  }
  // Add or update one "Where it's posted" entry. The entry for the same account and link is
  // updated (a queued entry with no link yet is the one that gets the link once it's live);
  // otherwise a new entry is added, so a second post on the same account shows up as a duplicate.
  // { id, account, url?, remove: true } deletes the matching entry.
  if (req.method === 'POST' && url.pathname === '/api/post') {
    const { id, account, status, at, caption, url: link, remove } = await readBody(req);
    if (!resolveId(id)) return sendJson(res, 404, { error: 'not found' });
    if (!own(ACCOUNTS, account)) return sendJson(res, 400, { error: 'bad account' });
    if (link !== undefined && !(link === '' || (typeof link === 'string' && link.length <= 500
      && /^https?:\/\/[^\s]+$/.test(link.trim())))) {
      return sendJson(res, 400, { error: 'bad url' });
    }
    const labels = readLabelsForWrite();
    const posts = Array.isArray(labels[id]?.posts) ? [...labels[id].posts] : [];
    const u = (link || '').trim();
    if (remove) {
      const i = posts.findIndex((p) => p.account === account && (p.url || '') === u);
      if (i < 0) return sendJson(res, 404, { error: 'no such entry' });
      posts.splice(i, 1);
    } else {
      if (!POST_STATES.includes(status)) return sendJson(res, 400, { error: 'bad status' });
      if (at !== undefined && (typeof at !== 'string' || Number.isNaN(Date.parse(at)))) {
        return sendJson(res, 400, { error: 'bad at' });
      }
      if (caption !== undefined && (typeof caption !== 'string' || caption.length > 3000)) {
        return sendJson(res, 400, { error: 'bad caption' });
      }
      let i = posts.findIndex((p) => p.account === account && u && p.url === u);
      if (i < 0) i = posts.findIndex((p) => p.account === account && !p.url && (p.status === 'queued' || !u));
      const entry = {
        ...(i >= 0 ? posts[i] : {}),
        account, status,
        ...(at !== undefined && { at: new Date(at).toISOString() }),
        ...(caption !== undefined && { caption: caption.trim() }),
        ...(u && { url: u }),
      };
      if (i >= 0) posts[i] = entry; else posts.push(entry);
    }
    labels[id] = { ...labels[id], posts };
    writeLabels(labels);
    return sendJson(res, 200, { ok: true, posts });
  }
  if (req.method === 'POST' && url.pathname === '/api/trash') {
    const { id } = await readBody(req);
    const file = resolveId(id);
    if (!file) return sendJson(res, 404, { error: 'not found' });
    try {
      await moveToTrash(file);
      // Labels are kept (description, posted, source…), so a video restored with "Put Back" keeps them.
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 500, { error: String(err.message || err) });
    }
  }
  // Erase videos for good (the Library's bulk "Delete permanently"): the file and its card. Not undoable, so only
  // the owner in the Video Studio app may do it (its token AND a request from our own page; a browser tab, a script
  // or a background run can't). Only videos in a subject folder or Unsorted: never songs, never anything in
  // originals/ (several videos can share one original, and the ids can't reach there anyway).
  if (req.method === 'POST' && url.pathname === '/api/videos/delete-forever') {
    if (!studioAuthorized(req) || !fromStudioPage(req)) return sendJson(res, 403, { error: 'Only the Video Studio app can delete videos permanently' });
    const { ids } = await readBody(req);
    if (!Array.isArray(ids) || !ids.length || ids.length > 500) return sendJson(res, 400, { error: 'Pick the videos to delete' });
    let labels;
    try { labels = readLabelsForWrite(); } catch (err) { return sendJson(res, 500, { error: 'labels.json could not be read, so nothing was deleted: ' + err.message }); }
    const results = [];
    for (const raw of [...new Set(ids.map(String))]) {
      const folder = raw.split('/')[0];
      const file = (own(SUBJECTS, folder) || folder === 'generations') ? resolveId(raw) : null;
      if (!file) { results.push({ id: raw, ok: false, error: 'not found' }); continue; }
      try {
        fs.unlinkSync(file);
        delete labels[raw];
        // A song's "Used in" no longer lists it.
        for (const l of Object.values(labels)) if (l && Array.isArray(l.usedIn)) l.usedIn = l.usedIn.filter((u) => u !== raw);
        results.push({ id: raw, ok: true });
      } catch (err) { results.push({ id: raw, ok: false, error: String(err.message || err) }); }
    }
    if (results.some((r) => r.ok)) writeLabels(labels);
    return sendJson(res, 200, { results, deleted: results.filter((r) => r.ok).length });
  }
  if (req.method === 'POST' && url.pathname === '/api/reveal') {
    const { id } = await readBody(req);
    const file = resolveId(id);
    if (!file) return sendJson(res, 404, { error: 'not found' });
    execFile('open', ['-R', file]);
    return sendJson(res, 200, { ok: true });
  }

  // ---------- Studio routes ----------
  if (req.method === 'GET' && url.pathname === '/buffer') {
    return sendFile(res, path.join(__dirname, 'buffer.html'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  if (url.pathname.startsWith('/api/buffer/')) return bufferSection.handle(req, res, url);
  if (req.method === 'GET' && url.pathname === '/studio') {
    let html; try { html = fs.readFileSync(path.join(__dirname, 'studio.html'), 'utf8'); } catch { return sendJson(res, 500, { error: 'studio.html missing' }); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    // The page no longer carries the owner's token: anything on this Mac (including a background run's shell)
    // can fetch this page. The Video Studio app reads .studio-token itself and hands it to the page; in a plain
    // browser the Studio is read-only.
    return res.end(html.replace('__STUDIO_TOKEN__', ''));
  }
  if (req.method === 'GET' && url.pathname === '/api/studio/state') {
    const gates = readJsonFile(GATES_FILE, []).filter((g) => !g.cleared).map((g) => ({ ...g, listening: listening(g.id) }));
    const sessions = readJsonFile(SESSIONS_FILE, []).slice(-12).reverse();
    const list = sessionList(gates), { runs: runList, chats } = list;
    const starts = listSkills().filter((k) => k.character && !own(PIPELINES, k.name)).map((k) => { const c = readCharacterLite(k.character); return { id: k.name, label: c ? c.name : k.name, target: k.target, photo: c && c.photo ? `/api/studio/character-file?slug=${encodeURIComponent(c.slug)}&f=${encodeURIComponent(c.photo)}` : null }; });
    return sendJson(res, 200, { projects: listProjects(), gates, sessions, runs: runList, chats, videos: videoList(gates, list), starts, maxRuns: MAX_RUNS, spend: spendSummary(), projectReads });
  }
  if (req.method === 'GET' && url.pathname === '/api/studio/characters') return sendJson(res, 200, { characters: listCharacters() });
  if (req.method === 'GET' && url.pathname === '/api/studio/skills') return sendJson(res, 200, { skills: Object.keys(pipelines()).map((n) => readSkill(n)).filter(Boolean).map(({ md, ...k }) => k) });
  if (req.method === 'GET' && url.pathname === '/api/studio/skill') {
    const k = readSkill(String(url.searchParams.get('name') || ''));
    return k ? sendJson(res, 200, k) : sendJson(res, 404, { error: 'not found' });
  }
  if (req.method === 'GET' && url.pathname === '/api/studio/character') {
    const c = readCharacter(String(url.searchParams.get('slug') || ''), true);
    return c ? sendJson(res, 200, c) : sendJson(res, 404, { error: 'not found' });
  }
  // A character's picture by folder and file name (only its own top-level photos); small unless full=1.
  if (req.method === 'GET' && url.pathname === '/api/studio/character-file') {
    const c = readCharacter(String(url.searchParams.get('slug') || ''));
    const name = String(url.searchParams.get('f') || '');
    if (!c || !c.images.includes(name)) return sendJson(res, 404, { error: 'not found' });
    const f = path.join(charDir(c.slug), name);
    if (notModified(req, res, f)) return;
    const type = /\.png$/i.test(f) ? 'image/png' : /\.webp$/i.test(f) ? 'image/webp' : 'image/jpeg';
    if (url.searchParams.get('full') === '1') return sendFile(res, f, { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etagOf(f) });
    try { const jpg = await thumbnail(f); return sendFile(res, jpg, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', ETag: etagOf(f) }); }
    catch { return sendFile(res, f, { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etagOf(f) }); }
  }
  // A chat session's conversation on its page: every question it posted to the Studio, and your answers.
  if (req.method === 'GET' && url.pathname === '/api/studio/chat') {
    const project = String(url.searchParams.get('project') || '');
    const list = readJsonFile(GATES_FILE, []).filter((g) => !g.runId && g.project === project).slice(-40)
      .map((g) => ({ id: g.id, at: g.at, title: g.title, detail: g.detail, credits: g.credits, cleared: g.cleared || null, answer: g.answer || null, note: g.note || '', options: g.options || [], choice: g.choice || null }));
    return sendJson(res, 200, { project, gates: list });
  }
  // A chat session's latest frame, found by project name in its scratchpad (the page never names a path).
  if (req.method === 'GET' && url.pathname === '/api/studio/scratch-frame') {
    const project = String(url.searchParams.get('project') || '');
    const f = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project) && scratchLookup(project).image;
    if (!f || !fs.existsSync(f)) return sendJson(res, 404, { error: 'not found' });
    if (notModified(req, res, f)) return;
    try { const jpg = await thumbnail(f); return sendFile(res, jpg, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', ETag: etagOf(f) }); }
    catch { return sendFile(res, f, { 'Content-Type': /\.png$/i.test(f) ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-cache', ETag: etagOf(f) }); }
  }
  // One gate's state, for a chat session waiting on it (scripts/studio-gate.sh wait): open, answered or cleared.
  if (req.method === 'GET' && url.pathname === '/api/studio/gate') {
    const id = String(url.searchParams.get('id') || '');
    gatePolls.set(id, Date.now());   // a session is listening: its card gets Approve / Send notes
    const g = readJsonFile(GATES_FILE, []).filter((x) => x.id === id).pop();
    if (!g) return sendJson(res, 404, { error: 'not found' });
    const pk = g.answer === 'approved' ? gateApproval(g, g.choice) : null;
    return sendJson(res, 200, { id: g.id, title: g.title, credits: pk && pk.ok ? pk.credits : g.credits, cleared: g.cleared || null, answer: g.answer || null, note: g.note || '',
      choice: g.choice || null, choiceLabel: (pk && pk.choice && (g.options || []).find((o) => o.id === pk.choice) || {}).label || null });
  }
  if (req.method === 'GET' && url.pathname === '/api/studio/original') {
    const key = String(url.searchParams.get('key') || '');
    if (!originalFiles.has(key)) { const gates = readJsonFile(GATES_FILE, []).filter((g) => !g.cleared); videoList(gates); }
    const f = originalFiles.get(key);
    if (!f || !fs.existsSync(f)) return sendJson(res, 404, { error: 'not found' });
    return streamVideo(req, res, f);
  }
  if (req.method === 'GET' && url.pathname === '/api/studio/file') {
    const f = path.resolve(url.searchParams.get('path') || '');
    if (!studioFileAllowed(f) || !fs.existsSync(f)) return sendJson(res, 404, { error: 'not found' });
    if (VIDEO_EXT.has(path.extname(f).toLowerCase())) return streamVideo(req, res, f);   // Range requests, so it can seek
    if (notModified(req, res, f)) return;
    return sendFile(res, f, { 'Content-Type': /\.png$/i.test(f) ? 'image/png' : /\.gif$/i.test(f) ? 'image/gif' : /\.webp$/i.test(f) ? 'image/webp' : 'image/jpeg', 'Cache-Control': 'no-cache', ETag: etagOf(f) });
  }
  if (req.method === 'GET' && url.pathname === '/api/studio/log') {
    const r = runs.get(url.searchParams.get('run') || '');
    if (!r) return sendJson(res, 404, { error: 'not found' });
    // Only the last 2 MB: logs of long runs grow large and the page asks every 5 s.
    let lines = [];
    try {
      const file = path.join(RUNS_DIR, r.id, 'log.jsonl'), size = fs.statSync(file).size, start = Math.max(0, size - 2_000_000);
      const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
      lines = buf.toString('utf8').split('\n'); if (start > 0) lines.shift();   // drop the cut-off first line
    } catch {}
    // Every event carries a time: its own stamp, or (older logs) the last time seen before it, at least its turn's start.
    const out = [];
    let at = null;
    for (const line of lines) {
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      at = ev._at || ev.at || at;
      if (ev.type === 'studio') out.push({ kind: 'you', text: ev.owner || ev.message, paid: ev.paid, at });
      else if (ev.type === 'assistant' && ev.message) for (const c of ev.message.content || []) {
        if (c.type === 'text' && c.text.trim()) out.push({ kind: 'text', text: c.text.trim().slice(0, 1200), at });
        if (c.type === 'tool_use') out.push({ kind: 'tool', text: hfName(c.name) + ' ' + JSON.stringify(c.input || {}).slice(0, 160), at });
      }
      else if (ev.type === 'result') out.push({ kind: 'result', text: String(ev.result || '').slice(0, 1200), error: !!ev.is_error, at });
    }
    return sendJson(res, 200, { run: publicRun(r), events: out.slice(-150) });
  }
  if (req.method === 'GET' && url.pathname === '/api/studio/thumb') {
    const slug = url.searchParams.get('p') || '', rel = url.searchParams.get('f') || '';
    const base = path.join(PROJECTS, slug);
    const file = path.resolve(base, rel);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || !file.startsWith(base + path.sep) || !/\.(png|jpe?g)$/i.test(file) || !fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
    // A small poster of the latest frame, not the full-size render (cards are 150 px tall).
    if (notModified(req, res, file)) return;
    try {
      const jpg = await thumbnail(file);
      return sendFile(res, jpg, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', ETag: etagOf(file) });
    } catch {
      return sendFile(res, file, { 'Content-Type': /\.png$/i.test(file) ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-cache', ETag: etagOf(file) });
    }
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/studio/')) {
    // A background run authenticates with its own run token, which only posts and clears its own gates.
    const runTok = String(req.headers['x-studio-run-token'] || '');
    const asRun = runTok ? [...runs.values()].find((x) => x.runToken && x.runToken.length === runTok.length &&
      crypto.timingSafeEqual(Buffer.from(x.runToken), Buffer.from(runTok))) : null;
    if (runTok && (!asRun || !['/api/studio/gate', '/api/studio/gate/clear', '/api/studio/step'].includes(url.pathname))) return sendJson(res, 403, { error: 'A run can only post and clear its own gates and report its step' });
    if (!asRun && !studioAuthorized(req)) return sendJson(res, 403, { error: 'Studio token required' });
    if (url.pathname.startsWith('/api/studio/character') && (asRun || !fromStudioPage(req))) return sendJson(res, 403, { error: 'Only the Studio page can change characters' });
    if (url.pathname.startsWith('/api/studio/skill') && (asRun || !fromStudioPage(req))) return sendJson(res, 403, { error: 'Only the Studio page can change skills' });
    if (url.pathname === '/api/studio/character/photo') {
      const c = readCharacter(String(url.searchParams.get('slug') || ''));
      if (!c) return sendJson(res, 404, { error: 'not found' });
      let name = path.basename(String(url.searchParams.get('name') || 'photo.jpg')).replace(/[^A-Za-z0-9._ -]+/g, '').replace(/^[.\s]+/, '').slice(0, 80) || 'photo.jpg';
      const ext = path.extname(name).toLowerCase();
      if (!IMAGE_EXT.has(ext)) return sendJson(res, 400, { error: 'Pick a JPG, PNG or WebP photo' });
      let buf; try { buf = await readRaw(req, 30 * 1024 * 1024); } catch { return sendJson(res, 413, { error: 'That photo is over 30 MB' }); }
      if (!buf.length) return sendJson(res, 400, { error: 'The photo was empty' });
      const dir = charDir(c.slug), stem = name.slice(0, -ext.length);
      for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${stem}-${i}${ext}`;   // never overwrite
      fs.writeFileSync(path.join(dir, name), buf, { flag: 'wx' });
      if (!c.source) setSourcePhoto(c.slug, name);
      return sendJson(res, 200, { ok: true, file: name });
    }
    const body = await readBody(req);
    if (asRun) { body.runId = asRun.id; }
    const ownerOnly = ['/api/studio/start', '/api/studio/answer', '/api/studio/resume', '/api/studio/stop', '/api/studio/message', '/api/studio/adopt', '/api/studio/redo'];
    if (ownerOnly.includes(url.pathname) && !fromStudioPage(req)) return sendJson(res, 403, { error: 'Only the Studio page can do that' });
    if (url.pathname === '/api/studio/start') {
      const pipeline = String(body.pipeline || ''), input = String(body.input || '').replace(/[\r\n]+/g, ' ').trim();
      if (!own(pipelines(), pipeline)) return sendJson(res, 400, { error: 'Pick what to make: /video or one of the character skills' });
      if (!input || input.length > 1500) return sendJson(res, 400, { error: pipeline === 'video' ? 'Describe the video (up to 1500 characters)' : 'Paste a link or file path' });
      // Read and write the list in one synchronous step (after any await), so parallel starts all land.
      const record = (entry) => { const list = readJsonFile(SESSIONS_FILE, []); list.push(entry); writeJsonFile(SESSIONS_FILE, list.slice(-200)); };
      // Everything runs in the app: there is no Terminal mode any more.
      if (body.mode && body.mode !== 'background') return sendJson(res, 400, { error: 'Sessions run in the Video Studio app' });
      const r = createRun(pipeline, input);
      record({ at: new Date().toISOString(), pipeline, input, mode: 'background', run: r.id });
      return sendJson(res, 200, { ok: true, mode: 'background', run: r.id, status: r.status });
    }
    if (url.pathname === '/api/studio/answer') {
      const gates = readJsonFile(GATES_FILE, []);
      const g = gates.find((x) => x.id === String(body.gateId) && !x.cleared);
      if (!g) return sendJson(res, 404, { error: 'That gate is already answered' });
      const r = g.runId && runs.get(g.runId);
      const approve = body.decision === 'approve', note = String(body.text || '').slice(0, 2000).trim();
      if (!approve && !note) return sendJson(res, 400, { error: 'Write your notes first' });
      const pick = approve ? gateApproval(g, body.choice) : { ok: true, choice: null, credits: null, what: '' };   // notes never need a pick
      if (!pick.ok) return sendJson(res, 400, { error: 'Pick one of the options first' });
      // A chat session's gate: keep the answer on the gate. The session waits for it with
      // `scripts/studio-gate.sh wait <id>` (a background command), which wakes it up with your answer.
      if (!r) {
        if (!listening(g.id)) { const out = await adoptChat(g.project, { answer: { decision: approve ? 'approve' : 'notes', text: note, choice: pick.choice } }); return sendJson(res, out.status, out.json); }
        Object.assign(g, { cleared: new Date().toISOString(), answer: approve ? 'approved' : 'notes', note, choice: pick.choice });
        writeJsonFile(GATES_FILE, gates);
        return sendJson(res, 200, { ok: true, status: 'answered' });
      }
      if (r.status === 'running' || r.proc) return sendJson(res, 409, { error: 'The run is still working; try again when it stops' });
      if (r.status === 'queued') return sendJson(res, 409, { error: 'This run already has an answer waiting to start' });
      g.cleared = new Date().toISOString(); g.answer = approve ? 'approved' : 'notes'; g.choice = pick.choice; writeJsonFile(GATES_FILE, gates);
      const message = approve
        ? `The owner APPROVED in the Studio: "${g.title}"${pick.credits ? ` (${pick.credits} credits)` : ''}.${pick.what}${note ? ` Their note: ${note}` : ''} Continue the skill from this gate${pick.choice ? ' with that option only' : ''}.${pick.credits ? ' Paid Higgsfield tools are enabled for this turn, for exactly what was approved.' : ''}`
        : `The owner did NOT approve "${g.title}" yet. Their notes: ${note} Revise as the skill says, then post a new gate. Paid tools stay blocked.`;
      r.pending = { message, paid: approve && !!pick.credits, owner: (approve ? 'Approved' + (pick.choice ? ' option ' + pick.choice : '') + (pick.credits ? ` (${pick.credits} cr)` : '') : 'Notes') + (note ? ': ' + note : '') }; r.status = 'queued'; r.queuedAt = new Date().toISOString();
      saveRun(r); pump();
      return sendJson(res, 200, { ok: true, status: r.status });
    }
    if (url.pathname === '/api/studio/skill/save') {
      try { return sendJson(res, 200, { ok: true, version: saveSkill(String(body.name || ''), body.md, body.version) }); }
      catch (e) { return sendJson(res, e.code || 400, { error: e.message }); }
    }
    if (url.pathname === '/api/studio/character/save') {
      const c = readCharacter(String(body.slug || ''));
      if (!c) return sendJson(res, 404, { error: 'not found' });
      const md = String(body.md || '');
      if (!md.trim()) return sendJson(res, 400, { error: 'character.md cannot be empty' });
      if (md.length > 200000) return sendJson(res, 400, { error: 'That is too long for a character card' });
      atomicWrite(path.join(charDir(c.slug), 'character.md'), md.endsWith('\n') ? md : md + '\n');
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/studio/character/new') {
      try { return sendJson(res, 200, { ok: true, slug: newCharacter(body) }); }
      catch (e) { return sendJson(res, e.code || 400, { error: e.message }); }
    }
    if (url.pathname === '/api/studio/character/source') {
      const c = readCharacter(String(body.slug || ''));
      if (!c || !c.images.includes(String(body.file || ''))) return sendJson(res, 404, { error: 'not found' });
      setSourcePhoto(c.slug, String(body.file)); return sendJson(res, 200, { ok: true });
    }
    // The grey swap reference (cutout on #d9d9d9) from its main photo, with the free macOS Vision script.
    if (url.pathname === '/api/studio/character/cutout') {
      const c = readCharacter(String(body.slug || ''));
      if (!c) return sendJson(res, 404, { error: 'not found' });
      if (!c.source) return sendJson(res, 400, { error: 'Add its photo first' });
      if (c.cutting) return sendJson(res, 409, { error: 'Already making it' });
      const out = path.join(charDir(c.slug), `${c.slug}_grey.png`), tmp = out + '.tmp.png';
      cutouts.set(c.slug, { running: true });
      execFile('swift', [path.join(GENERATIONS, 'scripts', 'cutout.swift'), path.join(charDir(c.slug), c.source), tmp, 'd9d9d9'], { timeout: 180000 }, (err, stdout) => {
        const ok = !err && fs.existsSync(tmp);
        if (ok) fs.renameSync(tmp, out); else fs.rm(tmp, { force: true }, () => {});
        cutouts.set(c.slug, { running: false, error: ok ? null : (String(stdout || '').trim() || 'The cutout failed') });
      });
      return sendJson(res, 202, { ok: true });
    }
    if (url.pathname === '/api/studio/adopt') {
      const out = await adoptChat(String(body.project || ''), { note: body.text });
      return sendJson(res, out.status, out.json);
    }
    if (url.pathname === '/api/studio/message' && body.project && !body.run) {
      const text = String(body.text || '').slice(0, 2000).trim();
      if (!text) return sendJson(res, 400, { error: 'Write a message first' });
      const out = await adoptChat(String(body.project), { note: text });
      return sendJson(res, out.status, out.json);
    }
    if (url.pathname === '/api/studio/message') {
      const r = runs.get(String(body.run));
      if (!r) return sendJson(res, 404, { error: 'not found' });
      if (closedError(r)) return sendJson(res, 409, { error: closedError(r) });
      const text = String(body.text || '').slice(0, 2000).trim();
      if (!text) return sendJson(res, 400, { error: 'Write a message first' });
      if (!r.started && r.status === 'queued') return sendJson(res, 409, { error: 'This run has not started yet' });
      if (r.status === 'queued' && r.pending) {                     // not started this turn yet: add to it
        r.pending.message += ` The owner also sent a message from the Studio: "${text}". Reply to it too.`;
        r.pending.owner = (r.pending.owner ? r.pending.owner + '\n\n' : '') + text;
        saveRun(r); return sendJson(res, 200, { ok: true, status: 'queued' });
      }
      r.inbox = [...(r.inbox || []), text].slice(-10);
      if (r.status === 'running' || r.proc) { saveRun(r); return sendJson(res, 200, { ok: true, status: 'after-turn' }); }
      queueMessages(r); saveRun(r); pump();
      return sendJson(res, 200, { ok: true, status: r.status });
    }
    if (url.pathname === '/api/studio/step') {
      const project = String(body.project || '').slice(0, 120), pipeline = String(body.pipeline || '').replace('/', ''), step = String(body.step || '').slice(0, 40);
      if (!project || !step || !own(pipelines(), pipeline)) return sendJson(res, 400, { error: 'project, pipeline (video or a swap skill) and step are required' });
      const all = readJsonFile(STEPS_FILE, []);
      const runId = asRun ? asRun.id : null, at = new Date().toISOString(), note = String(body.note || '').slice(0, 200);
      const prev = all.find((x) => x.project === project && x.runId === runId);
      // The files this step made (stills, reels, a test result), shown when the owner opens the step; tagged with the take it belongs to.
      const files = fileList(body.files), item = { step, at, note, take: currentTake(project), ...(files.length ? { files } : {}) };
      const entry = { project, pipeline, runId, step, at, note, history: [...(prev ? prev.history : []), item].slice(-40) };
      writeJsonFile(STEPS_FILE, [...all.filter((x) => x !== prev), entry].slice(-200));
      if (asRun && asRun.project !== project) { asRun.project = project; saveRun(asRun); }
      setTimeout(closeFinishedRuns, 2000);   // its last step may have finished the video
      return sendJson(res, 200, { ok: true });
    }
    // "Redo from this step": a new take that keeps the steps before it and runs that step and everything after it
    // again. A run gets it as its next turn; a chat session is moved into the app with it. Never an approval.
    if (url.pathname === '/api/studio/redo') {
      const project = String(body.project || ''), key = String(body.step || ''), note = String(body.text || '').slice(0, 2000).trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project)) return sendJson(res, 400, { error: 'Unknown video' });
      const r = body.run ? runs.get(String(body.run)) : null;
      if (body.run && !r) return sendJson(res, 404, { error: 'not found' });
      if (closedError(r)) return sendJson(res, 409, { error: closedError(r) });
      const last = readJsonFile(STEPS_FILE, []).filter((x) => x.project === project).pop();
      const pipeline = fs.existsSync(path.join(PROJECTS, project, 'shots.json')) ? 'video' : r ? r.pipeline : last ? last.pipeline : '';
      const list = PIPELINE_STEPS[pipeline] || (pipeline ? SWAP_STEPS : []), k = list.findIndex(([x]) => x === key);
      if (k < 0) return sendJson(res, 400, { error: 'Unknown step' });
      if (k === 0) return sendJson(res, 400, { error: 'To redo the first step, start a new video instead' });
      if (r && (r.proc || ['running', 'queued'].includes(r.status))) return sendJson(res, 409, { error: 'It is working right now. Redo once it stops at a question, or Stop it first.' });
      const n = currentTake(project) + 1, label = list[k][1], prevKey = list[k - 1][0];
      const redo = { message: redoMessage(pipeline, n, label, key, prevKey, note), owner: `Redo from "${label}" as take ${n}` + (note ? ': ' + note : '') };
      let runId = r && r.id;
      if (!r) {
        const out = await adoptChat(project, { redo });
        if (out.status !== 200) return sendJson(res, out.status, out.json);
        runId = out.json.run;
      }
      const at = new Date().toISOString();
      writeJsonFile(TAKES_FILE, { ...readJsonFile(TAKES_FILE, {}), [project]: [...takesOf(project), { take: n, from: key, at, note }].slice(-20) });
      if (pipeline !== 'video') {   // the tracker goes back to the last kept step (a /video project's comes from shots.json)
        const all = readJsonFile(STEPS_FILE, []), prev = all.find((x) => x.project === project && x.runId === runId);
        const item = { step: prevKey, at, note: `Take ${n}: redo from ${label}`, take: n, redo: true };
        writeJsonFile(STEPS_FILE, [...all.filter((x) => x !== prev), { project, pipeline, runId, step: prevKey, at, note: item.note, history: [...(prev ? prev.history : []), item].slice(-40) }].slice(-200));
      }
      if (r) {
        const gates = readJsonFile(GATES_FILE, []), open = gates.filter((g) => g.runId === r.id && !g.cleared);
        if (open.length) { for (const g of open) Object.assign(g, { cleared: at, answer: 'redo' }); writeJsonFile(GATES_FILE, gates); }
        if (r.project !== project) r.project = project;
        r.pending = { message: redo.message, paid: false, owner: redo.owner };
        r.status = 'queued'; r.queuedAt = at; saveRun(r); pump();
      }
      return sendJson(res, 200, { ok: true, take: n, run: runId, moved: !r });
    }
    if (url.pathname === '/api/studio/resume') {
      const r = runs.get(String(body.run));
      if (!r) return sendJson(res, 404, { error: 'not found' });
      if (closedError(r)) return sendJson(res, 409, { error: closedError(r) });
      if (r.proc || !['interrupted', 'failed', 'stopped', 'finished'].includes(r.status)) return sendJson(res, 409, { error: 'Only a stopped, failed, interrupted or finished run can be resumed' });
      const note = String(body.text || '').slice(0, 2000).trim();
      r.pending = { message: r.started ? `Continue where you left off.${note ? ' The owner says: ' + note : ''} If you were waiting at a gate, post it again.` : r.firstMessage, paid: false, owner: 'Resume' + (note ? ': ' + note : '') };
      r.status = 'queued'; r.queuedAt = new Date().toISOString(); saveRun(r); pump();
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/studio/stop') {
      const r = runs.get(String(body.run));
      if (!r) return sendJson(res, 404, { error: 'not found' });
      if (r.proc) { stopRun(r); saveRun(r); } else if (r.status === 'queued') { r.status = 'stopped'; r.pending = null; saveRun(r); }
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/studio/gate') {
      const gates = readJsonFile(GATES_FILE, []);
      // A run can't take over another run's (or a chat session's) gate by reusing its id.
      if (asRun) { const prev = gates.find((x) => x.id === String(body.id) && !x.cleared); if (prev && prev.runId !== asRun.id) return sendJson(res, 403, { error: 'That gate belongs to another session' }); }
      const g = { id: String(body.id || crypto.randomBytes(6).toString('hex')).slice(0, 64), at: new Date().toISOString(),
        pipeline: String(body.pipeline || '').slice(0, 20), project: String(body.project || '').slice(0, 120),
        title: String(body.title || 'Waiting for you').slice(0, 200), detail: String(body.detail || '').slice(0, 600),
        credits: body.credits == null ? null : String(body.credits).slice(0, 20),
        runId: body.runId ? String(body.runId).slice(0, 40) : null,
        images: Array.isArray(body.images) ? body.images.map((x) => path.resolve(GENERATIONS, String(x))).filter(studioFileAllowed).slice(0, 12) : [],
        options: gateOptions(body.options) };
      const rest = gates.filter((x) => x.id !== g.id);
      rest.push(g); writeJsonFile(GATES_FILE, rest.slice(-200));
      // The run's video, for In progress: it keeps it after the gate is answered.
      const gr = g.runId && runs.get(g.runId); if (gr && g.project && gr.project !== g.project) { gr.project = g.project; saveRun(gr); }
      notify('Waiting for you · ' + (g.project || g.pipeline), g.title + (g.credits ? ` · ${g.credits} cr` : ''));
      return sendJson(res, 200, { ok: true, id: g.id });
    }
    if (url.pathname === '/api/studio/gate/clear') {
      const gates = readJsonFile(GATES_FILE, []);
      for (const g of gates) if (g.id === String(body.id) && !g.cleared && (!asRun || g.runId === asRun.id)) g.cleared = new Date().toISOString();
      writeJsonFile(GATES_FILE, gates);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'not found' });
  }
  sendJson(res, 404, { error: 'not found' });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Video library running at http://localhost:${PORT}`);
});
