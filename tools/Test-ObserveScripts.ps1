param(
    [string]$Repository = 'D:\project\wzry'
)

$ErrorActionPreference = 'Stop'

$observePath = Join-Path $Repository 'tools\Observe-Client.ps1'
$parsePath = Join-Path $Repository 'tools\Parse-ProcNet.ps1'
foreach ($path in @($observePath, $parsePath)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Missing script: $path"
    }
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
        throw "$path has parse errors: $($errors | ForEach-Object Message)"
    }
}

$sample = Join-Path $Repository 'workspace\observations\sample-proc-net.txt'
$sampleDirectory = Split-Path $sample
New-Item -ItemType Directory -Force -Path $sampleDirectory | Out-Null
@'
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retridtm   uid  timeout inode
     0: 0100007F:1F90 00000000:0000 0A 00000000:0000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0
     1: 6A0A0A0C:8AE3 0100007F:01BB 01 00000000:0000 00:00000000 00000000 10255        0 67890 1 0000000000000000 20 4 30 10 -1
'@ | Set-Content -LiteralPath $sample

$output = & powershell -NoProfile -ExecutionPolicy Bypass -File $parsePath -Path $sample
if ($LASTEXITCODE -ne 0) {
    throw "Parse-ProcNet failed with exit code $LASTEXITCODE"
}
if (-not ($output -match 'ESTABLISHED')) {
    throw 'Parse-ProcNet did not report ESTABLISHED row'
}
if (-not ($output -match 'Rows: 2')) {
    throw 'Parse-ProcNet did not report two rows'
}

Write-Host 'Observation script tests passed.'
