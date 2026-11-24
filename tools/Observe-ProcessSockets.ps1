param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d{1,3}(\.\d{1,3}){3}:\d+$')]
    [string]$Serial,

    [Parameter(Mandatory = $true)]
    [string]$Package,

    [string]$AdbPath = 'D:\project\poxxiao\tools\android-sdk\platform-tools\adb.exe',

    [string]$OutputDirectory = 'D:\project\wzry\workspace\observations\process-sockets'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $AdbPath -PathType Leaf)) {
    throw "ADB not found: $AdbPath"
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Invoke-AdbShell {
    param([Parameter(Mandatory = $true)][string]$Command)
    $result = & $AdbPath -s $Serial shell $Command 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "ADB command failed ($Command): $result"
    }
    return ($result -join "`n")
}

$deviceState = (& $AdbPath -s $Serial get-state 2>&1).Trim()
if ($LASTEXITCODE -ne 0 -or $deviceState -ne 'device') {
    throw "Device $Serial is not ready; state: $deviceState"
}

$processIdText = (Invoke-AdbShell "pidof $Package").Trim()
if (-not $processIdText) {
    throw "Package $Package is not running."
}
$processIds = @($processIdText -split '\s+' | Where-Object { $_ -match '^\d+$' })
if ($processIds.Count -ne 1) {
    throw "Expected one $Package process, found $($processIds.Count): $processIdText"
}
$processId = $processIds[0]

$status = Invoke-AdbShell "su -c 'cat /proc/$processId/status'"
$uidLine = ($status -split "`n" | Where-Object { $_ -match '^Uid:' } | Select-Object -First 1)
if (-not $uidLine) {
    throw "Unable to read UID from /proc/$processId/status."
}
$uid = [int](($uidLine -split '\s+')[1])

$fileDescriptors = Invoke-AdbShell "su -c 'ls -l /proc/$processId/fd'"
$socketInodes = @()
foreach ($line in ($fileDescriptors -split "`n")) {
    if ($line -match 'socket:\[(\d+)\]') {
        $socketInodes += [pscustomobject]@{
            Raw = $line
            Inode = [int64]$Matches[1]
        }
    }
}

$socketTables = @('tcp', 'tcp6', 'udp', 'udp6')
$connections = @()
foreach ($table in $socketTables) {
    $tableText = Invoke-AdbShell "su -c 'cat /proc/$processId/net/$table'"
    foreach ($line in (($tableText -split "`n") | Select-Object -Skip 1)) {
        $columns = ($line -split '\s+') | Where-Object { $_ -ne '' }
        if ($columns.Count -lt 10 -or $columns[9] -eq '0') {
            continue
        }
        $inode = [int64]$columns[9]
        if ($socketInodes.Inode -notcontains $inode) {
            continue
        }
        $connections += [pscustomobject]@{
            Table = $table
            LocalAddress = $columns[1]
            RemoteAddress = $columns[2]
            State = $columns[3]
            Uid = [int]$columns[7]
            Inode = $inode
        }
    }
}

$result = [ordered]@{
    capturedAt = (Get-Date).ToString('o')
    serial = $Serial
    package = $Package
    processId = $processId
    uid = $uid
    socketCount = $socketInodes.Count
    sockets = $socketInodes
    connections = $connections
}

$outputPath = Join-Path $OutputDirectory "$Package-$stamp.json"
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outputPath -Encoding UTF8
Write-Host "Process socket evidence written to $outputPath"
