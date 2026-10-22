#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Installs the Android SDK packages the APK build needs, on a clean machine.

.DESCRIPTION
  Downloads Google command-line tools, unpacks them into <SdkRoot>/cmdline-tools/latest,
  then installs platform-tools, platforms;android-36 and build-tools;36.0.0 through the
  current CLI:

      android --sdk=<dir> sdk install 'platforms;android-36' 'build-tools;36.0.0'

  cmdline-tools 23.0 deprecated `sdkmanager`; `android` replaced it. This script prefers
  the new CLI and only falls back to `sdkmanager` when `android` is not present.

  The script is idempotent: it skips the download when cmdline-tools already exists and
  re-running `sdk install` on already installed packages is a no-op. Every command's real
  output is printed; nothing is suppressed.

  Licenses: cmdline-tools 23.0 accepts them automatically during `sdk install` and writes
  <SdkRoot>/licenses/android-sdk-license. The script verifies that file and only falls back
  to the legacy `sdkmanager --licenses` when it is missing.

  ANDROID_HOME is persisted in the *user* environment (not the machine environment, which
  would need elevation). A user environment change is only picked up by newly started
  processes, so the script also exports it into its own process and prints a reminder.

.PARAMETER SdkRoot
  SDK location. Defaults to $env:ANDROID_HOME, then $env:ANDROID_SDK_ROOT, then
  $HOME/.local/share/android-sdk.

.PARAMETER Packages
  SDK packages to install. The defaults are what AGP 9.4.0 needs.

.PARAMETER SkipUserEnvironment
  Do not persist ANDROID_HOME / ANDROID_SDK_ROOT in the user environment.

.EXAMPLE
  ./packages/android/scripts/setup-android-sdk.ps1
  ./packages/android/scripts/setup-android-sdk.ps1 -SdkRoot D:\android-sdk -SkipUserEnvironment
#>
[CmdletBinding()]
param(
  [string] $SdkRoot,
  [string[]] $Packages = @("platform-tools", "platforms;android-36", "build-tools;36.0.0"),
  [switch] $SkipUserEnvironment
)

$ErrorActionPreference = "Stop"

# Build that ships cmdline-tools 23.0. Verified against
# https://dl.google.com/android/repository/repository2-3.xml on 2026-10-18.
$CmdlineToolsBuild = "16111833"

$onWindows = $env:OS -eq "Windows_NT"
$onMac = $env:OS -eq "Darwin"

if (-not $SdkRoot) {
  if ($env:ANDROID_HOME) {
    $SdkRoot = $env:ANDROID_HOME
  }
  elseif ($env:ANDROID_SDK_ROOT) {
    $SdkRoot = $env:ANDROID_SDK_ROOT
  }
  else {
    $SdkRoot = Join-Path $HOME ".local/share/android-sdk"
  }
}

$archiveName = if ($onWindows) {
  "commandlinetools-win-$CmdlineToolsBuild`_latest.zip"
}
elseif ($onMac) {
  $arm = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64
  if ($arm) { "commandlinetools-mac_arm64-$CmdlineToolsBuild`_latest.zip" }
  else { "commandlinetools-mac_x86_64-$CmdlineToolsBuild`_latest.zip" }
}
else {
  "commandlinetools-linux-$CmdlineToolsBuild`_latest.zip"
}
$archiveUrl = "https://dl.google.com/android/repository/$archiveName"

Write-Host "==> Android SDK root: $SdkRoot"
Write-Host "==> Packages:        $($Packages -join ', ')"
Write-Host "==> Command-line tools: $archiveUrl"

New-Item -ItemType Directory -Force -Path $SdkRoot | Out-Null

$cmdlineRoot = Join-Path $SdkRoot "cmdline-tools/latest"
$cli = if ($onWindows) { Join-Path $cmdlineRoot "bin/android.exe" } else { Join-Path $cmdlineRoot "bin/android" }
$sdkmanager = if ($onWindows) { Join-Path $cmdlineRoot "bin/sdkmanager.bat" } else { Join-Path $cmdlineRoot "bin/sdkmanager" }

