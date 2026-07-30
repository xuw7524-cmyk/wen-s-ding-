@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "packaging\windows\Enable-AutoStart.ps1"
if errorlevel 1 pause
