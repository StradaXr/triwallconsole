@echo off
rem Tri-Wall Studio - starts the app and opens it in your browser.
rem Safe to double-click again: if the studio is already running, it just opens the browser.
cd /d "%~dp0"
title Tri-Wall Studio
set "URL=http://127.0.0.1:8790"

curl.exe -s -o nul -m 3 "%URL%/api/status" >nul 2>nul
if not errorlevel 1 (
  echo  Tri-Wall Studio is already running. Opening it in your browser...
  start "" "%URL%"
  "%SystemRoot%\System32\timeout.exe" /t 2 /nobreak >nul
  exit /b 0
)

where uv >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Tri-Wall Studio needs "uv" to run. Install it from https://docs.astral.sh/uv/
  echo  and then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo  Starting Tri-Wall Studio... your browser will open in a moment.
echo  Keep this window open while you use the app. Close it to stop the studio.
echo.
rem Open the browser once the studio answers (up to about a minute on the very first start).
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 60;$i++){try{Invoke-WebRequest -UseBasicParsing '%URL%/api/status' -TimeoutSec 2 | Out-Null; Start-Process '%URL%'; break}catch{Start-Sleep 1}}"
uv run --quiet server.py
echo.
echo  Tri-Wall Studio has stopped.
pause
