param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$inputLibrary = Join-Path $root "workspace\analysis\extracted\lib\arm64-v8a\libGameCore.so"
$outputDirectory = Join-Path $root "workspace\analysis\gamecore"

if (-not (Test-Path -LiteralPath $inputLibrary)) {
    throw "Missing input library: $inputLibrary"
}

Write-Host "== node syntax check =="
node --check (Join-Path $PSScriptRoot "analyze_gamecore.mjs")
if ($LASTEXITCODE -ne 0) {
    throw "node --check failed"
}

Write-Host "== gamecore analyzer =="
node (Join-Path $PSScriptRoot "analyze_gamecore.mjs") $inputLibrary $outputDirectory
if ($LASTEXITCODE -ne 0) {
    throw "gamecore analyzer failed"
}

Write-Host "== analyzer assertions =="
$analysisPath = Join-Path $outputDirectory "gamecore_analysis.json"
$symbolsPath = Join-Path $outputDirectory "dynamic_symbols.txt"
$importsPath = Join-Path $outputDirectory "undefined_imports.txt"
foreach ($path in @($analysisPath, $symbolsPath, $importsPath)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Missing analyzer output: $path"
    }
}

$analysis = Get-Content -LiteralPath $analysisPath -Raw | ConvertFrom-Json
if ($analysis.size -ne 58805320) { throw "unexpected size: $($analysis.size)" }
if ($analysis.sha256 -ne "58e36f26973c05b2998f50c206a992176d33afb271f2d4289f2d49d0883708e5") {
    throw "unexpected SHA-256: $($analysis.sha256)"
}
if ($analysis.elf.machine -ne 183) { throw "unexpected machine: $($analysis.elf.machine)" }
if ($analysis.elf.sectionTableAvailable -ne $true) { throw "section table unavailable" }
if ($analysis.elf.sections.Count -ne 22) { throw "unexpected section count: $($analysis.elf.sections.Count)" }
if ($analysis.symbolCounts.defined -ne 320) { throw "unexpected defined symbol count: $($analysis.symbolCounts.defined)" }
if ($analysis.symbolCounts.undefined -ne 239) { throw "unexpected undefined symbol count: $($analysis.symbolCounts.undefined)" }
if (-not $analysis.findings.hasGameCoreInfoExports) { throw "GameCoreInfo exports missing" }
if (-not $analysis.findings.hasPackBufferExports) { throw "pack-buffer exports missing" }
if (-not $analysis.findings.hasSettleDataExport) { throw "settle-data export missing" }
if (-not $analysis.findings.hasIl2CppBridgeStrings) { throw "IL2CPP bridge strings missing" }
if (-not $analysis.findings.hasNetworkImports) { throw "network imports missing" }
if (-not $analysis.findings.hasProtectionBridgeImports) { throw "protection bridge imports missing" }

Write-Host "== selected evidence =="
Select-String -LiteralPath $symbolsPath -Pattern "GameCoreInfo_|SGC_GetPlayerSettleData|PushCsBuffer|JNI_OnLoad" |
    Select-Object -First 20 | ForEach-Object { Write-Host $_.Line }
Select-String -LiteralPath $importsPath -Pattern "^(socket|connect|send|recv)$" |
    ForEach-Object { Write-Host $_.Line }

Write-Host "Gamecore analyzer tests passed."
