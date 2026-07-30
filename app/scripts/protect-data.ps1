param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('protect', 'unprotect')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$base64Input = [Console]::In.ReadToEnd().Trim()
$inputBytes = [Convert]::FromBase64String($base64Input)
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser

if ($Mode -eq 'protect') {
    $outputBytes = [System.Security.Cryptography.ProtectedData]::Protect($inputBytes, $null, $scope)
} else {
    $outputBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $null, $scope)
}

[Console]::Out.Write([Convert]::ToBase64String($outputBytes))
