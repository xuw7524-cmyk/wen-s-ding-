$ErrorActionPreference = 'Stop'
$basePath = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $basePath 'Start.vbs'
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'Wens Ding.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.Arguments = 'background'
$shortcut.WorkingDirectory = $basePath
$shortcut.Description = 'Start Wens Ding after Windows sign-in'
$shortcut.Save()

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show('Automatic startup is enabled.', 'Wens Ding') | Out-Null
