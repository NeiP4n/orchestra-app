@echo off
setlocal
for /f "tokens=2 delims=:" %%c in ('chcp') do set "ORCHESTRA_CP=%%c"
chcp 65001 >nul

set "CLI_DIR=%~dp0.."
set "PRELOAD=%CLI_DIR%\node_modules\@opentui\solid\scripts\preload.js"
set "ENTRY=%CLI_DIR%\src\index.ts"

if defined ORCHESTRA_BIN_PATH if exist "%ORCHESTRA_BIN_PATH%" (
  "%ORCHESTRA_BIN_PATH%" %*
  goto :done
)

if exist "%~dp0orchestra.exe" (
  "%~dp0orchestra.exe" %*
  goto :done
)

set "BUN_CMD=bun"
where bun >nul 2>&1
if %ERRORLEVEL% neq 0 (
  if exist "%USERPROFILE%\.bun\bin\bun.exe" (
    set "BUN_CMD=%USERPROFILE%\.bun\bin\bun.exe"
  )
)

if exist "%ENTRY%" (
  if exist "%PRELOAD%" (
    "%BUN_CMD%" --preload="%PRELOAD%" "%ENTRY%" %*
  ) else (
    "%BUN_CMD%" "%ENTRY%" %*
  )
  goto :done
)

if exist "%~dp0orchestra.cjs" (
  node "%~dp0orchestra.cjs" %*
  goto :done
)

echo orchestra: entrypoint not found>&2
exit /b 1

:done
set "ORCHESTRA_EXIT=%ERRORLEVEL%"
if defined ORCHESTRA_CP chcp %ORCHESTRA_CP% >nul
exit /b %ORCHESTRA_EXIT%
