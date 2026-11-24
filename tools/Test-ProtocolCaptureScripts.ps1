param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$failures = New-Object System.Collections.Generic.List[string]

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        $script:failures.Add($Message)
    }
}

$socketScript = Join-Path $ProjectRoot 'tools\Observe-ProcessSockets.ps1'
$fridaScript = Join-Path $ProjectRoot 'tools\frida\wzry-network.js'
$planPath = Join-Path $ProjectRoot 'reports\protocol_capture_plan.md'

foreach ($path in @($socketScript, $fridaScript, $planPath)) {
    Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "Required file missing: $path"
}

$parserErrors = @()
[System.Management.Automation.Language.Parser]::ParseFile($socketScript, [ref]$null, [ref]$parserErrors) | Out-Null
Assert-True ($parserErrors.Count -eq 0) "Observe-ProcessSockets.ps1 has $($parserErrors.Count) parser error(s)"

$socketContent = Get-Content -Raw -LiteralPath $socketScript
foreach ($requiredToken in @(
    "pidof $Package",
    '/proc/$processId/status',
    '/proc/$processId/fd',
    '/proc/$processId/net/$table',
    'socket:\[(\d+)\]'
)) {
    Assert-True ($socketContent.Contains($requiredToken)) "Socket script must implement $requiredToken"
}

$fridaContent = Get-Content -Raw -LiteralPath $fridaScript
foreach ($requiredToken in @('Module.findExportByName', "'connect'", "'send'", "'recv'", 'maximumPreviewBytes', 'JSON.stringify(event)')) {
    Assert-True ($fridaContent.Contains($requiredToken)) "Frida template must implement $requiredToken"
}

$planContent = Get-Content -Raw -LiteralPath $planPath
foreach ($requiredHeading in @('## Account traffic', '## Battle traffic', '## Shop traffic', '## Read-only tcpdump option')) {
    Assert-True ($planContent.Contains($requiredHeading)) "Protocol plan must contain $requiredHeading"
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    throw "Protocol capture tests failed: $($failures.Count) failure(s)"
}

Write-Host 'Protocol capture tests passed.'
