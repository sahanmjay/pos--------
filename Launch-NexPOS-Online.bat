@echo off
title NexPOS — Online Launcher
:: Opens the online NexPOS in its own Chrome/Edge window with SILENT PRINTING:
:: bills print straight to the Windows default printer, no print dialog.
:: Put your NexPOS web address below, then double-click this file
:: (or make a desktop shortcut to it).
set "POS_URL=https://YOUR-APP.vercel.app"

set "CHROME="
set "EDGE="
for %%i in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
  if exist %%i set "CHROME=%%~i"
)
for %%i in (
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do (
  if exist %%i set "EDGE=%%~i"
)

:: Its own profile folder, so this window always starts fresh with silent
:: printing on, even while your normal Chrome is open (Chrome ignores
:: --kiosk-printing if it joins an already running window).
set "PROFILE=%LocalAppData%\NexPOS-Till"

if defined CHROME (
  start "" "%CHROME%" --app=%POS_URL% --user-data-dir="%PROFILE%" --kiosk-printing --window-size=1366,768
) else if defined EDGE (
  start "" "%EDGE%" --app=%POS_URL% --user-data-dir="%PROFILE%" --kiosk-printing --window-size=1366,768
) else (
  echo Chrome or Edge is needed for printing without the dialog.
  pause
)
