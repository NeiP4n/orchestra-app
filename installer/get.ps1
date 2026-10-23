# One-command install for Windows:
#   irm https://raw.githubusercontent.com/NeiP4n/orchestra-app/main/installer/get.ps1 | iex
# Installs git and Bun when missing, downloads Orchestra to %LOCALAPPDATA%\orchestra-app and creates the
# `orchestra-app` command. Running it again updates the checkout.
$ErrorActionPreference = "Stop"
$repo = "https://github.com/NeiP4n/orchestra-app.git"
$dir = Join-Path $env:LOCALAPPDATA "orchestra-app"

function Update-SessionPath {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "Installing git..."
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw "git is missing and winget is unavailable: install git from https://git-scm.com and run this again" }
  winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements --silent
  Update-SessionPath
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { $env:Path += ";$env:ProgramFiles\Git\cmd" }
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host "Installing Bun..."
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://bun.sh/install.ps1 | iex"
  Update-SessionPath
  $env:Path += ";$env:USERPROFILE\.bun\bin"
}

if (Test-Path (Join-Path $dir ".git")) {
  Write-Host "Updating $dir..."
  git -C $dir pull --ff-only
} else {
  Write-Host "Downloading Orchestra to $dir..."
  git clone --depth 1 $repo $dir
}
if ($LASTEXITCODE -ne 0) { throw "git failed" }

Write-Host "Installing dependencies (a few minutes the first time)..."
Push-Location $dir
try {
  bun install
  if ($LASTEXITCODE -ne 0) { throw "bun install failed" }
} finally {
  Pop-Location
}

# A separate process with Bypass: the default execution policy blocks running .ps1 files, even though `irm | iex` itself is allowed.
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir "installer\install.ps1")
if ($LASTEXITCODE -ne 0) { throw "creating the orchestra-app command failed" }
