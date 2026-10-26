---
name: run-videoapp
description: Open the video library app and the Video Studio (http://localhost:4420 and /studio). The server is always on (a macOS LaunchAgent); this opens it, or restarts it if it is down. Use when the owner types /run-videoapp or asks to open, run or launch the video app or the Studio.
---

# Open the video library and the Studio

The server runs all the time as the LaunchAgent that `setup.sh` installed; its label is the `agent` field of `studio.config.json` (`<label>` below; read it with `python3 -I -c 'import json;print(json.load(open("studio.config.json"))["agent"])'`). It starts at login, restarts itself after a crash, logs to `~/Library/Logs/video-studio.log`). Never start your own copy.

1. Check it: `curl -s -m 5 -o /dev/null -w "%{http_code}" localhost:4420`. `200` → go to step 3.
2. Not 200: start the agent, `launchctl kickstart gui/$(id -u)/<label>` (no `-k`: that kills a slow but working server and its background runs), wait 2 s and check again. Only if it is running but still not answering after ~15 s, force it with `kickstart -k`. If it hangs at start, the log is silent and the process sits at 0% CPU, macOS is blocking its access to the folder (Desktop and Documents are protected): ask the owner to allow **node** under System Settings → Privacy & Security → Files & Folders. Still down: read the last lines of `~/Library/Logs/video-studio.log` and tell the owner what it says. If the agent is missing (`launchctl print gui/$(id -u)/<label>` fails), load it: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`.
3. Open it for the owner: `mcp__Claude_Browser__preview_start` with `{name: "video-library"}` (it only attaches to the running server; it never starts one), or `open http://localhost:4420` (library). For the Studio open the app: `open -a "Video Studio"` (a browser tab at /studio is read-only: only the app can start sessions and answer approvals).
4. Reply with one line: the URL, and whether you had to restart it.

Never run `node video-library/server.js` yourself (`&`, `nohup` or otherwise): a second copy cannot get port 4420 and a stray one blocks launchd's. Never change `newSince` in `settings.json`, and never move or delete videos while doing this.
