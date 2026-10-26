// Starts a throwaway copy of the app with sample data for checking the pages in a browser:
//   node video-library/test/ui-server.js      → prints the URL; Ctrl-C stops it and deletes the data.
// Same isolation as the tests (temp home, fake claude and osascript).
const fs = require('fs');
const path = require('path');
const { startServer, makeVideo } = require('./harness');

(async () => {
  const s = await startServer({
    fixtures: ({ gen, lib }) => {
      makeVideo(path.join(gen, 'Alpha', 'alphaclips - alpha-cat-swap.mp4'));
      makeVideo(path.join(gen, 'Alpha', 'originals', 'alphaclips - 123.mp4'));
      makeVideo(path.join(gen, 'Beta', 'evil <img src=x onerror=window.__xss=1> name.mp4'));
      fs.writeFileSync(path.join(lib, 'labels.json'), JSON.stringify({
        'alpha/alphaclips - alpha-cat-swap.mp4': { description: 'Alpha Cat <script>window.__xss=2</script> on a couch.',
          original: path.join(gen, 'Alpha', 'originals', 'alphaclips - 123.mp4'), xQuote: 'Frame stays sharp', sourceUrl: 'https://www.tiktok.com/@alphaclips/video/123' },
      }, null, 2));
      fs.writeFileSync(path.join(lib, 'alpha-finds.json'), '[]');
      fs.writeFileSync(path.join(lib, 'beta-finds.json'), '[]');
      const p = path.join(gen, 'projects', 'cat-dj');
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 'shots.json'), JSON.stringify({ shots: [{ id: 's1', status: 'concept-ok' }] }));
      fs.writeFileSync(path.join(p, 'brief.md'), '- Concept: Cat DJ <b>on a roof</b>\n');
    },
  });
  console.log(s.base);
  const bye = async () => { await s.stop(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
})();
