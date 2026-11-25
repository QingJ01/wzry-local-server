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

function New-StoredZipFixture {
    param(
        [string]$Path,
        [hashtable]$Entries
    )

    $crcTable = New-Object 'uint32[]' 256
    for ($n = 0; $n -lt 256; $n++) {
        $c = [uint32]$n
        for ($k = 0; $k -lt 8; $k++) {
            if ($c -band 1) { $c = 0xedb88320 -bxor ($c -shr 1) } else { $c = $c -shr 1 }
        }
        $crcTable[$n] = $c
    }

    $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create)
    $writer = New-Object System.IO.BinaryWriter($fs)
    $centrals = New-Object System.Collections.Generic.List[object]

    try {
        foreach ($entryName in $Entries.Keys) {
            $data = [byte[]]$Entries[$entryName]
            $nameBytes = [System.Text.Encoding]::UTF8.GetBytes($entryName)
            $crc = 0xffffffffL
            foreach ($b in $data) {
                $crc = $crcTable[($crc -bxor $b) -band 0xff] -bxor ($crc -shr 8)
            }
            $crc = ($crc -bxor 0xffffffffL) -band 0xffffffffL

            $centrals.Add([ordered]@{
                Name = $nameBytes
                Crc = [uint32]$crc
                Size = [uint32]$data.Length
                LocalHeaderOffset = [uint32]$fs.Position
            })

            $writer.Write([uint32]0x04034b50)      # local file header signature
            $writer.Write([uint16]20)              # version needed
            $writer.Write([uint16]0)               # flags
            $writer.Write([uint16]0)               # method: stored
            $writer.Write([uint16]0)               # mod time
            $writer.Write([uint16]0)               # mod date
            $writer.Write([uint32]$crc)
            $writer.Write([uint32]$data.Length)    # compressed size
            $writer.Write([uint32]$data.Length)    # uncompressed size
            $writer.Write([uint16]$nameBytes.Length)
            $writer.Write([uint16]0)               # extra length
            $writer.Write($nameBytes)
            $writer.Write($data)
        }

        $cdStart = $fs.Position
        foreach ($central in $centrals) {
            $writer.Write([uint32]0x02014b50)  # central directory signature
            $writer.Write([uint16]20)          # version made by
            $writer.Write([uint16]20)          # version needed
            $writer.Write([uint16]0)           # flags
            $writer.Write([uint16]0)           # method: stored
            $writer.Write([uint16]0)           # mod time
            $writer.Write([uint16]0)           # mod date
            $writer.Write([uint32]$central.Crc)
            $writer.Write([uint32]$central.Size)
            $writer.Write([uint32]$central.Size)
            $writer.Write([uint16]$central.Name.Length)
            $writer.Write([uint16]0)           # extra length
            $writer.Write([uint16]0)           # comment length
            $writer.Write([uint16]0)           # disk number
            $writer.Write([uint16]0)           # internal attrs
            $writer.Write([uint32]0)           # external attrs
            $writer.Write([uint32]$central.LocalHeaderOffset)
            $writer.Write($central.Name)
        }
        $cdEnd = $fs.Position
        $cdSize = $cdEnd - $cdStart

        $writer.Write([uint32]0x06054b50)      # EOCD signature
        $writer.Write([uint16]0)               # disk number
        $writer.Write([uint16]0)               # cd start disk
        $writer.Write([uint16]$centrals.Count)
        $writer.Write([uint16]$centrals.Count)
        $writer.Write([uint32]$cdSize)
        $writer.Write([uint32]$cdStart)
        $writer.Write([uint16]0)               # comment length
    }
    finally {
        $writer.Dispose()
        $fs.Dispose()
    }
}

function Get-StreamCrc32 {
    param([byte[]]$Data)

    $crcTable = New-Object 'uint32[]' 256
    for ($n = 0; $n -lt 256; $n++) {
        $c = [uint32]$n
        for ($k = 0; $k -lt 8; $k++) {
            if ($c -band 1) { $c = 0xedb88320 -bxor ($c -shr 1) } else { $c = $c -shr 1 }
        }
        $crcTable[$n] = $c
    }
    $crc = 0xffffffffL
    foreach ($b in $Data) {
        $crc = $crcTable[($crc -bxor $b) -band 0xff] -bxor ($crc -shr 8)
    }
    return ($crc -bxor 0xffffffffL) -band 0xffffffffL
}

