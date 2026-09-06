@echo off
title NexPOS — Desktop Launcher
color 0B
echo.
echo  ====================================================
echo   NexPOS - Universal Point of Sale
echo   Desktop Launcher v2.0
echo  ====================================================
echo.
echo  Starting NexPOS server...
echo.

:: Start the server in the background
start /B node server.js

:: Wait for the server to be ready
timeout /t 2 /nobreak >nul

:: Try Chrome first, then Edge, then default browser
set "CHROME="
set "EDGE="

:: Check for Chrome
for %%i in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
  if exist %%i set "CHROME=%%~i"
)

:: Check for Edge
for %%i in (
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do (
  if exist %%i set "EDGE=%%~i"
)

:: Launch in app mode (frameless dedicated window)
if defined CHROME (
  echo  Opening NexPOS in Chrome App Mode...
  start "" "%CHROME%" --app=http://localhost:3000 --window-size=1366,768 --disable-extensions
) else if defined EDGE (
  echo  Opening NexPOS in Edge App Mode...
  start "" "%EDGE%" --app=http://localhost:3000 --window-size=1366,768 --disable-extensions
) else (
  echo  Opening NexPOS in default browser...
  start http://localhost:3000
)

echo.
echo  NexPOS is running at: http://localhost:3000
echo  Press Ctrl+C or close this window to stop the server.
echo.

:: Keep the window open so the server stays alive
cmd /k
