param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

$matrixTool = Join-Path $ProjectRoot 'tools\capture_matrix.mjs'
$matrixConfig = Join-Path $ProjectRoot 'tools\config\capture_matrix.json'
foreach ($path in @($matrixTool, $matrixConfig)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing required file: $path"
    }
}

node --check $matrixTool
if ($LASTEXITCODE -ne 0) {
    throw 'Capture matrix tool failed JavaScript syntax validation'
}

$config = Get-Content -Raw -LiteralPath $matrixConfig | ConvertFrom-Json
if ($config.version -ne 1) {
    throw 'Capture matrix config version must be 1'
}
if (-not $config.phases -or $config.phases.Count -eq 0) {
    throw 'Capture matrix config must define phases'
}
foreach ($phase in $config.phases) {
    foreach ($required in @('phase', 'order', 'minRounds', 'gate')) {
        if ($null -eq $phase.$required) {
            throw "Phase $($phase.phase) is missing required field: $required"
        }
    }
}

$fixtureRoot = Join-Path $ProjectRoot 'workspace\tests\capture-matrix'
$socketDirectory = Join-Path $fixtureRoot 'process-sockets'
$fridaDirectory = Join-Path $fixtureRoot 'frida'
$httpDirectory = Join-Path $fixtureRoot 'http'
$outputJson = Join-Path $fixtureRoot 'capture-matrix.json'
$outputMarkdown = Join-Path $fixtureRoot 'capture_matrix.md'
Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $socketDirectory, $fridaDirectory, $httpDirectory | Out-Null

# Two login rounds: each has an owned socket snapshot plus a phase-tagged Frida
# capture with a session-started event, a non-443 connect, and bidirectional data.
$roundTimes = @{ a = '10:00'; b = '10:10' }
foreach ($round in @('a', 'b')) {
    $base = $roundTimes[$round]
    $snapshot = [ordered]@{
        capturedAt = "2026-11-24T$($base):00.000Z"
        serial = '192.168.5.102:5555'
        package = 'com.tencent.tmgp.sgame'
        processId = 1234
        uid = 10255
        socketCount = 1
        sockets = @([ordered]@{ Raw = 'socket'; Inode = 67890 })
        connections = @([ordered]@{
            Table = 'tcp'
            LocalAddress = '7F000001:3039'
            RemoteAddress = '0A7100CB:1F90'
            State = 'ESTABLISHED'
            Uid = 10255
            Inode = 67890
        })
    }
    $snapshot | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $socketDirectory "login-$round.json")

    $frida = @(
        [ordered]@{ timestamp = "2026-11-24T$($base):00.000Z"; type = 'session-started'; package = 'com.tencent.tmgp.sgame' },
        [ordered]@{ timestamp = "2026-11-24T$($base):01.000Z"; type = 'connect'; descriptor = 12; result = 0; network = $true; endpoint = [ordered]@{ family = 'AF_INET'; address = '203.0.113.10'; port = 8080 } },
        [ordered]@{ timestamp = "2026-11-24T$($base):02.000Z"; type = 'socket-data'; direction = 'outbound'; function = 'send'; descriptor = 12; actualLength = 64 },
        [ordered]@{ timestamp = "2026-11-24T$($base):03.000Z"; type = 'socket-data'; direction = 'inbound'; function = 'recv'; descriptor = 12; actualLength = 64 }
    )
    $frida | ForEach-Object { $_ | ConvertTo-Json -Compress } | Set-Content -LiteralPath (Join-Path $fridaDirectory "login-$round.ndjson")
}

node $matrixTool `
    --config $matrixConfig `
    --sockets $socketDirectory `
    --frida $fridaDirectory `
    --http $httpDirectory `
    --output $outputJson `
    --markdown $outputMarkdown
if ($LASTEXITCODE -ne 0) {
    throw 'Capture matrix tool failed fixture run'
}

$result = Get-Content -Raw -LiteralPath $outputJson | ConvertFrom-Json
if ($result.schemaVersion -ne 1) {
    throw 'Capture matrix result schema version must be 1'
}
$login = $result.phases | Where-Object { $_.phase -eq 'login' }
if ($login.observedRounds -ne 2) {
    throw "Login phase must observe two rounds, got $($login.observedRounds)"
}
if ($login.completedRounds -ne 2 -or $login.status -ne 'complete') {
    throw "Login phase must be complete with two rounds, got $($login.completedRounds)/$($login.status)"
}
$battle = $result.phases | Where-Object { $_.phase -eq 'battle' }
if ($battle.status -ne 'pending') {
    throw 'Battle phase must remain pending with no evidence'
}

$markdown = Get-Content -Raw -LiteralPath $outputMarkdown
foreach ($requiredToken in @(
    'Dynamic capture matrix',
    'Phase status',
    'Round detail',
    'Evidence index',
    'Blockers',
    'login'
)) {
    if (-not $markdown.Contains($requiredToken)) {
        throw "Generated matrix report is missing required token: $requiredToken"
    }
}

Write-Host 'Capture matrix tests passed.'
