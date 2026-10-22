# Installs the `orchestra-app` command for the current user: no admin rights, no registry beyond the user PATH.
#   .\installer\install.ps1               create the launcher
#   .\installer\install.ps1 -Uninstall    remove it and its PATH entry (sessions and memory stay)
# The application runs from this checkout with Bun, so the folder has to stay where it is.
param(
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
  Write-Host "Orchestra removed. Your sessions are in $env:USERPROFILE\.local\share\orchestra"
  return
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw "Bun is required: https://bun.sh" }
New-Item -ItemType Directory -Force $target | Out-Null

# The interface is Solid JSX, so Bun needs the Solid preload no matter where the command is run from;
# code page 65001 keeps the box characters intact in the console.
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

Set-UserPath $target $true
$env:Path = "$env:Path;$target"

Write-Host ""
Write-Host "Installed: $target\orchestra-app.cmd"
Write-Host "Open a NEW terminal and run:  orchestra-app"
