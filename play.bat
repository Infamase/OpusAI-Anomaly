@echo off
rem Double-click to play: installs what the game needs (first run only),
rem starts it, and opens it in your browser. Close this window to stop.
cd /d "%~dp0"
title Stalker: Future Anomaly

where node >nul 2>nul
if errorlevel 1 goto nonode

if exist node_modules goto run
echo Installing the game's tools - first run only, this takes a minute...
call npm install
if errorlevel 1 goto failed

:run
echo.
echo Starting the game. Your browser opens at http://localhost:5173
echo Keep this window open while you play. Close it to stop the game.
echo.
call npm run dev -- --open
goto end

:nonode
echo Node.js is not installed.
echo Download the LTS version from https://nodejs.org, install it, then double-click play.bat again.
start "" https://nodejs.org
goto end

:failed
echo.
echo Installing failed. Check your internet connection and try again.

:end
pause
