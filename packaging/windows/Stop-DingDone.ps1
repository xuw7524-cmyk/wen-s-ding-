$ErrorActionPreference = 'SilentlyContinue'
$basePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$serverPath = Join-Path $basePath 'app\server.js'
$appDataDir = Join-Path $env:LOCALAPPDATA 'DingTalkReminderManager'

foreach ($name in @('watchdog.pid', 'backend.pid')) {
    $pidPath = Join-Path $appDataDir $name
    if (Test-Path -LiteralPath $pidPath) {
        $processId = [int](Get-Content -LiteralPath $pidPath -Raw -ErrorAction SilentlyContinue)
        if ($processId -gt 0) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    }
}

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($serverPath) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show('DingDone is stopped for this Windows session. Automatic startup will resume at the next sign-in.', 'DingDone') | Out-Null
