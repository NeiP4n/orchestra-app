$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '..\get.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('orchestra-update-' + [Guid]::NewGuid().ToString('N'))
$oldLocal = $env:LOCALAPPDATA
function Assert($Value, $Message) { if (-not $Value) { throw $Message } }
function Git-Ok { & git @args; if ($LASTEXITCODE -ne 0) { throw "Fixture git failed: $args" } }
# No package downloads or child installer run in this test. The actual git
# stash/pull code in get.ps1 operates against real local repositories.
function bun {
  Assert (($args -join ' ') -eq 'install --frozen-lockfile') 'Install must not rewrite lockfile'
  $global:LASTEXITCODE = 0
}
function powershell { $global:LASTEXITCODE = 0 }
try {
  New-Item -ItemType Directory -Path $root | Out-Null
  $remote = Join-Path $root 'remote.git'
  $source = Join-Path $root 'source'
  $env:LOCALAPPDATA = Join-Path $root 'appdata'
  New-Item -ItemType Directory -Path $env:LOCALAPPDATA | Out-Null
  $checkout = Join-Path $env:LOCALAPPDATA 'orchestra-app'
  Git-Ok init --bare $remote
  Git-Ok clone $remote $source
  Git-Ok -C $source config user.email 'test@example.invalid'
  Git-Ok -C $source config user.name 'Installer test'
  Set-Content (Join-Path $source 'bun.lock') 'upstream-v1'
  Set-Content (Join-Path $source 'source.txt') 'source-v1'
  Git-Ok -C $source add .
  Git-Ok -C $source commit -m initial
  Git-Ok -C $source push origin HEAD
  Git-Ok clone $remote $checkout
  Git-Ok -C $checkout config user.email 'test@example.invalid'
  Git-Ok -C $checkout config user.name 'Installer test'
  Set-Content (Join-Path $checkout 'bun.lock') 'local-generated-lock'
  Set-Content (Join-Path $checkout 'source.txt') 'personal-source-edit'
  Set-Content (Join-Path $checkout 'private.txt') 'private-untracked'
  Set-Content (Join-Path $source 'bun.lock') 'upstream-v2'
  Git-Ok -C $source add bun.lock
  Git-Ok -C $source commit -m update
  Git-Ok -C $source push
  & $installer
  Assert ((Get-Content (Join-Path $checkout 'bun.lock')) -eq 'upstream-v2') 'Did not update lockfile'
  Assert ((Get-Content (Join-Path $checkout 'source.txt')) -eq 'personal-source-edit') 'Source edits lost'
  Assert ((Get-Content (Join-Path $checkout 'private.txt')) -eq 'private-untracked') 'Untracked data lost'
  $stash = git -C $checkout show 'stash@{0}:bun.lock'
  Assert ($stash -eq 'local-generated-lock') 'Original lockfile not recoverable'
  $count = @(git -C $checkout stash list).Count
  & $installer
  Assert (@(git -C $checkout stash list).Count -eq $count) 'Clean rerun created extra stash'
  Write-Host 'PASS: real update, preserved source/untracked files, recoverable lockfile, idempotent rerun'
} finally {
  $env:LOCALAPPDATA = $oldLocal
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
