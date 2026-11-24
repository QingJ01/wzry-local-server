param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d{1,3}(\.\d{1,3}){3}:\d+$')]
    [string]$Serial,

    [string]$AdbPath = 'D:\project\poxxiao\tools\android-sdk\platform-tools\adb.exe',

    [string]$OutputDirectory = 'D:\project\wzry\workspace\observations',

    [string]$Package = 'com.tencent.tmgp.sgame',

    [int]$Seconds = 60,

    [switch]$StartApp
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $AdbPath)) {
    throw "ADB not found: $AdbPath"
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Invoke-Adb {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    & $AdbPath -s $Serial @Arguments
}

$state = Invoke-Adb @('get-state')
if ($LASTEXITCODE -ne 0 -or $state.Trim() -ne 'device') {
    throw "Device $Serial is not ready; state: $state"
}

$paths = @(
    "device-state-$stamp.txt",
    "logcat-before-$stamp.txt",
    "tcp-before-$stamp.txt",
    "tcp6-before-$stamp.txt",
    "logcat-live-$stamp.txt",
    "tcp-after-$stamp.txt",
    "tcp6-after-$stamp.txt",
    "processes-$stamp.txt"
)

Invoke-Adb @('shell', 'getprop') | Set-Content -LiteralPath (Join-Path $OutputDirectory $paths[0])
Invoke-Adb @('shell', 'logcat', '-d', '-v', 'time') | Set-Content -LiteralPath (Join-Path $OutputDirectory $paths[1])
Invoke-Adb @('shell', 'cat', '/proc/net/tcp') | Set-Content -LiteralPath (Join-Path $OutputDirectory $paths[2])
Invoke-Adb @('shell', 'cat', '/proc/net/tcp6') | Set-Content -LiteralPath (Join-Path $OutputDirectory $paths[3])

if ($StartApp) {
    Invoke-Adb @('shell', 'monkey', '-p', $Package, '-c', 'android.intent.category.LAUNCHER', '1') | Out-Null
}

$logcatPath = Join-Path $OutputDirectory $paths[4]
$process = Start-Process -FilePath $AdbPath -ArgumentList @('-s', $Serial, 'shell', 'logcat', '-v', 'time') -RedirectStandardOutput $logcatPath -PassThru -WindowStyle Hidden
try {
    Start-Sleep -Seconds $Seconds
}
finally {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }
}

Invoke-Adb @('shell', 'cat', '/proc/net/tcp') | Set-Content -LiteralPath (Join-Path $OutputDirectory $paths[5])
Invoke-Adb @('shell', 'cat', '/proc/net/tcp6') | Set-Content -LiteralPath (Join-Path $OutputDirectory $paths[6])
Invoke-Adb @('shell', 'ps', '-A') | Set-Content -LiteralPath (Join-Path $OutputDirectory $paths[7])

$manifest = [ordered]@{
    serial = $Serial
    package = $Package
    started = [bool]$StartApp
    seconds = $Seconds
    startedAt = (Get-Date).ToString('o')
    files = $paths
}
if (Get-Command ConvertTo-Json -ErrorAction SilentlyContinue) {
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutputDirectory "manifest-$stamp.json")
}

Write-Host "Observation files written to $OutputDirectory"
