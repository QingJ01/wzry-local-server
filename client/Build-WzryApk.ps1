param(
    [Parameter(Mandatory = $true)]
    [string]$SourceApk,

    [Parameter(Mandatory = $true)]
    [string]$OutputApk,

    [Parameter(Mandatory = $true)]
    [string]$PatchManifest,

    [string]$ExpectedSha256 = 'A016D941A3D7BA0A8FC976DAE6FE744EFEC85835A16DD10928B65A9C7E19EE5D',

    [string]$ToolsRoot = 'D:\project\poxxiao\tools',

    [string]$KeyStore = "$PSScriptRoot\keys\wzry-debug.keystore",

    [string]$KeyAlias = 'wzry-debug',

    [securestring]$KeyPassword,

    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-FileSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-ZipEntrySha256 {
    param(
        [System.IO.Compression.ZipArchiveEntry]$Entry
    )

    $entryStream = $Entry.Open()
    try {
        $hashStream = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([System.BitConverter]::ToString($hashStream.ComputeHash($entryStream))).Replace('-', '')
        }
        finally {
            $hashStream.Dispose()
        }
    }
    finally {
        $entryStream.Dispose()
    }
}

function Convert-ToBinaryString {
    param(
        [string]$Text,
        [string]$Encoding = 'utf8'
    )

    if ($Encoding -eq 'utf16') {
        return [System.Text.Encoding]::Unicode.GetBytes($Text)
    }
    return [System.Text.Encoding]::UTF8.GetBytes($Text)
}

function Read-EntryBytes {
    param(
        [System.IO.Compression.ZipArchiveEntry]$Entry
    )

    $stream = $Entry.Open()
    try {
        $memory = [System.IO.MemoryStream]::new()
        $stream.CopyTo($memory)
        return $memory.ToArray()
    }
    finally {
        $stream.Dispose()
    }
}

function Test-BinaryReplacement {
    param(
        [byte[]]$Bytes,
        [byte[]]$Find,
        [int]$ExpectedCount = 1
    )

    $count = 0
    for ($index = 0; $index -le $Bytes.Length - $Find.Length; $index++) {
        $matches = $true
        for ($offset = 0; $offset -lt $Find.Length; $offset++) {
            if ($Bytes[$index + $offset] -ne $Find[$offset]) {
                $matches = $false
                break
            }
        }
        if ($matches) {
            $count++
            $index += $Find.Length - 1
        }
    }
    if ($ExpectedCount -ge 0) {
        return ($count -eq $ExpectedCount)
    }
    return $count
}

