param(
    [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
    $Version = (Get-Content -LiteralPath (Join-Path $projectRoot 'app\version.json') -Raw | ConvertFrom-Json).version
}
$distRoot = Join-Path $projectRoot 'dist'
$packageName = "DingDone-$Version-win-x64"
$packageRoot = Join-Path $distRoot $packageName
$zipPath = Join-Path $distRoot "$packageName.zip"
$nodePath = (Get-Command node -ErrorAction Stop).Source

if (Test-Path -LiteralPath $packageRoot) {
    $resolvedDist = [IO.Path]::GetFullPath($distRoot)
    $resolvedPackage = [IO.Path]::GetFullPath($packageRoot)
    if (-not $resolvedPackage.StartsWith($resolvedDist, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to clean a package path outside dist.'
    }
    Remove-Item -LiteralPath $packageRoot -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Force -Path $packageRoot, (Join-Path $packageRoot 'runtime'), (Join-Path $packageRoot 'seed') | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'app') -Destination (Join-Path $packageRoot 'app') -Recurse
Remove-Item -LiteralPath (Join-Path $packageRoot 'app\test') -Recurse -Force
@{ version = $Version } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageRoot 'app\version.json') -Encoding ASCII
Copy-Item -LiteralPath $nodePath -Destination (Join-Path $packageRoot 'runtime\node.exe')
New-Item -ItemType Directory -Force -Path (Join-Path $packageRoot 'packaging\windows') | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'packaging\windows\launcher.js') -Destination (Join-Path $packageRoot 'packaging\windows\launcher.js')
Copy-Item -LiteralPath (Join-Path $projectRoot 'packaging\windows\watchdog.js') -Destination (Join-Path $packageRoot 'packaging\windows\watchdog.js')
Copy-Item -LiteralPath (Join-Path $projectRoot 'packaging\windows\Enable-AutoStart.ps1') -Destination (Join-Path $packageRoot 'packaging\windows\Enable-AutoStart.ps1')
Copy-Item -LiteralPath (Join-Path $projectRoot 'packaging\windows\Disable-AutoStart.ps1') -Destination (Join-Path $packageRoot 'packaging\windows\Disable-AutoStart.ps1')
Copy-Item -LiteralPath (Join-Path $projectRoot 'packaging\windows\Stop-DingDone.ps1') -Destination (Join-Path $packageRoot 'packaging\windows\Stop-DingDone.ps1')
Copy-Item -LiteralPath (Join-Path $projectRoot 'packaging\windows\Start-DingDone.cmd') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'packaging\windows\Enable-AutoStart.cmd') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'packaging\windows\Disable-AutoStart.cmd') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'packaging\windows\Stop-DingDone.cmd') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'packaging\windows\README-Windows.txt') -Destination $packageRoot

& $nodePath (Join-Path $projectRoot 'tools\create-sanitized-seed.js') `
    --source (Join-Path $projectRoot 'data\reminders.db') `
    --output (Join-Path $packageRoot 'seed\starter.db') `
    --update-repository 'xuw7524-cmyk/wen-s-ding-'
if ($LASTEXITCODE -ne 0) {
    throw 'Sanitized starter database creation failed.'
}

Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal

[pscustomobject]@{
    PackageDirectory = $packageRoot
    ZipPath = $zipPath
    ZipSizeMB = [Math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 1)
    BundledNode = $nodePath
}
