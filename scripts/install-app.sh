#!/usr/bin/env bash
# Builds "Feeld Swiper.app" (a Dock launcher that starts the dashboard and opens it) and installs it.
# Usage: npm run install-app            → /Applications/Feeld Swiper.app
#        scripts/install-app.sh ~/Applications
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-/Applications}"
APP="$DEST/Feeld Swiper.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/app/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/app/FeeldSwiper.icns" "$APP/Contents/Resources/FeeldSwiper.icns"
sed "s|__PROJECT_DIR__|$ROOT|" "$ROOT/app/launcher.sh" > "$APP/Contents/MacOS/launcher"
chmod +x "$APP/Contents/MacOS/launcher"
touch "$APP"   # nudge Finder/LaunchServices to pick up the icon
echo "Installed $APP"
echo "Open it once, then right-click its Dock icon → Options → Keep in Dock."
