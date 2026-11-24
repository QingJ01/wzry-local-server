[CmdletBinding()]
param(
    [ValidatePattern('^192\.168\.5\.102:5555$')]
    [string]$Serial = '192.168.5.102:5555',

    [ValidateSet('deploy', 'start', 'run', 'stop', 'cleanup', 'verify')]
    [string]$Action,

    [string]$ServerPath = 'D:\project\poxxiao\work\period-formula-research\tools\frida-server-17.27.5-android-arm64',

    [int]$ServerPort = 27042,

    [int]$CaptureSeconds = 90,

    [switch]$Attach
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSCommandPath | Split-Path -Parent | Split-Path -Parent
$AdbPath = 'D:\project\poxxiao\tools\android-sdk\platform-tools\adb.exe'
$Package = 'com.tencent.tmgp.sgame'
$DeviceServerPath = '/data/local/tmp/wzry-frida-server-17.27.5'
$ObservationDirectory = Join-Path $ProjectRoot 'workspace\observations\frida'
$RunNotePath = Join-Path $ObservationDirectory 'latest-run.json'

if (-not (Test-Path -LiteralPath $AdbPath)) {
    throw "ADB not found: $AdbPath"
}

function Invoke-Adb {
    param([string[]]$CommandArguments)
    & $AdbPath -s $Serial @CommandArguments
    if ($LASTEXITCODE -ne 0) {
        throw "adb $($CommandArguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Get-ServerPid {
    $pidOutput = Invoke-Adb @('shell', "su -c 'pgrep -x wzry-frida-serv || true'")
    $trimmedPid = "$pidOutput".Trim()
    if ($trimmedPid -match '^[0-9]+$') {
        return [int]$trimmedPid
    }
    return $null
}

function Read-RunNote {
    if (Test-Path -LiteralPath $RunNotePath) {
        return Get-Content -LiteralPath $RunNotePath -Raw | ConvertFrom-Json
    }
    return $null
}

function Write-RunNote {
    param([hashtable]$Properties)
    $existing = Read-RunNote
    $note = if ($null -ne $existing) {
        $merged = @{}
        foreach ($property in $existing.PSObject.Properties) {
            $merged[$property.Name] = $property.Value
        }
        foreach ($key in $Properties.Keys) {
            $merged[$key] = $Properties[$key]
        }
        [pscustomobject]$merged
    } else {
        [pscustomobject]$Properties
    }

    New-Item -ItemType Directory -Force -Path $ObservationDirectory | Out-Null
    $note | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $RunNotePath -Encoding UTF8
}

switch ($Action) {
    'deploy' {
        if (-not (Test-Path -LiteralPath $ServerPath -PathType Leaf)) {
            throw "Frida server not found: $ServerPath"
        }

        $serverHash = (Get-FileHash -LiteralPath $ServerPath -Algorithm SHA256).Hash
        Write-RunNote @{
            serverHostPath = $ServerPath
            serverDevicePath = $DeviceServerPath
            serverSha256 = $serverHash
            serverVersion = '17.27.5'
            serverPort = $ServerPort
            serial = $Serial
            deployedAt = (Get-Date).ToUniversalTime().ToString('o')
        }

        Invoke-Adb @('shell', "su -c 'rm -f $DeviceServerPath'")
        Invoke-Adb @('push', $ServerPath, $DeviceServerPath)
        Invoke-Adb @('shell', "su -c 'chown shell:shell $DeviceServerPath && chmod 700 $DeviceServerPath'")
        Invoke-Adb @('shell', "su -c 'ls -l $DeviceServerPath'")
    }
    'start' {
        $existingPid = Get-ServerPid
        if ($null -ne $existingPid) {
            throw "Frida server is already running as PID $existingPid"
        }

        Invoke-Adb @(
            'shell',
            "su -c 'nohup $DeviceServerPath -l 127.0.0.1:$ServerPort >/dev/null 2>&1 &'"
        )
        Start-Sleep -Seconds 1
        $startedPid = Get-ServerPid
        if ($null -eq $startedPid) {
            throw 'Frida server failed to start'
        }

        Invoke-Adb @('forward', "tcp:$ServerPort", "tcp:$ServerPort")
        Write-RunNote @{
            serverPid = $startedPid
            serverStartedAt = (Get-Date).ToUniversalTime().ToString('o')
            adbForward = "tcp:$ServerPort"
        }
    }
    'run' {
        if ($null -eq (Get-ServerPid)) {
            throw 'Frida server is not running'
        }

        New-Item -ItemType Directory -Force -Path $ObservationDirectory | Out-Null
        $runId = Get-Date -Format 'yyyyMMdd-HHmmss'
        $logPath = Join-Path $ObservationDirectory "$runId.ndjson"
        $stderrPath = "$logPath.stderr"
        $nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
            throw 'Node.js not found on PATH'
        }

        Write-RunNote @{
            lastRunId = $runId
            lastLogPath = $logPath
            captureStartedAt = (Get-Date).ToUniversalTime().ToString('o')
            captureSeconds = $CaptureSeconds
            attachMode = [bool]$Attach
        }

        $captureArguments = @(
            (Join-Path (Split-Path -Parent $PSCommandPath) 'run-network-capture.mjs'),
            $logPath,
            $CaptureSeconds
        )
        if ($Attach) {
            $captureArguments += 'attach'
        }

        $process = Start-Process -FilePath $nodePath `
            -ArgumentList $captureArguments `
            -WorkingDirectory $ProjectRoot `
            -RedirectStandardOutput $logPath `
            -RedirectStandardError $stderrPath `
            -NoNewWindow `
            -PassThru

        Start-Sleep -Seconds $CaptureSeconds
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force
            $process.WaitForExit()
        }

        Write-RunNote @{
            captureStoppedAt = (Get-Date).ToUniversalTime().ToString('o')
            lastExitCode = $process.ExitCode
        }
        Write-Output $logPath
    }
    'stop' {
        $serverPid = Get-ServerPid
        if ($null -ne $serverPid) {
            Invoke-Adb @('shell', "su -c 'kill $serverPid'")
            Start-Sleep -Seconds 1
            if ($null -ne (Get-ServerPid)) {
                throw "Frida server PID $serverPid did not stop"
            }
        }

        Invoke-Adb @('forward', '--remove', "tcp:$ServerPort")
        Write-RunNote @{
            serverStoppedAt = (Get-Date).ToUniversalTime().ToString('o')
            adbForwardRemoved = "tcp:$ServerPort"
        }
    }
    'cleanup' {
        Invoke-Adb @('shell', "su -c 'rm -f $DeviceServerPath'")
        Write-RunNote @{
            cleanedUpAt = (Get-Date).ToUniversalTime().ToString('o')
            serverDevicePathRemoved = $DeviceServerPath
        }
    }
    'verify' {
        if (Test-Path -LiteralPath $RunNotePath) {
            Get-Content -LiteralPath $RunNotePath -Raw
        } else {
            Write-Output 'run note missing'
        }

        Invoke-Adb @('shell', "su -c 'ls -l $DeviceServerPath 2>/dev/null || true'")
        Invoke-Adb @('forward', '--list')
    }
}
