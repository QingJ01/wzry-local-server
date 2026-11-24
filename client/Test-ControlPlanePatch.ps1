param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$manifestPath = Join-Path $ProjectRoot 'client\patches\control-plane.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

if ($manifest.sessionIdentity.mode -ne 'default-local-session') {
    throw "sessionIdentity must declare default-local-session for the current patch."
}
if ($manifest.sessionIdentity.requiresTokenInjection) {
    throw "sessionIdentity must not require token injection for the current patch."
}
if ($manifest.sessionIdentity.requiresUrlRewrite) {
    throw "sessionIdentity must not require URL rewriting for the current patch."
}

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

if (-not $manifest.PSObject.Properties['entries'] -or $manifest.entries.Count -gt 0) {
    throw "The current patch must stay method0 and must not add or replace ZIP entries."
}

$buildScript = Join-Path $ProjectRoot 'client\Build-WzryApk.ps1'
$buildContent = Get-Content -Raw -LiteralPath $buildScript
foreach ($requiredToken in @(
    'binaryPatches',
    'WhatIf',
    'Convert-ToBinaryString',
    'Get-EntryStorePolicy',
    'CompressionMethod',
    "EntryPath -eq 'resources.arsc'",
    'New-StagingZip',
    'apksigner verify --verbose',
    'zipalign -c -p 4'
)) {
    if (-not $buildContent.Contains($requiredToken)) {
        throw "Build script must implement $requiredToken"
    }
}

$newStagingZipFunction = [System.Management.Automation.Language.Parser]::ParseFile(
    $buildScript, [ref]$null, [ref]$null
).Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'New-StagingZip'
}, $true)
if (-not $newStagingZipFunction.Body.Extent.Text.Contains('foreach ($entry in $SourceArchive.Entries)')) {
    throw 'New-StagingZip must rebuild staging ZIP in source entry order'
}

Write-Host 'Control-plane patch tests passed.'
