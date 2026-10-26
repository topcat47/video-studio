#!/bin/zsh
# Launch FilmCraft with its control server on 127.0.0.1:9876 so the
# "filmcraft" MCP server (bridge mode) can drive the live app.
# Usage: scripts/open-filmcraft.sh [project.fcproj]
FILMCRAFT_CONTROL_PORT=9876 nohup /Applications/FilmCraft.app/Contents/MacOS/FilmCraft --control 9876 "$@" >/dev/null 2>&1 &
