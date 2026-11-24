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
        [string]$ExpectedText
    )

    try {
        & $ScriptBlock | Out-Null
        $script:failures.Add("$Message (expected failure)")
    }
    catch {
        if ($ExpectedText -and $_.Exception.Message -notlike "*$ExpectedText*") {
            $script:failures.Add("$Message (unexpected error: $($_.Exception.Message))")
        }
    }
}

function New-NativePatchTestApk {
    param(
        [string]$Path,
        [string[]]$EntryPaths
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::Open($Path, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($entryPath in $EntryPaths) {
            $entry = $archive.CreateEntry($entryPath, [System.IO.Compression.CompressionLevel]::Optimal)
            $stream = $entry.Open()
            try {
                if ($entryPath -eq 'lib/arm64-v8a/test.so') {
                    $bytes = [byte[]](1, 2, 3, 4, 5, 6, 7, 8)
                    $stream.Write($bytes, 0, $bytes.Length)
                }
                elseif ($entryPath -eq 'resources.arsc' -or
                    $entryPath -like 'lib/*' -or
                    $entryPath -like 'assets/*') {
                    $bytes = [byte[]](0..255)
                    $stream.Write($bytes, 0, $bytes.Length)
                }
                else {
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes('A' * 10000)
                    $stream.Write($bytes, 0, $bytes.Length)
                }
            }
            finally {
                $stream.Dispose()
            }
        }
    }
    finally {
        $archive.Dispose()
    }
}

function Get-ZipEntryInfo {
    param([string]$Path)

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entryInfo = foreach ($entry in $archive.Entries) {
                [ordered]@{
                    FullName = $entry.FullName
                    Length = $entry.Length
                    CompressedLength = $entry.CompressedLength
                }
            }
        return @($entryInfo)
    }
    finally {
        $archive.Dispose()
    }
}

function New-NativePatchManifest {
    param(
        [string]$EntryPath,
        [int64]$Offset,
        [string]$OriginalBytesHex,
        [string]$ReplacementBytesHex
    )

    return [ordered]@{
        nativePatches = @(
            [ordered]@{
                entryPath = $EntryPath
                offset = $Offset
                originalBytesHex = $OriginalBytesHex
                replacementBytesHex = $ReplacementBytesHex
                evidence = 'test://exact-offset'
            }
        )
    } | ConvertTo-Json -Depth 5
}

$scriptPath = Join-Path $ProjectRoot 'tools\Build-WzryNativePatch.ps1'
$planPath = Join-Path $ProjectRoot 'reports\native_patch_plan.md'
Assert-True (Test-Path -LiteralPath $scriptPath -PathType Leaf) 'Build-WzryNativePatch.ps1 must exist'
Assert-True (Test-Path -LiteralPath $planPath -PathType Leaf) 'native_patch_plan.md must exist'

if (Test-Path -LiteralPath $scriptPath -PathType Leaf) {
    $parserErrors = @()
    [System.Management.Automation.Language.Parser]::ParseFile(
        $scriptPath,
        [ref]$null,
        [ref]$parserErrors
    ) | Out-Null
    Assert-True ($parserErrors.Count -eq 0) "Build script must parse without errors: $($parserErrors.Count)"

    $scriptContent = Get-Content -Raw -LiteralPath $scriptPath
    foreach ($requiredToken in @(
        'ExpectedSha256',
        'Get-EntryCompressionLevel',
        'CompressionLevel',
        'originalBytesHex',
        'replacementBytesHex',
        'originalEntrySha256',
        'patchedEntrySha256',
        'apksigner',
        'zipalign',
        'WhatIf'
    )) {
        Assert-True ($scriptContent.Contains($requiredToken)) "Build script must implement $requiredToken"
    }

    Assert-Throws {
        & $scriptPath -SourceApk (Join-Path $ProjectRoot 'missing.apk') `
            -PatchManifest (Join-Path $ProjectRoot 'missing.json') `
            -OutputApk (Join-Path $ProjectRoot 'workspace\apk\native-test.apk')
    } 'Build script must reject missing source APK' 'Source APK not found'

    Assert-Throws {
        & $scriptPath -SourceApk (Join-Path $ProjectRoot 'workspace\apk\3.81.1.8.apk') `
            -PatchManifest (Join-Path $ProjectRoot 'missing.json') `
            -OutputApk (Join-Path $ProjectRoot 'workspace\apk\native-test.apk')
    } 'Build script must reject missing patch manifest' 'Patch manifest not found'
}

