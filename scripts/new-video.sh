#!/bin/zsh
# Scaffold a new video project: scripts/new-video.sh <slug>
# Creates projects/<slug>/ with the folders and state files the /video skill expects.
set -euo pipefail
[[ $# -eq 1 && "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "usage: $0 <slug> (lowercase, digits, dashes)" >&2; exit 2; }
root="${0:A:h:h}/projects/$1"
[[ -e "$root" ]] && { echo "exists: $root" >&2; exit 1; }
mkdir -p "$root"/{scenes,renders/concept,renders/frames,renders/animatic,higgsfield/inputs,higgsfield/results,review,edit,final}
cat > "$root/brief.md" <<EOF
# $1

- Concept:
- Length:
- Format: 9:16 vertical, 1080x1920, 24 fps
- Style / look:
- Characters & recurring assets:
- Audio (music / voiceover / sfx):
- Must include / must avoid:
EOF
cat > "$root/shots.json" <<'EOF'
{ "format": { "aspect": "9:16", "width": 1080, "height": 1920, "fps": 24 }, "graphics": [], "shots": [] }
EOF
cat > "$root/log.md" <<EOF
# $1 log

## Spend (credits)
| When | Shot | Job | Model | Credits | Approved by owner | Result |
|---|---|---|---|---|---|---|

## Notes
EOF
echo "$root"
