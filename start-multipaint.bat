@echo off
title MultiPaint
cd /d "%~dp0"

REM Install dependencies the first time (or if the folder was moved/cleaned).
if not exist node_modules (
  echo First-time setup: installing dependencies, this may take a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo Setup failed. Is Node.js installed? Get it from https://nodejs.org
    pause
    exit /b 1
  )
)

echo.
echo Starting MultiPaint - your browser will open automatically.
echo Leave this window open while you work. Close it or press Ctrl+C to stop.
echo.

REM --open tells Vite to launch the default browser at the right URL once ready.
call npm run dev -- --open

REM If the server exits unexpectedly, keep the window open so errors are visible.
pause
