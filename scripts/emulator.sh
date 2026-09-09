#!/usr/bin/env bash
# Creates (first run) and boots the "feeld" Android virtual device with the Play Store.
# Usage: npm run emulator      (or: scripts/emulator.sh [avd-name])
set -euo pipefail

AVD_NAME="${1:-feeld}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
if [ -z "${JAVA_HOME:-}" ]; then
  for j in /opt/homebrew/opt/openjdk@21 /opt/homebrew/opt/openjdk@17 /opt/homebrew/opt/openjdk; do
    [ -d "$j" ] && export JAVA_HOME="$j" && break
  done
fi
BREW_CMDLINE="/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin"
CMDLINE="$ANDROID_HOME/cmdline-tools/latest/bin"
IMAGE="system-images;android-35;google_apis_playstore;arm64-v8a"

# Bootstrap: the SDK needs its own copy of cmdline-tools so avdmanager sees the system images.
if [ ! -x "$CMDLINE/avdmanager" ]; then
  BOOT="$BREW_CMDLINE/sdkmanager"
  [ -x "$BOOT" ] || { echo "Install the SDK tools first: brew install --cask android-commandlinetools"; exit 1; }
  yes | "$BOOT" --sdk_root="$ANDROID_HOME" --licenses >/dev/null
  "$BOOT" --sdk_root="$ANDROID_HOME" --install "cmdline-tools;latest"
fi
if [ ! -x "$ANDROID_HOME/emulator/emulator" ] || [ ! -d "$ANDROID_HOME/system-images/android-35/google_apis_playstore" ]; then
  echo "Installing emulator + Play Store image (about 1.5 GB)…"
  yes | "$CMDLINE/sdkmanager" --sdk_root="$ANDROID_HOME" --licenses >/dev/null
  "$CMDLINE/sdkmanager" --sdk_root="$ANDROID_HOME" --install "platform-tools" "emulator" "$IMAGE"
fi

if ! "$CMDLINE/avdmanager" list avd 2>/dev/null | grep -q "Name: $AVD_NAME\$"; then
  echo "Creating virtual device '$AVD_NAME' (Pixel 8, Android 15 with Play Store)…"
  echo no | "$CMDLINE/avdmanager" create avd -n "$AVD_NAME" -k "$IMAGE" -d "pixel_8" --force >/dev/null
  CFG="$HOME/.android/avd/$AVD_NAME.avd/config.ini"
  # a bit more RAM/storage so the Play Store and Feeld are comfortable
  sed -i '' -e 's/^hw.ramSize=.*/hw.ramSize=4096/' "$CFG" 2>/dev/null || true
  grep -q '^hw.ramSize' "$CFG" || echo 'hw.ramSize=4096' >> "$CFG"
  grep -q '^disk.dataPartition.size' "$CFG" || echo 'disk.dataPartition.size=8G' >> "$CFG"
  sed -i '' -e 's/^hw.keyboard=.*/hw.keyboard=yes/' "$CFG" 2>/dev/null || true
  grep -q '^hw.keyboard=' "$CFG" || echo 'hw.keyboard=yes' >> "$CFG"
fi

echo "Booting '$AVD_NAME'. First boot takes a minute or two."
echo "Then: open the Play Store in the emulator, sign in, install Feeld, log in, and run 'npm start'."
exec "$ANDROID_HOME/emulator/emulator" -avd "$AVD_NAME" -no-snapshot-load -no-boot-anim -no-metrics "$@"
