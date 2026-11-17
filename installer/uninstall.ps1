# One-command full uninstall for Windows:
#   irm https://raw.githubusercontent.com/NeiP4n/orchestra-app/main/installer/uninstall.ps1 | iex
param(
  [switch]$KeepBun
)

$ErrorActionPreference = "Continue"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "      ПОЛНОЕ УДАЛЕНИЕ ORCHESTRA И ВСЕХ ДАННЫХ          " -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

# 1. Stop processes
Write-Host "`n1. Завершение запущенных процессов Orchestra..." -ForegroundColor Yellow
Get-Process | Where-Object { $_.ProcessName -match "orchestra" } | Stop-Process -Force -ErrorAction SilentlyContinue

# 2. Clean PATH
Write-Host "2. Очистка системных путей PATH..." -ForegroundColor Yellow
$targetPath = Join-Path $env:LOCALAPPDATA "Programs\orchestra"
try {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath) {
    $filtered = ($userPath -split ";" | Where-Object { $_ -and ($_.TrimEnd("\") -ne $targetPath.TrimEnd("\")) }) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $filtered, "User")
    Write-Host "   [OK] $targetPath удален из PATH." -ForegroundColor Green
  }
} catch {
  Write-Host "   [!] Не удалось обновить PATH: $_" -ForegroundColor Yellow
}

# 3. Directories to remove
$dirsToDelete = @(
  (Join-Path $env:LOCALAPPDATA "orchestra-app"),
  (Join-Path $env:LOCALAPPDATA "Programs\orchestra"),
  (Join-Path $env:USERPROFILE ".local\share\orchestra"),
  (Join-Path $env:USERPROFILE ".orchestra"),
  (Join-Path $env:USERPROFILE ".config\orchestra"),
  (Join-Path $env:APPDATA "com.nei4pn.orchestra.dev")
)

Write-Host "`n3. Удаление рабочих папок, сессий и баз данных..." -ForegroundColor Yellow
foreach ($dir in $dirsToDelete) {
  if (Test-Path $dir) {
    Write-Host "   Удаление: $dir" -ForegroundColor Gray
    try {
      Remove-Item -Path $dir -Recurse -Force -ErrorAction Stop
      Write-Host "   [OK] Удалено: $dir" -ForegroundColor Green
    } catch {
      Write-Host "   [!] Ошибка при удалении $dir: $_" -ForegroundColor Yellow
    }
  }
}

# 4. Stray files and npm shortcuts
Write-Host "`n4. Удаление оставшихся файлов и npm-оберток..." -ForegroundColor Yellow
$filesToDelete = @(
  (Join-Path $env:APPDATA "orchestra-proxy-backup.txt"),
  (Join-Path $env:LOCALAPPDATA "orchestra-local.patch")
)
foreach ($file in $filesToDelete) {
  if (Test-Path $file) {
    Remove-Item -Path $file -Force -ErrorAction SilentlyContinue
    Write-Host "   [OK] Удален: $file" -ForegroundColor Green
  }
}

Get-ChildItem -Path (Join-Path $env:APPDATA "npm") -Filter "orchestra*" -ErrorAction SilentlyContinue | ForEach-Object {
  Remove-Item -Path $_.FullName -Force -ErrorAction SilentlyContinue
  Write-Host "   [OK] Удалена ссылка: $($_.FullName)" -ForegroundColor Green
}

# 5. Temp cleanup
Write-Host "`n5. Очистка временных файлов..." -ForegroundColor Yellow
Get-ChildItem -Path $env:TEMP -Filter "*orchestra*" -ErrorAction SilentlyContinue | ForEach-Object {
  Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "   [OK] Временные файлы очищены." -ForegroundColor Green

# 6. Bun check
$bunPath = Join-Path $env:USERPROFILE ".bun"
if ((Test-Path $bunPath) -and (-not $KeepBun)) {
  Write-Host "`nOrchestra также могла установить среду Bun ($bunPath)." -ForegroundColor Yellow
  $shouldDeleteBun = $false
  try {
    $ans = Read-Host "Хотите удалить и Bun (%USERPROFILE%\.bun)? (y/n)"
    if ($ans -match '^(y|yes|д|да)$') {
      $shouldDeleteBun = $true
    }
  } catch {
    # Non-interactive mode: keep Bun
  }

  if ($shouldDeleteBun) {
    Remove-Item -Path $bunPath -Recurse -Force -ErrorAction SilentlyContinue
    $bunBin = Join-Path $bunPath "bin"
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath) {
      $filtered = ($userPath -split ";" | Where-Object { $_ -and ($_.TrimEnd("\") -ne $bunBin.TrimEnd("\")) }) -join ";"
      [Environment]::SetEnvironmentVariable("Path", $filtered, "User")
    }
    [Environment]::SetEnvironmentVariable("BUN_INSTALL", $null, "User")
    Write-Host "   [OK] Среда Bun полностью удалена." -ForegroundColor Green
  } else {
    Write-Host "   Среда Bun сохранена." -ForegroundColor Gray
  }
}

Write-Host "`n========================================================" -ForegroundColor Green
Write-Host "      ВСЕ СЛЕДЫ И ФАЙЛЫ ORCHESTRA УСПЕШНО УДАЛЕНЫ!       " -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
