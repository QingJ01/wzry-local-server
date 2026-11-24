param(
    [Parameter(Mandatory = $true)]
    [string]$ApkPath,
    [Parameter(Mandatory = $true)]
    [string]$Tag,
    [string]$AdbPath = 'D:\project\poxxiao\tools\android-sdk\platform-tools\adb.exe',
    [string]$Serial = '192.168.5.102:5555',
    [string]$Package = 'com.tencent.tmgp.sgame',
    [int]$WatchSeconds = 130,
    [string]$OutputDirectory = 'D:\project\wzry\workspace\observations\lifetime',
    [switch]$SkipPush
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $OutputDirectory "$Tag-$stamp.jsonl"
$logcatPath = Join-Path $OutputDirectory "$Tag-$stamp-logcat.txt"
function Invoke-Adb { param([Parameter(Mandatory = $true)][string[]]$Arguments) & $AdbPath -s $Serial @Arguments }
function Write-Event { param([hashtable]$Event) $Event.timestamp = (Get-Date).ToString('o'); Add-Content -LiteralPath $logPath -Value ($Event | ConvertTo-Json -Compress -Depth 5) }
$apkHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ApkPath).Hash.ToLower()
Write-Event @{ type = 'run-start'; tag = $Tag; apk = $ApkPath; apkSha256 = $apkHash; watchSeconds = $WatchSeconds }
$remote = "/data/local/tmp/mx-$Tag.apk"
if (-not $SkipPush) { Write-Event @{ type = 'push-begin' }; Invoke-Adb @('push', $ApkPath, $remote) | Out-Null; Write-Event @{ type = 'push-done' } }
$remoteHash = ((Invoke-Adb @('shell', 'su', '-c', "sha256sum '$remote'") | Out-String).Trim() -split '\s+') | Select-Object -First 1
Write-Event @{ type = 'remote-hash'; remoteSha256 = $remoteHash; matchesLocal = ($remoteHash -eq $apkHash) }
Write-Event @{ type = 'install-begin' }
$installOut = (Invoke-Adb @('shell', 'su', '-c', "pm install -r -d '$remote'") | Out-String).Trim()
Write-Event @{ type = 'install-result'; output = $installOut }
if ($installOut -match 'Failure|INSTALL_FAILED|Error' -or $installOut -notmatch 'Success') { Write-Event @{ type = 'install-failed'; output = $installOut }; Write-Host "INSTALL FAILED: $installOut"; exit 3 }
$devicePath = (Invoke-Adb @('shell', 'pm', 'path', $Package) | Out-String).Trim() -replace 'package:', ''
$deviceHash = ((Invoke-Adb @('shell', 'su', '-c', "sha256sum '$devicePath'") | Out-String).Trim() -split '\s+') | Select-Object -First 1
Write-Event @{ type = 'installed-verified'; devicePath = $devicePath; deviceSha256 = $deviceHash; matchesLocal = ($deviceHash -eq $apkHash) }
Invoke-Adb @('shell', 'su', '-c', "rm -f '$remote'") | Out-Null
Invoke-Adb @('logcat', '-c') | Out-Null
Invoke-Adb @('shell', 'am', 'force-stop', $Package) | Out-Null
Start-Sleep -Milliseconds 800
$launchT0 = Get-Date
Invoke-Adb @('shell', 'am', 'start', '-W', '-n', "$Package/.SGameActivity") | Out-Null
Write-Event @{ type = 'launched'; launchElapsedMs = [int]((Get-Date) - $launchT0).TotalMilliseconds }
$deadline = $launchT0.AddSeconds($WatchSeconds)
$lastPid = $null; $alive = $true; $aliveSec = 0
while ((Get-Date) -lt $deadline) {
    $pidOut = (Invoke-Adb @('shell', 'pidof', $Package) | Out-String).Trim()
    $aliveSec = [int]((Get-Date) - $launchT0).TotalSeconds
    if ([string]::IsNullOrWhiteSpace($pidOut)) {
        if ($null -ne $lastPid) { Write-Event @{ type = 'died'; aliveSeconds = $aliveSec; lastPid = $lastPid }; $alive = $false; break }
    } else { $lastPid = $pidOut.Trim(); Write-Event @{ type = 'alive'; aliveSeconds = $aliveSec; pid = $lastPid } }
    Start-Sleep -Seconds 2
}
if ($alive) { Write-Event @{ type = 'survived'; aliveSeconds = $WatchSeconds; pid = $lastPid } }
Invoke-Adb @('logcat', '-d', '-t', '4000') | Out-File -LiteralPath $logcatPath -Encoding utf8
$killLines = Select-String -LiteralPath $logcatPath -Pattern 'SIGKILL|kill: pid|Force stopping|has died|ApkAbort|tersafe|tprt|Houdini' | ForEach-Object { $_.Line }
Write-Event @{ type = 'kill-evidence'; lines = $killLines }
Write-Host "== $Tag =="
if ($alive) { Write-Host "  SURVIVED ${WatchSeconds}s (pid $lastPid)" } else { Write-Host "  DIED ~${aliveSec}s (last pid $lastPid)" }
Write-Host "  kill evidence:"; $killLines | Select-Object -First 12 | ForEach-Object { Write-Host "    $_" }
Write-Host "  log: $logPath"
exit 0
