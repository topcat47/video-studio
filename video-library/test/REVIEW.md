# App review, 2026-10-24: every finding, its fix, and its proof

Three reviews (server, pages, Mac app), then a fresh second review of the fixed code (section 4).
Run the proof: `node --test --test-concurrency=1 video-library/test/*.test.js` (55 tests) and, for the Mac
app, `RUN_APP_TESTS=1 node --test video-library/test/app.test.js video-library/test/app-real.test.js` (6 tests, opens a window).
Last full run: 2026-10-24, after the usability review's fixes: main 58/58, app + real-server + UI 23/23 inside the
real app (16 UI), live sandbox 1/1 with the real claude. App tests use the separate test build
(`scripts/build-studio-app.sh --test`); the real app ignores test settings.

Test files: `library.test.js` (L), `studio.test.js` (S), `pages.test.js` (P), `app.test.js` (A, fake server),
`app-real.test.js` (R, real server through a read-only proxy), `ui.test.js` (U, both pages driven inside the real app's WebKit). Rows below that once said "Browser" were first checked by hand; each is now a U test
against `test/ui-server.js` sample data (steps in the session; the checks are written as JS assertions).

## 1. Server (`server.js`)

| # | Finding | Fix | Proof |
|---|---|---|---|
| 1 | Any throw in the async handler crashed the server (null bodies, `constructor/x` ids, stream errors, stat races, missing html) | try/catch around every request, `own()` lookups, `sendFile`/`pipeline` with error handlers, stats in try | L "malformed requests never take the server down", S "studio-cast…", S "lookups keyed by user input ignore built-in names" |
| 2 | CSRF on `/api/label`, `/api/post`, `/api/trash`, `/api/reveal`, `/api/finds/delete`; folder ids trashable; DNS rebinding | Origin check on every POST, Host check on every request, ids must be real files of the right type | L "other websites cannot change the library (CSRF)", L "DNS-rebinding guard", S "folders and non-video files are never treated as videos" |
| 3 | Missing `claude` binary / stdin EPIPE crashed the server | `proc.on('error')`, `stdin.on('error')`, run marked failed | S "a missing claude binary fails the run instead of crashing the server" |
| 4 | labels.json non-atomic, corrupt file read as `{}` and overwritten; link-original.js same | atomic writes, `readLabelsForWrite` refuses a corrupt file; link-original.js saves through the server | L "labels file is never left half-written or wiped", L "link-original.js links through the running app" |
| 5 | Stop → immediate resume → two processes on one session; stale close handler clobbers the new turn | resume/answer refuse while `r.proc`; close handler ignores itself when superseded | S "background runs: at most 2 at a time… Stop works" (early resume refused or safe) |
| 6 | Stop only killed claude, not its children | detached process group, SIGTERM then SIGKILL after 5 s | S "background runs…" (pid null after stop) |
| 7 | Queued runs never started after a restart | `pump()` after loading runs | S "after a restart: … queued ones start by themselves" |
| 8 | Transcripts never retried; tool failures cached as "no speech" | queue key is path+size+mtime, failures write nothing and retry after 10 min | L "transcripts: a tool failure stores nothing and is retried…" (fake whisper-cli) |
| 9 | File descriptors leaked on client abort | `stream.pipeline` destroys the source | L "video streaming…" (range/abort paths) |
| 10 | `bytes=-N` suffix ranges served the wrong bytes | suffix handled | L "video streaming… suffix range" |
| 11 | Thumbnails: partial files cached, unlimited ffmpeg | temp file + rename, in-flight dedupe, 3 at a time | L "thumbnails: many at once… at most 3… same file twice" |
| 12 | A background run could approve its own (or another's) priced gate | Owner-only routes need a local browser Origin and the owner token; each run has its own token limited to its own gates; **runs' shell commands are sandboxed** (OS-enforced: the token file can't be read, Anthropic can't be reached so no second unguarded Claude, only pipeline sites allowed, the model can't switch it off); the token is no longer in the Studio page (the Mac app supplies it); WebFetch/WebSearch removed from runs. | S "runs get their own token…" (settings), live: `test/live-sandbox.test.js` with the real claude (cat/python → Operation not permitted, Read denied, Anthropic blocked, Studio + Higgsfield reachable), A/R token supplied by the app, never in /studio, never to other frames |
| 13 | `started` set before the session existed → `--resume` of nothing | `started` set on first output | S "a missing claude binary…" (started stays false) |
| 14 | A second answer replaced a queued one | 409 while queued | S "a second answer while the first is still queued is refused" |
| 15 | `timingSafeEqual` could throw on odd token bytes | compare byte buffers | S "write calls need the token and this origin" |
| 16 | UTF-8 split across chunks | `setEncoding('utf8')` on bodies and claude output | S "text split mid-character by the pipe arrives intact" |
| 17 | Whole log read every 5 s; projects re-read every 5 s | log tail (2 MB); project summaries cached until files change | S "run log: only the tail is read", S "projects are re-read only when their files change" |
| 18 | Parallel Terminal starts lost session entries | read+write after the await, in one step | S "parallel Terminal starts are all recorded" (fails on the old server) |
| 19 | Relative gate image paths stored unresolved | stored resolved | S "gates: studio-gate.sh opens…" |
| 20 | `constructor`/`__proto__` accepted as account/pipeline | `own()` | S "lookups keyed by user input…" |
| 21 | Symlinks could escape runs/ and projects/ | realpath check | S "gate images: a symlink inside runs/ that points outside is refused" |
| 22 | "Today" was the UTC day; malformed rows counted as jobs | local day, only parsed rows count | S "spend 'today' is the local day" |

## 2. Pages (`studio.html`, `index.html`)

| # | Finding | Fix | Proof |
|---|---|---|---|
| 1 | Studio redraw every 5 s wiped selection, focus, open log position, reloaded images | `setHtml` only on change, log keeps scroll unless at bottom, focus restored | U "studio: background run through the page…" (selection survives the refresh) and U "studio: Open in Terminal…" (log keeps its place) |
| 2 | Sent notes pre-filled into the next gate with the same id | drafts deleted on success | U "studio: background run through the page…" (note box empty on the re-posted gate) |
| 3 | Blur re-render swallowed the next click | `renderSoon()` waits for pointerup | U "library: Approve and Posted save; one click works right after leaving an unchanged editor…" |
| 4 | Window focus reload restarted playing media | reload skipped when data unchanged | U "library: coming back to the window does not restart a playing video" |
| 5 | Description / source link / "Used in" not keyboard reachable | `role=button` + tabindex + Enter/Space, `href` on chips | U "library: Approve and Posted…" (Enter opens the description editor) |
| 6 | Review panel not a dialog, focus lost on every action, details closed | `role=dialog`, focus in/out, Tab trapped, focus and open sections kept | U "library: review panel is a dialog; focus moves in, stays on the pressed button, and returns to the tile on Esc" |
| 7 | Studio layout 641–780 px: full-height sidebar | breakpoint at 780 px, compact bar | U "studio: narrow windows: a short bar at 720 px, nothing sideways at 375 px" |
| 8 | Library writes open to other sites | server Origin check (1.2) | L "CSRF" |
| 9 | Armed Delete overflowed the panel | `.row` wraps | U "library: narrow windows: posted rows and the armed Delete never spill out…" |
| 10 | "Where it's posted" rows overflowed | flex-wrap | U "library: narrow windows…" (3 long rows at 1000 px and 375 px) |
| 11 | Light native controls on the dark page | `color-scheme: dark` | U "library: dark native controls, load failure message, delete by id…" |
| 12 | Delete filtered by object identity | filter by id | U "library: dark native controls, load failure message, delete by id…" |
| 13 | Saves ignored server refusals | `api()` always returns `{error}`; every save alerts and rolls back | U "library: refused saves show why and undo the change…" |
| 14 | First load had no error handling | load() catches, keeps the screen, shows a message | U "library: dark native controls, load failure message…" |
| — | Data from the server put into HTML unescaped | (none found) | P "studio.html escapes everything…", U "library: file names and descriptions from the server never run as code", U "studio: escapes project data…" |
| — | Page scripts or API routes broken | — | P "scripts compile", P "every API route it calls exists" |

## 3. Mac app (`desktop/VideoStudio.swift`, `scripts/build-studio-app.sh`)

| # | Finding | Fix | Proof |
|---|---|---|---|
| 1 | Cancelled loads treated as "server down" + `kickstart -k` killed the server and its runs | only connection errors count; `kickstart` without `-k` | A "…ignores cancelled loads", A/R one kickstart, no `-k` |
| 2 | Window released on close → crash on reopen | `isReleasedWhenClosed = false` (old code did not crash on macOS 26, kept as a safeguard) | A close/reopen ×3, R close/reopen ×2 on the real Studio |
| 3 | Error page reset the retry; fixed 3 s wait | `showingErrorPage`, wait up to 15 s for the server | A "server down at launch…", A/R "error page… Try again" |
| 4 | YouTube iframe sent to the browser | subframes load in place | A "links, frames and downloads…" (outside frame loads in place) |
| 5 | `target=_blank` replaced the Studio | new-window links open in the browser | A "links, frames and downloads…" |
| 6 | `README 2.` download names | extension only when present | A: downloads land as `clip.mp4`, `clip 2.mp4`, `README`, `README 2` |
| 7 | Silent download failures | alert | A: a broken download raises "Download failed" |
| 8 | Content under the toolbar | dropped `fullSizeContentView` | R: page frame equals the window's content area below the toolbar; plus the app's own picture of its window on the real Studio |
| 9 | Retry lost the current URL | retries the failed URL | R Try again returns to the real Studio |
| 10 | arm64 hard-coded | `uname -m` | build log |
| 11 | Build script failure modes | icon check, signature verify, safe swap, relaunch | build log |
| 12 | Badge stale after activation | refresh on activate | A/R badge equals the waiting count, clears at 0 |

## 4. Second review of the fixed code (fresh reviewers, same day)

| # | Finding | Fix | Proof |
|---|---|---|---|
| 4.1 | Runs could still approve their own price (they can read the owner token with Bash) | per-run tokens, Bash sandbox for runs, token out of the page (see 1.12) | live sandbox test + A/R |
| 4.2 | Paid guard failed open (Claude Code only blocks on exit 2; a missing python3 or a crash allowed the call) | hook wrapped: anything but 0 → 2; absolute python path; exceptions → 2 | S "paid guard fails closed…"; checked on the live settings (blocked, exit 2) |
| 4.3 | One `get_cost` anywhere let a whole batch through | every job must be a price check; a flag beside real settings doesn't count | S "paid guard: a batch passes only if every job is a price check" |
| 4.4 | studio-gate.sh said "open" when the Studio refused | HTTP code checked, refusal reported | S "studio-gate.sh says so when the Studio refuses the gate" |
| 4.5 | A growing file was sent past its announced length | read exactly Content-Length bytes | L "a file still being written is sent at exactly its announced length" |
| 4.6 | A leftover child holding the pipes kept a run "running" | finish 2 s after claude exits, end the group | S "a run whose leftover child holds the output still finishes" |
| 4.7 | Two first ledger writes could lose a row | header + row under one file lock | S "spend ledger: parallel first writes keep every row and one header" |
| 4.8 | "Open in Terminal" stayed disabled | re-enabled on success | U "studio: Open in Terminal re-enables…" |
| 4.9 | An open log jumped to the bottom when the run list changed | scroll saved and restored around the redraw | U "studio: Open in Terminal… an open log keeps its place…" |
| 4.10 | Focus went to the first row's × (could remove the wrong post) | focus restored by kind and position | U "library: focus stays on the same row's × and that row is the one removed" |
| 4.11 | A refused approve kept `approvedAt` | extra fields rolled back too | U "library: refused saves… (approve with its time)" |
| 4.12 | `pointercancel` could leave a redraw waiting | handled | U "library: a cancelled press still lets the page redraw" |
| 4.13 | Error-page flag could go stale on a double navigation | error page recognised by its title, no flag | A "server never comes back… Try again", R real-server Try again |
| 4.14 | Found in the window picture: the sidebar highlighted **Runs** at the top of the page in the app (the highlight ran before data arrived, when the page was short, and WebKit slows timers in background windows) | highlight re-checked after every redraw; "at the bottom" only after you've scrolled; a clicked link stays until you scroll | U "studio: escapes project data; styled radios; sidebar highlight right at load, on click…"; R picture |
| 4.15 | Found in the window picture: unstyled radio buttons | explicit size and accent colour (the dot-only look in the picture is macOS's inactive-window style) | U "studio: … styled radios …" (16 px, accent colour set) |

## 5. Final review of the last changes

| # | Finding | Fix | Proof |
|---|---|---|---|
| 5.1 | High: a run could change the app with file tools (Studio page, server, its own sandbox settings, the paid guard, the token file) | sandbox `denyWrite` and `Edit(...)` deny for `video-library/`, `scripts/`, `.claude/`, `.mcp.json`, `CLAUDE.md`, `SETUP-PROMPT.md`, `.git`; settings rewritten before every turn | S "runs get their own token…" (settings), live: `touch` in video-library/ and scripts/ → Operation not permitted, Write tool denied, run folder writable |
| 5.2 | Medium: the real app honoured `VIDEO_STUDIO_URL` etc. (token sent to any server, test channel on) | overrides compiled only into a separate test build (`-D STUDIO_TEST`, own bundle id, `test/.build/`) | A "the real app ignores test settings…": launched with them, nothing reached the given server |
| 5.3 | Low: run tokens saved in run.json | kept in memory only | S "runs get their own token…" (not in run.json) |
| 5.4 | Low: the guard let unknown tools and unreadable input through | known free tools only; everything else (new names, posting tools) needs a price check or an approved turn; bad input blocked | S "paid-guard hook…" |

## 6. Real-data check and usability review

A read-only check of the real library (all 194 videos: thumbnails, seeking, originals, song links, finds) and a
usability / accessibility / speed review.

| # | Finding | Fix | Proof |
|---|---|---|---|
| 6.1 | Five real videos showed "Original missing": their originals are pictures (a tweet screenshot, a poster), which the app refused | originals may be .jpg/.png/.webp: served as images, shown as a picture in the panel, thumbnails made, pickable | L "an original can be a picture…", U "library: a picture original shows as a picture…"; real library: all 5 now show their original |
| 6.2 | ← / → died after ticking Posted/Approved/Archive in a filtered tab (video left the list) | the open video keeps its place while the panel is open | U "library: ← / → keep working after a tick…" |
| 6.3 | Sidebar clicks lost keyboard focus; nav state only in CSS | focus restored; `aria-current`, `aria-pressed`, search field named, result count announced, finds Play buttons named | U "library: ← / → …" (tab focus, search label) |
| 6.4 | X quote "Copy" said "Copied ✓" even when it failed | uses the same copy-with-fallback as links and says "Copy failed" | U "library: Copy tells the truth…" (success and failure) |
| 6.5 | "Set original" picker went stale, could hang on "Loading…", hid the 80-item cap | fetched fresh each time, errors shown, "Showing 80 of N" | U "library: Copy tells the truth; picker refreshes, shows errors and its cap…" |
| 6.6 | Misleading text: songs/finds empty states, "Show archive", "In progress", transcribing count counted untranscribable videos | wording fixed; transcribing count from the transcriber itself, refreshed during a search | U "library: … honest empty states; transcribing note from the transcriber…" |
| 6.7 | `/` jumped behind the open panel; Delete dropped you back to the grid | `/` ignored while the panel is open; Delete opens the next video | U "library: ← / → …" |
| 6.8 | Low-contrast text (`--dim` ≈3.1:1); blank posters when ffmpeg fails | `--dim` raised; "No preview" placeholder | P "library: secondary text colours meet AA contrast…", U "… "No preview" posters" |
| 6.9 | Studio refetched every image each minute (the "ago" text rebuilt the lists); full-size renders as card thumbnails | "ago" updated in place; images revalidated (ETag/304); cards get a 360 px poster | S "Studio images are revalidated…", U "studio: the refresh keeps images and focus…" |
| 6.10 | Gate buttons lost focus on redraw; read-only browser tab looked live; errors shown far from the click; static "Server on"; disabled Approve unexplained | focus restored; read-only tab dims controls; errors beside the button; live server dot; "still finishing its turn" note; contrast of red fills; radios use arrow keys; images and progress bars labelled; poll pauses when hidden | U "studio: the refresh keeps images and focus; a plain browser tab (no token) is read-only", P "studio: text on the red fills meets AA…" |
| 6.11 | A gate whose run was older than the 20 newest showed the wrong button | runs that own an open gate are always listed | S "a run with an open gate is always listed…" |
| 6.12 | Docs drifted: `kickstart -k` in /run-videoapp, approval wording, gate script signature, protected paths, folder/archive names | CLAUDE.md and the skill updated (plus what to do if macOS blocks node's Desktop access) | P "docs match the app…" |
| 6.13 | Found while fixing: a find-and-replace made the Studio's time helper call itself (page couldn't draw) | fixed | U Studio tests (caught it) |
| — | Three old cards point at videos that no longer exist anywhere | data, not code: left as is (they show nowhere) | real-data check |

