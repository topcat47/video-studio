#!/bin/zsh
# Launch PhotoCraft with its control server on 127.0.0.1:9878 for the "photocraft" MCP bridge.
# The bridge authenticates with a token file (created on first launch), and the app may only
# read and write files inside this folder (the repo folder).
# Usage: scripts/open-photocraft.sh [image.psd|.pcraft|.png]
root="${0:A:h:h}"
mkdir -p ~/.config/photocraft
nohup /Applications/PhotoCraft.app/Contents/MacOS/PhotoCraft --control 9878 \
  --control-token-file ~/.config/photocraft/control.token \
  --automation-read-root "$root" --automation-write-root "$root" "$@" >/dev/null 2>&1 &
