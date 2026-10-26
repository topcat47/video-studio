#!/bin/zsh
# Build the Video Studio Mac app (a native window around http://127.0.0.1:4420) into ~/Applications.
#   scripts/build-studio-app.sh          the real app, into ~/Applications
#   scripts/build-studio-app.sh --test   the test build (env overrides + test channel), into video-library/test/.build/
# Re-run after editing video-library/desktop/VideoStudio.swift. The web pages themselves need no rebuild:
# the app always shows what the server serves.
set -e
root="${0:A:h:h}"
src="$root/video-library/desktop"
app="$HOME/Applications/Video Studio.app"
test_build=false; flags=(); prefix="${STUDIO_BUNDLE_PREFIX:-local.$(id -un | tr -cd "a-zA-Z0-9-")}"; bundle_id=$prefix.video-studio-app; name="Video Studio"
if [[ "${1:-}" == --test ]]; then
  test_build=true; flags=(-D STUDIO_TEST); bundle_id=$prefix.video-studio-app.test; name="Video Studio Test"
  app="$src/../test/.build/Video Studio Test.app"
fi
icon_svg="$root/video-library/desktop/app-icon.svg"
[[ -f "$icon_svg" ]] || { echo "missing icon source: $icon_svg" >&2; exit 1; }
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
icon_src="$build/icon-1024.png"
swift "$root/scripts/render-svg.swift" "$icon_svg" "$icon_src" 1024 >/dev/null || { echo "icon render failed" >&2; exit 1; }

mkdir -p "$build/Video Studio.app/Contents/MacOS" "$build/Video Studio.app/Contents/Resources"
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13" "${flags[@]}" \
  -o "$build/Video Studio.app/Contents/MacOS/VideoStudio" "$src/VideoStudio.swift" 2>&1 | grep -v "^$" || true
[[ -x "$build/Video Studio.app/Contents/MacOS/VideoStudio" ]] || { echo "build failed" >&2; exit 1; }

# Icon: the split-frame logo (video-library/desktop/app-icon.svg)
set_dir="$build/AppIcon.iconset"; mkdir "$set_dir"
for s in 16 32 128 256 512; do
  sips -z $s $s "$icon_src" --out "$set_dir/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$icon_src" --out "$set_dir/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o "$build/Video Studio.app/Contents/Resources/AppIcon.icns"

cat > "$build/Video Studio.app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundleDisplayName</key><string>$name</string>
  <key>CFBundleIdentifier</key><string>$bundle_id</string>
  <key>CFBundleExecutable</key><string>VideoStudio</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>StudioAgent</key><string>$prefix.video-studio</string>
  <key>StudioRoot</key><string>$root</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
EOF

codesign --force --sign - "$build/Video Studio.app" >/dev/null
codesign --verify "$build/Video Studio.app"
if $test_build; then          # the test build never touches the real app
  mkdir -p "$(dirname "$app")"; rm -rf "$app"; mv "$build/Video Studio.app" "$app"; echo "built: $app"; exit 0
fi
mkdir -p "$HOME/Applications"
# Swap in the new app; the old one is only removed once the new one is in place. Quit it first and
# reopen it afterwards if it was running (the server and background runs are not affected).
was_running=false
# (a plain TERM signal, not an AppleScript "quit": that waits on a macOS automation prompt and can hang)
if pgrep -x VideoStudio >/dev/null; then
  was_running=true; pkill -TERM -x VideoStudio
  for _ in 1 2 3 4 5 6; do pgrep -x VideoStudio >/dev/null || break; sleep 0.5; done
  pkill -KILL -x VideoStudio 2>/dev/null || true
fi
[[ -e "$app" ]] && mv "$app" "$build/old.app"
mv "$build/Video Studio.app" "$app"
echo "built: $app"
$was_running && open "$app"
exit 0
