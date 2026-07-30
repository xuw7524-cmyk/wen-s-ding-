param(
    [string]$StartupDirectory = [Environment]::GetFolderPath('Startup'),
    [string]$LocalAppData = $env:LOCALAPPDATA,
    [switch]$SkipLaunch,
    [switch]$NoDialog
)

$ErrorActionPreference = 'Stop'
$basePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runtimePath = Join-Path $basePath 'runtime\node.exe'
$bundledRuntime = Test-Path -LiteralPath $runtimePath
if (-not $bundledRuntime) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $runtimePath = $nodeCommand.Source }
}
$watchdogPath = Join-Path $basePath 'packaging\windows\watchdog.js'
$shortcutPath = Join-Path $StartupDirectory 'DingDone Auto Recovery.lnk'
$oldShortcutPath = Join-Path $StartupDirectory 'Wens Ding Auto Recovery.lnk'
$legacyShortcutPath = Join-Path $StartupDirectory 'Wens Ding.lnk'
$appDataDir = Join-Path $LocalAppData 'DingTalkReminderManager'
$markerPath = Join-Path $appDataDir 'autostart-enabled.json'
$watchdogPidPath = Join-Path $appDataDir 'watchdog.pid'

if (-not (Test-Path -LiteralPath $runtimePath) -or -not (Test-Path -LiteralPath $watchdogPath)) {
    throw 'Node.js runtime or watchdog file is missing.'
}

if (Test-Path -LiteralPath $watchdogPidPath) {
    $oldPid = [int](Get-Content -LiteralPath $watchdogPidPath -Raw -ErrorAction SilentlyContinue)
    if ($oldPid -gt 0) {
        Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            if (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 100
        }
    }
}

New-Item -ItemType Directory -Force -Path $StartupDirectory | Out-Null
if (Test-Path -LiteralPath $legacyShortcutPath) { Remove-Item -LiteralPath $legacyShortcutPath -Force }
if (Test-Path -LiteralPath $oldShortcutPath) { Remove-Item -LiteralPath $oldShortcutPath -Force }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $runtimePath
$shortcut.Arguments = '"' + $watchdogPath + '"'
$shortcut.WorkingDirectory = $basePath
$shortcut.WindowStyle = 7
$shortcut.Description = 'Keep DingDone running after Windows sign-in'
$shortcut.Save()

New-Item -ItemType Directory -Force -Path $appDataDir | Out-Null
$marker = @{ enabled = $true; packagePath = $basePath; updatedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
[IO.File]::WriteAllText($markerPath, $marker, (New-Object Text.UTF8Encoding($false)))
if (-not $SkipLaunch) {
    Start-Process -FilePath $runtimePath -ArgumentList ('"' + $watchdogPath + '"') -WorkingDirectory $basePath -WindowStyle Hidden
}

if (-not $NoDialog) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show('Automatic startup and recovery are enabled. Keep this folder in its current location.', 'DingDone') | Out-Null
}
