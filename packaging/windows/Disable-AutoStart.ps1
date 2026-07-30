param(
    [string]$StartupDirectory = [Environment]::GetFolderPath('Startup'),
    [string]$LocalAppData = $env:LOCALAPPDATA,
    [switch]$NoDialog
)

$ErrorActionPreference = 'Stop'
$shortcutPath = Join-Path $StartupDirectory 'DingDone Auto Recovery.lnk'
$oldShortcutPath = Join-Path $StartupDirectory 'Wens Ding Auto Recovery.lnk'
$legacyShortcutPath = Join-Path $StartupDirectory 'Wens Ding.lnk'
$appDataDir = Join-Path $LocalAppData 'DingTalkReminderManager'
$markerPath = Join-Path $appDataDir 'autostart-enabled.json'
$watchdogPidPath = Join-Path $appDataDir 'watchdog.pid'

if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force }
if (Test-Path -LiteralPath $oldShortcutPath) { Remove-Item -LiteralPath $oldShortcutPath -Force }
if (Test-Path -LiteralPath $legacyShortcutPath) { Remove-Item -LiteralPath $legacyShortcutPath -Force }
if (Test-Path -LiteralPath $markerPath) { Remove-Item -LiteralPath $markerPath -Force }
if (Test-Path -LiteralPath $watchdogPidPath) {
    $watchdogPid = [int](Get-Content -LiteralPath $watchdogPidPath -Raw -ErrorAction SilentlyContinue)
    if ($watchdogPid -gt 0) { Stop-Process -Id $watchdogPid -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $watchdogPidPath -Force -ErrorAction SilentlyContinue
}

if (-not $NoDialog) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show('Automatic startup and recovery are disabled. The current backend remains running.', 'DingDone') | Out-Null
}