function Invoke-NodeScript {
    param(
        [string]$Script,
        [string[]]$Arguments,
        [string]$StdoutFile,
        [string]$WorkDir
    )

    # PowerShell 5.1 treats any stderr line from a native command as a
    # NativeCommandError when ErrorActionPreference=Stop, even when the node
    # process exits 0. Route through cmd redirection so only the exit code
    # and captured output matter here.
    $argLine = (@($Script) + $Arguments | ForEach-Object {
        if ($_ -match '\s') { '"' + $_ + '"' } else { $_ }
    }) -join ' '
    $prefix = ''
    if ($WorkDir) {
        $prefix = 'cd /d "' + $WorkDir + '" && '
    }
    if ($StdoutFile) {
        cmd /c "$prefix`"node`" $argLine 1> `"$StdoutFile`" 2> NUL" | Out-Null
    }
    else {
        cmd /c "$prefix`"node`" $argLine 1> NUL 2> NUL" | Out-Null
    }
    return $LASTEXITCODE
}

function Invoke-NodeScriptInDir {
    param(
        [string]$Script,
        [string[]]$Arguments,
        [string]$StdoutFile,
        [string]$WorkDir
    )
    return Invoke-NodeScript -Script $Script -Arguments $Arguments -StdoutFile $StdoutFile -WorkDir $WorkDir
}

$analyzeTool = Join-Path $ProjectRoot 'tools\analyze_resid_gate.mjs'
$patchTool = Join-Path $ProjectRoot 'tools\patch_arsc_inplace.mjs'
$signTool = Join-Path $ProjectRoot 'tools\sign_apk_direct.mjs'
$checkTool = Join-Path $ProjectRoot 'tools\check_v4_arsc.mjs'
$reportDoc = Join-Path $ProjectRoot 'reports\resource_license_gate_20261125.md'
$runbookDoc = Join-Path $ProjectRoot 'reports\backend_live_acceptance_runbook_20261125.md'
$v4Manifest = Join-Path $ProjectRoot 'client\builds\wzry-version-gate-localdebug-sgamx-v4.apk.manifest.json'

Write-Host '== node syntax checks =='
foreach ($tool in @($analyzeTool, $patchTool, $signTool, $checkTool)) {
    Assert-True (Test-Path -LiteralPath $tool -PathType Leaf) "Missing tool: $tool"
    node --check $tool
    Assert-True ($LASTEXITCODE -eq 0) "node --check failed for $tool"
}

foreach ($doc in @($reportDoc, $runbookDoc)) {
    Assert-True (Test-Path -LiteralPath $doc -PathType Leaf) "Missing report: $doc"
}

Write-Host '== patch_arsc_inplace round-trip fixture =='
$testDirectory = Join-Path $ProjectRoot 'workspace\tests\resid-gate'
if (Test-Path -LiteralPath $testDirectory) {
    Remove-Item -LiteralPath $testDirectory -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $testDirectory | Out-Null

$utf16 = [System.Text.Encoding]::Unicode
$arscBytes = New-Object 'System.Collections.Generic.List[byte]'
$arscBytes.AddRange([byte[]](0x02, 0x00, 0x0C, 0x00))                       # 0..3 table header filler
$arscBytes.AddRange([byte[]](0x00) * 4)                                     # 4..7 padding
$arscBytes.AddRange($utf16.GetBytes('com.tencent.tmgp.sgame'))              # 8..51 (final 'e' at 50..51)
$arscBytes.AddRange([byte[]](0xAA, 0xBB, 0xCC, 0xDD))                       # trailing payload
$arscArray = $arscBytes.ToArray()
Assert-True ($arscArray[50] -eq 0x65 -and $arscArray[51] -eq 0x00) 'Fixture must place final e of sgame at bytes 50..51'

$otherData = [System.Text.Encoding]::UTF8.GetBytes('unchanged sentinel payload')
$zipPath = Join-Path $testDirectory 'fixture.apk'
New-StoredZipFixture -Path $zipPath -Entries ([ordered]@{
    'resources.arsc' = $arscArray
    'classes.dex' = $otherData
})

$patchStdout = Join-Path $testDirectory 'patch-output.json'
$patchExit = Invoke-NodeScript -Script $patchTool -Arguments @($zipPath, 'resources.arsc', '50', '6500', '7800') -StdoutFile $patchStdout
$patchOutput = Get-Content -Raw -LiteralPath $patchStdout
Assert-True ($patchExit -eq 0) "patch_arsc_inplace failed with exit ${patchExit}: $patchOutput"
$patchInfo = $patchOutput | ConvertFrom-Json
Assert-True ($patchInfo.entry -eq 'resources.arsc') 'Patch output must name resources.arsc'
Assert-True ($patchInfo.newCrc -ne $patchInfo.oldCrc) 'CRC must change after patching different bytes'

# Verify patched bytes in place and CRC consistency in both zip records.
$zipBytes = [System.IO.File]::ReadAllBytes($zipPath)
Assert-True ($zipBytes[$patchInfo.absPatchOff] -eq 0x78 -and $zipBytes[$patchInfo.absPatchOff + 1] -eq 0x00) 'Patched bytes must be 7800 at absPatchOff'
$arscPatched = [byte[]]$arscArray.Clone()
$arscPatched[50] = 0x78
$expectedCrc = Get-StreamCrc32 -Data $arscPatched
# local header starts at dataOff - 30 - nameLen - extraLen; nameLen=14 for resources.arsc, extraLen=0
$localHeaderOff = $patchInfo.dataOff - 30 - 'resources.arsc'.Length
$lfhCrc = [System.BitConverter]::ToUInt32($zipBytes, $localHeaderOff + 14)
$cdCrc = [System.BitConverter]::ToUInt32($zipBytes, $patchInfo.cdFileOff + 16)
Assert-True ($lfhCrc -eq $expectedCrc) "LFH CRC must match recomputed crc32 of patched data (got $($lfhCrc.ToString('x8')) want $($expectedCrc.ToString('x8')))"
Assert-True ($cdCrc -eq $expectedCrc) 'CD CRC must match recomputed crc32 of patched data'
Assert-True ([Convert]::ToUInt32($patchInfo.newCrc, 16) -eq $expectedCrc) 'Reported newCrc must match independent crc32'

# Negative control: patching again with the original bytes must fail the byte guard.
$reapplyExit = Invoke-NodeScript -Script $patchTool -Arguments @($zipPath, 'resources.arsc', '50', '6500', '7800')
Assert-True ($reapplyExit -ne 0) 'Re-applying the patch against already-patched bytes must fail the originalBytes guard'

# Negative control: length mismatch must be rejected before any write.
$freshZip = Join-Path $testDirectory 'fixture-lenmismatch.apk'
New-StoredZipFixture -Path $freshZip -Entries ([ordered]@{ 'resources.arsc' = $arscArray })
$lenExit = Invoke-NodeScript -Script $patchTool -Arguments @($freshZip, 'resources.arsc', '50', '6500', '78')
Assert-True ($lenExit -ne 0) 'Length-mismatched replacement must be rejected'

Write-Host '== analyze_resid_gate live fixture run =='
$sgamxExtract = Join-Path $ProjectRoot 'workspace\analysis\sgamx_v3'
if (Test-Path -LiteralPath (Join-Path $sgamxExtract 'resources.arsc') -PathType Leaf) {
    $analyzeOut = Join-Path $testDirectory 'analyze-output.txt'
    # analyzer resolves paths relative to cwd, so run it with the repo root as cwd
    $analyzeExit = Invoke-NodeScriptInDir -Script $analyzeTool -Arguments @() -StdoutFile $analyzeOut -WorkDir $ProjectRoot
    Assert-True ($analyzeExit -eq 0) 'analyze_resid_gate must run cleanly against sgamx_v3 fixture'
    $analysisJson = Join-Path $ProjectRoot 'workspace\analysis\resid_gate\resid_gate_analysis.json'
    Assert-True (Test-Path -LiteralPath $analysisJson -PathType Leaf) 'Analyzer must emit resid_gate_analysis.json'
    $analysis = Get-Content -Raw -LiteralPath $analysisJson | ConvertFrom-Json
    Assert-True ($analysis.arsc.packageName -eq 'com.tencent.tmgp.sgame') "sgamx_v3 extraction must still carry the original arsc package group, got $($analysis.arsc.packageName)"
    Assert-True ($analysis.arsc.licenseLayoutPresent -eq $true) 'layout/license must exist in arsc'
    Assert-True ($analysis.arsc.tmgpMissingInArsc.Count -eq 0) "All 39 init queries must resolve in arsc, missing: $($analysis.arsc.tmgpMissingInArsc.Count)"
    Assert-True (@($analysis.residClasses).Count -ge 2) 'Analyzer must find at least the msdk tools and tmgp Common ResID classes'
    $msdkExit = $analysis.residClasses |
        Where-Object { $_.classType -eq 'Lcom/tencent/msdk/tools/ResID;' } |
        ForEach-Object { $_.methods } |
        Where-Object { $_.name -eq 'loadIdentifierResource' } |
        ForEach-Object { $_.insns } |
        Where-Object { $_.methodRef -eq 'Ljava/lang/System;->exit' }
    Assert-True ($null -ne $msdkExit) 'msdk tools ResID must contain a System.exit invoke'
    if ($null -ne $msdkExit) {
        $exitInsn = @($msdkExit)[0]
        Assert-True ($exitInsn.fileOffset -eq 0x42f8f6) "System.exit invoke offset drifted: expected 0x42f8f6 got 0x$($exitInsn.fileOffset.ToString('x'))"
    }
}
else {
    Write-Host '  (skipped: workspace/analysis/sgamx_v3 fixture not present)'
}

Write-Host '== v4 arsc + manifest cross-check =='
$v4Apk = Join-Path $ProjectRoot 'client\builds\wzry-version-gate-localdebug-sgamx-v4.apk'
if ((Test-Path -LiteralPath $v4Manifest -PathType Leaf) -and (Test-Path -LiteralPath $v4Apk -PathType Leaf)) {
    $manifest = Get-Content -Raw -LiteralPath $v4Manifest | ConvertFrom-Json
    $apkHash = (Get-FileHash -LiteralPath $v4Apk -Algorithm SHA256).Hash
    Assert-True ($apkHash -eq $manifest.outputSha256) "v4 APK sha256 mismatch: file $apkHash vs manifest $($manifest.outputSha256)"
    Assert-True ($manifest.nativePatches[0].offset -eq 52166) 'Manifest patch offset must be 52166 (0xCBC6)'
    Assert-True ($manifest.nativePatches[0].originalBytesHex -eq '6500') 'Manifest original bytes must be 6500'
    Assert-True ($manifest.nativePatches[0].replacementBytesHex -eq '7800') 'Manifest replacement bytes must be 7800'
    Assert-True ($manifest.verification.apksigner.v2 -eq $true -and $manifest.verification.apksigner.v3 -eq $true) 'Manifest must record v2+v3 signature verification'

    $checkFile = Join-Path $testDirectory 'check-v4-output.txt'
    $checkExit = Invoke-NodeScript -Script $checkTool -Arguments @($v4Apk) -StdoutFile $checkFile
    $checkOutput = Get-Content -LiteralPath $checkFile
    Assert-True ($checkExit -eq 0) "check_v4_arsc failed: $($checkOutput -join ' ')"
    Assert-True (($checkOutput -join ' ') -match 'com\.tencent\.tmgp\.sgamx') 'check_v4_arsc must report patched package group sgamx'
    Assert-True (($checkOutput -join ' ') -match '7800') 'check_v4_arsc must report patched bytes 7800 at 0xCBC6'
}
else {
    Write-Host '  (skipped: v4 APK or manifest not present locally - both are gitignored build outputs)'
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    throw "ResID gate tests failed: $($failures.Count) failure(s)"
}

Write-Host 'ResID gate tests passed.'
