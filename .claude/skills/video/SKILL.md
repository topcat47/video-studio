---
name: video
description: Orchestrate a custom video end to end in this folder — brief → storyboard → Blender blockout → animatic → Higgsfield generation → review → edit (FilmCraft, or ffmpeg for a simple cut) → final. Use when the owner types /video <idea>, /video resume <slug>, or asks to "make a video", "start a new video", "storyboard this", "continue the <slug> video". Runs the stages in order, delegates building/review/editing to subagents, and stops for the owner's approval at every gate, including before every paid Higgsfield job.
---

# /video: idea → finished 9:16 video

You are the orchestrator. You own the plan, the state files and every conversation with the owner. Subagents do the hands-on work and report back; **only you talk to the owner and only you submit paid jobs** (subagents can't ask the owner anything, so no spend can go through them).

| Who | Does | Tools |
|---|---|---|
| you | brief, storyboard, prompts, pricing, approvals, generation, state, report | Higgsfield MCP, AskUserQuestion, SendUserFile |
| `scene-builder` | one shot's Blender blockout → start/end frames + animatic clip | `higgsfield-use-blender` MCP (`bl_*`) |
| `frame-fixer` | retouch a start/end frame (or make a cover) before it costs anything | PhotoCraft MCP |
| `clip-reviewer` | QA of one generated clip → pass/fail with frames | read-only + ffmpeg |
| `graphics` | titles, lower-thirds, callouts, end card → transparent ProRes 4444 overlays (only when the video has words on screen) | EffectCraft MCP |
| `editor` | assembly (clips + overlays + audio) → `final/*-vN.mp4`, in FilmCraft (`edit/*.fcproj`) or plain ffmpeg for a simple cut (step 7) | FilmCraft MCP or ffmpeg |

Repo root = this folder (where you cloned it). Projects live in `projects/<slug>/`; finished videos are also filed in the library (their character's folder, or `Other/`, with a card) following `CLAUDE.md`. Helpers in `scripts/`: `new-video.sh <slug>`, `sheet.sh <video> <png> [fps] [cols]`, `animatic.sh <out> <w> <h> <fps> <clips…>`, `open-filmcraft.sh`, `open-effectcraft.sh`, `open-photocraft.sh`. Each app's MCP has a `-headless` server (no window, default for agents) and a bridge server that drives the app once the owner opens it with its `open-*.sh` script.

**Text rule:** never ask Higgsfield for readable on-screen text (it garbles it). Every title, label and caption is a `graphics` overlay; prompts say "no text, no letters, no logos".

## Ground rules

- **State lives in files, not in your head.** Right after creating (or resuming) the project, run `scripts/studio-gate.sh step <slug> video Brief` once: it links this session to the project, and the Studio then reads its step from `shots.json`. `projects/<slug>/shots.json` is the source of truth; update it after every stage so `/video resume <slug>` can pick up in a new session. Every credit spent goes in the `log.md` spend table the moment the job is submitted.
- **Never overwrite** a render, result or final. New attempts are `-v2`, `-v3`. **Redo from a step** (the owner's button on the video's page in the Studio) is a new take: set the shots back to the stage before that step in `shots.json` and run from there, keeping every earlier file; its paid jobs ask the price again.
- **Default format:** 9:16 vertical, 1080×1920, 24 fps (the owner's choice). Only change it if the brief says so.
- **Never post or publish** anything.
- `scene-builder` runs **one at a time** (one shared Blender scene). `clip-reviewer` can run in parallel, one per clip.
- Send the owner images/videos with `SendUserFile` before asking them to judge something, so they can decide from their phone.

## Stop and ask the owner when

At every one of these stops, tell the Studio first: `scripts/studio-gate.sh open <project>:<gate> /video <project> "<the question>" [credits] ["<short detail>"] [image or video …]` (attach the test result or final video itself when asking about one, so the owner can play it in the Studio), then start `scripts/studio-gate.sh wait <project>:<gate>` as a background command so the owner can answer from the Studio app too (its output is their answer), and `scripts/studio-gate.sh clear <project>:<gate>` once the owner has answered (see "Video Studio" in `CLAUDE.md`).

**When you ask the owner to choose (still A or B, which idea, which take), post the choices as options** so they can click one: add `--option "<id>[*]|<name>|<why, one line>|<picture or video>|<credits>"` once per choice after the pictures (only id and name are required). Mark the one you recommend with `*` (at most one; say why in its line) and give each option its own price when they differ, because Approve pays for exactly the picked option's price. Their answer names the pick ("They picked option B"); continue with that option only. Notes are for "none of these" or a mix. Questions that aren't a choice (approve this price, this final) stay a plain Approve.

**When the video is done, end the session.** After the last step (a swap: the 1080p finish once the owner has approved it; /video: the final the owner approved, then Learn), report that step with `scripts/studio-gate.sh step`, clear any gate you still have open, stop any `studio-gate.sh wait` you started, give the owner a short final report and stop. Start nothing new in this session: the Studio closes a finished video's background runs for good, and a chat window can be closed.
Right after submitting any paid job: `scripts/spend.sh <project> video <job id> <model> <credits>`. In a background run from the Studio (`STUDIO_RUN_ID` set) never ask in chat: post the gate with its images and end your turn.

- the brief is missing something that changes the shots (step 1);
- the written plan is ready (2a); the concept frames are ready, and again after every revision (2b); each shot's Blender animation is ready, and again after every revision (3b); the whole animatic is ready (4). Nothing moves on without a yes;
- before **every** paid job: price, balance, approval, then submit (step 5). A redo is a new cost and a new approval;
- a result fails review (show the frames first, then ask before a redo);
- a job comes back `ip_detected`, `nsfw` or failed;
- the final is exported (step 8). Never mark it final on your own.

## Shot state machine (`shots.json` → `shots[].status`)
`planned` → `concept-ok` (2b) → `blocked` (3a) → `blockout-ok` (3b) → `animatic-ok` (4) → `priced` → `generating` → `generated` → `approved` | `failed` → `placed`

Each shot:
```json
{"id": "s01", "duration": 4, "description": "what we see and what happens", "camera": "slow push-in, eye level",
 "blender": "layout notes for scene-builder", "mode": "i2v-start" , "prompt": "", "audio": "",
 "status": "planned", "concept": "", "concept_notes": [], "blend": "", "start": "", "end": "", "animatic": "", "blockout_notes": [],
 "jobs": [], "results": [], "approved_result": "", "trim": null, "transition": "cut"}
```
`mode`: `i2v-start` (Blender start frame → video), `i2v-start-end` (start + end frame pin the motion), `v2v` (restyle the Blender animatic), `t2v` (no Blender, rare).

## 1. Brief
- New: pick a short slug, run `scripts/new-video.sh <slug>`, fill `brief.md` from the owner's idea.
- Ask (one AskUserQuestion, ≤4 questions) only for what changes the shots: length, story beats, look/style, recurring characters (a cast member from `characters/` — read its `character.md` and use its look sentence and photo; a new one gets its own `characters/<name>/` folder first, see `characters/README.md`; other references go in `assets/`), audio. Use the defaults for everything else.
- Resume: read `brief.md`, `shots.json`, `log.md`; tell the owner where it stands in one line and continue from the first shot not yet `approved`.

## 2. Storyboard — written plan, then concept frames (owner's loop)

### 2a. Written plan (free gate)
- Break the video into shots of 3–8 s (most video models bill per second and do best on one continuous action). Write them into `shots.json` with `duration`, `description`, `camera`, `blender`, `mode`, a first-draft `prompt`, and the on-screen words in `graphics`.
- Show the owner a table: shot, seconds, what happens, camera, on-screen text. Total length. Revise until they approve. Nothing is generated before a yes.

### 2b. Concept frames (paid, owner's choice since 2026-10-21) — back and forth until approved
One AI still per shot that shows the **look and composition** the owner is signing up for. It becomes the reference for everything after it: `scene-builder` lays out Blender to match it, and step 5 passes it to Higgsfield as the style reference.
1. **Model: Nano Banana 2.1** (`nano_banana_2_1`, owner's choice since 2026-10-23 for photorealism). `resolution: "1k"` = 1.5 cr, `"2k"` = 2 cr (use 2k only when the brief asks for fine detail); `thinking_level: "high"`; `aspect_ratio: "9:16"`. Confirm the price with `get_cost`. Same model for every frame of a project; record it in `log.md`. A stylised (non-photoreal) brief may suit another model better: say so and ask before switching. Fallback when it refuses or keeps missing a note after one redo: the same prompt on `gpt_image_2_5` (quality high), with the owner's OK.
2. **Prompt per shot:** the brief's look first (identical wording in every shot), then the shot's subject, setting, framing and camera position as a single moment (the first instant of the shot). Character photos from `characters/<name>/` (and the character's look sentence from its `character.md` and prompt order from its `prompts.md`, word for word; use the kit's `<name>_grey.png` and any fitting `approved-stills/` as references) go in as `image_references`, always in the same order, and the prompt names them ("the cat from image 1"). "No text, no letters, no logos." Keep each shot's `seed` in `shots.json` so a liked take can be varied.
3. **Price all frames in one round** (`get_cost`, `balance`), send the owner the count, per-frame and total credits, and ask. Submit only on yes. Log each job.
4. Save results to `renders/concept/<shot>-cN.png` (never overwrite). Build the board:
   `SB_TH=420 swift scripts/swap/storyboard.swift review/storyboard-vN.txt review/storyboard-vN.png`
   spec lines (tab-separated): `title<TAB><slug> · storyboard vN`, then per shot `row<TAB><shot> · <sec> s<TAB><camera + what happens><TAB><png>@cN|<older png>@cN-1`. Show older versions next to the new one when a shot was revised.
5. `SendUserFile` the board and ask **per shot**: approve, or notes. Record notes in the shot's `concept_notes`.
6. For each shot with notes: **edit the previous frame instead of starting over**: pass the current `-cN` (its job id or upload) as image 1, the character references after it, and a prompt that starts "Edit image 1. Keep everything else exactly as it is." followed by only the owner's changes. That keeps what they already liked. Start from scratch only when the notes change the whole shot. Re-price **only those frames**, ask, generate as `-c(N+1)`, rebuild the board with the old and new frame side by side, ask again. Repeat until every shot is approved. Small fixes the owner describes as "move", "remove", "recolour" can go to `frame-fixer` instead, for free.
7. Approved → set the shot's `concept` to that PNG, `status: "concept-ok"`. If the frame stars a main-cast character, also copy it into `characters/<name>/approved-stills/` with a row in its `index.md`.
The owner can skip 2b for a shot ("no concept frame for s04"); then Blender works from the written plan alone.

## 3. Blender blockout — build all, then the owner reviews each shot's animation

### 3a. Build
For each shot with `status: "concept-ok"` (or approved in 2a when 2b was skipped), in order, **one at a time**: spawn `scene-builder` with the project path, shot id, and the concept frame to match (camera height and angle, subject placement and scale, lighting direction). Read its start/end PNGs yourself and re-run it with specific notes if the framing clearly misses the concept, before the owner sees it. Record paths, `status: "blocked"`.

### 3b. Owner review of the animation (free gate, per shot)
1. Board: per shot one row: concept frame, Blender start frame, Blender end frame, plus 4 frames sampled across the animatic (`ffmpeg -v error -i renders/animatic/<shot>-bN.mp4 -vf "select='not(mod(n\,K))'" -vsync vfr -frames:v 4 review/<shot>-bN-%d.png` with K = frames/4). `SB_TH=420 swift scripts/swap/storyboard.swift review/blockout-vN.txt review/blockout-vN.png`.
2. `SendUserFile` the board **and each shot's** latest `renders/animatic/<shot>-bN.mp4` (the motion is the point; stills alone don't show it). Name what each clip shows: camera move, timing, what moves.
3. Ask per shot: approve, or notes (camera path, speed, timing, framing, placement, what should move). Record them in `blockout_notes`.
4. Shots with notes: re-run `scene-builder` with the notes; it opens the latest `scenes/<shot>-bN.blend` and saves the next version (`-b(N+1)` scene, frames and animatic; earlier versions stay); send only the revised shots' clips with the previous version alongside; ask again. Repeat until every shot is approved.
5. Approved → `status: "blockout-ok"`. Remind the owner they can open any `scenes/<shot>-bN.blend` in Blender and adjust it by hand; if they do, save it as the next `-bN`, then have `scene-builder` render that version's frames and animatic before moving on.

### 3c. Frame fix-up (optional, free)
When a start/end frame has something a prompt can't reliably fix (a stand-in that shows, a stray object, the wrong grade, a character reference that must sit in a specific spot), spawn `frame-fixer` with the shot and the exact change. Read the before/after yourself. It's always cheaper than a redo after generation. Character photos come from `characters/<name>/` (PhotoCraft's bridge can't read outside `video generations`).

## 4. Animatic (free gate, whole video)
`scripts/animatic.sh projects/<slug>/renders/animatic.mp4 540 960 24 <each shot's latest animatic in order>` and `scripts/sheet.sh` of it. Send both. This gate is about the **whole** video now that each shot is approved: pacing, order, shot lengths, how the cuts flow. Changes → back to 3b for the affected shots. Approved → every shot `animatic-ok`.

## 5. Generate (paid — approve every job)
1. **Pick the model once per project**: `models_explore` for image-to-video that supports 9:16 and the shot mode (start frame / start+end / video reference). Note the model and why in `log.md`. Keep the same model across shots for a consistent look unless the owner agrees otherwise.
2. **Prompts:** describe the final look (materials, lighting, style from the brief), the action and the camera move; tell the model to keep the input frame's composition, subject placement and camera. Put recurring-character descriptions first and word them identically in every shot. The Blender start (and end) frame is the motion/composition input; the approved **concept frame** goes in as the style/image reference where the model takes one, so the clip looks like what the owner approved in 2b. Reuse the concept prompt's look paragraph word for word.
3. **Upload** the inputs for the shots you're pricing: `media_upload` → `curl -X PUT -H "Content-Type: …" --data-binary @file '<upload_url>'` → `media_confirm`. Record media ids in the shot's `jobs`.
4. **Preflight** each job with `get_cost: true`; get `balance`.
5. **Test first:** pick the hardest shot (most motion, the main character, fine detail). Ask the owner to approve **that one job** — shot, seconds, model, credits, balance, plus the projected total for the whole video. Submit nothing until they say yes.
6. Submit with `generate_video`. If the call answers with a preset suggestion instead of a job, call again with `declined_preset_id` set to that preset's id. Log the spend row immediately. `status: "generating"`.
7. `jobs_wait` (or `show_generation_by_ids`), download to `higgsfield/results/<shot>-vN.mp4`, `status: "generated"`.
8. Spawn `clip-reviewer` for it. Send the owner the sheet + verdict. Pass → `approved`, `approved_result` set. Fail → show the failing frames, propose a prompt or blockout fix and its price, ask before redoing. If the issue is `fixable_in_edit`, offer that first (free).
9. After the test is approved: price the remaining shots as one round (or two, hardest first), ask, run them in parallel, review them in parallel, and gate each failure as above.
10. Check `transactions` at the end: only the jobs you submitted, matching `log.md`.

## 6. Rough cut check (free)
`scripts/animatic.sh projects/<slug>/review/roughcut.mp4 1080 1920 24 <approved results in order>`; send it. Ask for trims/reorders; write them into `shots.json` (`trim: [in, out]`, `transition`).

### 6b. Graphics (optional, free)
Only when the video has words on screen (titles, labels, captions, an end card); with none, leave `graphics` empty, skip this step and say so. List every title, lower-third, callout and the end card in the `graphics` array at the top of `shots.json` (see the `graphics` agent for the fields); add it to the storyboard in step 2 so the owner approves the words early. Spawn `graphics`; it can run in parallel with step 5's generation since it only needs the shot timings. Send the owner the preview stills; fix wording now, not after the edit.

## 7. Edit
**Pick the route** (free either way) and write it in `shots.json` as `"edit_route": "filmcraft" | "ffmpeg"`:
- **`ffmpeg`** when the cut is simple: hard cuts or crossfades, at most one music bed or voice, overlays from 6b placed at fixed times, no grade. Spawn `editor` with "route: ffmpeg". This ffmpeg has no `drawtext` or `subtitles`, so any captions must come from 6b as overlays.
- **`filmcraft`** when the edit needs a grade or Color Match between shots, music ducked under voice, stabilizing, optical-flow speed changes, captions made from the transcript, or a project file the owner can open and tweak later.
Say which route and why in one line when you send the rough cut (step 6); the owner can switch it. A redo or `/video resume` keeps the recorded route.

FilmCraft route: ask whether the owner wants to watch the edit live. If yes, run `scripts/open-filmcraft.sh` and tell `editor` to use the `filmcraft` bridge; otherwise it uses `filmcraft-headless`. The editor puts the rendered overlays from `edit/graphics/` on V2 and above at their `at` times. Spawn `editor` with the project path. Voiceover or music that needs a paid generation (Higgsfield audio, ElevenLabs) goes through the step-5 approval before the editor runs. Put audio files in `edit/audio/`.

## 8. Final (owner's gate)
Read the editor's report and the final sheet yourself. Send the final video. Report in one short message: the final path, length, shots and which version of each, credits spent per job and total vs approved, what was checked, anything left over. Ask: **"Approve it as final?"** Only on a clear yes, set every shot `placed`, add `"final": "final/<slug>-vN.mp4"` and `"approved": true` at the top of `shots.json`. Changes instead → make them (paid ones re-approved), export `-v(N+1)`, ask again.

## 9. Learn
Append what worked or failed (model quirks, prompt phrasings that held composition, blockout tricks, costs) to **Lessons** below, dated, one line each, and to `log.md`. Keep this skill accurate: if a step changed, edit the step.

## Lessons
_(none yet — add dated one-liners as projects teach us things)_
