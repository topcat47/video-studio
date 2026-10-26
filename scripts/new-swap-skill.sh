#!/bin/zsh
# Make a character's swap skill from templates/swap-skill/SKILL.md.
#   scripts/new-swap-skill.sh <skill> <character folder> "<who it swaps>" <Library folder>
#   e.g. scripts/new-swap-skill.sh bowtie bowtie-cat "Jane Streamer" Bowtie
# Writes .claude/skills/<skill>/SKILL.md (never over an existing one) and makes <Library folder>/originals/.
# Restart the server afterwards (the command is printed) so the Studio shows the new start button and folder.
set -e
root="${0:A:h:h}"
skill="$1"; slug="$2"; target="$3"; folder="$4"
[[ -n "$skill" && -n "$slug" && -n "$target" && -n "$folder" ]] || { sed -n 2,6p "$0" >&2; exit 1; }
[[ "$skill" =~ '^[a-z][a-z0-9-]{1,30}$' ]] || { echo "skill name: lower-case letters, digits and dashes" >&2; exit 1; }
[[ "$skill" != video && "$skill" != run-videoapp && "$skill" != setup ]] || { echo "$skill is taken" >&2; exit 1; }
[[ "$folder" =~ '^[A-Za-z0-9][A-Za-z0-9 _-]{0,40}$' ]] || { echo "library folder: letters, digits, spaces, _ or -" >&2; exit 1; }
[[ "$folder" != Other ]] || { echo "Other/ is the shared folder; give this character its own" >&2; exit 1; }
md="$root/characters/$slug/character.md"
[[ -f "$md" ]] || { echo "no $md: make the character first (Studio → Characters → New character)" >&2; exit 1; }
out="$root/.claude/skills/$skill/SKILL.md"
[[ ! -e "$out" ]] || { echo "$out already exists" >&2; exit 1; }
name=$(sed -n 's/^# //p' "$md" | head -1)
mkdir -p "${out:h}" "$root/$folder/originals"
SKILL="$skill" SLUG="$slug" TARGET="$target" FOLDER="$folder" CHARACTER="${name:-$slug}" python3 -I -c '
import os, sys
s = open(sys.argv[1]).read()
for k in ("SKILL", "SLUG", "TARGET", "FOLDER", "CHARACTER"):
    s = s.replace("{{" + k + "}}", os.environ[k].replace("\n", " "))
open(sys.argv[2], "w").write(s)
' "$root/templates/swap-skill/SKILL.md" "$out"
agent=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("agent", ""))' "$root/studio.config.json" 2>/dev/null || true)
echo "made $out and $folder/originals/"
echo "next: fill in characters/$slug/character.md (look, voice, off-limits) and characters/$slug/prompts.md as you learn them"
[[ -n "$agent" ]] && echo "then restart the server: launchctl kickstart -k gui/$(id -u)/$agent   (-k stops background runs; wait until none is working)"
