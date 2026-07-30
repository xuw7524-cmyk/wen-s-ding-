@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "packaging\windows\Disable-AutoStart.ps1"
if errorlevel 1 pause
