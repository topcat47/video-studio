---
name: setup
description: First-time setup of this Video Studio on a new Mac, after ./setup.sh: checks the tools and the server, connects Higgsfield for paid generations, offers the optional apps (Blender MCP, FilmCraft, EffectCraft, PhotoCraft), and makes the owner's first character with its swap skill. Use when the owner types /setup, or asks to "set this up", "finish setup", "add the optional apps", or "connect Higgsfield".
---

# /setup: finish setting up the Video Studio

`./setup.sh` did the mechanical part (tools, folders, `studio.config.json`, the server's LaunchAgent, the Mac app). This skill does the parts that need the owner: accounts, optional apps and the first character. Work through the parts in order, say what you checked after each one, and ask the owner before installing anything or changing their accounts. Skip a part the owner says they don't want. Never print or commit `video-library/.studio-token` or `video-library/.buffer-key`.

## 1. Check the base

1. `studio.config.json` exists? If not, run `./setup.sh` (or `./setup.sh --install` if tools are missing; ask first, it uses Homebrew) and read its output.
2. Server: `curl -s -m 5 -o /dev/null -w "%{http_code}" localhost:4420` → 200. If not, follow `/run-videoapp`.
3. App: `ls ~/Applications/"Video Studio.app"`. Missing → `scripts/build-studio-app.sh`.
4. Tests (about a minute, a throwaway copy, never the real library): `node --test --test-concurrency=1 video-library/test/*.test.js`. Report failures with their output; don't skip any.

## 2. Higgsfield (paid generations)

Every swap and `/video` generation runs on Higgsfield (https://higgsfield.ai) through its MCP. Without it the Studio still works as a library, and free steps still work.

1. Ask whether the owner has a Higgsfield account. The simplest route is the Higgsfield connector in Claude (claude.ai → Settings → Connectors → Higgsfield); then restart Claude Code in this folder. Check it's there: the Higgsfield tools (`balance`, `generate_video`, `media_upload`) show up in your tool list.
2. **Find its tool prefix for background runs.** Studio runs are `claude -p` sessions and may name the connector differently from this chat. Run:
   `claude -p "Reply with only the exact name of your tool that checks the Higgsfield credit balance, nothing else." --output-format text`
   The answer looks like `mcp__<server>__balance`; the prefix is everything before `__balance`. Put it in `studio.config.json` as `"higgsfieldMcp": "<prefix>"` (keep the file's other fields; build the change with `python3 -I` and `json`). If your own tool list uses a different prefix, list both: `"higgsfieldMcp": ["<one>", "<other>"]`.
3. Restart the server so runs get the new name: `launchctl kickstart -k gui/$(id -u)/<agent from studio.config.json>` (no background runs exist yet, so `-k` is safe now).
4. Check: `balance` answers (free). Tell the owner their balance, and that every paid job will be priced and wait for their Approve.

## 3. Optional apps (all free)

Ask which of these the owner wants; each is optional and every skill works without it.

- **Blender MCP** (`/video`'s blockouts): `brew install --cask blender`, then call Higgsfield's `get_preset_instructions` with `/use-blender` and its `/use-blender/references/installation` reference, and follow it exactly (it installs `fnf-blender-mcp` and runs `claude mcp add --scope user higgsfield-use-blender …`). Use the stable `node` path (e.g. `/opt/homebrew/bin/node`), not a versioned Cellar path. Check with `claude mcp get higgsfield-use-blender`.
- **FilmCraft, EffectCraft, PhotoCraft** (open source by the ArtCraft team: GitHub `storytold/filmcraft`, `storytold/effectcraft`, `storytold/photocraft`): FilmCraft colour-matches AI shots in swaps and edits `/video`; EffectCraft makes `/video` titles; PhotoCraft retouches `/video` frames. For each one the owner wants: read the README and `docs/agents.md`, take the latest release's macOS universal `.dmg` and the separate `-cli-…-macos-universal.zip`, **verify both against the release's `SHA256SUMS.txt`**, copy the app to `/Applications` and the CLI to `~/.local/bin`, then check `spctl -a -vv` (notarized) and `codesign -dv` on the CLI. Put each download in its own new folder in your scratchpad and delete them afterwards. Then rebuild `.mcp.json` from `.mcp.example.json` (move the old one aside first, run `./setup.sh --no-agent --no-app`, which writes it with only the installed CLIs) and tell the owner to restart Claude Code here and approve the project MCP servers. Check each headless server answers one read-only call.

## 4. The first character

A character is a folder in `characters/`; a starring character also gets a swap skill (`/<skill> <link>`) that turns one public person in a video into it. Ask the owner (one question set):
- its **name** and a **photo** (a file path; the photo should show the whole character clearly);
- whether it should **swap someone**, and if so who (a public figure whose clips they parody), the **skill name** (short, lower-case, e.g. `bowtie`) and its **library folder** (e.g. `Bowtie`);
- its **look** (one sentence), **signature accessory** if any, **voice** (how its captions and replies sound) and **off-limits** topics.

Then:
1. `mkdir characters/<slug>/`, copy the photo in (keep its file name), write `character.md` from the template in `characters/README.md` (fill `**Source photo:**`, look, accessory, voice, off-limits), and add its roster row. Or the owner can do this on the Studio's **Characters** page ("New character").
2. Grey cutout: `swift scripts/cutout.swift characters/<slug>/<photo> characters/<slug>/<slug>_grey.png d9d9d9` (free); Read it and check the whole character is there.
3. Swap skill (if it swaps someone): `scripts/new-swap-skill.sh <skill> <slug> "<who>" <Folder>`, then read the new `.claude/skills/<skill>/SKILL.md` once and fix anything that reads wrong for this character.
4. Social accounts (if any, for "Where it's posted" and the Buffer section): add them to `accounts` and a `brands` entry (`subject` = the skill name, the accounts, `handle`, and the `voice` lines) in `studio.config.json`.
5. Restart the server (`launchctl kickstart -k gui/$(id -u)/<agent>`), then check: `curl -s localhost:4420/api/config` lists the folder; the Studio app shows the character's start button.

## 5. Hand over

Open the app (`open -a "Video Studio"`) and tell the owner in a few lines: what is set up, what was skipped, and a cheap first run to try (a `/<skill>` swap of a short clip: the skill prices a ~12-credit test first and waits for Approve; or `/video` with a 2-shot, ~10 s idea). Mention that Buffer is optional and connects on the app's Buffer page with a personal API key.
