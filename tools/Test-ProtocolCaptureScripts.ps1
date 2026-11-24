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
$fridaRunner = Join-Path $ProjectRoot 'tools\frida\Run-NetworkCapture.ps1'
$fridaCaptureHelper = Join-Path $ProjectRoot 'tools\frida\run-network-capture.mjs'
$fridaPackage = Join-Path $ProjectRoot 'tools\frida\package.json'
$il2cppAnalyzer = Join-Path $ProjectRoot 'tools\analyze_il2cpp.mjs'
$planPath = Join-Path $ProjectRoot 'reports\protocol_capture_plan.md'
$runbookPath = Join-Path $ProjectRoot 'reports\dynamic_capture_runbook.md'

foreach ($path in @($socketScript, $fridaScript, $fridaRunner, $fridaCaptureHelper, $fridaPackage, $il2cppAnalyzer, $planPath, $runbookPath)) {
    Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "Required file missing: $path"
}

node --check $fridaCaptureHelper
if ($LASTEXITCODE -ne 0) {
    throw 'Frida capture helper failed JavaScript syntax validation'
}

$fridaCaptureHelperContent = Get-Content -Raw -LiteralPath $fridaCaptureHelper
foreach ($requiredToken in @(
    'addRemoteDevice',
    'device.spawn',
    'device.resume',
    'session.detach',
    'uncaughtException',
    'unhandledRejection'
)) {
    Assert-True ($fridaCaptureHelperContent.Contains($requiredToken)) "Frida capture helper must implement $requiredToken"
}

$fridaPackageContent = Get-Content -Raw -LiteralPath $fridaPackage | ConvertFrom-Json
Assert-True ($fridaPackageContent.dependencies.frida -eq '17.27.5') "Frida dependency must be pinned to 17.27.5"

$fridaRunnerErrors = @()
[System.Management.Automation.Language.Parser]::ParseFile($fridaRunner, [ref]$null, [ref]$fridaRunnerErrors) | Out-Null
Assert-True ($fridaRunnerErrors.Count -eq 0) "Run-NetworkCapture.ps1 has $($fridaRunnerErrors.Count) parser error(s)"
$fridaRunnerContent = Get-Content -Raw -LiteralPath $fridaRunner
foreach ($requiredRunnerToken in @(
    "'^192\.168\.5\.102:5555$'",
    '$DeviceServerPath = ''/data/local/tmp/wzry-frida-server-17.27.5''',
    '-l 127.0.0.1:$ServerPort',
    "'forward', '--remove'",
    '"tcp:$ServerPort"',
    'rm -f $DeviceServerPath',
    'Stop-Process -Id $process.Id -Force'
)) {
    Assert-True ($fridaRunnerContent.Contains($requiredRunnerToken)) "Frida runner must implement safety token: $requiredRunnerToken"
}

node --check $il2cppAnalyzer
if ($LASTEXITCODE -ne 0) {
    throw 'IL2CPP analyzer failed JavaScript syntax validation'
}
$il2cppAnalyzerContent = Get-Content -Raw -LiteralPath $il2cppAnalyzer
foreach ($requiredToken in @(
    'METADATA_VERSION = 23',
    '["methods", 0x30, 56]',
    '["parameters", 0x58, 16]',
    '["fields", 0x60, 16]',
    '["typeDefinitions", 0xa0, 104]',
    '["images", 0xb0, 24]',
    '["assemblies", 0xb8, 32]',
    'Assets.Scripts.Framework.FrameSynchr',
    'Assets.Scripts.Framework.FrameWindow',
    'Assets.Scripts.Framework.LobbyConnector',
    'ApolloHelper',
    'CLoginSystem2',
    'Assets.Scripts.GameSystem.CShopSystem'
)) {
    Assert-True ($il2cppAnalyzerContent.Contains($requiredToken)) "IL2CPP analyzer must implement $requiredToken"
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
node --check $fridaScript
if ($LASTEXITCODE -ne 0) {
    throw 'Frida template failed JavaScript syntax validation'
}

foreach ($requiredToken in @(
    'Module.findExportByName',
    "'socket'",
    "'connect'",
    "'send'",
    "'sendto'",
    "'recv'",
    "'recvfrom'",
    "'write'",
    "'writev'",
    'Socket.peerAddress',
    'maximumPreviewBytes',
    'JSON.stringify(event)',
    'previewHex',
    'previewTruncated',
    'requestedLength',
    'actualLength',
    "'outbound'",
    "'inbound'",
    "outputFormat: 'jsonl'"
)) {
    Assert-True ($fridaContent.Contains($requiredToken)) "Frida template must implement $requiredToken"
}

$protocolCallChainPath = Join-Path $ProjectRoot 'reports\protocol_call_chain.md'
Assert-True (Test-Path -LiteralPath $protocolCallChainPath -PathType Leaf) "Protocol call-chain report missing: $protocolCallChainPath"
$protocolCallChain = Get-Content -Raw -LiteralPath $protocolCallChainPath
foreach ($requiredHeading in @(
    '## Candidate call chains',
    '## Static hook candidates',
    '## Metadata call-chain and dispatch anchors',
    '## Semantic message anchors',
    '## Static-to-dynamic route',
    '## Capture standards',
    '## Current blockers'
)) {
    Assert-True ($protocolCallChain.Contains($requiredHeading)) "Protocol call-chain report must contain $requiredHeading"
}

foreach ($requiredToken in @(
    'libGameCore.so',
    'libil2cpp.so',
    'libgcloudcore.so',
    'global-metadata.dat',
    '0x1DBF758',
    '0x77F42C0',
    '0x5B668',
    'SCPKG_CMD_GAMELOGINRSP',
    'SCPKG_MULTGAME_BEGINFIGHT',
    'SCPKG_CMD_SHOPBUY',
    'commandId',
    'PID + UID + fd -> socket inode'
)) {
    Assert-True ($protocolCallChain.Contains($requiredToken)) "Protocol call-chain report must contain evidence token: $requiredToken"
}

$planContent = Get-Content -Raw -LiteralPath $planPath
foreach ($requiredHeading in @('## Account traffic', '## Battle traffic', '## Shop traffic', '## Read-only tcpdump option')) {
    Assert-True ($planContent.Contains($requiredHeading)) "Protocol plan must contain $requiredHeading"
}

$runbookContent = Get-Content -Raw -LiteralPath $runbookPath
foreach ($requiredHeading in @(
    '## Scope and non-negotiable boundaries',
    '## Operator preparation',
    '## Game start and stop',
    '## Read-only process socket ownership',
    '## Frida server deployment boundary',
    '## Hook execution and log preservation',
    '## Minimum trigger paths',
    '## Result determination',
    '## Rollback and cleanup'
)) {
    Assert-True ($runbookContent.Contains($requiredHeading)) "Dynamic capture runbook must contain $requiredHeading"
}

foreach ($requiredToken in @(
    '192.168.5.102:5555',
    'com.tencent.tmgp.sgame',
    'Only the main thread executes ADB',
    'Do not patch, reinstall, clear data',
    'workspace\observations\frida',
    'server binary in an operator-chosen temporary location',
    'rm -f /data/local/tmp/frida-server',
    'No device rollback is required for `Observe-ProcessSockets.ps1` itself',
    'it does not mean traffic was captured'
)) {
    Assert-True ($runbookContent.Contains($requiredToken)) "Dynamic capture runbook must contain safety token: $requiredToken"
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    throw "Protocol capture tests failed: $($failures.Count) failure(s)"
}

Write-Host 'Protocol capture tests passed.'
