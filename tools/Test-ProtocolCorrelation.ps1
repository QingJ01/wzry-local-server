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
    socketCount = 3
    sockets = @()
    connections = @(
        [ordered]@{
            Table = 'tcp'
            LocalAddress = '7F000001:3039'
            RemoteAddress = 'CB00710A:1F90'
            State = 'ESTABLISHED'
            Uid = 10255
            Inode = 67890
        },
        # /proc/net/tcp6 IPv4-mapped loopback written as host-order 32-bit
        # words: 00000000 00000000 FFFF0000 0100007F == ::ffff:127.0.0.1.
        # This is the ADB reverse endpoint the Rust server listens on.
        [ordered]@{
            Table = 'tcp6'
            LocalAddress = '0000000000000000FFFF00000100007F:9C40'
            RemoteAddress = '0000000000000000FFFF00000100007F:4CA4'
            State = 'ESTABLISHED'
            Uid = 10255
            Inode = 67900
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

# A wrapped Frida envelope (as emitted by run-network-capture.mjs) whose socketInode
# matches the process-owned snapshot connection. The correlator must unwrap the
# payload and prove ownership through the socket inode rather than the fd number.
$wrapped = [ordered]@{
    timestamp = '2026-11-24T10:00:06.000Z'
    message = [ordered]@{
        type = 'send'
        payload = [ordered]@{
            timestamp = '2026-11-24T10:00:06.000Z'
            type = 'socket-data'
            direction = 'inbound'
            function = 'recv'
            descriptor = 55
            socketInode = 67890
            endpoint = [ordered]@{ family = 'AF_INET'; address = '203.0.113.10'; port = 8080 }
            requestedLength = 128
            actualLength = 40
        }
    }
    data = $null
}
$wrapped | ConvertTo-Json -Compress -Depth 8 | Add-Content -LiteralPath (Join-Path $fridaDirectory 'login-capture.jsonl')

# A socket-data event on a foreign endpoint with no matching process-owned inode;
# this one must remain unowned.
$unowned = [ordered]@{
    timestamp = '2026-11-24T10:00:07.000Z'
    message = [ordered]@{
        type = 'send'
        payload = [ordered]@{
            timestamp = '2026-11-24T10:00:07.000Z'
            type = 'socket-data'
            direction = 'outbound'
            function = 'send'
            descriptor = 99
            socketInode = 424242
            endpoint = [ordered]@{ family = 'AF_INET'; address = '198.51.100.7'; port = 9000 }
            requestedLength = 32
            actualLength = 32
        }
    }
    data = $null
}
$unowned | ConvertTo-Json -Compress -Depth 8 | Add-Content -LiteralPath (Join-Path $fridaDirectory 'login-capture.jsonl')

# ADB reverse endpoint written two ways by wzry-network.js: the connect hook
# reports the sockaddr as expanded AF_INET6, while socket-data events read the
# peer address as ::ffff:127.0.0.1. All three events must canonicalize onto the
# single AF_INET 127.0.0.1:19620 endpoint classified as local-adb-reverse.
$adbReverseEvents = @(
    [ordered]@{
        timestamp = '2026-11-24T10:00:08.000Z'
        type = 'connect'
        descriptor = 63
        result = 0
        socketClass = 'local-adb-reverse'
        endpoint = [ordered]@{ family = 'AF_INET6'; address = '0:0:0:0:0:ffff:7f00:1'; port = 19620 }
    },
    [ordered]@{
        timestamp = '2026-11-24T10:00:09.000Z'
        type = 'socket-data'
        direction = 'outbound'
        function = 'send'
        descriptor = 63
        socketInode = 67900
        endpoint = [ordered]@{ family = $null; address = '::ffff:127.0.0.1'; port = 19620 }
        requestedLength = 200
        actualLength = 200
        previewHex = '03'
        previewTruncated = $false
    },
    [ordered]@{
        timestamp = '2026-11-24T10:00:10.000Z'
        type = 'socket-data'
        direction = 'inbound'
        function = 'recv'
        descriptor = 63
        socketInode = 67900
        endpoint = [ordered]@{ family = $null; address = '::ffff:127.0.0.1'; port = 19620 }
        requestedLength = 16384
        actualLength = 126
        previewHex = '04'
        previewTruncated = $false
    }
)
$adbReverseEvents | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 } | Add-Content -LiteralPath (Join-Path $fridaDirectory 'login-capture.jsonl')

@{
    startedAt = '2026-11-24T10:00:00.000Z'
    packageId = 'com.tencent.tmgp.sgame'
    pid = 1234
    attachMode = $true
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fridaDirectory 'login-capture.jsonl.metadata.json')

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
if ($result.input.fridaEvents -ne 10) {
    throw 'Fixture must parse ten valid Frida events'
}
# The snapshot remote 0A7100CB:1F90 is little-endian 203.0.113.10:8080, the same
# endpoint the three fd-12 socket-data events and the inode-67890 wrapped event ride
# on; those are process-owned. The 198.51.100.7:9000 event (inode 424242) has no
# matching process-owned inode and must be the only unowned socket-data event.
if ($result.unownedFridaEventCount -ne 1) {
    throw 'Fixture must leave exactly the foreign-endpoint event unowned'
}
if ($result.input.fridaOutboundEvents -ne 4 -or $result.input.fridaInboundEvents -ne 3) {
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

$adbReverseEndpoints = @($result.endpoints | Where-Object {
    $_.endpoint.address -eq '127.0.0.1' -and $_.endpoint.port -eq 19620
})
if ($adbReverseEndpoints.Count -ne 1) {
    throw 'ADB reverse endpoint must collapse onto one canonical 127.0.0.1:19620 record'
}
$adbReverseEndpoint = $adbReverseEndpoints[0]
if ($adbReverseEndpoint.classification -ne 'local-adb-reverse') {
    throw 'ADB reverse endpoint must be classified local-adb-reverse'
}
if (-not ($adbReverseEndpoint.sources -contains 'frida' -and $adbReverseEndpoint.sources -contains 'process-socket')) {
    throw 'ADB reverse endpoint must merge frida and process-socket evidence'
}
if ($adbReverseEndpoint.endpoint.family -ne 'AF_INET') {
    throw 'ADB reverse endpoint must canonicalize to AF_INET'
}
if (-not ($adbReverseEndpoint.socketClasses -contains 'local-adb-reverse')) {
    throw 'ADB reverse endpoint must retain the local-adb-reverse socket class'
}
if ($adbReverseEndpoint.outboundEvents -lt 1 -or $adbReverseEndpoint.inboundEvents -lt 1) {
    throw 'ADB reverse endpoint must record bidirectional socket data'
}
$mappedRemoteEndpoint = @($result.endpoints | Where-Object {
    $_.endpoint.address -eq '203.0.113.10' -and $_.endpoint.port -eq 8080
})
if ($mappedRemoteEndpoint.Count -ne 1) {
    throw '203.0.113.10:8080 must remain a single canonical endpoint'
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
