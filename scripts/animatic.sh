#!/bin/zsh
# Join shot clips into one review video at a common size/fps (re-encodes, drops audio):
#   scripts/animatic.sh <out.mp4> <w> <h> <fps> <clip1> [clip2 ...]
# Use for the Blender animatic and for quick rough cuts of generated clips before the FilmCraft edit.
set -euo pipefail
[[ $# -ge 5 ]] || { echo "usage: $0 <out.mp4> <w> <h> <fps> <clips...>" >&2; exit 2; }
out=$1 w=$2 h=$3 fps=$4; shift 4
inputs=() chain="" i=0
for c in "$@"; do
  inputs+=(-i "$c")
  chain+="[$i:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=${fps},setsar=1,format=yuv420p[v$i];"
  i=$((i+1))
done
concat=""; for ((j=0;j<i;j++)); do concat+="[v$j]"; done
ffmpeg -v error -y "${inputs[@]}" -filter_complex "${chain}${concat}concat=n=${i}:v=1:a=0[out]" -map "[out]" -c:v libx264 -crf 20 -preset veryfast "$out"
echo "$out  ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out")s, $i clips)"
