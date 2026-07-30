$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'Wens Ding.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
}

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show('Automatic startup is disabled.', 'Wens Ding') | Out-Null
