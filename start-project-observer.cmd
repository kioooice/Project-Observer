@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [Project Observer] Node.js 20+ is required.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)
start "Project Observer" cmd /c "node src\server.mjs"
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:4177"
endlocal
