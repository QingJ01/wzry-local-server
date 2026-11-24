param(
    [Parameter(Mandatory = $true)]
    [string]$Apk,

    [string]$Serial = '192.168.5.102:5555',

    [string]$ToolsRoot = 'D:\project\poxxiao\tools',

    [switch]$SkipDeviceConnect
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $Apk -PathType Leaf)) {
    throw "APK not found: $Apk"
}

$adb = Join-Path $ToolsRoot 'android-sdk\platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adb -PathType Leaf)) {
    throw "ADB not found: $adb"
}

$logDirectory = Join-Path (Split-Path -Parent $Apk) 'install-logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss-fffZ')
$logPath = Join-Path $logDirectory "$timestamp-install.log"

function Invoke-LoggedCommand {
    param(
        [string]$Description,
        [scriptblock]$Action
    )

    "$timestamp | $Description" | Add-Content -LiteralPath $logPath -Encoding UTF8
    $output = & $Action 2>&1
    "$output" | Add-Content -LiteralPath $logPath -Encoding UTF8
    return $output
}

$localHash = (Get-FileHash -LiteralPath $Apk -Algorithm SHA256).Hash
Invoke-LoggedCommand 'Local APK SHA-256' {
    Write-Output $localHash
}

if (-not $SkipDeviceConnect) {
    Invoke-LoggedCommand "Connect ADB target $Serial" {
        & $adb connect $Serial
        if ($LASTEXITCODE -ne 0) {
            throw "adb connect failed with exit code $LASTEXITCODE."
        }
    } | Out-Null
}

$deviceState = Invoke-LoggedCommand 'Check device state' {
    $state = & $adb -s $Serial get-state
    if ($LASTEXITCODE -ne 0) {
        throw "adb get-state failed with exit code $LASTEXITCODE."
    }
    $state
}
if (@($deviceState)[-1] -ne 'device') {
    throw "Device $Serial is not ready. State: $($deviceState[-1])"
}

Invoke-LoggedCommand 'Collect package baseline' {
    & $adb -s $Serial shell pm path com.tencent.tmgp.sgame
} | Out-Null

Invoke-LoggedCommand 'Set ADB reverse mapping for HTTP 19620' {
    & $adb -s $Serial reverse tcp:19620 tcp:19620
    if ($LASTEXITCODE -ne 0) {
        throw "adb reverse tcp:19620 failed with exit code $LASTEXITCODE."
    }
} | Out-Null

Invoke-LoggedCommand 'Set ADB reverse mapping for frame TCP 19621' {
    & $adb -s $Serial reverse tcp:19621 tcp:19621
    if ($LASTEXITCODE -ne 0) {
        throw "adb reverse tcp:19621 failed with exit code $LASTEXITCODE."
    }
} | Out-Null

Invoke-LoggedCommand 'Install debug APK' {
    & $adb -s $Serial install -r -d $Apk
    if ($LASTEXITCODE -ne 0) {
        throw "adb install failed with exit code $LASTEXITCODE."
    }
} | Out-Null

$devicePaths = Invoke-LoggedCommand 'Resolve installed APK path' {
    $paths = & $adb -s $Serial shell pm path com.tencent.tmgp.sgame
    if ($LASTEXITCODE -ne 0) {
        throw "adb pm path failed with exit code $LASTEXITCODE."
    }
    $paths
}

"$timestamp | Installation complete. APK: $Apk SHA-256: $localHash" | Add-Content -LiteralPath $logPath -Encoding UTF8
Write-Host "Installed $Apk on $Serial. Log: $logPath"
Write-Host 'If installation fails, use `adb -s 192.168.5.102:5555 uninstall com.tencent.tmgp.sgame` only if you accept app-data loss, then reinstall.'
Write-Host 'ADB reverse mappings persist until the device reconnects. Re-run this script after a reconnect.'
