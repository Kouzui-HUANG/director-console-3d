#!/bin/bash
# Builds "3D 導演台.app" — a one-click launcher with its own icon — in the project folder
# (or another folder). Usage: npm run mac-app [-- <target folder>]
# Inside the project folder the app finds the project from its own location, so it keeps working
# when the whole project is moved. Copies elsewhere use the path recorded here.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/scripts/mac-app"
TARGET="${1:-$REPO}"
NAME="3D 導演台"
BUNDLE_ID="local.director3d.launcher"
APP="$TARGET/$NAME.app"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ "$(uname)" != "Darwin" ]; then
  echo "This script builds a macOS app; it only runs on macOS." >&2
  exit 1
fi
mkdir -p "$TARGET"

# Refuse to replace something that is not our launcher.
if [ -e "$APP" ]; then
  existing="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || true)"
  if [ "$existing" != "$BUNDLE_ID" ]; then
    echo "$APP already exists and is not a 3D 導演台 launcher; not touching it." >&2
    exit 1
  fi
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. Icon: render the SVG to a 1024 px PNG (headless Chrome, Quick Look as a fallback).
PNG="$WORK/icon_1024.png"
if [ -x "$CHROME" ]; then
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$WORK/chrome" \
    --default-background-color=00000000 --window-size=1024,1024 --screenshot="$PNG" "file://$SRC/icon.svg" >/dev/null 2>&1 || true
fi
if [ ! -s "$PNG" ]; then
  qlmanage -t -s 1024 -o "$WORK" "$SRC/icon.svg" >/dev/null 2>&1 || true
  [ -s "$WORK/icon.svg.png" ] && mv "$WORK/icon.svg.png" "$PNG"
fi
[ -s "$PNG" ] || { echo "Could not render scripts/mac-app/icon.svg (needs Google Chrome or Quick Look)." >&2; exit 1; }

ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$PNG" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z "$d" "$d" "$PNG" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$WORK/AppIcon.icns"

# 2. App bundle.
STAGE="$WORK/$NAME.app"
mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources"
cp "$WORK/AppIcon.icns" "$STAGE/Contents/Resources/AppIcon.icns"
REPO_ESCAPED="$(printf '%s' "$REPO" | sed 's/[&|\\]/\\&/g')"
sed "s|__REPO__|$REPO_ESCAPED|" "$SRC/launch.sh" >"$STAGE/Contents/MacOS/launch"
chmod +x "$STAGE/Contents/MacOS/launch"
VERSION="$(node -p "require('$REPO/package.json').version" 2>/dev/null || echo 0.1.0)"
cat >"$STAGE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSArchitecturePriority</key><array><string>arm64</string><string>x86_64</string></array>
  <key>LSRequiresNativeExecution</key><true/>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# 3. Install (replace our previous launcher) and refresh Finder's icon cache.
rm -rf "$APP"
mv "$STAGE" "$APP"
touch "$APP"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true

echo "Created: $APP"
