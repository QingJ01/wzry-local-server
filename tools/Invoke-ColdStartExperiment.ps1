param(
    [Parameter(Mandatory = $true)]
    [string]$Label,

    [Parameter(Mandatory = $true)]
    [string]$Apk,

    [string]$Serial = "192.168.5.102:5555",

    [string]$ToolsRoot = "D:\project\poxxiao\tools",

    [int]$ObserveSeconds = 120,

    [string]$OutDir = "D:\project\wzry\workspace\experiments"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$adb = Join-Path $ToolsRoot "android-sdk\platform-tools\adb.exe"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$prefix = Join-Path $OutDir "$stamp-$Label"

function Adb { param([string]$ArgLine) (& $adb -s $Serial shell $ArgLine 2>&1) -join "`n" }

$result = [ordered]@{
    label = $Label
    apk = $Apk
    apkSha256 = (Get-FileHash -LiteralPath $Apk -Algorithm SHA256).Hash
    startedAt = (Get-Date).ToString("o")
}

& $adb -s $Serial shell "logcat -c" 2>&1 | Out-Null

$installOut = & $adb -s $Serial install -r -d "$Apk" 2>&1
$result.installOutput = @($installOut)
if ($LASTEXITCODE -ne 0 -or ($installOut -join " ") -notmatch "Success") {
    $result.installSucceeded = $false
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$prefix.result.json" -Encoding UTF8
    throw "Install failed for $Label : $($installOut -join " | ")"
}
$result.installSucceeded = $true

Adb "am force-stop com.tencent.tmgp.sgame" | Out-Null
Start-Sleep -Milliseconds 800

$launchOut = & $adb -s $Serial shell "am start -W -n com.tencent.tmgp.sgame/.SGameActivity" 2>&1
$result.launchOutput = @($launchOut)
$result.launchedAt = (Get-Date).ToString("o")

$samples = @()
$deadAt = $null
$firstPid = ""
for ($i = 0; $i -lt $ObserveSeconds; $i++) {
    Start-Sleep -Seconds 1
    $raw = Adb "pidof com.tencent.tmgp.sgame"
    $procId = if ($raw) { ($raw -split "\s+")[0] } else { "" }
    if (-not $firstPid -and $procId) { $firstPid = $procId }
    $samples += [ordered]@{ t = $i; pid = $procId }
    if (-not $procId -and $i -gt 5 -and -not $deadAt) {
        $deadAt = $i
        break
    }
}
$result.firstPid = $firstPid
$result.samples = $samples
$result.pidDiedAtSecond = $deadAt

Start-Sleep -Seconds 2
& $adb -s $Serial shell "logcat -d -v threadtime" > "$prefix.logcat.txt"
$result.finishedAt = (Get-Date).ToString("o")
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$prefix.result.json" -Encoding UTF8
Write-Host "[$Label] pid=$firstPid diedAt=$deadAt logcat=$prefix.logcat.txt"
