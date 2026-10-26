# Video Studio

The hub for every video made with your characters: the cast, the skills that make the videos, the scripts, and the library of finished work, plus a Mac app (the Video Studio) to start sessions, answer approvals and browse the library.
New here? Run `./setup.sh`, then `/setup` in Claude Code (see `README.md`). Your own settings live in `studio.config.json` (gitignored; `studio.config.example.json` documents every field).

## Characters
The cast is in **`characters/`**, one folder per character, with a roster and the rules for every character in `characters/README.md`. Read it before any character work.
- Each character looks exactly like its source photo, and has no human parts (rules in `characters/README.md`).
- A starring character gets its own swap skill (`/<skill> <link>`) made from `templates/swap-skill/` with `scripts/new-swap-skill.sh`, and its own library folder.

## Skills and helpers
| Skill | What it does |
|---|---|
| `/setup` | First-time setup after `./setup.sh`: checks the tools, connects Higgsfield and the optional apps, makes your first character and its swap skill |
| `/video <idea>` / `/video resume <slug>` | Original video from an idea: storyboard + concept frames → Blender → Higgsfield → edit (FilmCraft, or ffmpeg for a simple cut), in `projects/<slug>/` |
| `/<character skill> <link or file>` | Swaps the public person it names for that character (`templates/swap-skill/SKILL.md`); video in the skill's `folder:`. Its `SKILL.md` has `character:`, `swaps:` and `folder:` in the frontmatter, which makes it a start button on the Studio page, a library folder and a step tracker. Made in a chat session (background runs can't write `.claude/`). |
| `/run-videoapp` | Open the always-on library app (http://localhost:4420) and the Video Studio (`/studio`), restarting the server if it's down |

Subagents in `.claude/agents/`: swap helpers (`swap-mapper`, `reel-builder`, `swap-reviewer`, `swap-assembler`, `library-filer`) for the character swap skills; production helpers (`scene-builder`, `frame-fixer`, `clip-reviewer`, `graphics`, `editor`) for `/video`. The skill is always the orchestrator: only it talks to the owner and spends credits.
Scripts are in `scripts/` (swap scripts in `scripts/swap/`; run Python ones with `python3 -I`). `.mcp.json` (written by `setup.sh` from `.mcp.example.json`) holds the FilmCraft, EffectCraft and PhotoCraft servers (headless + live-app bridge each); Blender is the user-level `higgsfield-use-blender` server. The three Craft apps are optional, free steps: FilmCraft colour-matches AI shots to the source in a swap when they read as inserts (swap step 9b) and does `/video` edits that need it (else ffmpeg), EffectCraft makes `/video` graphics only when there are words on screen, PhotoCraft only fixes a `/video` frame (step 3c). Every skill works without them.

## Video Studio

**The Video Studio app** (`~/Applications/Video Studio.app`, built by `setup.sh`; the same page at http://localhost:4420/studio is read-only in a browser, because the page doesn't carry the token and only the app supplies it): start a `/video` or character-swap session on the **Studio** page (it always runs inside the app as a background run), and follow everything being made on **In progress**: one card per video, with its step, latest frame, credits and sessions; a card waiting on the owner turns lime and carries the question. Finished, filed videos are in the Library (⌘2). It only listens on 127.0.0.1, and its write calls need the token in `video-library/.studio-token` (never print or commit it).
- **Every gate goes to the Studio.** Right before you stop to ask the owner anything (a price, a still, a shot, a final), run `scripts/studio-gate.sh open <project>:<gate> <pipeline> <project> "<what you're asking>" [credits] ["<short detail>"] [image …]`; it shows a macOS notification and turns that video's card lime. An `image` can also be a video (a test result, a final): it plays in the card. A question that is a choice gets one `--option "<id>[*]|<name>|<why>|<picture>|<credits>"` per choice (`*` = recommended): **Approve** names the pick and approves exactly that option's price. When the owner has answered, `scripts/studio-gate.sh clear <project>:<gate>`. **In a chat session, right after `open`, start `scripts/studio-gate.sh wait <project>:<gate>` as a background command** and end your turn: when the owner answers in the Studio the command ends and its output wakes you up; treat it exactly like their answer in chat.
- **Every session reports its step:** `scripts/studio-gate.sh step <project> <pipeline> <step>` each time its stage changes (swaps: their `state.json` stages; `/video`: once, then `shots.json` drives it). Add the files that step made after a note (`step <project> <pipeline> <step> "<note>" [file …]`): on the video's page every step is clickable and shows them. A finished step has **Redo from this step**: a new take (take 2, 3…) that keeps the steps before it and every file of the earlier take; its paid steps ask the price again. In progress groups everything by that `<project>` name, so use the same name for gates, steps and `spend.sh`.
- **Characters** (Studio sidebar): a card per `characters/<name>/` folder; pick the main photo, add photos, make the grey cutout (free), edit `character.md`. "New character" makes the folder, a `character.md` and a roster row.
- **Skills** (Studio sidebar): a card per skill the Studio starts; its `SKILL.md` split at the `## ` headings, each part editable on its own. A save names the version it was opened from (a change made meanwhile is never overwritten); the replaced version goes to `.skill-history/<name>/`.
- **Finished videos close their sessions:** once a video's last step is done with nothing open and nothing working, the server marks its background runs `done`.
- **Every paid job goes in the ledger:** right after submitting it, `scripts/spend.sh <project> <skill> <job id> <model> <credits>` (one row in `spend.csv`; the Studio totals it per project and per day).
- **Background runs** (up to 2 at a time) are `claude -p` sessions working in `runs/<id>/work/`, with `STUDIO_RUN_ID` set. They never ask in chat: they post the gate with their own run token and end their turn, and the owner's Approve or Notes in the Studio resumes them. Their shell commands run in Claude Code's sandbox: no access to `.studio-token`, no Anthropic (no second Claude), only the sites in `RUN_SITES` in `server.js`. Runs also can't change `video-library/`, `scripts/`, `.claude/`, `.mcp.json`, `CLAUDE.md`, `studio.config.json`, `setup.sh` or `.git` (shell or file tools), so a skill step that edits notes, rules or skills has to happen in a chat session. A hook (`scripts/studio-paid-guard.py`) blocks every paid Higgsfield call in them except `get_cost` price checks, unless the turn was started by an Approve on a priced gate. The Higgsfield MCP's tool prefix is `higgsfieldMcp` in `studio.config.json` (`/setup` finds it).
- **Buffer section** (`/buffer`, ⌘3; optional): Buffer's Queue, Sent and Drafts for every channel, each post matched to its Library card, and "Not scheduled" = approved videos with no post anywhere. It only reads Buffer (official GraphQL API); the owner pastes a personal API key on its page (kept in `video-library/.buffer-key`, 0600, gitignored, denied to background runs). Comments and "Schedule on Buffer" drive Buffer's own pages in the owner's Chrome, and a reply or post goes out only on the owner's click on that exact text. Which accounts and voice each character's videos use: `brands` in `studio.config.json`.

## The app's code (server, pages, Mac app)

No build step, no dependencies, no `package.json`: the server is Node's standard library only (CommonJS), and the pages are one file each with inline `<style>` and `<script>`. `node --check <file>` is the only lint. Keep it that way, and add a feature by editing these files.

| File | What it is |
|---|---|
| `video-library/server.js` | The whole backend: the **library** (listing, labels, streaming, thumbnails, transcripts), the **Studio** (projects, gates, session launcher), then **background runs**. One `handle(req, res)` at the bottom dispatches on exact `url.pathname`, so `grep -n "pathname ===" server.js` is the route map. |
| `video-library/config.js` | Reads `studio.config.json` once at start (restart the server after editing it). |
| `video-library/index.html` | The library page (http://localhost:4420). Tabs are real pages: `#/videos/<tab>[/<folder>]`, `#/songs`, `#/finds/<section>`. |
| `video-library/studio.html` | The Studio page (`/studio`). Served with `__STUDIO_TOKEN__` replaced by `''`: the Mac app hands the page the real token, which is what makes a browser tab read-only. |
| `video-library/buffer*.js`, `buffer.html` | The Buffer section. |
| `video-library/desktop/VideoStudio.swift` | The Mac app: a `WKWebView` around 127.0.0.1:4420 with a Dock approval badge. Only a Swift change needs a rebuild (`scripts/build-studio-app.sh`). |
| `video-library/link-original.js` | CLI that links a conversion to its original *through the running server*, never by writing `labels.json` directly. |

**The server is launchd's, not yours.** `setup.sh` installs a LaunchAgent (label = `agent` in `studio.config.json`; `RunAtLoad`, `KeepAlive`, log `~/Library/Logs/video-studio.log`). After changing `server.js`, restart it with `launchctl kickstart gui/$(id -u)/<label>` (plain first; `-k` only if it is running but still not answering after ~15 s, because `-k` also kills background runs). Never run `node video-library/server.js` yourself — see `/run-videoapp`. `STUDIO_PORT` moves it off 4420, which is how the tests run many copies at once.

### Who may write (three layers, easy to break by accident)

1. **Every POST** whose `Origin` header exists and is not `http://localhost:4420` / `http://127.0.0.1:4420` gets 403. There is also a `Host` check on every request (DNS rebinding), and all lookups keyed by user input go through `own()` so an id like `constructor` cannot reach a prototype key.
2. **`/api/studio/*` POSTs** additionally need the `X-Studio-Token` header, compared with `crypto.timingSafeEqual` against `video-library/.studio-token` (mode 0600, gitignored, generated on first start).
3. **Owner-only actions** (approve, notes, resume, stop, messages, characters, skills, and the Library's "Delete permanently") additionally need `fromStudioPage(req)`: a real localhost `Origin`, which only the page itself sends. A background run holds a token and uses `curl` (no `Origin`), so it can post and clear its own gates but can never approve a price.

### Data model

`video-library/labels.json` is the library's only database, keyed `<folder id>/<file>` (`other/`, a character skill's name, or `generations/` for Unsorted). Per-entry fields: `description`, `original`, `sourceUrl`, `xQuote`, `posts[]`, `approved`/`approvedAt`, `posted`, `status`, `note`, `usedIn`. The key is the path, so a rename or `mv` loses the card. Every JSON write goes through `atomicWrite`, and `readLabelsForWrite` refuses a corrupt file rather than overwriting it. Don't hand-edit these while the server is running; POST to `/api/label` instead. `.thumbs/` and `.transcripts/` are caches the server rebuilds. Runtime state is gitignored.

### Tests

Everything runs on `node:test`. **Serial is required** (`--test-concurrency=1`).

| Command | What it does |
|---|---|
| `node --test --test-concurrency=1 video-library/test/*.test.js` | The full suite (the gated ones below are skipped unless switched on). |
| `node video-library/test/ui-server.js` | A throwaway app with sample data and a printed URL, for clicking through the pages by hand. |
| `RUN_APP_TESTS=1 …` | `app.test.js`, `app-real.test.js`, `ui.test.js` drive the real app's WebKit (build the test app first: `scripts/build-studio-app.sh --test`). |

`test/harness.js` is why these are safe to run any time: each test spawns a **copy** of `server.js` under a throwaway `HOME` with a fake `claude`, and the real library is never read or written. `video-library/test/pages.test.js` also reads this file: keep the phrases it asserts on.

## Where videos live

- **Every new video goes in its subject folder:** a character's own folder (its swap skill's `folder:`) or `Other/`, flat inside (no deeper subfolders, or the app won't list it). Untouched source clips go in `<Folder>/originals/`, named `<source handle> - <post id>.mp4`. Pictures go in `<Folder>/pictures/` (the app lists only videos).
- The app lists anything left at the top level as **Unsorted**.
- Naming: conversions `<source handle> - <character>-swap.mp4`; `-v2` for a second finished version, `-REJECTED-<reason>` for a failed take, `-PREVIEW` or `-test` for a partial preview, `-partN` for a piece. Don't rename existing videos: the card is keyed by the file name. To move one, stop the server, `mv` it, re-key its entry in `labels.json`, start the server (back up `labels.json` first).
- Finding a video: in the app press `/` and search (file names, descriptions and what's said). The sidebar's Folders list filters by folder. Videos older than `newSince` in `video-library/settings.json` are under the "Archive" toggle at the top. From the terminal: `curl -s localhost:4420/api/videos`.
- Not storage: `~/Downloads` and session scratchpads. Anything worth keeping gets saved into its subject folder with a card.

## Cost approval before every paid generation

- **Before any paid generation, tell the owner the cost and wait for their approval.** Covers swaps, re-rolls, redos, fixes, stills and any other paid model.
- Preflight every job with `get_cost: true` (at 480p for video) and list the jobs, the credits each, the total and the current balance. Submit nothing until the owner says yes in chat, or clicks Approve on that priced gate in the Studio.
- An approval covers only the jobs listed. A redo or extra job is a new cost: ask again, even mid-task, even if it is cheap.
- Free steps don't need approval: ffmpeg cuts and stitches, frame checks, `get_cost` preflights, uploads, the Craft apps, the 1080p finish.
- **Test the hardest few seconds first** on every new clip (about 12 credits) and ask approval for the test and for the full run separately.
- **Check the credit total afterwards** against Higgsfield's transaction list: another session can be spending at the same time.

## Original + conversion, always together

The owner reviews every conversion side by side with its original in the library app, so every time you convert a video (character swap, edit, crop, music overlay, stitch, snip), before you report it done:

1. **Keep the original** in the `originals/` folder of the conversion's subject folder. Never move or delete the source.
2. **Save the conversion and link it:** `node video-library/link-original.js <conversion.mp4> <original.mp4>` (copies the original next to it, no overwrites, and records the link).

- The original is the **real source footage**, not an intermediate. If you can't find it, say so. Don't link a guess.
- Tell the owner both file names in the reply: original → conversion.

## Keep the library app up to date

After every new video:
1. Save it directly in its subject folder.
2. Link its original (above), and record the exact source URL the owner gave you: POST `{"id":"<folder>/<file>","sourceUrl":"https://…"}` to `http://localhost:4420/api/label`.
3. If it uses a song, the song must be in the songs folder (`songsDir` in `studio.config.json`, default `songs/`); add the video to the song's "Used in" with a POST of `{"id":"songs/<file>","usedIn":[…all video ids…]}`.
4. **Write its description** (1–3 plain sentences, max ~300 chars: which character is on screen, what happens and where, a key line said, the kind of video) and POST `{"id":"<folder>/<file>","description":"…"}` (build the JSON with python so quotes are escaped).
5. Check it appears: `curl -s localhost:4420/api/videos` lists it with `archived: false`. If the server doesn't answer, follow `/run-videoapp`. The server transcribes each video by itself (whisper, in the background).

- Don't set `posted` yourself; the owner ticks Posted when it's actually posted.
- **✅ Approved:** when a video is finished, ask the owner whether to approve it. Only after they say yes to that video, POST `{"id":"<folder>/<file>","approved":true}`. Never approve previews, tests, parts or rejected takes.
- **Where it's posted:** whenever a video is queued or goes live, POST `{"id":"<folder>/<file>","account":"<network>:<handle>","status":"queued"|"posted","at":"<ISO time>","caption":"<exact caption>","url":"<live link>"}` to `http://localhost:4420/api/post`. Accounts are `accounts` in `studio.config.json`. Check the app's "Where it's posted" filter before scheduling so nothing is posted twice.

## X quote and captions

Every new video gets an **X quote**: a ready-to-post line written from that video's audio, saved as `xQuote` (POST `{"id":"<folder>/<file>","xQuote":"<quote>"}`). Get what's said from the burned-in captions first, then the app's transcript. Write it in the on-screen character's voice (its `character.md`): under 280 characters, short lines, at most one emoji, no hashtags, cut profanity. In the reply, show the transcript and the quote.

## Posting and parody rules

- **Never post or publish anything without the owner's go-ahead.**
- A character is a parody: never sign as, or claim to be, the real person it swaps, and never use their handle.
- Before pricing a clip, screen it against the character's off-limits list (in its `character.md`); when unsure, ask. Never rate or insult real people's looks.
- If a provider refuses a job (`ip_detected`, `nsfw`), stop and tell the owner. Never try to get around it.
