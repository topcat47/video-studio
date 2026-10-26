# Swap skill template

`SKILL.md` here is the skill every character swap uses: it turns one public person in a video into one of your characters (`/<skill> <link>`), with a test job first, a price approval before every paid job, captions put back, and the final filed in the library. It is not a skill itself until it's copied into `.claude/skills/`.

Make one per starring character, after the character exists in `characters/<slug>/`:

```bash
scripts/new-swap-skill.sh <skill> <character folder> "<who it swaps>" <Library folder>
```

That fills in the `{{…}}` placeholders, writes `.claude/skills/<skill>/SKILL.md` and makes `<Library folder>/originals/`. The frontmatter's `character:`, `swaps:` and `folder:` lines are what make it a start button on the Studio page, a folder in the library and a step tracker on In progress, so keep them. Restart the server afterwards (the script prints the command). `/setup` does all of this for your first character.

Edit the new skill freely (the Studio's **Skills** page edits it in place too); its **Lessons** section and the character's `prompts.md` are where each clip's lessons go.
