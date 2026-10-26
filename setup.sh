#!/bin/zsh
# Set up the Video Studio on this Mac. Safe to run again: it never overwrites your config, library or characters.
#   ./setup.sh             check the tools, make the folders and config, install the server's LaunchAgent, build the app
#   ./setup.sh --install   also install missing tools with Homebrew (node, ffmpeg, yt-dlp, whisper-cpp) and the whisper model
#   ./setup.sh --no-agent  don't install or restart the LaunchAgent (e.g. another copy already serves port 4420)
#   ./setup.sh --no-app    don't build ~/Applications/Video Studio.app
# Then open Claude Code in this folder and run /setup (Higgsfield, the optional apps, your first character).
set -euo pipefail
root="${0:A:h}"
install=false; agent=true; app=true
for a in "$@"; do
  case "$a" in
    --install) install=true ;; --no-agent) agent=false ;; --no-app) app=false ;;
    -h|--help) sed -n 2,7p "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
ok()   { print -P "%F{green}✓%f $*"; }
warn() { print -P "%F{yellow}!%f $*"; }
bad()  { print -P "%F{red}✗%f $*"; }
missing=()

[[ "$(uname)" == Darwin ]] || { bad "The Video Studio is a macOS app (it uses launchd, Swift and Apple's on-device upscaler)."; exit 1; }
case "$root" in
  *"/Desktop/"*|*"/Documents/"*) warn "This folder is under Desktop or Documents: macOS will ask to allow node access to it the first time the server starts (System Settings → Privacy & Security → Files & Folders)." ;;
esac

# 1. Tools
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
need() {   # need <command> <brew formula or ""> <what it is for> [optional]
  if command -v "$1" >/dev/null; then ok "$1 ($(command -v "$1"))"; return; fi
  if $install && [[ -n "$2" ]] && command -v brew >/dev/null; then brew install "$2" && { ok "$1 installed"; return; }; fi
  if [[ "${4:-}" == optional ]]; then warn "$1 missing: $3${2:+ (brew install $2)}"; else bad "$1 missing: $3${2:+ (brew install $2)}"; missing+=("$1"); fi
}
command -v brew >/dev/null && ok "Homebrew" || warn "Homebrew missing (https://brew.sh): needed for --install"
need node node "runs the library server"
if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  (( major >= 22 )) || { bad "node $major is too old: 22 or newer"; missing+=(node); }
fi
need ffmpeg ffmpeg "thumbnails, cuts, assembling swaps"
need ffprobe ffmpeg "video lengths and frame counts"
need python3 "" "the swap scripts and the paid guard (Xcode command-line tools: xcode-select --install)"
need swiftc "" "the Mac app, the cutout and the 1080p upscaler (xcode-select --install)"
need yt-dlp yt-dlp "downloading source clips"
need whisper-cli whisper-cpp "transcripts (search by what's said)" optional
need claude "" "Claude Code itself (https://claude.com/claude-code)"
model="$HOME/.cache/whisper-models/ggml-base.en.bin"
if [[ -f "$model" ]]; then ok "whisper model"
elif $install; then
  mkdir -p "${model:h}" && curl -fL --progress-bar -o "$model.part" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin && mv "$model.part" "$model" && ok "whisper model downloaded"