function Write-EntryBytes {
    param(
        [System.IO.Compression.ZipArchive]$Archive,
        [string]$EntryPath,
        [byte[]]$Bytes
    )

    $existingEntry = $Archive.GetEntry($EntryPath)
    if ($existingEntry) {
        $existingEntry.Delete()
    }
    $entry = $Archive.CreateEntry($EntryPath, (Get-EntryCompressionLevel $EntryPath))
    if (Get-EntryStorePolicy $EntryPath) {
        $compressionMethodProperty = [System.IO.Compression.ZipArchiveEntry].GetProperty(
            'CompressionMethod',
            [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic
        )
        $compressionMethodProperty.SetValue(
            $entry,
            [Enum]::Parse($compressionMethodProperty.PropertyType, 'Stored'),
            $null
        )
    }
    $stream = $entry.Open()
    try {
        $stream.Write($Bytes, 0, $Bytes.Length)
    }
    finally {
        $stream.Dispose()
    }
}

function Get-EntryCompressionLevel {
    param([string]$EntryPath)

    if ($EntryPath -eq 'resources.arsc' -or $EntryPath -like 'lib/*' -or $EntryPath -like 'assets/*') {
        return [System.IO.Compression.CompressionLevel]::NoCompression
    }
    return [System.IO.Compression.CompressionLevel]::Optimal
}

function Get-EntryStorePolicy {
    param([string]$EntryPath)

    return ($EntryPath -eq 'resources.arsc' -or
        $EntryPath -like 'lib/*' -or
        $EntryPath -like 'assets/*')
}

function Assert-CommandPath {
    param(
        [string]$Path,
        [string]$Name
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required $Name was not found: $Path"
    }
}

if (-not (Test-Path -LiteralPath $SourceApk -PathType Leaf)) {
    throw "Source APK not found: $SourceApk"
}

if (-not (Test-Path -LiteralPath $PatchManifest -PathType Leaf)) {
    throw "Patch manifest not found: $PatchManifest"
}

$sourceHash = Get-FileSha256 $SourceApk
if ($sourceHash -ne $ExpectedSha256) {
    throw "Source APK hash mismatch. Expected $ExpectedSha256, got $sourceHash."
}

$outputDirectory = Split-Path -Parent $OutputApk
if ($outputDirectory) {
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
}
if (Test-Path -LiteralPath $OutputApk) {
    throw "Output APK already exists: $OutputApk. Remove it or choose a new timestamped path."
}

$buildTools = Join-Path $ToolsRoot 'android-sdk\build-tools\36.1.0'
$zipalign = Join-Path $buildTools 'zipalign.exe'
$apksignerJar = Join-Path $buildTools 'lib\apksigner.jar'
$java = Join-Path $ToolsRoot 'java17\bin\java.exe'
$keytool = Join-Path $ToolsRoot 'java17\bin\keytool.exe'
Assert-CommandPath $zipalign 'ZipAlign'
Assert-CommandPath $apksignerJar 'APKSigner'
Assert-CommandPath $java 'Java'
Assert-CommandPath $keytool 'Keytool'

Add-Type -AssemblyName System.IO.Compression.FileSystem

$patch = Get-Content -Raw -LiteralPath $PatchManifest | ConvertFrom-Json
$entries = @()
if ($patch.PSObject.Properties['entries']) {
    $entries = @($patch.PSObject.Properties['entries'].Value)
}
$binaryPatches = @()
if ($patch.PSObject.Properties['binaryPatches']) {
    $binaryPatches = @($patch.PSObject.Properties['binaryPatches'].Value)
}
$changes = @()

$binaryPatchPlan = @()
if ($binaryPatches.Count -gt 0) {
    $inspectionArchive = [System.IO.Compression.ZipFile]::OpenRead($SourceApk)
    try {
        foreach ($binaryPatch in $binaryPatches) {
            if ([string]::IsNullOrWhiteSpace($binaryPatch.entryPath)) {
                throw 'Binary patch entryPath is required.'
            }
            $entry = $inspectionArchive.GetEntry($binaryPatch.entryPath)
            if (-not $entry) {
                throw "Binary patch target entry not found: $($binaryPatch.entryPath)"
            }
            $entryBytes = Read-EntryBytes $entry
            foreach ($replacement in @($binaryPatch.replacements)) {
                if ([string]::IsNullOrWhiteSpace($replacement.find) -or [string]::IsNullOrWhiteSpace($replacement.replace)) {
                    throw "Binary patch find and replace are required for $($binaryPatch.entryPath)."
                }
                if ($replacement.find.Length -ne $replacement.replace.Length) {
                    throw "Binary replacement lengths must match for $($binaryPatch.entryPath): $($replacement.find)"
                }
                $expectedCount = if ($null -ne $replacement.count) { [int]$replacement.count } else { 1 }
                $encoding = if ($replacement.encoding) { [string]$replacement.encoding } else { 'utf8' }
                $actualCount = [int](Test-BinaryReplacement $entryBytes (Convert-ToBinaryString $replacement.find $encoding) -1)
                if ($actualCount -ne $expectedCount) {
                    throw "Binary replacement count mismatch for $($binaryPatch.entryPath): $($replacement.find). Expected $expectedCount, found $actualCount."
                }
                if ($expectedCount -lt 1) {
                    throw "Binary replacement count must be positive for $($binaryPatch.entryPath)."
                }
                $binaryPatchPlan += [ordered]@{
                    entryPath = $binaryPatch.entryPath
                    find = $replacement.find
                    replace = $replacement.replace
                    count = $expectedCount
                    encoding = $encoding
                }
            }
        }
    }
    finally {
        $inspectionArchive.Dispose()
    }
}

if ($WhatIf) {
    Write-Host "Validated $($binaryPatchPlan.Count) binary replacement(s) and $($entries.Count) entry replacement(s). No APK was built."
    return
}

$stagingApk = "$OutputApk.staging"
Copy-Item -LiteralPath $SourceApk -Destination $stagingApk

try {
if ($entries.Count -gt 0 -or $binaryPatches.Count -gt 0) {
        $compressedArchive = [System.IO.Compression.ZipFile]::Open($stagingApk, 'Update')
        try {
            foreach ($binaryPatch in $binaryPatches) {
                $entry = $compressedArchive.GetEntry($binaryPatch.entryPath)
                if (-not $entry) {
                    throw "Binary patch target entry not found during update: $($binaryPatch.entryPath)"
                }
                $entryBytes = Read-EntryBytes $entry
                foreach ($replacement in @($binaryPatch.replacements)) {
                    $encoding = if ($replacement.encoding) { [string]$replacement.encoding } else { 'utf8' }
                    $findBytes = Convert-ToBinaryString $replacement.find $encoding
                    $replaceBytes = Convert-ToBinaryString $replacement.replace $encoding
                    $expectedCount = if ($null -ne $replacement.count) { [int]$replacement.count } else { 1 }
                    $actualCount = [int](Test-BinaryReplacement $entryBytes $findBytes -1)
                    if ($actualCount -lt 1) {
                        throw "Binary replacement count mismatch during update: $($replacement.find). Expected $expectedCount, found $actualCount."
                    }
                    $position = 0
                    while ($position -le $entryBytes.Length - $findBytes.Length) {
                        $matches = $true
                        for ($offset = 0; $offset -lt $findBytes.Length; $offset++) {
                            if ($entryBytes[$position + $offset] -ne $findBytes[$offset]) {
                                $matches = $false
                                break
                            }
                        }
                        if ($matches) {
                            for ($offset = 0; $offset -lt $replaceBytes.Length; $offset++) {
                                $entryBytes[$position + $offset] = $replaceBytes[$offset]
                            }
                            $position += $replaceBytes.Length
                        }
                        else {
                            $position++
                        }
                    }
                    $remainingCount = [int](Test-BinaryReplacement $entryBytes $findBytes -1)
                    if ($remainingCount -ne 0) {
                        throw "Binary replacement did not complete for $($replacement.find). Remaining count: $remainingCount."
                    }
                }
                Write-EntryBytes $compressedArchive $binaryPatch.entryPath $entryBytes
                $changes += [ordered]@{
                    entryPath = $binaryPatch.entryPath
                    operation = 'binary-replace'
                    replacements = @($binaryPatch.replacements)
                }
            }

            foreach ($entrySpec in $entries) {
                if ([string]::IsNullOrWhiteSpace($entrySpec.entryPath)) {
                    throw 'Patch entryPath is required.'
                }
                if ([string]::IsNullOrWhiteSpace($entrySpec.sourcePath)) {
                    throw "Patch sourcePath is required for $($entrySpec.entryPath)."
                }
                if (-not (Test-Path -LiteralPath $entrySpec.sourcePath -PathType Leaf)) {
                    throw "Patch source file not found: $($entrySpec.sourcePath)"
                }

                $oldHash = $null
                $existingEntry = $compressedArchive.GetEntry($entrySpec.entryPath)
                if ($existingEntry) {
                    $oldHash = Get-ZipEntrySha256 $existingEntry
                    $existingEntry.Delete()
                }

                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $compressedArchive,
                    $entrySpec.sourcePath,
                    $entrySpec.entryPath,
                    [System.IO.Compression.CompressionLevel]::Optimal
                ) | Out-Null

                $newHash = Get-FileSha256 $entrySpec.sourcePath
                $changes += [ordered]@{
                    entryPath = $entrySpec.entryPath
                    operation = if ($oldHash) { 'replace' } else { 'add' }
                    oldSha256 = $oldHash
                    newSha256 = $newHash
                }
            }

            for ($index = $compressedArchive.Entries.Count - 1; $index -ge 0; $index--) {
                $entry = $compressedArchive.Entries[$index]
                if ($entry.FullName -like 'META-INF/*' -and (
                    $entry.FullName.EndsWith('.SF') -or
                    $entry.FullName.EndsWith('.RSA') -or
                    $entry.FullName.EndsWith('.DSA') -or
                    $entry.FullName -eq 'META-INF/MANIFEST.MF')) {
                    $entry.Delete()
                }
            }
        }
        finally {
            $compressedArchive.Dispose()
        }
    }
    else {
        $compressedArchive = [System.IO.Compression.ZipFile]::Open($stagingApk, 'Update')
        try {
            for ($index = $compressedArchive.Entries.Count - 1; $index -ge 0; $index--) {
                $entry = $compressedArchive.Entries[$index]
                if ($entry.FullName -like 'META-INF/*' -and (
                    $entry.FullName.EndsWith('.SF') -or
                    $entry.FullName.EndsWith('.RSA') -or
                    $entry.FullName.EndsWith('.DSA') -or
                    $entry.FullName -eq 'META-INF/MANIFEST.MF')) {
                    $entry.Delete()
                }
            }
        }
        finally {
            $compressedArchive.Dispose()
        }
    }
}
catch {
    if (Test-Path -LiteralPath $stagingApk) {
        Remove-Item -LiteralPath $stagingApk -Force
    }
    throw
}

