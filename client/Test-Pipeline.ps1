param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$failures = New-Object System.Collections.Generic.List[string]

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        $script:failures.Add($Message)
    }
}

function Assert-Throws {
    param(
        [scriptblock]$ScriptBlock,
        [string]$Message,
        [string]$ExpectedErrorId
    )

    try {
        & $ScriptBlock | Out-Null
        $script:failures.Add("$Message (expected failure)")
    }
    catch {
        if ($ExpectedErrorId -and $_.FullyQualifiedErrorId -notlike "$ExpectedErrorId*") {
            $script:failures.Add("$Message (unexpected error id: $($_.FullyQualifiedErrorId))")
        }
    }
}

$buildScript = Join-Path $ProjectRoot 'client\Build-WzryApk.ps1'
$installScript = Join-Path $ProjectRoot 'client\Install-WzryDbg.ps1'

Assert-True (Test-Path -LiteralPath $buildScript) 'Build script must exist'
Assert-True (Test-Path -LiteralPath $installScript) 'Install script must exist'

$parserErrors = @()
[System.Management.Automation.Language.Parser]::ParseFile($buildScript, [ref]$null, [ref]$parserErrors) | Out-Null
Assert-True ($parserErrors.Count -eq 0) "Build script must parse without errors: $($parserErrors.Count)"

$parserErrors = @()
[System.Management.Automation.Language.Parser]::ParseFile($installScript, [ref]$null, [ref]$parserErrors) | Out-Null
Assert-True ($parserErrors.Count -eq 0) "Install script must parse without errors: $($parserErrors.Count)"

$buildAst = [System.Management.Automation.Language.Parser]::ParseFile($buildScript, [ref]$null, [ref]$null)
$buildParameters = $buildAst.ParamBlock.Parameters.Name.VariablePath.UserPath
foreach ($requiredParameter in @('SourceApk', 'OutputApk', 'PatchManifest')) {
    Assert-True ($buildParameters -contains $requiredParameter) "Build script must expose $requiredParameter"
}

$installAst = [System.Management.Automation.Language.Parser]::ParseFile($installScript, [ref]$null, [ref]$null)
$installParameters = $installAst.ParamBlock.Parameters.Name.VariablePath.UserPath
foreach ($requiredParameter in @('Apk', 'Serial')) {
    Assert-True ($installParameters -contains $requiredParameter) "Install script must expose $requiredParameter"
}

$buildContent = Get-Content -Raw -LiteralPath $buildScript
foreach ($requiredToken in @('A016D941A3D7BA0A8FC976DAE6FE744EFEC85835A16DD10928B65A9C7E19EE5D', 'zipalign', 'apksigner', 'META-INF', 'keystore')) {
    Assert-True ($buildContent.Contains($requiredToken)) "Build script must implement $requiredToken"
}

$installContent = Get-Content -Raw -LiteralPath $installScript
foreach ($requiredToken in @('192.168.5.102:5555', 'reverse tcp:19620 tcp:19620', 'reverse tcp:19621 tcp:19621')) {
    Assert-True ($installContent.Contains($requiredToken)) "Install script must implement $requiredToken"
}

Assert-Throws {
    & $buildScript -SourceApk (Join-Path $ProjectRoot 'missing.apk') -OutputApk (Join-Path $ProjectRoot 'client\builds\test.apk') -PatchManifest (Join-Path $ProjectRoot 'client\patches\empty.json') -ExpectedSha256 'A016D941A3D7BA0A8FC976DAE6FE744EFEC85835A16DD10928B65A9C7E19EE5D'
} 'Build script must reject missing source APK' 'Source APK not found'

Assert-Throws {
    & $installScript -Apk (Join-Path $ProjectRoot 'missing.apk') -Serial '192.168.5.102:5555' -SkipDeviceConnect
} 'Install script must reject missing APK' 'APK not found'

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    throw "Pipeline tests failed: $($failures.Count) failure(s)"
}

Write-Host 'Pipeline tests passed.'
