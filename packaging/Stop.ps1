$ErrorActionPreference = 'SilentlyContinue'
$basePath = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = Join-Path $basePath 'app\server.js'

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($serverPath) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show('Wens Ding background service has stopped.', 'Wens Ding') | Out-Null
