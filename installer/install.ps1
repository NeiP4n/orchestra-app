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

Set-UserPath $target $true
$env:Path = "$env:Path;$target"

Write-Host ""
Write-Host "Orchestra is installed: $exe"
Write-Host "Open a NEW terminal and run:"
Write-Host "  orchestra           start (you answer as the model until a model is connected)"
Write-Host "  orchestra setup     connect a model endpoint (your own key, a local server, a gateway)"
Write-Host "  orchestra --help"
