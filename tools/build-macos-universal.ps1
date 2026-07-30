param(
    [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
    $Version = (Get-Content -LiteralPath (Join-Path $projectRoot 'app\version.json') -Raw | ConvertFrom-Json).version
}
$distRoot = Join-Path $projectRoot 'dist'
$cacheRoot = Join-Path $projectRoot '.cache\node-v24.18.0-macos'
$packageName = "Wens-Ding-$Version-macos-universal"
$packageRoot = Join-Path $distRoot $packageName
$archivePath = Join-Path $distRoot "$packageName.tar.gz"
$nodePath = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = '24.18.0'
$artifacts = @(
    @{ Arch = 'darwin-arm64'; File = "node-v$nodeVersion-darwin-arm64.tar.gz"; Sha256 = 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1' },
    @{ Arch = 'darwin-x64'; File = "node-v$nodeVersion-darwin-x64.tar.gz"; Sha256 = 'dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080' }
)

New-Item -ItemType Directory -Force -Path $distRoot, $cacheRoot | Out-Null
foreach ($target in @($packageRoot, $archivePath)) {
    if (Test-Path -LiteralPath $target) {
        $resolvedDist = [IO.Path]::GetFullPath($distRoot)
        $resolvedTarget = [IO.Path]::GetFullPath($target)
        if (-not $resolvedTarget.StartsWith($resolvedDist, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing to clean a path outside dist.'
        }
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}

New-Item -ItemType Directory -Force -Path $packageRoot, (Join-Path $packageRoot 'runtime'), (Join-Path $packageRoot 'seed') | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'app') -Destination (Join-Path $packageRoot 'app') -Recurse
Remove-Item -LiteralPath (Join-Path $packageRoot 'app\test') -Recurse -Force
@{ version = $Version } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageRoot 'app\version.json') -Encoding ASCII
Copy-Item -Path (Join-Path $projectRoot 'packaging\macos\*') -Destination $packageRoot

foreach ($artifact in $artifacts) {
    $downloadPath = Join-Path $cacheRoot $artifact.File
    if (-not (Test-Path -LiteralPath $downloadPath)) {
        Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/$($artifact.File)" -OutFile $downloadPath
    }
    $actualHash = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $artifact.Sha256) {
        throw "SHA256 mismatch for $($artifact.File)"
    }
    $extractRoot = Join-Path $cacheRoot "extract-$($artifact.Arch)"
    if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
    tar.exe -xzf $downloadPath -C $extractRoot "$($artifact.File -replace '\.tar\.gz$','')/bin/node"
    if ($LASTEXITCODE -ne 0) { throw "Could not extract $($artifact.File)" }
    $runtimeDir = Join-Path $packageRoot "runtime\$($artifact.Arch)"
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $extractRoot "$($artifact.File -replace '\.tar\.gz$','')\bin\node") -Destination (Join-Path $runtimeDir 'node')
}

& $nodePath (Join-Path $projectRoot 'tools\create-sanitized-seed.js') `
    --source (Join-Path $projectRoot 'data\reminders.db') `
    --output (Join-Path $packageRoot 'seed\starter.db') `
    --update-repository 'xuw7524-cmyk/wen-s-ding-'
if ($LASTEXITCODE -ne 0) { throw 'Sanitized starter database creation failed.' }

& $nodePath (Join-Path $projectRoot 'tools\create-tar-gz.js') $packageRoot $archivePath
if ($LASTEXITCODE -ne 0) { throw 'macOS archive creation failed.' }

[pscustomobject]@{
    PackageDirectory = $packageRoot
    ArchivePath = $archivePath
    ArchiveSizeMB = [Math]::Round((Get-Item -LiteralPath $archivePath).Length / 1MB, 1)
    AppleSiliconSha256 = $artifacts[0].Sha256
    IntelSha256 = $artifacts[1].Sha256
}
