#!/usr/bin/env bash
# Builds the debug APK: web bundle from packages/app, copied into the app assets, then Gradle.
#
# Three steps, in order:
#
#   1. Build the web bundle from packages/app with VITE_ORCHESTRA_SERVER_MODE=none. That mode
#      ships no initial server, so the app opens on its own full-screen connection form and
#      the user adds a server by address/password, by an `opencode pair` link or by QR code
#      (packages/app/README.md, "VITE_ORCHESTRA_SERVER_MODE").
#   2. Copy packages/app/dist into packages/android/app/src/main/assets/app/, replacing
#      whatever was there so stale hashed assets never survive a rebuild.
#   3. Run packages/android/gradlew :app:assembleDebug.
#
# The script fails fast with a readable message when packages/android/app does not exist yet,
# rather than letting Gradle print a stack trace.
#
# ANDROID_HOME comes from the environment; if it is unset the script falls back to
# $HOME/.local/share/android-sdk and errors out with the setup command when that is missing too.
# No local.properties is written, so the SDK location never lands in the repository.
#
# Usage:
#   ./packages/android/scripts/build-apk.sh

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android_root="$(dirname "$script_dir")"
repo_root="$(dirname "$(dirname "$android_root")")"
app_dir="$repo_root/packages/app"
dist_dir="$app_dir/dist"
assets_dir="$android_root/app/src/main/assets/app"

echo "==> Repository root: $repo_root"
echo "==> Android project: $android_root"

# Fail with a readable message, before spending ten seconds on a bundle build, when the
# Android application module is not written yet.
if [ ! -f "$android_root/app/build.gradle.kts" ]; then
  echo "The Android app module is missing: expected $android_root/app/build.gradle.kts. packages/android/app/** has to exist before an APK can be assembled." >&2
  exit 1
fi
if [ ! -f "$android_root/settings.gradle.kts" ]; then
  echo "The Gradle settings file is missing: expected $android_root/settings.gradle.kts." >&2
  exit 1
fi

sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/.local/share/android-sdk}}"
if [ ! -d "$sdk_root/platforms/android-36" ]; then
  echo "Android SDK platform android-36 not found under $sdk_root. Run: ./packages/android/scripts/setup-android-sdk.sh" >&2
  exit 1
fi
export ANDROID_HOME="$sdk_root"
export ANDROID_SDK_ROOT="$sdk_root"
echo "==> ANDROID_HOME: $sdk_root"

echo "==> Building the web bundle from packages/app with VITE_ORCHESTRA_SERVER_MODE=none"
# `none` means the APK ships without a baked-in server: the app shows its own connection
# form. The previous value is restored so this script does not leak the setting upward.
previous_server_mode="${VITE_ORCHESTRA_SERVER_MODE-}"
export VITE_ORCHESTRA_SERVER_MODE="none"
trap 'export VITE_ORCHESTRA_SERVER_MODE="$previous_server_mode"' EXIT
(cd "$app_dir" && bun run build)

if [ ! -f "$dist_dir/index.html" ]; then
  echo "The web bundle is missing $dist_dir/index.html after the build." >&2
  exit 1
fi
echo "==> Bundle ready: $(du -sh "$dist_dir" | cut -f1) in $dist_dir"

echo "==> Copying the bundle into $assets_dir"
# Wipe first: a previous build leaves hashed asset files behind that the new index.html
# no longer references, and they would still be packaged into the APK.
rm -rf "$assets_dir"
mkdir -p "$assets_dir"
cp -R "$dist_dir/." "$assets_dir/"

echo "==> Running :app:assembleDebug"
(cd "$android_root" && ./gradlew :app:assembleDebug)

apk="$android_root/app/build/outputs/apk/debug/app-debug.apk"
if [ ! -f "$apk" ]; then
  echo "Gradle reported success but no APK was produced at $apk." >&2
  exit 1
fi
echo "==> APK: $apk"
echo "==> Size: $(du -h "$apk" | cut -f1)"
echo "==> sha256: $(sha256sum "$apk" | cut -d' ' -f1)"