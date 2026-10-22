#!/usr/bin/env bash
# Installs the Android SDK packages the APK build needs, on a clean machine.
#
# Downloads Google command-line tools, unpacks them into "$SDK_ROOT/cmdline-tools/latest",
# then installs platform-tools, platforms;android-36 and build-tools;36.0.0 through the
# current CLI:
#
#     android --sdk=<dir> sdk install 'platforms;android-36' 'build-tools;36.0.0'
#
# cmdline-tools 23.0 deprecated `sdkmanager`; `android` replaced it. This script prefers the
# new CLI and only falls back to `sdkmanager` when `android` is not present.
#
# The script is idempotent: it skips the download when cmdline-tools already exists and
# re-running `sdk install` on already installed packages is a no-op. Every command's real
# output is printed; nothing is suppressed.
#
# Licenses: cmdline-tools 23.0 accepts them automatically during `sdk install` and writes
# "$SDK_ROOT/licenses/android-sdk-license". The script verifies that file and only falls back
# to the legacy `sdkmanager --licenses` when it is missing.
#
# ANDROID_HOME is exported for this process and for every process started after the SDK is in
# place. Nothing is written to a shell profile automatically; the script prints the exact line
# to add, because a user environment change only reaches newly started shells.
#
# Usage:
#   ./packages/android/scripts/setup-android-sdk.sh
#   SDK_ROOT=/opt/android-sdk ./packages/android/scripts/setup-android-sdk.sh

set -euo pipefail

# Build that ships cmdline-tools 23.0. Verified against
# https://dl.google.com/android/repository/repository2-3.xml on 2026-10-18.
CMDLINE_TOOLS_BUILD="16111833"
PACKAGES=("platform-tools" "platforms;android-36" "build-tools;36.0.0")

os="$(uname -s)"
machine="$(uname -m)"
case "$os" in
  Linux) archive_name="commandlinetools-linux-${CMDLINE_TOOLS_BUILD}_latest.zip" ;;
  Darwin)
    if [ "$machine" = "arm64" ]; then
      archive_name="commandlinetools-mac_arm64-${CMDLINE_TOOLS_BUILD}_latest.zip"
    else
      archive_name="commandlinetools-mac_x86_64-${CMDLINE_TOOLS_BUILD}_latest.zip"
    fi
    ;;
  *) echo "Unsupported host '$os'. Install the Android SDK by hand and set ANDROID_HOME." >&2; exit 1 ;;
esac
archive_url="https://dl.google.com/android/repository/${archive_name}"

sdk_root="${SDK_ROOT:-${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/.local/share/android-sdk}}}"
cmdline_root="$sdk_root/cmdline-tools/latest"
cli="$cmdline_root/bin/android"
sdkmanager="$cmdline_root/bin/sdkmanager"
license_file="$sdk_root/licenses/android-sdk-license"

echo "==> Android SDK root: $sdk_root"
echo "==> Packages:         ${PACKAGES[*]}"
echo "==> Command-line tools: $archive_url"

mkdir -p "$sdk_root"

if [ -x "$cli" ]; then
  echo "==> cmdline-tools already installed at $cmdline_root, skipping download"
else
  staging="$(mktemp -d)"
  trap 'rm -rf "$staging"' EXIT
  echo "==> Downloading command-line tools to $staging/$archive_name"
  curl --fail --location --retry 3 --output "$staging/$archive_name" "$archive_url"
  echo "==> Extracting command-line tools"
  unzip -q "$staging/$archive_name" -d "$staging"
  rm -rf "$cmdline_root"
  mkdir -p "$(dirname "$cmdline_root")"
  mv "$staging/cmdline-tools" "$cmdline_root"
  echo "==> Installed command-line tools to $cmdline_root"
fi

if [ ! -x "$cli" ]; then
  echo "Command-line tools are missing: expected the 'android' CLI at $cli. Delete '$cmdline_root' and run this script again." >&2
  exit 1
fi

echo "==> Installing SDK packages"
if [ -x "$cli" ]; then
  echo "==> Using the current CLI: android sdk install"
  "$cli" "--sdk=$sdk_root" sdk install "${PACKAGES[@]}"
else
  echo "==> 'android' CLI not found, falling back to the deprecated sdkmanager"
  "$sdkmanager" "--sdk_root=$sdk_root" "${PACKAGES[@]}"
fi

if [ -f "$license_file" ]; then
  echo "==> Licenses accepted: $license_file"
elif [ -x "$sdkmanager" ]; then
  echo "==> No license file yet, accepting licenses with the legacy sdkmanager"
  "$sdkmanager" "--sdk_root=$sdk_root" --licenses
  if [ ! -f "$license_file" ]; then
    echo "Licenses were not accepted: $license_file is still missing." >&2
    exit 1
  fi
else
  echo "Android SDK licenses were not accepted: $license_file is missing and no sdkmanager is available." >&2
  exit 1
fi

echo "==> Installed packages"
"$cli" "--sdk=$sdk_root" sdk list

export ANDROID_HOME="$sdk_root"
export ANDROID_SDK_ROOT="$sdk_root"

echo "==> Add these lines to your shell profile so new shells find the SDK:"
echo "    export ANDROID_HOME='$sdk_root'"
echo "    export ANDROID_SDK_ROOT='$sdk_root'"
echo "==> Done. ANDROID_HOME=$sdk_root"