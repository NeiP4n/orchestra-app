#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Builds the debug APK: web bundle from packages/app, copied into the app assets, then Gradle.

.DESCRIPTION
  Three steps, in order:

    1. Build the web bundle from packages/app with VITE_ORCHESTRA_SERVER_MODE=none. That mode
       ships no initial server, so the app opens on its own full-screen connection form and
       the user adds a server by address/password, by an `orchestra pair` link or by QR code
       (packages/app/README.md, "VITE_ORCHESTRA_SERVER_MODE").
    2. Copy packages/app/dist into packages/android/app/src/main/assets/app/, replacing
       whatever was there so stale hashed assets never survive a rebuild.
    3. Run packages/android/gradlew :app:assembleDebug.

  The script fails fast with a readable message when packages/android/app does not exist yet,
  rather than letting Gradle print a stack trace.

  ANDROID_HOME comes from the environment; if it is unset the script falls back to
  $HOME/.local/share/android-sdk and errors out with the setup command when that is missing too.
  No local.properties is written, so the SDK location never lands in the repository.

.EXAMPLE
  ./packages/android/scripts/build-apk.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$androidRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $androidRoot)
$appDir = Join-Path $repoRoot "packages/app"
$distDir = Join-Path $appDir "dist"
$assetsDir = Join-Path $androidRoot "app/src/main/assets/app"
$onWindows = $env:OS -eq "Windows_NT"

Write-Host "==> Repository root:  $repoRoot"
Write-Host "==> Android project:  $androidRoot"

# Fail with a readable message, before spending ten seconds on a bundle build, when the
# Android application module is not written yet.
$appModule = Join-Path $androidRoot "app/build.gradle.kts"
if (-not (Test-Path $appModule)) {
  throw "The Android app module is missing: expected $appModule. packages/android/app/** has to exist before an APK can be assembled."
}
$settings = Join-Path $androidRoot "settings.gradle.kts"
if (-not (Test-Path $settings)) {
  throw "The Gradle settings file is missing: expected $settings."
}

$sdkRoot = if ($env:ANDROID_HOME) {
  $env:ANDROID_HOME
}
elseif ($env:ANDROID_SDK_ROOT) {
  $env:ANDROID_SDK_ROOT
}
else {
  Join-Path $HOME ".local/share/android-sdk"
}
if (-not (Test-Path (Join-Path $sdkRoot "platforms/android-36"))) {
  throw "Android SDK platform android-36 not found under $sdkRoot. Run: ./packages/android/scripts/setup-android-sdk.ps1"
}
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
Write-Host "==> ANDROID_HOME:      $sdkRoot"

Write-Host "==> Building the web bundle from packages/app with VITE_ORCHESTRA_SERVER_MODE=none"
$previousServerMode = $env:VITE_ORCHESTRA_SERVER_MODE
$env:VITE_ORCHESTRA_SERVER_MODE = "none"
try {
  Push-Location $appDir
  try {
    & bun run build
    if ($LASTEXITCODE -ne 0) { throw "'bun run build' in packages/app failed with exit code $LASTEXITCODE." }
  }
  finally {
    Pop-Location
  }
}
finally {
  $env:VITE_ORCHESTRA_SERVER_MODE = $previousServerMode
}

if (-not (Test-Path (Join-Path $distDir "index.html"))) {
  throw "The web bundle is missing $distDir\index.html after the build."
}
$bundleSize = (Get-ChildItem -Recurse -File $distDir | Measure-Object -Property Length -Sum).Sum
Write-Host ("==> Bundle ready: {0:N1} MB in {1}" -f ($bundleSize / 1MB), $distDir)

Write-Host "==> Copying the bundle into $assetsDir"
# Wipe first: a previous build leaves hashed asset files behind that the new index.html
# no longer references, and they would still be packaged into the APK.
if (Test-Path $assetsDir) { Remove-Item -Recurse -Force $assetsDir }
New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null
Copy-Item -Path (Join-Path $distDir "*") -Destination $assetsDir -Recurse -Force

Write-Host "==> Running :app:assembleDebug"
$gradlew = if ($onWindows) { Join-Path $androidRoot "gradlew.bat" } else { Join-Path $androidRoot "gradlew" }
Push-Location $androidRoot
try {
  & $gradlew :app:assembleDebug
  if ($LASTEXITCODE -ne 0) { throw "':app:assembleDebug' failed with exit code $LASTEXITCODE." }
}
finally {
  Pop-Location
}

$apk = Join-Path $androidRoot "app/build/outputs/apk/debug/app-debug.apk"
if (-not (Test-Path $apk)) {
  throw "Gradle reported success but no APK was produced at $apk."
}
$apkInfo = Get-Item $apk
$sha = (Get-FileHash -Algorithm SHA256 $apk).Hash.ToLowerInvariant()
Write-Host "==> APK:  $apk"
Write-Host "==> Size: {0:N1} MB" -f ($apkInfo.Length / 1MB)
Write-Host "==> sha256: $sha"