else warn "whisper model missing ($model): run ./setup.sh --install, or transcripts stay off"; fi
(( ${#missing} == 0 )) || { bad "Install the missing tools (or run ./setup.sh --install), then run this again."; exit 1; }

# 2. Folders and your own files (never overwritten)
mkdir -p "$root/Other/originals" "$root/songs" "$root/projects" "$root/runs" "$root/assets"
ok "folders: Other/, songs/, projects/, runs/, assets/"
user_slug=$(id -un | tr -cd 'a-zA-Z0-9-' | tr 'A-Z' 'a-z')
label="local.${user_slug:-user}.video-studio"
config="$root/studio.config.json"
if [[ -f "$config" ]]; then
  label=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("agent") or sys.argv[2])' "$config" "$label")
  ok "studio.config.json (kept)"
else
  python3 -I - "$root/studio.config.example.json" "$config" "$label" <<'PY'
import json, sys
src, out, label = sys.argv[1:4]
c = {k: v for k, v in json.load(open(src)).items() if not k.startswith("_")}
c["agent"] = label
json.dump(c, open(out, "w"), indent=2)
open(out, "a").write("\n")
PY
  ok "studio.config.json (new; see studio.config.example.json for every field)"
fi
settings="$root/video-library/settings.json"
[[ -f "$settings" ]] || { print '{ "newSince": 0 }' > "$settings"; ok "video-library/settings.json (shows every video)"; }
[[ -f "$root/video-library/labels.json" ]] || print '{}' > "$root/video-library/labels.json"
if [[ -f "$root/.mcp.json" ]]; then ok ".mcp.json (kept)"
else
  python3 -I - "$root/.mcp.example.json" "$root/.mcp.json" "$HOME" <<'PY'
import json, os, sys
src, out, home = sys.argv[1:4]
servers = json.loads(open(src).read().replace("__HOME__", home))["mcpServers"]
keep = {k: v for k, v in servers.items() if os.path.exists(v["command"])}
json.dump({"mcpServers": keep}, open(out, "w"), indent=2)
open(out, "a").write("\n")
print("  craft servers found:", ", ".join(keep) or "none (optional; /setup can install FilmCraft, EffectCraft and PhotoCraft)")
PY
  ok ".mcp.json"
fi
chmod +x "$root"/scripts/*.sh "$root/setup.sh" 2>/dev/null || true

# 3. The server, always on (a LaunchAgent)
if $agent; then
  plist="$HOME/Library/LaunchAgents/$label.plist"
  node_bin=$(command -v node); claude_bin=$(command -v claude)
  mkdir -p "${plist:h}" "$HOME/Library/Logs"
  python3 -I - "$plist" "$label" "$node_bin" "$root" "$claude_bin" "$HOME" <<'PY'
import plistlib, sys
out, label, node, root, claude, home = sys.argv[1:7]
log = f"{home}/Library/Logs/video-studio.log"
plistlib.dump({
    "Label": label,
    "ProgramArguments": [node, f"{root}/video-library/server.js"],
    "WorkingDirectory": root,
    "EnvironmentVariables": {"PATH": f"/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                             "HOME": home, "STUDIO_CLAUDE_BIN": claude},
    "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10,
    "StandardOutPath": log, "StandardErrorPath": log,
}, open(out, "wb"))
PY
  domain="gui/$(id -u)"
  launchctl bootout "$domain/$label" 2>/dev/null || true
  for _ in {1..10}; do lsof -nP -iTCP:4420 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done
  if lsof -nP -iTCP:4420 -sTCP:LISTEN >/dev/null 2>&1; then
    bad "Something else already listens on port 4420 (another Video Studio?). Stop it, or rerun with --no-agent."; exit 1
  fi
  launchctl bootstrap "$domain" "$plist"
  ok "LaunchAgent $label (log: ~/Library/Logs/video-studio.log)"
  for _ in {1..20}; do curl -s -m 2 -o /dev/null localhost:4420 && break; sleep 0.5; done
  if curl -s -m 2 -o /dev/null -w '%{http_code}' localhost:4420 | grep -q 200; then ok "server answers on http://localhost:4420"
  else warn "the server isn't answering yet: check ~/Library/Logs/video-studio.log (macOS may be asking to allow node access to this folder)"; fi
else warn "LaunchAgent skipped (--no-agent)"; fi

# 4. The Mac app
if $app; then
  "$root/scripts/build-studio-app.sh" >/dev/null && ok "~/Applications/Video Studio.app" || warn "the app didn't build: run scripts/build-studio-app.sh to see why"
else warn "app build skipped (--no-app)"; fi

print
print "Next: open Claude Code in this folder (cd ${(q)root} && claude) and run /setup."
print "It connects Higgsfield, offers the optional apps (Blender, FilmCraft, EffectCraft, PhotoCraft) and makes your first character."
