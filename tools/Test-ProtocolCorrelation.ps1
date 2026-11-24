param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

$analyzer = Join-Path $ProjectRoot 'tools\correlate_protocol_capture.mjs'
$anchorCatalog = Join-Path $ProjectRoot 'tools\config\protocol_anchor_catalog.json'
foreach ($path in @($analyzer, $anchorCatalog)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing required file: $path"
    }
}

node --check $analyzer
if ($LASTEXITCODE -ne 0) {
    throw 'Protocol correlation analyzer failed JavaScript syntax validation'
}

$catalog = Get-Content -Raw -LiteralPath $anchorCatalog | ConvertFrom-Json
if ($catalog.version -ne 1) {
    throw 'Anchor catalog version must be 1'
}
foreach ($anchor in @($catalog.staticEvidence) + @($catalog.semanticAnchors)) {
    if ([string]::IsNullOrWhiteSpace($anchor.name)) {
        throw 'Anchor catalog contains an empty name'
    }
    if ($anchor.confidence -notin @('high', 'medium', 'low')) {
        throw "Anchor $($anchor.name) has invalid confidence"
    }
}

$fixtureRoot = Join-Path $ProjectRoot 'workspace\tests\protocol-correlation'
$socketDirectory = Join-Path $fixtureRoot 'process-sockets'
$fridaDirectory = Join-Path $fixtureRoot 'frida'
$outputJson = Join-Path $fixtureRoot 'correlation.json'
$outputMarkdown = Join-Path $fixtureRoot 'protocol_capture_findings.md'
Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $socketDirectory, $fridaDirectory | Out-Null

$socketSnapshot = [ordered]@{
    capturedAt = '2026-11-24T10:00:00.000Z'
    serial = '192.168.5.102:5555'
    package = 'com.tencent.tmgp.sgame'
    processId = 1234
    uid = 10255
    socketCount = 2
    sockets = @()
    connections = @(
        [ordered]@{
            Table = 'tcp'
            LocalAddress = '7F000001:3039'
            RemoteAddress = '0A7100CB:1F90'
            State = 'ESTABLISHED'
            Uid = 10255
            Inode = 67890
        }
    )
}
$socketSnapshot | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $socketDirectory 'login-20261124.json')
$bomSocketDirectory = Join-Path $fixtureRoot 'bom-sockets'
New-Item -ItemType Directory -Force -Path $bomSocketDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path $socketDirectory 'login-20261124.json') -Destination (Join-Path $bomSocketDirectory 'login-bom-20261124.json')
$bomPath = Join-Path $bomSocketDirectory 'login-bom-20261124.json'
[IO.File]::WriteAllText(
    $bomPath,
    [IO.File]::ReadAllText($bomPath),
    [System.Text.UTF8Encoding]::new($true)
)

$events = @(
    [ordered]@{
        timestamp = '2026-11-24T10:00:01.000Z'
        type = 'connect'
        descriptor = 12
        result = 0
        endpoint = [ordered]@{ family = 'AF_INET'; address = '203.0.113.10'; port = 8080 }
    },
    [ordered]@{
        timestamp = '2026-11-24T10:00:02.000Z'
        type = 'socket-data'
        direction = 'outbound'
        function = 'send'
        descriptor = 12
        endpoint = [ordered]@{ family = 'AF_INET'; address = '203.0.113.10'; port = 8080 }
        requestedLength = 128
        actualLength = 128
        previewHex = '00'
        previewTruncated = $true
    },
    [ordered]@{
        timestamp = '2026-11-24T10:00:03.000Z'
        type = 'socket-data'
        direction = 'inbound'
        function = 'recv'
        descriptor = 12
        endpoint = [ordered]@{ family = 'AF_INET'; address = '203.0.113.10'; port = 8080 }
        requestedLength = 256
        actualLength = 96
        previewHex = '01'
        previewTruncated = $true
    },
    [ordered]@{
        timestamp = '2026-11-24T10:00:04.000Z'
        type = 'socket-data'
        direction = 'outbound'
        function = 'send'
        descriptor = 12
        endpoint = [ordered]@{ family = 'AF_INET'; address = '203.0.113.10'; port = 8080 }
        requestedLength = 64
        actualLength = 64
        previewHex = '02'
        previewTruncated = $false
    }
)
$events | ForEach-Object { $_ | ConvertTo-Json -Compress } | Set-Content -LiteralPath (Join-Path $fridaDirectory 'login-capture.jsonl')
'not-json' | Add-Content -LiteralPath (Join-Path $fridaDirectory 'login-capture.jsonl')
@{
    timestamp = '2026-11-24T10:00:05.000Z'
    type = 'hook-attached'
    module = 'libc.so'
    hook = 'connect'
    export = 'connect'
} | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $fridaDirectory 'login-capture.jsonl')

$unrelatedDirectory = Join-Path $fixtureRoot 'unrelated-json'
New-Item -ItemType Directory -Force -Path $unrelatedDirectory | Out-Null
@{ notASnapshot = $true } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $unrelatedDirectory 'lifecycle.json')

node $analyzer `
    --sockets "$socketDirectory;$bomSocketDirectory" `
    --frida $fridaDirectory `
    --output $outputJson `
    --markdown $outputMarkdown
if ($LASTEXITCODE -ne 0) {
    throw 'Protocol correlation analyzer failed fixture run'
}

$result = Get-Content -Raw -LiteralPath $outputJson | ConvertFrom-Json
if ($result.schemaVersion -ne 1) {
    throw 'Correlation result schema version must be 1'
}
if ($result.input.processSocketSnapshots -ne 2) {
    throw 'Fixture must produce two process-socket snapshots'
}
if ($result.input.fridaEvents -ne 5) {
    throw 'Fixture must parse five valid Frida events'
}
if ($result.input.fridaOutboundEvents -ne 2 -or $result.input.fridaInboundEvents -ne 1) {
    throw 'Fixture direction counts are incorrect'
}
if ($result.input.fridaAttachedHooks -ne 1 -or $result.input.fridaMissingHooks -ne 0) {
    throw 'Fixture hook evidence counts are incorrect'
}
if ($result.dataQuality.invalidJsonLines -ne 1) {
    throw 'Fixture must detect one invalid JSONL line'
}
if ($result.evidenceStatus -ne 'insufficient-for-protocol-recovery') {
    throw 'Fixture evidence status must remain insufficient'
}

$gateway = $result.findings | Where-Object { $_.name -eq 'Gateway endpoint' }
if ($gateway.status -ne 'not proven') {
    throw 'Gateway endpoint must not be proven from fixture evidence'
}
$frame = $result.findings | Where-Object { $_.name -eq 'Frame boundary' }
if ($frame.status -ne 'not recovered') {
    throw 'Frame boundary must not be recovered from fixture evidence'
}
$commandId = $result.findings | Where-Object { $_.name -eq 'Command ID' }
if ($commandId.status -ne 'not recovered') {
    throw 'Command ID must not be recovered from fixture evidence'
}
foreach ($gate in $result.flowGates) {
    if ($gate.status -eq 'complete') {
        throw "Flow gate $($gate.flow) must not be complete"
    }
}

$markdown = Get-Content -Raw -LiteralPath $outputMarkdown
foreach ($requiredToken in @(
    'Evidence status',
    'Endpoint evidence',
    'Protocol findings',
    'Flow gates',
    'Static anchor correlation',
    'Current blockers',
    'Raw byte previews are not copied into this report',
    'not correlated'
)) {
    if (-not $markdown.Contains($requiredToken)) {
        throw "Generated findings report is missing required token: $requiredToken"
    }
}

Write-Host 'Protocol correlation tests passed.'
