param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$inputLibrary = Join-Path $root "workspace\analysis\jadx\resources\lib\arm64-v8a\libtersafe.so"
$outputDirectory = Join-Path $root "workspace\analysis\security\libtersafe-arm64\call-analysis"

if (-not (Test-Path -LiteralPath $inputLibrary)) {
    throw "Missing input library: $inputLibrary"
}

Write-Host "== node syntax check =="
node --check (Join-Path $PSScriptRoot "analyze_tersafe_calls.mjs")
if ($LASTEXITCODE -ne 0) {
    throw "node --check failed"
}

Write-Host "== tersafe call analyzer =="
node (Join-Path $PSScriptRoot "analyze_tersafe_calls.mjs") $inputLibrary $outputDirectory
if ($LASTEXITCODE -ne 0) {
    throw "tersafe analyzer failed"
}

Write-Host "== analyzer assertions =="
$analysisPath = Join-Path $outputDirectory "tersafe_call_analysis.json"
$callSitesPath = Join-Path $outputDirectory "call_sites.txt"
if (-not (Test-Path -LiteralPath $analysisPath)) { throw "Missing analysis JSON" }
if (-not (Test-Path -LiteralPath $callSitesPath)) { throw "Missing call_sites.txt" }

$analysis = Get-Content -LiteralPath $analysisPath -Raw | ConvertFrom-Json
if ($analysis.sha256 -ne "c11dfa6a8a220e9b01a42919dafd467d13a10a482b9f002bc5edc593598aed79") {
    throw "unexpected SHA-256: $($analysis.sha256)"
}
if ($analysis.elf.machine -ne 183) { throw "unexpected machine: $($analysis.elf.machine)" }

$kill = $analysis.targets | Where-Object { $_.name -eq "kill" }
$abort = $analysis.targets | Where-Object { $_.name -eq "abort" }
$exitSym = $analysis.targets | Where-Object { $_.name -eq "exit" }
$underExit = $analysis.targets | Where-Object { $_.name -eq "_exit" }
$syscall = $analysis.targets | Where-Object { $_.name -eq "syscall" }

if (-not $kill) { throw "kill target missing" }
if ($kill.pltAddress -ne 151424) { throw "unexpected kill PLT: $($kill.pltAddress)" }
if ($kill.callSites.Count -ne 3) { throw "expected 3 kill call sites (1 thunk + 2 callers), got $($kill.callSites.Count)" }
$directKill = $kill.callSites | Where-Object { -not $_.indirect }
$indirectKill = $kill.callSites | Where-Object { $_.indirect }
$directList = @($directKill)
if ($directList.Count -ne 1 -or $directList[0].vaddr -ne 2332368) { throw "unexpected kill thunk site" }
if ($indirectKill.Count -ne 2) { throw "expected 2 indirect kill callers" }
$killVas = $indirectKill | ForEach-Object { $_.vaddr } | Sort-Object
if ($killVas[0] -ne 2502812 -or $killVas[1] -ne 2593524) { throw "unexpected kill caller addresses: $($killVas -join ',')" }

if (-not $abort -or $abort.callSites.Count -ne 0) { throw "expected 0 abort call sites" }
if (-not $exitSym -or $exitSym.callSites.Count -ne 0) { throw "expected 0 exit call sites" }
if (-not $underExit -or $underExit.callSites.Count -ne 0) { throw "expected 0 _exit call sites" }
if (-not $syscall -or $syscall.callSites.Count -ne 0) { throw "expected 0 syscall call sites" }

if ($analysis.stringRefs.Count -ne 0) { throw "expected no string xrefs for protected strings, got $($analysis.stringRefs.Count)" }

Write-Host "Tersafe analyzer tests passed."
