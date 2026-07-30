@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "packaging\windows\Stop-DingDone.ps1"
if errorlevel 1 pause
