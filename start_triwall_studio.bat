@echo off
rem Tri-Wall Studio - starts the app and opens it in your browser.
cd /d "%~dp0"
title Tri-Wall Studio
where uv >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Tri-Wall Studio needs "uv" to run. Install it from https://docs.astral.sh/uv/ and try again.
  echo.
  pause
  exit /b 1
)
echo.
echo  Starting Tri-Wall Studio... your browser will open in a moment.
echo  Keep this window open while you use the app. Close it to stop.
echo.
start "" /b cmd /c "timeout /t 4 /nobreak >nul & start "" http://127.0.0.1:8790"
uv run --quiet server.py
pause
