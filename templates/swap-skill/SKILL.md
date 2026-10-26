---
name: {{SKILL}}
description: Turn {{TARGET}} into {{CHARACTER}} in a video from a link or a file. Use when the owner types /{{SKILL}} <link or file>, or gives a YouTube/X/TikTok/Instagram/Kick link or a local video and asks to "turn {{TARGET}} into {{CHARACTER}}", "make a {{CHARACTER}} version" or similar. Finds which person is {{TARGET}} from context (never by face), plans the shots, gets the owner's cost approval, runs the Higgsfield swap, puts it back together under the original audio and files it in the video library under {{FOLDER}}/. Orchestrates the swap-mapper, reel-builder, swap-reviewer, swap-assembler and library-filer subagents; all decisions, approvals and paid jobs stay with you.
character: {{SLUG}}
swaps: {{TARGET}}
folder: {{FOLDER}}
---

# /{{SKILL}}: {{TARGET}} → {{CHARACTER}}

The owner gives a link or a file (`/{{SKILL}} https://…`). You find {{TARGET}} in it, swap every shot of them to {{CHARACTER}}, and deliver one video in `{{FOLDER}}/` with its card filled in. Everything in `CLAUDE.md` applies; this skill is the order of work plus what has worked on earlier clips. Add what you learn to **Lessons** at the bottom and to `characters/{{SLUG}}/prompts.md`.

## Orchestration

