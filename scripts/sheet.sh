#!/bin/zsh
# Contact sheet of a video for review: scripts/sheet.sh <video> <out.png> [fps=4] [cols=6]
# Tiles are in time order, left to right, top to bottom; at fps=4 each tile is 0.25 s.
set -euo pipefail
[[ $# -ge 2 ]] || { echo "usage: $0 <video> <out.png> [fps] [cols]" >&2; exit 2; }
in=$1 out=$2 fps=${3:-4} cols=${4:-6}
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$in")
n=$(python3 -I -c "import math,sys;print(max(1,math.ceil(float(sys.argv[1])*float(sys.argv[2]))))" "$dur" "$fps")
rows=$(( (n + cols - 1) / cols ))
ffmpeg -v error -y -i "$in" -vf "fps=$fps,scale=200:-2,tile=${cols}x${rows}:padding=4:color=0x202020" -frames:v 1 -update 1 "$out"
echo "$out  (${n} tiles, ${cols}x${rows}, 1 tile = $(python3 -I -c "print(round(1/float('$fps'),3))") s, duration ${dur}s)"
