@echo off
setlocal
cd /d "%~dp0.."
set "TRIWALL_STATE=%~dp0.local\state.json"
set "ASTRA_DATA_DIR=%~dp0.local"
set "ASTRA_PORT=8937"
node astra\server.js
pause
