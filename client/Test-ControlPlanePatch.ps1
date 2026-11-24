param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$manifestPath = Join-Path $ProjectRoot 'client\patches\control-plane.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

foreach ($patch in $manifest.binaryPatches) {
    foreach ($replacement in $patch.replacements) {
        if ($replacement.find.Length -ne $replacement.replace.Length) {
            throw "Replacement lengths must match: $($replacement.find) => $($replacement.replace)"
        }
        if ($replacement.find -eq $replacement.replace) {
            throw "Replacement must change: $($replacement.find)"
        }
        if ($replacement.replace -notmatch '^http://127\.0\.0\.1:19620') {
            throw "Replacement must target ADB reverse loopback: $($replacement.replace)"
        }
        if (-not $replacement.encoding -or $replacement.encoding -notin @('utf8', 'utf16')) {
            throw "Replacement must explicitly use UTF-8 or UTF-16 binary string encoding: $($replacement.find)"
        }
    }
}

$buildScript = Join-Path $ProjectRoot 'client\Build-WzryApk.ps1'
$buildContent = Get-Content -Raw -LiteralPath $buildScript
foreach ($requiredToken in @('binaryPatches', 'WhatIf', 'Convert-ToBinaryString')) {
    if (-not $buildContent.Contains($requiredToken)) {
        throw "Build script must implement $requiredToken"
    }
}

Write-Host 'Control-plane patch tests passed.'