$testDirectory = Join-Path $ProjectRoot 'workspace\tests\native-patch'
if (Test-Path -LiteralPath $testDirectory) {
    Remove-Item -LiteralPath $testDirectory -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $testDirectory | Out-Null
$testApk = Join-Path $testDirectory 'source.apk'
$testPatch = Join-Path $testDirectory 'patch.json'
$testOutput = Join-Path $testDirectory 'patched.apk'
New-NativePatchTestApk $testApk @('lib/arm64-v8a/test.so')
$expectedSourceEntries = Get-ZipEntryInfo $testApk
$testHash = (Get-FileHash -LiteralPath $testApk -Algorithm SHA256).Hash

$testPatchJson = New-NativePatchManifest 'lib/arm64-v8a/test.so' 4 '05060708' 'AA BB CC DD'
Set-Content -LiteralPath $testPatch -Value $testPatchJson -Encoding UTF8

$validationPath = Join-Path $testDirectory 'whatif.txt'
& $scriptPath -SourceApk $testApk -PatchManifest $testPatch -OutputApk $testOutput -ExpectedSha256 $testHash -WhatIf *> $validationPath
$validationText = Get-Content -Raw -LiteralPath $validationPath
Assert-True ($validationText.Contains('Validated 1 native patch(es). No APK was built.')) "WhatIf must validate exact native patch: $validationText"
Assert-True (-not (Test-Path -LiteralPath $testOutput -PathType Leaf)) 'WhatIf must not build an APK'

Assert-Throws {
    & $scriptPath -SourceApk $testApk -PatchManifest $testPatch -OutputApk $testOutput -ExpectedSha256 $testHash -ToolsRoot (Join-Path $testDirectory 'missing-tools')
} 'Native patch build must require Android signing tools' 'Required ZipAlign'

$invalidPatchPath = Join-Path $testDirectory 'invalid-bytes.json'
$invalidPatchJson = New-NativePatchManifest 'lib/arm64-v8a/test.so' 4 '05060709' 'AA BB CC DD'
Set-Content -LiteralPath $invalidPatchPath -Value $invalidPatchJson -Encoding UTF8
Assert-Throws {
    & $scriptPath -SourceApk $testApk -PatchManifest $invalidPatchPath -OutputApk $testOutput -ExpectedSha256 $testHash -WhatIf *> $null
} 'Native patch must reject original byte mismatch' 'original bytes mismatch'

# --- Additional coverage: byte precision, bounds, multi-patch, length parity ---

# 1. Exact byte offset: patch at offset 0 must fail if bytes don't match there.
$offsetZeroWrong = Join-Path $testDirectory 'offset0-wrong.json'
$offsetZeroWrongJson = New-NativePatchManifest 'lib/arm64-v8a/test.so' 0 'FF FF FF FF' '11 22 33 44'
Set-Content -LiteralPath $offsetZeroWrong -Value $offsetZeroWrongJson -Encoding UTF8
Assert-Throws {
    & $scriptPath -SourceApk $testApk -PatchManifest $offsetZeroWrong -OutputApk $testOutput -ExpectedSha256 $testHash -WhatIf *> $null
} 'Offset 0 original-byte mismatch must be rejected' 'original bytes mismatch'

# 2. Offset + length must not exceed entry length (test.so is 8 bytes).
$outOfBounds = Join-Path $testDirectory 'out-of-bounds.json'
$outOfBoundsJson = New-NativePatchManifest 'lib/arm64-v8a/test.so' 6 '060708090A0B' 'AA BB CC DD EE FF'
Set-Content -LiteralPath $outOfBounds -Value $outOfBoundsJson -Encoding UTF8
Assert-Throws {
    & $scriptPath -SourceApk $testApk -PatchManifest $outOfBounds -OutputApk $testOutput -ExpectedSha256 $testHash -WhatIf *> $null
} 'Out-of-bounds patch must be rejected' 'out of bounds'

# 3. Original and replacement lengths must match exactly.
$lengthMismatch = Join-Path $testDirectory 'length-mismatch.json'
$lengthMismatchJson = New-NativePatchManifest 'lib/arm64-v8a/test.so' 4 '05060708' 'AA BB CC'
Set-Content -LiteralPath $lengthMismatch -Value $lengthMismatchJson -Encoding UTF8
Assert-Throws {
    & $scriptPath -SourceApk $testApk -PatchManifest $lengthMismatch -OutputApk $testOutput -ExpectedSha256 $testHash -WhatIf *> $null
} 'Mismatched patch lengths must be rejected' 'lengths must match'

# 4. Multi-patch manifest: two disjoint patches in one manifest must both validate.
$multiPatch = Join-Path $testDirectory 'multi-patch.json'
$multiPatchJson = [ordered]@{
    nativePatches = @(
        [ordered]@{
            entryPath = 'lib/arm64-v8a/test.so'
            offset = 0
            originalBytesHex = '01 02'
            replacementBytesHex = 'AA BB'
            evidence = 'test://multi-1'
        },
        [ordered]@{
            entryPath = 'lib/arm64-v8a/test.so'
            offset = 4
            originalBytesHex = '05 06 07 08'
            replacementBytesHex = 'CC DD EE FF'
            evidence = 'test://multi-2'
        }
    )
} | ConvertTo-Json -Depth 5
Set-Content -LiteralPath $multiPatch -Value $multiPatchJson -Encoding UTF8
$multiValidationPath = Join-Path $testDirectory 'multi-whatif.txt'
& $scriptPath -SourceApk $testApk -PatchManifest $multiPatch -OutputApk $testOutput -ExpectedSha256 $testHash -WhatIf *> $multiValidationPath
$multiValidationText = Get-Content -Raw -LiteralPath $multiValidationPath
Assert-True ($multiValidationText.Contains('Validated 2 native patch(es). No APK was built.')) "WhatIf must validate all patches in a multi-patch manifest: $multiValidationText"

# 5. Missing 'evidence' field must be rejected.
$noEvidence = Join-Path $testDirectory 'no-evidence.json'
$noEvidenceJson = [ordered]@{
    nativePatches = @(
        [ordered]@{
            entryPath = 'lib/arm64-v8a/test.so'
            offset = 0
            originalBytesHex = '01 02'
            replacementBytesHex = 'AA BB'
        }
    )
} | ConvertTo-Json -Depth 5
Set-Content -LiteralPath $noEvidence -Value $noEvidenceJson -Encoding UTF8
Assert-Throws {
    & $scriptPath -SourceApk $testApk -PatchManifest $noEvidence -OutputApk $testOutput -ExpectedSha256 $testHash -WhatIf *> $null
} 'Patch without evidence must be rejected' 'evidence'

# 6. Missing 'offset' field must be rejected.
$noOffset = Join-Path $testDirectory 'no-offset.json'
$noOffsetJson = [ordered]@{
    nativePatches = @(
        [ordered]@{
            entryPath = 'lib/arm64-v8a/test.so'
            originalBytesHex = '01 02'
            replacementBytesHex = 'AA BB'
            evidence = 'test://x'
        }
    )
} | ConvertTo-Json -Depth 5
Set-Content -LiteralPath $noOffset -Value $noOffsetJson -Encoding UTF8
Assert-Throws {
    & $scriptPath -SourceApk $testApk -PatchManifest $noOffset -OutputApk $testOutput -ExpectedSha256 $testHash -WhatIf *> $null
} 'Patch without offset must be rejected' 'offset'

$nonNativePatchPath = Join-Path $testDirectory 'non-native.json'
$nonNativePatchJson = New-NativePatchManifest 'assets/test.bin' 0 '0102' '0304'
Set-Content -LiteralPath $nonNativePatchPath -Value $nonNativePatchJson -Encoding UTF8
Assert-Throws {
    & $scriptPath -SourceApk $testApk -PatchManifest $nonNativePatchPath -OutputApk $testOutput -ExpectedSha256 $testHash -WhatIf *> $null
} 'Native patch must reject non-lib entry' 'only target lib/* entries'

$buildScriptAst = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
$scriptRaw = Get-Content -Raw -LiteralPath $scriptPath
Assert-True ($scriptRaw.Contains('foreach ($entry in $archive.Entries)')) 'Build script must iterate source entries in order'
Assert-True ($scriptRaw.Contains('Write-EntryStream')) 'Build script must stream-copy unmodified entries'
Assert-True ($scriptRaw.Contains('Write-EntryBytes')) 'Build script must write patched entries'
Assert-True ($scriptRaw.Contains('$patchedByEntry')) 'Build script must track patched entry bytes'
    Assert-True ((Get-Content -Raw -LiteralPath $scriptPath).Contains('Get-EntryStorePolicy')) 'Build script must write sensitive entries with ZIP Store method'
    Assert-True ((Get-Content -Raw -LiteralPath $scriptPath).Contains('CompressionMethod')) 'Build script must enforce the ZIP compression method'
Assert-True ((Get-Content -Raw -LiteralPath $scriptPath).Contains("EntryPath -eq 'resources.arsc'")) 'Build script must store resources.arsc uncompressed'
Assert-True ((Get-Content -Raw -LiteralPath $scriptPath).Contains("EntryPath -like 'lib/*'")) 'Build script must store lib entries uncompressed'
Assert-True ((Get-Content -Raw -LiteralPath $scriptPath).Contains("EntryPath -like 'assets/*'")) 'Build script must store assets entries uncompressed'
Assert-True (@($expectedSourceEntries).Count -eq 1) 'Native patch test source must contain the target entry'

if (Test-Path -LiteralPath $planPath -PathType Leaf) {
    $planContent = Get-Content -Raw -LiteralPath $planPath
    foreach ($requiredSection in @(
        '## Modification strategies',
        '## Build-WzryNativePatch.ps1',
        '## Exact offset requirements',
        '## Account, battle, and shop call sites',
        '## Prohibitions'
    )) {
        Assert-True ($planContent.Contains($requiredSection)) "Native patch plan must contain section: $requiredSection"
    }
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    throw "Native patch tests failed: $($failures.Count) failure(s)"
}

Write-Host 'Native patch tests passed.'
