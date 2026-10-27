[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cliDir = [System.IO.Path]::GetFullPath((Join-Path $scriptDir ".."))
$entry = Join-Path $cliDir "src\index.ts"
$preload = Join-Path $cliDir "node_modules\@opentui\solid\scripts\preload.js"

if ($env:ORCHESTRA_BIN_PATH -and (Test-Path $env:ORCHESTRA_BIN_PATH)) {
  & $env:ORCHESTRA_BIN_PATH @Arguments
  exit $LASTEXITCODE
}

$exe = Join-Path $scriptDir "orchestra.exe"
if (Test-Path $exe) {
  & $exe @Arguments
  exit $LASTEXITCODE
}

$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun -and (Test-Path "$env:USERPROFILE\.bun\bin\bun.exe")) {
  $bun = "$env:USERPROFILE\.bun\bin\bun.exe"
}

if ($bun -and (Test-Path $entry)) {
  $bunPath = if ($bun -is [System.Management.Automation.CommandInfo]) { $bun.Source } else { $bun }
  if (Test-Path $preload) {
    & $bunPath --preload="$preload" "$entry" @Arguments
  } else {
    & $bunPath "$entry" @Arguments
  }
  exit $LASTEXITCODE
}

$cjs = Join-Path $scriptDir "orchestra.cjs"
if (Test-Path $cjs) {
  & node "$cjs" @Arguments
  exit $LASTEXITCODE
}

Write-Error "orchestra: entrypoint not found"
exit 1