if (Test-Path $cli) {
  Write-Host "==> cmdline-tools already installed at $cmdlineRoot, skipping download"
}
else {
  $staging = Join-Path ([System.IO.Path]::GetTempPath()) ("android-cmdline-" + [Guid]::NewGuid().ToString("N"))
  try {
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    $archive = Join-Path $staging $archiveName
    Write-Host "==> Downloading command-line tools"
    Invoke-WebRequest -Uri $archiveUrl -OutFile $archive -UseBasicParsing
    Write-Host "==> Extracting command-line tools"
    Expand-Archive -Path $archive -DestinationPath $staging -Force
    if (Test-Path $cmdlineRoot) { Remove-Item -Recurse -Force $cmdlineRoot }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cmdlineRoot) | Out-Null
    Move-Item -Path (Join-Path $staging "cmdline-tools") -Destination $cmdlineRoot
    Write-Host "==> Installed command-line tools to $cmdlineRoot"
  }
  finally {
    Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
  }
}

if (-not (Test-Path $cli)) {
  throw "Command-line tools are missing: expected the 'android' CLI at $cli. Delete '$cmdlineRoot' and run this script again."
}

Write-Host "==> Installing SDK packages"
if (Test-Path $sdkmanager) { & $sdkmanager "--sdk_root=$SdkRoot" "--version" | Write-Host }
if (Test-Path $cli) {
  Write-Host "==> Using the current CLI: android sdk install"
  & $cli "--sdk=$SdkRoot" sdk install $Packages
}
else {
  Write-Host "==> 'android' CLI not found, falling back to the deprecated sdkmanager"
  & $sdkmanager "--sdk_root=$SdkRoot" $Packages
}
if ($LASTEXITCODE -ne 0) { throw "SDK package installation failed with exit code $LASTEXITCODE." }

$licenseFile = Join-Path $SdkRoot "licenses/android-sdk-license"
if (Test-Path $licenseFile) {
  Write-Host "==> Licenses accepted: $licenseFile"
}
elseif (Test-Path $sdkmanager) {
  Write-Host "==> No license file yet, accepting licenses with the legacy sdkmanager"
  & $sdkmanager "--sdk_root=$SdkRoot" --licenses
  if ($LASTEXITCODE -ne 0) { throw "License acceptance failed with exit code $LASTEXITCODE." }
  if (-not (Test-Path $licenseFile)) { throw "Licenses were not accepted: $licenseFile is still missing." }
}
else {
  throw "Android SDK licenses were not accepted: $licenseFile is missing and no sdkmanager is available."
}

Write-Host "==> Installed packages"
& $cli "--sdk=$SdkRoot" sdk list
if ($LASTEXITCODE -ne 0) { throw "'android sdk list' failed with exit code $LASTEXITCODE." }

$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot

if ($SkipUserEnvironment) {
  Write-Host "==> -SkipUserEnvironment given, ANDROID_HOME was set in this process only"
}
elseif ($onWindows) {
  [Environment]::SetEnvironmentVariable("ANDROID_HOME", $SdkRoot, "User")
  [Environment]::SetEnvironmentVariable("ANDROID_SDK_ROOT", $SdkRoot, "User")
  Write-Host "==> ANDROID_HOME and ANDROID_SDK_ROOT were written to the *user* environment as $SdkRoot"
  Write-Host "    Already open shells keep the old value; start a new shell or sign out and back in."
}
else {
  Write-Host "==> Add these lines to your shell profile so new shells find the SDK:"
  Write-Host "    export ANDROID_HOME='$SdkRoot'"
  Write-Host "    export ANDROID_SDK_ROOT='$SdkRoot'"
}

Write-Host "==> Done. ANDROID_HOME=$SdkRoot"