param(
    [Parameter(Mandatory = $true)]
    [string]$SourceApk,

    [Parameter(Mandatory = $true)]
    [string]$PatchManifest,

    [Parameter(Mandatory = $true)]
    [string]$OutputApk,

    [string]$ExpectedSha256 = 'A016D941A3D7BA0A8FC976DAE6FE744EFEC85835A16DD10928B65A9C7E19EE5D',

    [string]$ToolsRoot = 'D:\project\poxxiao\tools',

    [string]$KeyStore = "$PSScriptRoot\..\client\keys\wzry-debug.keystore",

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

function Get-BytesSha256 {
    param([byte[]]$Bytes)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha256.ComputeHash($Bytes))).Replace('-', '')
    }
    finally {
        $sha256.Dispose()
    }
}

function Convert-HexToBytes {
    param([string]$Hex)
    $normalized = $Hex -replace '[\s-]', ''
    if ($normalized -notmatch '^[0-9A-Fa-f]*$') {
        throw "Hex string is invalid: $Hex"
    }
    if ($normalized.Length % 2 -ne 0) {
        throw "Hex string length must be even: $Hex"
    }
    $bytes = [byte[]]::new($normalized.Length / 2)
    for ($index = 0; $index -lt $bytes.Length; $index++) {
        $bytes[$index] = [Convert]::ToByte($normalized.Substring($index * 2, 2), 16)
    }
    return $bytes
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

function Read-EntryBytes {
    param([System.IO.Compression.ZipArchiveEntry]$Entry)
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

function Write-EntryBytes {
    param(
        [System.IO.Compression.ZipArchive]$Archive,
        [string]$EntryPath,
        [byte[]]$Bytes
    )
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

function Assert-CommandPath {
    param([string]$Path, [string]$Name)
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

$patch = Get-Content -Raw -LiteralPath $PatchManifest | ConvertFrom-Json
$patches = @()
if ($patch.PSObject.Properties['nativePatches']) {
    $patches = @($patch.nativePatches)
}
if ($patches.Count -eq 0) {
    throw 'Native patch manifest contains no nativePatches.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem

$plannedChanges = @()
$archive = [System.IO.Compression.ZipFile]::OpenRead($SourceApk)
try {
    foreach ($patchSpec in $patches) {
        foreach ($requiredProperty in @('entryPath', 'offset', 'originalBytesHex', 'replacementBytesHex', 'evidence')) {
            if (-not $patchSpec.PSObject.Properties[$requiredProperty] -or [string]::IsNullOrWhiteSpace($patchSpec.$requiredProperty)) {
                throw "Native patch requires $requiredProperty for entry path $($patchSpec.entryPath)."
            }
        }

        if ($patchSpec.entryPath -notlike 'lib/*') {
            throw "Native patches may only target lib/* entries: $($patchSpec.entryPath)"
        }
        $entry = $archive.GetEntry($patchSpec.entryPath)
        if (-not $entry) {
            throw "Native patch target entry not found: $($patchSpec.entryPath)"
        }

        $entryBytes = Read-EntryBytes $entry
        $offset = [int64]$patchSpec.offset
        $originalBytes = Convert-HexToBytes $patchSpec.originalBytesHex
        $replacementBytes = Convert-HexToBytes $patchSpec.replacementBytesHex
        if ($originalBytes.Length -ne $replacementBytes.Length) {
            throw "Native patch lengths must match for $($patchSpec.entryPath)."
        }
        if ($offset -lt 0 -or $offset + $originalBytes.Length -gt $entryBytes.Length) {
            throw "Native patch range is out of bounds for $($patchSpec.entryPath)."
        }

        for ($index = 0; $index -lt $originalBytes.Length; $index++) {
            if ($entryBytes[$offset + $index] -ne $originalBytes[$index]) {
                throw "Native patch original bytes mismatch at offset $($offset + $index) in $($patchSpec.entryPath)."
            }
        }

        $plannedChanges += [ordered]@{
            entryPath = $patchSpec.entryPath
            offset = $offset
            length = $originalBytes.Length
            evidence = $patchSpec.evidence
            originalEntrySha256 = Get-BytesSha256 $entryBytes
        }
    }
}
finally {
    $archive.Dispose()
}

if ($WhatIf) {
    Write-Host "Validated $($plannedChanges.Count) native patch(es). No APK was built."
    return
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

$stagingApk = "$OutputApk.staging"
$archive = [System.IO.Compression.ZipFile]::OpenRead($SourceApk)
try {
    $entryMap = [ordered]@{}
    foreach ($entry in $archive.Entries) {
        $entryMap[$entry.FullName] = Read-EntryBytes $entry
    }
}
finally {
    $archive.Dispose()
}

try {
    $patchedByEntry = @{}
    foreach ($patchSpec in $patches) {
        if ($patchedByEntry.ContainsKey($patchSpec.entryPath)) {
            $bytes = $patchedByEntry[$patchSpec.entryPath]
        }
        else {
            $bytes = [byte[]]$entryMap[$patchSpec.entryPath].Clone()
        }
        $offset = [int64]$patchSpec.offset
        $replacementBytes = Convert-HexToBytes $patchSpec.replacementBytesHex
        for ($index = 0; $index -lt $replacementBytes.Length; $index++) {
            $bytes[$offset + $index] = $replacementBytes[$index]
        }
        $patchedByEntry[$patchSpec.entryPath] = $bytes
    }

    $outputArchive = [System.IO.Compression.ZipFile]::Open($stagingApk, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($entryPath in $entryMap.Keys) {
            $bytes = $entryMap[$entryPath]
            if ($patchedByEntry.ContainsKey($entryPath)) {
                $bytes = $patchedByEntry[$entryPath]
            }
            Write-EntryBytes $outputArchive $entryPath $bytes
        }
    }
    finally {
        $outputArchive.Dispose()
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
$plainKeyPassword = if ($KeyPassword) {
    [System.Net.NetworkCredential]::new([string]$KeyPassword, '').Password
} else {
    'wzry-local-debug'
}
if (-not (Test-Path -LiteralPath $KeyStore -PathType Leaf)) {
    & $keytool -genkeypair -keystore $KeyStore -storetype PKCS12 -alias $KeyAlias `
        -keyalg RSA -keysize 2048 -validity 10000 `
        -storepass $plainKeyPassword -keypass $plainKeyPassword `
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
& $java -jar $apksignerJar sign --ks $KeyStore --ks-key-alias $KeyAlias `
    --ks-pass "pass:$plainKeyPassword" --key-pass "pass:$plainKeyPassword" `
    --min-sdk-version 24 --out $OutputApk $alignedApk
if ($LASTEXITCODE -ne 0) {
    throw "apksigner sign failed with exit code $LASTEXITCODE."
}
$signatureOutput = & $java -jar $apksignerJar verify --verbose --min-sdk-version 24 $OutputApk 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "apksigner verify failed with exit code $LASTEXITCODE."
}
$alignmentOutput = & $zipalign -c -p 4 $OutputApk 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "zipalign verification failed with exit code $LASTEXITCODE."
}

$changes = foreach ($patchSpec in $patches) {
    [ordered]@{
        entryPath = $patchSpec.entryPath
        offset = [int64]$patchSpec.offset
        length = (Convert-HexToBytes $patchSpec.originalBytesHex).Length
        evidence = $patchSpec.evidence
        originalEntrySha256 = Get-BytesSha256 $entryMap[$patchSpec.entryPath]
        patchedEntrySha256 = Get-BytesSha256 $patchedByEntry[$patchSpec.entryPath]
    }
}

$manifest = [ordered]@{
    sourceApk = (Resolve-Path -LiteralPath $SourceApk).Path
    sourceSha256 = $sourceHash
    outputApk = (Resolve-Path -LiteralPath $OutputApk).Path
    outputSha256 = Get-FileSha256 $OutputApk
    patchManifest = (Resolve-Path -LiteralPath $PatchManifest).Path
    changes = @($changes)
    alignment = [ordered]@{
        command = 'zipalign -c -p 4'
        exitCode = 0
        output = @($alignmentOutput)
    }
    signature = [ordered]@{
        command = 'apksigner verify --verbose'
        exitCode = 0
        output = @($signatureOutput)
    }
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
}
($manifest | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath "$OutputApk.manifest.json" -Encoding UTF8

Remove-Item -LiteralPath $stagingApk -Force
Remove-Item -LiteralPath $alignedApk -Force
Write-Host "Built and verified native patch APK: $OutputApk"
