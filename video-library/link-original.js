// Link a conversion to its original in the video library.
// Usage: node video-library/link-original.js <conversion.mp4> <original.mp4>
// Copies the original into the originals/ folder next to the conversion (<Subject>/originals/; never moves or
// overwrites), then records the link in video-library/labels.json (through the running app when it's up).
const fs = require('fs');
const path = require('path');
const { ROOT: GENERATIONS, subjects, folders } = require('./config');
const SUBJECTS = subjects();
const FOLDERS = folders(SUBJECTS);
delete FOLDERS.songs;
const LABELS_FILE = path.join(__dirname, 'labels.json');

const [conversionArg, originalArg] = process.argv.slice(2);
if (!conversionArg || !originalArg) {
  console.error('Usage: node video-library/link-original.js <conversion.mp4> <original.mp4>');
  process.exit(1);
}
const conversion = path.resolve(conversionArg);
const original = path.resolve(originalArg);
for (const f of [conversion, original]) {
  if (!fs.existsSync(f)) { console.error(`Not found: ${f}`); process.exit(1); }
}

const folder = Object.keys(FOLDERS).find((k) => FOLDERS[k] === path.dirname(conversion));
if (!folder) {
  console.error(`The conversion must sit directly in one of the library folders (${Object.values(SUBJECTS).join(', ')}) or the top level.`);
  process.exit(1);
}
const ORIGINALS = path.join(SUBJECTS[folder] ? FOLDERS[folder] : GENERATIONS, 'originals');

// Copy the original into originals/ unless it is already there; add -2, -3… instead of overwriting.
let stored = original;
if (path.dirname(original) !== ORIGINALS) {
  fs.mkdirSync(ORIGINALS, { recursive: true });
  const ext = path.extname(original);
  const base = path.basename(original, ext);
  stored = path.join(ORIGINALS, base + ext);
  for (let n = 2; fs.existsSync(stored); n++) {
    if (fs.statSync(stored).size === fs.statSync(original).size) break; // same file already copied
    stored = path.join(ORIGINALS, `${base}-${n}${ext}`);
  }
  if (!fs.existsSync(stored)) fs.copyFileSync(original, stored);
}

// Record the link through the running app, so its own saves and this one never overwrite each other.
// Only when the app is down does this write labels.json itself (atomically, and never over a corrupt file).
const id = `${folder}/${path.basename(conversion)}`;
const done = () => console.log(`Linked ${id}\n  original: ${stored}`);
const body = JSON.stringify({ id, original: stored });
const req = require('http').request({ host: '127.0.0.1', port: Number(process.env.STUDIO_PORT) || 4420, path: '/api/label', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 5000 }, (res) => {
  let out = ''; res.on('data', (c) => (out += c));
  res.on('end', () => {
    if (res.statusCode === 200) return done();
    console.error(`The video app refused the link (${res.statusCode}): ${out}`); process.exit(1);
  });
});
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', () => writeDirectly());
req.end(body);

function writeDirectly() {
  let labels = {};
  try { labels = JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') { console.error(`labels.json can't be read (${err.message}); not overwriting it. Fix it first.`); process.exit(1); }
  }
  labels[id] = { ...labels[id], original: stored };
  const tmp = `${LABELS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(labels, null, 2));
  fs.renameSync(tmp, LABELS_FILE);
  done();
}