You are the orchestrator. Subagents in `.claude/agents/` do the local, mechanical work and report back; **you keep every decision, every conversation with the owner and every Higgsfield call** (subagents can't ask the owner, so no spend or approval may go through them).

| Step | Who | Runs |
|---|---|---|
| 1–2 download, repeat check, shot map; evidence for 3; screen for 4 | `swap-mapper` | once |
| 3 decide who {{TARGET}} is, ask about unsure shots · 4 decide on off-limits · 5 plan | **you** | |
| 6.1–6.2 build reels + grey cutout + reel sheets | `reel-builder` | **parallel, one per reel** |
| 6.3–6.5 upload, preflight, balance, ask · 7 submit, wait, download | **you** | jobs in parallel once approved |
| preview stills and their paid jobs | **you** | |
| 8 check each result | `swap-reviewer` | **parallel, one per result** |
| 9 assemble, compare, captions (9b colour match when needed) | `swap-assembler` | once (again after fixes) |
| 10.3 description + X quote (the character's voice) | **you** | |
| 10 copy, link original, POST label, verify | `library-filer` (start the app first: `run-videoapp`) | once |
| 11 report · 12 approval · lessons into this skill | **you** | |
| 13 1080p finish (Apple super resolution, free), only after the owner's yes | `swap-assembler` | once |

**Character card** (paste into every agent prompt): target = {{TARGET}} (never decided by face); not them = hosts, guests, B-roll people unless the evidence or the owner says so; character = {{CHARACTER}}, reference `characters/{{SLUG}}/<source photo>` (the `**Source photo:**` line of its `character.md`), cutout `characters/{{SLUG}}/{{SLUG}}_grey.png`, prompt book `characters/{{SLUG}}/prompts.md`; must-haves = the look sentence and accessory in `character.md`, the whole character, no human parts; library = `{{FOLDER}}/`, names `<handle> - {{SLUG}}-swap[-slug].mp4`, label id `{{SKILL}}/<file>`; off-limits = the list in its `character.md`.

**State:** the run lives in `<scratchpad>/<name>/` (`dl/`, `work/`) with `state.json` written by the agents and updated by you after every gate (`stage`: mapped → planned → built → test-approved → test-run → reviewed → rest-approved → run → assembled → filed → approved → hd). **Every time `stage` changes, also run `scripts/studio-gate.sh step <project> {{SKILL}} <stage>`** (the same `<project>` you use for gates), so the run's page in the Studio shows which step it is on; add the files that step made after the note (`step <project> {{SKILL}} <stage> "<note>" <file> …`: contact sheets, the plan board, reels and cutout, the test result, review sheets, pieces, the assembled video, the final). **Redo from a step:** when the owner presses it in the Studio you get a message naming the step and the take number; keep the earlier take's files untouched, work in a new `take-<n>/` folder, reuse what came before that step, and give that take's final a `-v<n>` name. A redo is never an approval: its paid steps ask the price again. After a context compaction, read `state.json` before doing anything.

**Agent prompts** always include: `WORK` (absolute), the character card, this skill's path, and exactly what to do. Read their reports and sheets yourself before acting on them; their verdicts are evidence, not decisions.

Helper scripts (stdlib + ffmpeg; run Python ones with `python3 -I`) are in `scripts/swap/`:

| Script | What it does |
|---|---|
| `shots.py <video> <dir>` | cuts (scdet), what is said in each shot (whisper), contact sheets of mid-shot frames plus one every 2.5 s in long shots, `shots.json` |
| `build_input.py <src> <reel.mp4> 107-197 286-337 [--min4]` | one swap input from source frame ranges; `--min4` retimes a reel under 4.25 s to exactly 96 frames @24 (12 credits); writes `<reel>.json`; prints the expected cost |
| `assemble.py <src> <final.mp4> <reel>=<result> … [--shift <reel>=1] [--patch <frame>=<clip>]` | stretches each result back to real time, converts to the source fps/size, puts every frame back at its source frame, original audio; warns about black frames; `--patch` lays a clip already at the source fps over the result from that source frame on |
| `compare.py <src> <final> <prefix> [--fps 2] [--band 0.55 0.76]` | side-by-side sheets: full frames for human parts, a caption band (source over final) for words |
| `capfix_runs.py <src> <final_raw> <final> 0-28 104-406 --preset <name> --python <venv>/bin/python` | puts the source captions back on every swapped range: chunks of ≤150 frames, runs `scripts/capfix.py` with a preset from `caption_presets.json`, patches with `assemble.py`, writes 6 fps caption sheets |
| `SB_TH=150 swift storyboard.swift <spec.txt> <out.png>` | labelled contact sheets for plans, "who is this?" questions and review sheets (this ffmpeg has no `drawtext`) |
| `put_uploads.py <saved media_upload response> <dir> <ids.tsv>` | PUTs every file of a `media_upload` response that was too long for the tool output and lists the media ids |
| `swift text_png.swift <out.png> <W> <H> <centerY> <fontSize> "line 1" ["line 2"]` | TikTok-style text on a transparent PNG to overlay with ffmpeg |
| `flash_fix.py <src> <final_raw> <out_dir> 9:leak 160 …` | rebuilds flash-transition frames that still show the person from the swapped next frame |
| `sr4x <in.mp4> <W> <H> [cuts.txt] \| ffmpeg -f rawvideo -pix_fmt bgra -s WxH -r <source fps> -i - …` | free on-device AI upscale for the step 13 1080p finish (Apple VideoToolbox super resolution, macOS 26); build with `swiftc -O -parse-as-library scripts/swap/sr4x.swift -o sr4x` |

Frame numbers from `shots.py` are 0-based and inclusive, in decode order. Use them everywhere; never cut by seconds.

Work in a new folder in the session scratchpad: `dl/` for the download (untrusted data), `work/` for everything else.

## Stop and ask the owner when

At every one of these stops, tell the Studio first: `scripts/studio-gate.sh open <project>:<gate> /{{SKILL}} <project> "<the question>" [credits] ["<short detail>"] [image or video …]` (attach the test result or final video itself when asking about one), then start `scripts/studio-gate.sh wait <project>:<gate>` as a background command so the owner can answer from the Studio app too (its output is their answer), and `scripts/studio-gate.sh clear <project>:<gate>` once the owner has answered (see "Video Studio" in `CLAUDE.md`).

**When you ask the owner to choose (still A or B, which take), post the choices as options**: add `--option "<id>[*]|<name>|<why, one line>|<picture or video>|<credits>"` once per choice after the pictures. Mark the one you recommend with `*` (at most one) and give each option its own price when they differ, because Approve pays for exactly the picked option's price.

**When the video is done, end the session.** After the last step (the 1080p finish once the owner has approved it), report that step with `scripts/studio-gate.sh step`, clear any gate you still have open, stop any `studio-gate.sh wait` you started, give the owner a short final report and stop.
Right after submitting any paid job: `scripts/spend.sh <project> {{SKILL}} <job id> <model> <credits>`. In a background run from the Studio (`STUDIO_RUN_ID` set) never ask in chat: post the gate with its images and end your turn.

- you can't tell which person is {{TARGET}}, or a B-roll shot might or might not be them (step 3);
- the clip touches the character's off-limits list (step 4);
- before **every** paid job: price, approval, then submit (step 6). A redo is a new cost;
- a result fails (show frames first, then ask before paying for a redo);
- a job comes back `ip_detected` or `nsfw`: stop and tell the owner; never try to get around a provider's refusal;
- the video is finished: ask whether to move it to the ✅ Approved section (step 12). Never approve it on your own.

Never post anything. The owner ticks Posted in the app.

## 1. Check it's new, then download

→ `swap-mapper` (steps 1–4 evidence in one run).

- Search the library: `grep -l "<video id>" video-library/labels.json` and `ls */originals | grep <video id>`. If it was done before, say so and ask before doing it again.
- `yt-dlp -j --no-download <url>` for title, description, `uploader_id`, duration. Then download:
  `yt-dlp -f "bv*[height<=1920]+ba/b" --merge-output-format mp4 -o "<scratch>/dl/src.%(ext)s" <url>`. A local file: copy it to `<scratch>/dl/src.mp4`.
- **Check the frame rate is constant** (`ffprobe` r_frame_rate vs avg_frame_rate, or frame count vs duration × fps). `build_input.py` and `assemble.py` number frames at a constant rate, so a variable-rate source puts the audio off the cuts. Fix first, then map everything on the copy: `ffmpeg -i dl/src.mp4 -vf "fps=30,format=yuv420p" -fps_mode cfr -r 30 -c:v libx264 -crf 10 -c:a copy work/src30.mp4`. Link the untouched download as the original.

## 2. Map the shots

`python3 -I scripts/swap/shots.py <scratch>/dl/src.mp4 <scratch>/work/shots`, then Read every `sheet_NN.png`. Tiles are in shot order (8 per row); the table says which tiles belong to which shot. Long shots get a tile every 2.5 s: check them for a change of person, angle or zoom that scdet missed, and run again with `--threshold 4` if a shot looks like two.

## 3. Find {{TARGET}} from context, never from a face

Decide who {{TARGET}} is from what the video itself says and shows, and write down the evidence for the owner:

- **Title, description, channel:** match the title's claim to the person who makes it.
- **Who asks, who answers:** on podcasts the guest is asked, the hosts ask. Use the "said" column of the shot table.
- **On-screen names:** lower thirds, stream overlays, usernames, chat.
- **Continuity within the clip:** once one shot is settled, other shots of the same seat, outfit and camera in the same video are the same person.
- **B-roll** (selfie, mirror, gym, other settings): context rarely settles it. Look for precedent in the library (`curl -s localhost:4420/api/videos`: descriptions say which shots were swapped). If there is none, ask.
- **Never leave a B-roll person unswapped without asking.** Before pricing, list every shot with a person you are *not* sending (a one-row-per-shot sheet of its frames, with times) and ask the owner which are {{TARGET}}.
- Never decide by facial resemblance or "looks like them". If two people could fit, ask.

## 4. Screen the content before pricing

Read the captions and the transcript. If the clip is mostly about something on the character's off-limits list, tell the owner what it contains and ask before you price anything.

## 5. Plan the jobs

`hf_mult_replace_object` accepts 4–30 s and bills 3 × ceil(seconds) at 480p (96 frames @24 = 12, 4.77 s = 15, 7.4 s = 24). It swaps best on one continuous shot with one subject.

- Send **only {{TARGET}}'s shots**. Never send a shot of anyone else.
- Join shots from the **same camera/setup** into one reel (≥4 s). Different setups go in separate reels: a mixed reel comes back as one look.
- A lone shot under 4 s, or a reel of 4.0–4.25 s: `--min4` (exactly 96 frames @24 = 12 credits instead of 15).
- A long shot: one job up to 30 s, or pieces of ~7–18 s cut where the caption **and** any graphic change together (pieces are generated separately, so the character can jump slightly at a seam; put seams on real source cuts where you can). Long runs fail more often than short ones.
- **Always run a test first.** The test is one job on the hardest few seconds (hands at the face, arms on a table, graphics over the chest, a second person in frame, the biggest movement): about 4 s, ideally exactly 96 frames @24 = 12 credits. Make the test piece part of the final where you can. Ask approval for the test alone, show the owner its frames, and only then price and ask for the rest. If the test fails, fix the prompt and test again (new approval) before any full run.
- Known trouble, warn the owner up front:
  - a seated person with forearms on a table or hands in their lap → the model keeps sleeves/hands. Fallback: one image-model still per setup + a start-frame video model with the original audio;
  - **letterboxed** sources (a band inside a taller frame): crop the band first (`ffmpeg -vf cropdetect`), run build/assemble/captions on the band, pad back at the end;
  - split screens → send only the target's panel, or the full frame with "keep the person on the right exactly as they are";
  - two-person shots → one person per pass;
  - **full-body standing people:** the swap fills the person's whole outline, so the character comes out person-sized. Offer a preview still with the character at its real size (below), or the still + video-model route.
  - tight face close-ups of real people can come back `ip_detected` (refunded): leave that shot as it is or cut it, and tell the owner.

### Preview still for the shots you can't predict

When it's unclear what the character will look like in the scene, make one image-model still first (about 1.5 credits; a paid job, so ask approval like any other) and show it to the owner with the test price. Do this for full-body people, B-roll with other people in frame, seated people with arms on furniture, split screens, and any reel that goes out as two or more pieces. Skip it for a plain talking-head close-up once `prompts.md` has a proven prompt for it.

How: take the hardest frame at full size (`ffmpeg -i src.mp4 -vf "select='eq(n,F)'" -frames:v 1 frame.png`), upload it with the grey cutout, and edit it with the image model (`models_explore` to pick one; image 1 = the frame, image 2 = the cutout, named in the prompt). Prompt: the accessory paragraph, then "Edit image 1. Remove the person completely (arms, hands, clothes and anything they hold) and the burned-in caption; {{CHARACTER}} sits <where, how big>; keep image 1's background, lighting, camera angle and crop exactly." Read the still for human parts and size before showing it. **Once the owner picks a still, save it to the kit** (`characters/{{SLUG}}/approved-stills/YYYY-MM-DD-<handle>-<shot>.png` plus a row in its `index.md`). An approved still can go in as the swap's `image_references` instead of the bare cutout: it pins the character's size, framing and pose.

## 6. Build, upload, price, ask

→ items 1–2: `reel-builder`, one per reel in parallel. Items 3–5: you.

1. Build each reel: `python3 -I scripts/swap/build_input.py <src> <work>/inputs/<name>.mp4 <ranges…> [--min4]`. Contact-sheet the built reel and look at it: it must show only {{TARGET}}.
2. Reference, cut out onto grey (a reference's background leaks into the video otherwise): `characters/{{SLUG}}/{{SLUG}}_grey.png` (copy it to `<work>/inputs/`). Missing: `swift scripts/cutout.swift characters/{{SLUG}}/<source photo> characters/{{SLUG}}/{{SLUG}}_grey.png d9d9d9`.
3. Higgsfield tools (load with ToolSearch, e.g. "higgsfield media_upload generate_video balance transactions jobs_wait"): `media_upload` → `curl -X PUT -H "Content-Type: …" --data-binary @file '<upload_url>'` → `media_confirm`. Upload only the round you are pricing.
4. Preflight every job: `generate_video` with `model: "hf_mult_replace_object"`, `resolution: "480p"`, `get_cost: true`, `medias: [{role: "video_references", value: <reel id>}, {role: "image_references", value: <cutout id>}]`. Get `balance`.
5. Ask the owner, sending the preview still or a frame sheet first: the test job (which shots, seconds, credits), the planned remaining jobs and the full-clip total, and the balance. Ask to approve the test only. Submit nothing until they say yes, and only the jobs they approved. After the test passes, ask again for the rest.

## 7. Run

Submit each approved job with the real prompt (from `characters/{{SLUG}}/prompts.md`; write the first ones there as you learn them), `resolution: "480p"`. If the call answers with a preset suggestion instead of a job, call again with `declined_preset_id` set to that preset's id. Wait with `jobs_wait`, then download each result into `<work>/results/`.

What has worked in prompts: put the accessory paragraph first; **describe what replaces the clothes, not only what to remove** ("Below the character's head the frame shows its own fur: neck, chest and belly where the shirt used to be; its two front legs rest flat on the desk and stay still"); add "keep the source's background; never use a background from the reference images"; names in prompts get drawn as captions, so describe instead of naming.

## 8. Check every result before assembling

→ `swap-reviewer`, one per result, in parallel. Read its sheets yourself before showing the owner.

Look at every shot for: any human part (hand, fingers, sleeve, collar, skin, hair or a head behind the character); the character's must-haves in every frame; a real body (no standing like a person, no clothes beyond its accessory); the graphics and captions still there. If a piece fails, show the owner the frames and ask before any redo (new price, new approval).

## 9. Assemble and check the final

→ `swap-assembler`.

```bash
python3 -I scripts/swap/assemble.py <src> <work>/final.mp4 <reel1>=<result1> <reel2>=<result2>
```
- The final must have the source's frame count (assemble checks).
- If the mouth or a caption change sits one frame late at every seam of a reel, run again with `--shift <reel>=1`.
- A "much darker" warning means black frames at a result's end: patch them by ping-ponging the last good frames.
- Human parts: `compare.py <src> <final> <work>/cmp --fps 2`, then read every sheet; use `--fps 6` around hand moves.
- Captions: find the caption band on the shot sheet, then `compare.py … --band Y0 Y1 --fps 6`. The model redraws captions: it can merge, drop or swap lines and spell out censored words. List every difference to the owner. To put the source captions back: `capfix_runs.py` (needs numpy + OpenCV in a scratchpad venv; setup line in `scripts/capfix.py`'s header). A new caption style: pass `--band Y0 Y1` and capfix flags after `--`, tune on one chunk, then add a preset to `scripts/swap/caption_presets.json`. If the model's captions are word-perfect at 6 fps, keep them.

### 9b. Colour match in FilmCraft (optional, free)

→ `swap-assembler`, before filing. It only helps where AI shots sit next to real footage and look like inserts (brighter, crisper, jet-black shadows against a hazy source). **Run it** on long films, still + video-model shots, or when the 2 fps compare sheet shows a swapped range lighter, darker or a different colour than the frames around it. **Skip it** on a one-reel swap that kept the room's light. Free steps need no approval, so decide yourself, say in the report which you did and why, and do the other if the owner asks. Needs FilmCraft installed (`/setup`); without it, skip and say so.

1. `filmcraft-cli --save-as <work>/cm.fcproj exec file.newProject name=cm`, then `--project <work>/cm.fcproj --save exec file.import '{"paths":["<final.mp4>","<src.mp4>"]}'` and `file.newSequenceFromClip` on the final. Check command ids with `filmcraft-cli commands lumetri` / `describe <id>`, never guess.
2. Place the source after the film on V1 (`timeline.place frame=<film length>`, audio off). Razor the final at every swapped range's start and end+1 (`timeline.razor`; ticks = frame × 254016000000 / fps).
3. Per swapped clip: `effects.apply` Lumetri, then `lumetri.applyMatch {clip, referenceFrame: <film length> + <first frame of that range>, faceDetection: false}`. **The reference is the original frame that shot replaced, never the neighbouring shot.**
4. `filmcraft-cli --project <work>/cm.fcproj export <work>/final-cm.mp4 --range <0 to film length in seconds>` with the original audio; it must keep the source's frame count. Compare a few frames per range against the source before keeping it; if it looks worse, keep `final.mp4`.
5. Report it with step `assembled` (note "colour-matched", the before/after frames).

## 10. File it in the library

→ you write the description and X quote, start the app (`run-videoapp`), then `library-filer` does 1–4. Item 5 (transactions): you.

1. **Names.** Conversion: `{{FOLDER}}/<handle> - {{SLUG}}-swap.mp4`. If that name exists, add a short topic slug. Never overwrite. Original: `<handle> - <post id>.mp4`; for YouTube, handle = `uploader_id` without "@", post id = the video id.
2. Copy the final into `{{FOLDER}}/` with `cp`. Put the download in the scratchpad under the original's name, then `node video-library/link-original.js <conversion> <original>` (copies it into `{{FOLDER}}/originals/` and links it).
3. POST to `http://localhost:4420/api/label` (build the JSON with python so quotes are escaped), id `{{SKILL}}/<file>`: `sourceUrl` (the exact link the owner gave); `description` (1–3 plain sentences: "{{CHARACTER}} replaces {{TARGET}} …", where, a key line, "character swap"); `xQuote` in the character's voice (its `character.md`), under 280 characters, at most one emoji, no hashtags, nothing from the off-limits list.
4. Check: `curl -s localhost:4420/api/videos` lists `{{SKILL}}/<file>` with `archived: false`, the description and the original. Don't set `posted`.
5. Check the spend: `transactions` should show only the jobs you submitted (other sessions spend at the same time).

## 11. Report

One short message: who {{TARGET}} was and the evidence; original → conversion file names; credits spent (per job, total) against the approval; what you checked (human parts, must-haves, captions, seams) and anything left over; the transcript and the X quote. Add anything new you learned to **Lessons** below and to `prompts.md`.

End the report by asking: **"Approve it? I'll move it to the ✅ Approved section."**

## 12. Approved section (only with the owner's yes)

- **Only after the owner says yes** to that exact video: set stage `approved`, do the **1080p finish (step 13) first**, then POST `{"id":"{{SKILL}}/<file>","approved":true}` to `http://localhost:4420/api/label`. Silence, "looks good so far" or approval of a test doesn't count. Never approve a `-PREVIEW`, `-test`, `-partN` or `-REJECTED-…` file.
- If the owner asks for changes instead, make them (new paid jobs need a new cost approval), report again and ask again.

## 13. Finish in 1080p after the owner approves (free, on the Mac)

→ `swap-assembler`. Every approved final is resized to 1080p on its short side with Apple's free on-device super resolution (`scripts/swap/sr4x.swift`, VideoToolbox, macOS 26). No credits.

1. Source already 1080p or more on its short side, and the final too → nothing to do.
2. Get the source's own 1080p rendition if there is one: `yt-dlp -f "bv*[height>=1080]/bv*[width>=1080]" -o "<scratch>/dl1080/src1080.%(ext)s" <url>`. It must have the source's frame count and line up.
3. `swiftc -O -parse-as-library scripts/swap/sr4x.swift -o <work>/sr4x`. Cuts file: every shot start from `shots.json` plus every reel/patch start and end+1, one per line.
4. `<work>/sr4x final.mp4 W H cuts.txt | ffmpeg -f rawvideo -pix_fmt bgra -s WxH -r <source fps> -i - -vf "scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=yuv420p" -c:v libx264 -crf 12 final_sr.mp4` (bt709 is required: bt601 shifts the colours; `-r` is the source's frame rate). Portrait input is turned sideways and back by sr4x itself. If the upscale comes out darker than the final, fit one brightness curve and apply it with `lut1d`.
5. Lay the source's real 1080p frames over every untouched range: `[1:v]trim=end_frame=<N>,setpts=PTS-STARTPTS[s];[0:v][s]overlay=0:0:enable='between(n,a,b)+…'`, the final's audio with `-c:a copy`.
6. Check: frame count = source; kept ranges match the 1080p source; a zoomed side-by-side crop of one kept frame and one swapped frame.
7. The 1080p file **replaces the filed final in place, under the same name** (`cp` over `{{FOLDER}}/<file>`), so its card stays; this is the one allowed overwrite. Then POST `approved: true` (step 12) and report `scripts/studio-gate.sh step <project> {{SKILL}} hd`.

## Lessons
_(none yet — add dated one-liners as clips teach you things)_
