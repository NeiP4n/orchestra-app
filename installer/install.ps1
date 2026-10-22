# Installs Orchestra for the current user: no admin rights, no registry beyond the user PATH.
#   .\installer\install.ps1               use dist\orchestra.exe, or build it when Rust is available
#   .\installer\install.ps1 -Url <link>   download a prebuilt orchestra.exe
#   .\installer\install.ps1 -Uninstall    remove the program and its PATH entry (sessions and memory stay)
param(
  [string]$Url,
  [string]$Source,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $env:LOCALAPPDATA "Programs\orchestra"

function Set-UserPath([string]$directory, [bool]$present) {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = @($current -split ";" | Where-Object { $_ -and ($_.TrimEnd("\") -ne $directory.TrimEnd("\")) })
  if ($present) { $entries += $directory }
  [Environment]::SetEnvironmentVariable("Path", ($entries -join ";"), "User")
}

if ($Uninstall) {
  Set-UserPath $target $false
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Write-Host "Orchestra removed. Your sessions and memory are in $env:USERPROFILE\.local\share\orchestra"
  return
}

New-Item -ItemType Directory -Force $target | Out-Null
$exe = Join-Path $target "orchestra.exe"

if ($Url) {
  Invoke-WebRequest $Url -OutFile $exe
} elseif ($Source) {
  Copy-Item $Source $exe -Force
} elseif (Test-Path (Join-Path $root "dist\orchestra.exe")) {
  Copy-Item (Join-Path $root "dist\orchestra.exe") $exe -Force
} elseif (Get-Command cargo -ErrorAction SilentlyContinue) {
  Push-Location $root
  try { cargo build --release -p orchestra } finally { Pop-Location }
  Copy-Item (Join-Path $root "target\release\orchestra.exe") $exe -Force
} else {
  throw "No orchestra.exe found. Pass -Url <download link> or -Source <path>, or install Rust (https://rustup.rs) and run again."
}

# The full application (interface, Society chat, modes, MCP, ...) runs from this checkout with Bun.
if (Get-Command bun -ErrorAction SilentlyContinue) {
  # The interface is Solid JSX, so Bun needs the Solid preload no matter where the command is run from;
  # code page 65001 keeps the box and dither characters intact in the console.
  $bun = (Get-Command bun).Source
  $preload = "$root\packages\cli\node_modules\@opentui\solid\scripts\preload.js"
  $launcher = @(
    "@echo off",
    "setlocal",
    "for /f `"tokens=2 delims=:`" %%c in ('chcp') do set `"ORCHESTRA_CP=%%c`"",
    "chcp 65001 >nul",
    "`"$bun`" --preload=`"$preload`" `"$root\packages\cli\src\index.ts`" %*",
    "set `"ORCHESTRA_EXIT=%ERRORLEVEL%`"",
    "if defined ORCHESTRA_CP chcp %ORCHESTRA_CP% >nul",
    "exit /b %ORCHESTRA_EXIT%"
  ) -join "`r`n"
  Set-Content -Path (Join-Path $target "orchestra-app.cmd") -Value $launcher -Encoding ascii
  $app = $true
}

Set-UserPath $target $true
$env:Path = "$env:Path;$target"

Write-Host ""
Write-Host "Orchestra is installed: $exe"
Write-Host "Open a NEW terminal and run:"
Write-Host "  orchestra           start (you answer as the model until a model is connected)"
Write-Host "  orchestra setup     connect a model endpoint (your own key, a local server, a gateway)"
Write-Host "  orchestra --help"
if ($app) { Write-Host "  orchestra-app       the full application with the new interface (needs this folder to stay in place)" }
