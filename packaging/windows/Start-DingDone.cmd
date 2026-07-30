@echo off
chcp 65001 >nul
title DingDone Launcher
cd /d "%~dp0"

if not exist "runtime\node.exe" (
  echo.
  echo Package files are incomplete.
  echo Right-click the ZIP, choose "Extract All", then run this file from the extracted folder.
  echo.
  pause
  exit /b 1
)

"runtime\node.exe" "packaging\windows\launcher.js" %*
if errorlevel 1 (
  echo.
  echo Please send the message above or startup.log to the maintainer.
  echo.
  pause
  exit /b 1
)

exit /b 0