$keyStoreDirectory = Split-Path -Parent $KeyStore
New-Item -ItemType Directory -Force -Path $keyStoreDirectory | Out-Null
if (-not (Test-Path -LiteralPath $KeyStore -PathType Leaf)) {
    $keyPasswordPlain = if ($KeyPassword) {
        [System.Net.NetworkCredential]::new([string]$KeyPassword, '').Password
    }
    else {
        'wzry-local-debug'
    }
    & $keytool -genkeypair -keystore $KeyStore -storetype PKCS12 -alias $KeyAlias `
        -keyalg RSA -keysize 2048 -validity 10000 `
        -storepass $keyPasswordPlain -keypass $keyPasswordPlain `
        -dname 'CN=WZRY Local Debug,O=Local Debug,C=CN' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "keytool failed with exit code $LASTEXITCODE."
    }
}

$alignedApk = "$OutputApk.aligned"
& $zipalign -f -p 4 $stagingApk $alignedApk
if ($LASTEXITCODE -ne 0) {
    throw "zipalign failed with exit code $LASTEXITCODE."
}

$plainKeyPassword = if ($KeyPassword) {
    [System.Net.NetworkCredential]::new([string]$KeyPassword, '').Password
}
else {
    'wzry-local-debug'
}

& $java -jar $apksignerJar sign --ks $KeyStore --ks-key-alias $KeyAlias `
    --ks-pass "pass:$plainKeyPassword" --key-pass "pass:$plainKeyPassword" `
    --out $OutputApk $alignedApk
if ($LASTEXITCODE -ne 0) {
    throw "apksigner sign failed with exit code $LASTEXITCODE."
}

$signatureOutput = & $java -jar $apksignerJar verify --verbose $OutputApk 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "apksigner verify failed with exit code $LASTEXITCODE."
}

$alignmentOutput = & $zipalign -c -p 4 $OutputApk 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "zipalign verification failed with exit code $LASTEXITCODE."
}

$manifest = [ordered]@{
    sourceApk = (Resolve-Path -LiteralPath $SourceApk).Path
    sourceSha256 = $sourceHash
    outputApk = (Resolve-Path -LiteralPath $OutputApk).Path
    outputSha256 = Get-FileSha256 $OutputApk
    patchManifest = (Resolve-Path -LiteralPath $PatchManifest).Path
    changes = $changes
    alignment = [ordered]@{
        command = "zipalign -c -p 4"
        exitCode = 0
        output = @($alignmentOutput)
    }
    signature = [ordered]@{
        command = "apksigner verify --verbose"
        exitCode = 0
        output = @($signatureOutput)
    }
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
}

$manifestPath = "$OutputApk.manifest.json"
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Remove-Item -LiteralPath $stagingApk -Force
Remove-Item -LiteralPath $alignedApk -Force
Write-Host "Built and verified APK: $OutputApk"
