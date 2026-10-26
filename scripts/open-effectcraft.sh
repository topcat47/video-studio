#!/bin/zsh
# Launch EffectCraft with its control server on 127.0.0.1:9877 so the
# "effectcraft" MCP server (bridge mode) can drive the live app.
# Usage: scripts/open-effectcraft.sh [project.ecproj]
nohup /Applications/EffectCraft.app/Contents/MacOS/EffectCraft --control 9877 "$@" >/dev/null 2>&1 &
