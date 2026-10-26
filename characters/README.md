# Characters

Every character you put on screen has one folder here. Look here first; never search Downloads, scratchpads or old sessions for a character.
When the owner names a character, use this folder's files without asking.

Add one on the Studio's **Characters** page ("New character"), or by hand with the steps at the bottom. `/setup` walks you through the first one.

## Roster

| Character | Folder | Role | Swaps out | Skill | Library folder | Source photo |
|---|---|---|---|---|---|---|

**main** = has a starring role: its own swap skill, library folder, voice and running jokes. **bench** = available as a cast member, no skill yet. Promoting a character changes its `role` and adds a skill; its folder never moves, so no path breaks.

## Rules for every character

- **Don't mix them up.** Each character has exactly one source photo; use that file, never a lookalike.
- **No human elements on a character.** The character is complete in its own body: no human body, arms, hands, fingers, skin, tattoos, or standing upright like a person; no human clothing or gear, only the character's own signature accessory (named in its `character.md`). In a person swap replace the **entire** person head to toe; a character head on a human body is a fail. Check a frame from every shot before delivering.
- **Each character looks exactly like its photo.** Put the character's look sentence (in its `character.md`) in every prompt, right after any accessory paragraph, and pass the grey cutout as a reference.
- **Parody, not impersonation.** A swap turns a public person into an obviously fictional character. Never present a character's video or post as the real person, never use their handle or sign as them, and screen every clip against the character's off-limits list before pricing it.

## How a character is built (folder anatomy)

```
characters/<name>/
  character.md            # role, who it parodies/replaces, look sentence, accessory paragraph, voice, off-limits, history
  <source photo>          # the one true reference (keep the original file name)
  <name>_grey.png         # the cutout on grey #d9d9d9, ready to pass as a swap reference (a reference's background leaks into the video otherwise)
  <name>-profile-*.png    # profile pictures, if you make them
```
Main-cast characters also carry a **kit**, so every pipeline starts from the same settled material:
```
  prompts.md              # the prompt book: prompt order, accessory paragraph, proven prompt per shot type, failures
  approved-stills/        # stills the owner picked, reused as references; index.md lists source, job id and prompt
```
Make a missing grey cutout once with `swift scripts/cutout.swift <photo> characters/<name>/<name>_grey.png d9d9d9` (free, macOS Vision), or with "Make grey cutout" on the character's page in the Studio.

## character.md

```markdown
# <Name>

**Role:** main | bench
**Source photo:** `<file>` (this folder).
**Swaps out:** <the public person this character parodies, or none>

## Look (put in every prompt)
- <one sentence: coat, colours, build, eyes, size>
- Signature accessory: <one paragraph, or none>. No human parts (see `../README.md`).

## Voice
- <how its captions, X posts and replies sound; two or three example lines>

## Off-limits
- <topics this character never touches: the real person's legal cases, health, drugs; rating real people's looks; …>

## Notes
- <dated lessons>
```

## Adding a character
1. `mkdir characters/<kebab-name>/`, put the source photo in it (original file name).
2. Write `character.md` from the template above.
3. Add a row to the roster above. Bench until the owner gives it a starring role.
4. Starring role: make its swap skill from `templates/swap-skill/` (see that folder's README), which gives it a start button in the Studio and its own library folder.
