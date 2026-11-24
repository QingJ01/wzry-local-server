param(
    [Parameter(Mandatory = $true)]
    [string]$SourceApk,

    [Parameter(Mandatory = $true)]
    [string]$OutputApk,

    [Parameter(Mandatory = $true)]
    [string]$SourcePackage,

    [Parameter(Mandatory = $true)]
    [string]$TargetPackage,

    [string]$ToolsRoot = 'D:\project\poxxiao\tools',

    [string]$KeyStore = "$PSScriptRoot\..\client\keys\wzry-debug.keystore",

    [string]$KeyAlias = 'wzry-debug',

    [securestring]$KeyPassword,

    [switch]$WhatIf,

    [switch]$ReplaceAllOccurrences,

    [int[]]$EditIndexes
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
        $property = [System.IO.Compression.ZipArchiveEntry].GetProperty(
            'CompressionMethod',
            [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic
        )
        $property.SetValue($entry, [Enum]::Parse($property.PropertyType, 'Stored'), $null)
    }
    $stream = $entry.Open()
    try {
        $stream.Write($Bytes, 0, $Bytes.Length)
    }
    finally {
        $stream.Dispose()
    }
}

function Write-EntryStream {
    param(
        [System.IO.Compression.ZipArchive]$Archive,
        [System.IO.Compression.ZipArchiveEntry]$SourceEntry
    )
    $entry = $Archive.CreateEntry($SourceEntry.FullName, (Get-EntryCompressionLevel $SourceEntry.FullName))
    if (Get-EntryStorePolicy $SourceEntry.FullName) {
        $property = [System.IO.Compression.ZipArchiveEntry].GetProperty(
            'CompressionMethod',
            [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic
        )
        $property.SetValue($entry, [Enum]::Parse($property.PropertyType, 'Stored'), $null)
    }
    $source = $SourceEntry.Open()
    $target = $entry.Open()
    try {
        $source.CopyTo($target)
    }
    finally {
        $target.Dispose()
        $source.Dispose()
    }
}

function Copy-ZipEntryRaw {
    param(
        [byte[]]$SourceBytes,
        [uint32]$LocalOffset,
        [hashtable]$Entry
    )

    $nameBytes = [System.Text.Encoding]::UTF8.GetBytes($Entry.Name)
    $extraBytes = New-Object byte[] $Entry.ExtraLength
    [Array]::Copy($SourceBytes, $Entry.LocalHeaderOffset + 30 + $Entry.NameLength, $extraBytes, 0, $Entry.ExtraLength)
    $commentBytes = [System.Text.Encoding]::UTF8.GetBytes('')

    $central = [System.IO.MemoryStream]::new()
    $writer = [System.IO.BinaryWriter]::new($central)
    $writer.Write([uint32]0x02014b50)
    $writer.Write([uint16]20)
    $writer.Write([uint16]20)
    $writer.Write([uint16]$Entry.Flags)
    $writer.Write([uint16]$Entry.Method)
    $writer.Write([uint16]$Entry.ModTime)
    $writer.Write([uint16]$Entry.ModDate)
    $writer.Write([uint32]$Entry.Crc32)
    $writer.Write([uint32]$Entry.CompressedSize)
    $writer.Write([uint32]$Entry.UncompressedSize)
    $writer.Write([uint16]$nameBytes.Length)
    $writer.Write([uint16]$extraBytes.Length)
    $writer.Write([uint16]$commentBytes.Length)
    $writer.Write([uint16]0)
    $writer.Write([uint16]0)
    $writer.Write([uint32]$Entry.ExternalAttributes)
    $writer.Write([uint32]$LocalOffset)
    $writer.Write($nameBytes)
    $writer.Write($extraBytes)
    $writer.Write($commentBytes)
    $writer.Flush()

    $local = [System.IO.MemoryStream]::new()
    $localWriter = [System.IO.BinaryWriter]::new($local)
    $localWriter.Write([uint32]0x04034b50)
    $localWriter.Write([uint16]20)
    $localWriter.Write([uint16]$Entry.Flags)
    $localWriter.Write([uint16]$Entry.Method)
    $localWriter.Write([uint16]$Entry.ModTime)
    $localWriter.Write([uint16]$Entry.ModDate)
    $localWriter.Write([uint32]$Entry.Crc32)
    $localWriter.Write([uint32]$Entry.CompressedSize)
    $localWriter.Write([uint32]$Entry.UncompressedSize)
    $localWriter.Write([uint16]$nameBytes.Length)
    $localWriter.Write([uint16]$extraBytes.Length)
    $localWriter.Write($nameBytes)
    $localWriter.Write($extraBytes)
    $localWriter.Flush()

    return [pscustomobject]@{
        LocalHeader = $local.ToArray()
        CompressedData = $Entry.CompressedData
        CentralDirectory = $central.ToArray()
    }
}

function Get-ZipEntries {
    param([byte[]]$Bytes)

    $eocd = -1
    for ($offset = $Bytes.Length - 22; $offset -ge 0; $offset--) {
        if ([System.BitConverter]::ToUInt32($Bytes, $offset) -eq 0x06054b50) {
            $eocd = $offset
            break
        }
    }
    if ($eocd -lt 0) {
        throw 'Invalid ZIP file: end of central directory not found.'
    }

    $entryCount = [System.BitConverter]::ToUInt16($Bytes, $eocd + 10)
    $centralOffset = [System.BitConverter]::ToUInt32($Bytes, $eocd + 16)
    $position = $centralOffset
    $entries = @()

    for ($index = 0; $index -lt $entryCount; $index++) {
        if ([System.BitConverter]::ToUInt32($Bytes, $position) -ne 0x02014b50) {
            throw "Invalid ZIP central directory at offset $position."
        }
        $nameLength = [System.BitConverter]::ToUInt16($Bytes, $position + 28)
        $extraLength = [System.BitConverter]::ToUInt16($Bytes, $position + 30)
        $commentLength = [System.BitConverter]::ToUInt16($Bytes, $position + 32)
        $name = [System.Text.Encoding]::UTF8.GetString($Bytes, $position + 46, $nameLength)
        $localHeaderOffset = [System.BitConverter]::ToUInt32($Bytes, $position + 42)

        if ([System.BitConverter]::ToUInt32($Bytes, $localHeaderOffset) -ne 0x04034b50) {
            throw "Invalid ZIP local header for entry $name."
        }
        $localNameLength = [System.BitConverter]::ToUInt16($Bytes, $localHeaderOffset + 26)
        $localExtraLength = [System.BitConverter]::ToUInt16($Bytes, $localHeaderOffset + 28)
        $dataOffset = $localHeaderOffset + 30 + $localNameLength + $localExtraLength
        $compressedSize = [System.BitConverter]::ToUInt32($Bytes, $position + 20)
        $uncompressedSize = [System.BitConverter]::ToUInt32($Bytes, $position + 24)
        $compressedData = New-Object byte[] $compressedSize
        [Array]::Copy($Bytes, $dataOffset, $compressedData, 0, $compressedSize)

        $entries += [ordered]@{
            Name = $name
            Flags = [System.BitConverter]::ToUInt16($Bytes, $position + 8)
            Method = [System.BitConverter]::ToUInt16($Bytes, $position + 10)
            ModTime = [System.BitConverter]::ToUInt16($Bytes, $position + 12)
            ModDate = [System.BitConverter]::ToUInt16($Bytes, $position + 14)
            Crc32 = [System.BitConverter]::ToUInt32($Bytes, $position + 16)
            CompressedSize = $compressedSize
            UncompressedSize = $uncompressedSize
            NameLength = $localNameLength
            ExtraLength = $localExtraLength
            ExternalAttributes = [System.BitConverter]::ToUInt32($Bytes, $position + 38)
            LocalHeaderOffset = $localHeaderOffset
            CompressedData = $compressedData
        }

        $position += 46 + $nameLength + $extraLength + $commentLength
    }

    return $entries
}

function Get-Crc32 {
    param([byte[]]$Bytes)

    $table = New-Object 'System.UInt32[]' 256
    for ($index = 0; $index -lt 256; $index++) {
        $value = [uint32]$index
        for ($bit = 0; $bit -lt 8; $bit++) {
            if (($value -band 1) -ne 0) {
                $value = 0xEDB88320 -bxor ($value -shr 1)
            }
            else {
                $value = $value -shr 1
            }
        }
        $table[$index] = $value
    }

    $crc = 0xFFFFFFFF
    foreach ($byte in $Bytes) {
        $crc = $table[($crc -bxor $byte) -band 0xFF] -bxor ($crc -shr 8)
    }
    return ($crc -bxor 0xFFFFFFFF)
}

function Find-AxmlPackageString {
    param(
        [byte[]]$Bytes,
        [string]$PackageName
    )

    if ($Bytes.Length -lt 12 -or [System.BitConverter]::ToUInt32($Bytes, 0) -ne 0x00080003) {
        throw 'AndroidManifest.xml is not a binary AXML document.'
    }

    $position = 8
    while ($position -lt $Bytes.Length) {
        $type = [System.BitConverter]::ToUInt16($Bytes, $position)
        $headerSize = [System.BitConverter]::ToUInt16($Bytes, $position + 2)
        $chunkSize = [System.BitConverter]::ToUInt32($Bytes, $position + 4)
        if ($chunkSize -lt 8 -or $position + $chunkSize -gt $Bytes.Length) {
            throw "Invalid AXML chunk at offset $position."
        }

        if ($type -eq 0x0001 -and $headerSize -ge 28) {
            $stringCount = [System.BitConverter]::ToUInt32($Bytes, $position + 8)
            $flags = [System.BitConverter]::ToUInt32($Bytes, $position + 16)
            $stringsStart = [System.BitConverter]::ToUInt32($Bytes, $position + 20)
            $isUtf8 = ($flags -band 0x00000100) -ne 0
            $matches = @()

            for ($index = 0; $index -lt $stringCount; $index++) {
                $relative = [System.BitConverter]::ToUInt32($Bytes, $position + 28 + ($index * 4))
                $stringOffset = $position + $stringsStart + $relative
                if ($isUtf8) {
                    continue
                }

                $length = [System.BitConverter]::ToUInt16($Bytes, $stringOffset)
                $textOffset = $stringOffset + 2
                $text = [System.Text.Encoding]::Unicode.GetString($Bytes, $textOffset, $length * 2)
                $matches += [ordered]@{
                    index = $index
                    stringOffset = $stringOffset
                    textOffset = $textOffset
                    length = $length
                    text = $text
                }
            }
            return $matches
        }

        $position += $chunkSize
    }

    return @()
}

if (-not (Test-Path -LiteralPath $SourceApk -PathType Leaf)) {
    throw "Source APK not found: $SourceApk"
}
if ($SourcePackage -cne $TargetPackage -and $SourcePackage.Length -ne $TargetPackage.Length) {
    throw "Source and target package names must have equal character length."
}
if ($SourcePackage -eq $TargetPackage) {
    throw 'Source and target package names must differ.'
}
if ($TargetPackage -notmatch '^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$') {
    throw "Target package is not a valid Java package name: $TargetPackage"
}

$outputDirectory = Split-Path -Parent $OutputApk
if ($outputDirectory) {
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
}
if (Test-Path -LiteralPath $OutputApk) {
    throw "Output APK already exists: $OutputApk. Remove it or choose a new timestamped path."
}

$sourceHash = Get-FileSha256 $SourceApk
$sourceBytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $SourceApk).Path)
$zipEntries = Get-ZipEntries $sourceBytes
$manifestEntry = $zipEntries | Where-Object { $_.Name -eq 'AndroidManifest.xml' } | Select-Object -First 1
if (-not $manifestEntry) {
    throw 'AndroidManifest.xml was not found in source APK.'
}

$manifestBytes = if ($manifestEntry.Method -eq 0) {
    $manifestEntry.CompressedData
}
elseif ($manifestEntry.Method -eq 8) {
    $compressedStream = [System.IO.MemoryStream]::new($manifestEntry.CompressedData)
    $deflate = [System.IO.Compression.DeflateStream]::new($compressedStream, [System.IO.Compression.CompressionMode]::Decompress)
    $output = [System.IO.MemoryStream]::new()
    try {
        $deflate.CopyTo($output)
        $output.ToArray()
    }
    finally {
        $deflate.Dispose()
        $compressedStream.Dispose()
        $output.Dispose()
    }
}
else {
    throw "Unsupported AndroidManifest.xml compression method $($manifestEntry.Method)."
}
$originalManifestHash = Get-BytesSha256 $manifestBytes
$matches = Find-AxmlPackageString -Bytes $manifestBytes -PackageName $SourcePackage

$editPoints = @()
if ($null -ne $EditIndexes -and $EditIndexes.Count -gt 0) {
    $sourceUtf16 = [System.Text.Encoding]::Unicode.GetBytes($SourcePackage)
    $targetUtf16 = [System.Text.Encoding]::Unicode.GetBytes($TargetPackage)
    foreach ($wantIdx in $EditIndexes) {
        $m = $matches | Where-Object { $_.index -eq $wantIdx } | Select-Object -First 1
        if (-not $m) { throw "String index $wantIdx not found in AXML string pool." }
        if ($m.text -notlike "*$SourcePackage*") { throw "String index $wantIdx does not contain '$SourcePackage': '$($m.text)'" }
        $charOffset = 0
        while ($true) {
            $hit = $m.text.IndexOf($SourcePackage, $charOffset, [System.StringComparison]::Ordinal)
            if ($hit -lt 0) { break }
            $byteOffset = $m.textOffset + ($hit * 2)
            for ($k = 0; $k -lt $targetUtf16.Length; $k++) {
                $manifestBytes[$byteOffset + $k] = $targetUtf16[$k]
            }
            $editPoints += [ordered]@{
                stringIndex = $m.index
                text = $m.text
                byteOffset = $byteOffset
                charOffset = $hit
            }
            $charOffset = $hit + $SourcePackage.Length
        }
    }
}
elseif ($ReplaceAllOccurrences) {
    $sourceUtf16 = [System.Text.Encoding]::Unicode.GetBytes($SourcePackage)
    $targetUtf16 = [System.Text.Encoding]::Unicode.GetBytes($TargetPackage)
    foreach ($m in $matches) {
        if ($m.text -notlike "*$SourcePackage*") { continue }
        $charOffset = 0
        while ($true) {
            $hit = $m.text.IndexOf($SourcePackage, $charOffset, [System.StringComparison]::Ordinal)
            if ($hit -lt 0) { break }
            $byteOffset = $m.textOffset + ($hit * 2)
            for ($k = 0; $k -lt $targetUtf16.Length; $k++) {
                $manifestBytes[$byteOffset + $k] = $targetUtf16[$k]
            }
            $editPoints += [ordered]@{
                stringIndex = $m.index
                text = $m.text
                byteOffset = $byteOffset
                charOffset = $hit
            }
            $charOffset = $hit + $SourcePackage.Length
        }
    }
    if ($editPoints.Count -eq 0) {
        throw "No occurrences of '$SourcePackage' found in AXML string pool."
    }
}
else {
    $packageString = $matches | Where-Object { $_.index -eq 231 -and $_.text -eq $SourcePackage } | Select-Object -First 1
    if (-not $packageString) {
        throw "Expected AXML string index 231 to contain root package '$SourcePackage'."
    }
    $targetBytes = [System.Text.Encoding]::Unicode.GetBytes($TargetPackage)
    for ($index = 0; $index -lt $targetBytes.Length; $index++) {
        $manifestBytes[$packageString.textOffset + $index] = $targetBytes[$index]
    }
    $editPoints += [ordered]@{
        stringIndex = $packageString.index
        text = $packageString.text
        byteOffset = $packageString.textOffset
        charOffset = 0
    }
}
$patchedManifestHash = Get-BytesSha256 $manifestBytes

if ($WhatIf) {
    Write-Host "Validated AXML package rename '$SourcePackage' -> '$TargetPackage'. Edits: $($editPoints.Count)"
    $editPoints | ForEach-Object { Write-Host "  idx=$($_.stringIndex) off=$($_.byteOffset) charOff=$($_.charOffset) '$($_.text)'" }
    return
}

$stagingApk = "$OutputApk.staging"
$fileBytes = [System.IO.MemoryStream]::new()
$centralRecords = [System.Collections.Generic.List[byte[]]]::new()

foreach ($entry in $zipEntries) {
    if ($entry.Name -like 'META-INF/*' -and (
        $entry.Name.EndsWith('.SF') -or
        $entry.Name.EndsWith('.RSA') -or
        $entry.Name.EndsWith('.DSA') -or
        $entry.Name -eq 'META-INF/MANIFEST.MF')) {
        continue
    }

    if ($entry.Name -eq 'AndroidManifest.xml') {
        $nameBytes = [System.Text.Encoding]::UTF8.GetBytes($entry.Name)
        $extraBytes = New-Object byte[] $entry.ExtraLength
        [Array]::Copy($sourceBytes, $entry.LocalHeaderOffset + 30 + $entry.NameLength, $extraBytes, 0, $entry.ExtraLength)
        $crcBytes = Get-Crc32 $manifestBytes

        $compressedStream = [System.IO.MemoryStream]::new()
        $deflate = [System.IO.Compression.DeflateStream]::new($compressedStream, [System.IO.Compression.CompressionLevel]::Optimal, $true)
        try {
            $deflate.Write($manifestBytes, 0, $manifestBytes.Length)
        }
        finally {
            $deflate.Dispose()
        }
        $compressedManifest = $compressedStream.ToArray()
        $compressedStream.Dispose()

        $localOffset = [uint32]$fileBytes.Position
        $writer = [System.IO.BinaryWriter]::new($fileBytes)
        $writer.Write([uint32]0x04034b50)
        $writer.Write([uint16]20)
        $writer.Write([uint16]0)
        $writer.Write([uint16]8)
        $writer.Write([uint16]$entry.ModTime)
        $writer.Write([uint16]$entry.ModDate)
        $writer.Write([uint32]$crcBytes)
        $writer.Write([uint32]$compressedManifest.Length)
        $writer.Write([uint32]$manifestBytes.Length)
        $writer.Write([uint16]$nameBytes.Length)
        $writer.Write([uint16]$extraBytes.Length)
        $writer.Write($nameBytes)
        $writer.Write($extraBytes)
        $writer.Write($compressedManifest, 0, $compressedManifest.Length)

        $central = [System.IO.MemoryStream]::new()
        $centralWriter = [System.IO.BinaryWriter]::new($central)
        $centralWriter.Write([uint32]0x02014b50)
        $centralWriter.Write([uint16]20)
        $centralWriter.Write([uint16]20)
        $centralWriter.Write([uint16]0)
        $centralWriter.Write([uint16]8)
        $centralWriter.Write([uint16]$entry.ModTime)
        $centralWriter.Write([uint16]$entry.ModDate)
        $centralWriter.Write([uint32]$crcBytes)
        $centralWriter.Write([uint32]$compressedManifest.Length)
        $centralWriter.Write([uint32]$manifestBytes.Length)
        $centralWriter.Write([uint16]$nameBytes.Length)
        $centralWriter.Write([uint16]$extraBytes.Length)
        $centralWriter.Write([uint16]0)
        $centralWriter.Write([uint16]0)
        $centralWriter.Write([uint16]0)
        $centralWriter.Write([uint32]$entry.ExternalAttributes)
        $centralWriter.Write([uint32]$localOffset)
        $centralWriter.Write($nameBytes)
        $centralWriter.Write($extraBytes)
        $centralWriter.Flush()
        $centralRecords.Add($central.ToArray())
        continue
    }

    $nameBytes = [System.Text.Encoding]::UTF8.GetBytes($entry.Name)
    $extraBytes = New-Object byte[] $entry.ExtraLength
    [Array]::Copy($sourceBytes, $entry.LocalHeaderOffset + 30 + $entry.NameLength, $extraBytes, 0, $entry.ExtraLength)
    $localOffset = [uint32]$fileBytes.Position

    $writer = [System.IO.BinaryWriter]::new($fileBytes)
    $writer.Write([uint32]0x04034b50)
    $writer.Write([uint16]20)
    $writer.Write([uint16]$entry.Flags)
    $writer.Write([uint16]$entry.Method)
    $writer.Write([uint16]$entry.ModTime)
    $writer.Write([uint16]$entry.ModDate)
    $writer.Write([uint32]$entry.Crc32)
    $writer.Write([uint32]$entry.CompressedSize)
    $writer.Write([uint32]$entry.UncompressedSize)
    $writer.Write([uint16]$nameBytes.Length)
    $writer.Write([uint16]$extraBytes.Length)
    $writer.Write($nameBytes)
    $writer.Write($extraBytes)
    $writer.Write($entry.CompressedData, 0, $entry.CompressedData.Length)

    $central = [System.IO.MemoryStream]::new()
    $centralWriter = [System.IO.BinaryWriter]::new($central)
    $centralWriter.Write([uint32]0x02014b50)
    $centralWriter.Write([uint16]20)
    $centralWriter.Write([uint16]20)
    $centralWriter.Write([uint16]$entry.Flags)
    $centralWriter.Write([uint16]$entry.Method)
    $centralWriter.Write([uint16]$entry.ModTime)
    $centralWriter.Write([uint16]$entry.ModDate)
    $centralWriter.Write([uint32]$entry.Crc32)
    $centralWriter.Write([uint32]$entry.CompressedSize)
    $centralWriter.Write([uint32]$entry.UncompressedSize)
    $centralWriter.Write([uint16]$nameBytes.Length)
    $centralWriter.Write([uint16]$extraBytes.Length)
    $centralWriter.Write([uint16]0)
    $centralWriter.Write([uint16]0)
    $centralWriter.Write([uint16]0)
    $centralWriter.Write([uint32]$entry.ExternalAttributes)
    $centralWriter.Write([uint32]$localOffset)
    $centralWriter.Write($nameBytes)
    $centralWriter.Write($extraBytes)
    $centralWriter.Flush()
    $centralRecords.Add($central.ToArray())
}

$centralStart = [uint32]$fileBytes.Position
foreach ($record in $centralRecords) {
    $fileBytes.Write($record, 0, $record.Length)
}
$centralSize = [uint32]$fileBytes.Position - $centralStart
$writer = [System.IO.BinaryWriter]::new($fileBytes)
$writer.Write([uint32]0x06054b50)
$writer.Write([uint16]0)
$writer.Write([uint16]0)
$writer.Write([uint16]$centralRecords.Count)
$writer.Write([uint16]$centralRecords.Count)
$writer.Write([uint32]$centralSize)
$writer.Write([uint32]$centralStart)
$writer.Write([uint16]0)
$writer.Flush()
[System.IO.File]::WriteAllBytes($stagingApk, $fileBytes.ToArray())

$buildTools = Join-Path $ToolsRoot 'android-sdk\build-tools\36.1.0'
$zipalign = Join-Path $buildTools 'zipalign.exe'
$apksignerJar = Join-Path $buildTools 'lib\apksigner.jar'
$java = Join-Path $ToolsRoot 'java17\bin\java.exe'
$keytool = Join-Path $ToolsRoot 'java17\bin\keytool.exe'
foreach ($required in @(
    @{ Path = $zipalign; Name = 'ZipAlign' },
    @{ Path = $apksignerJar; Name = 'APKSigner' },
    @{ Path = $java; Name = 'Java' },
    @{ Path = $keytool; Name = 'Keytool' })) {
    if (-not (Test-Path -LiteralPath $required.Path -PathType Leaf)) {
        throw "Required $($required.Name) was not found: $($required.Path)"
    }
}

$plainKeyPassword = if ($KeyPassword) {
    [System.Net.NetworkCredential]::new([string]$KeyPassword, '').Password
}
else {
    'wzry-local-debug'
}
if (-not (Test-Path -LiteralPath $KeyStore -PathType Leaf)) {
    $keyStoreDirectory = Split-Path -Parent $KeyStore
    New-Item -ItemType Directory -Force -Path $keyStoreDirectory | Out-Null
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

$manifest = [ordered]@{
    sourceApk = (Resolve-Path -LiteralPath $SourceApk).Path
    sourceSha256 = $sourceHash
    outputApk = (Resolve-Path -LiteralPath $OutputApk).Path
    outputSha256 = Get-FileSha256 $OutputApk
    sourcePackage = $SourcePackage
    targetPackage = $TargetPackage
    replaceAll = [bool]$ReplaceAllOccurrences
    editCount = $editPoints.Count
    editPoints = $editPoints
    originalManifestSha256 = $originalManifestHash
    patchedManifestSha256 = $patchedManifestHash
    alignment = [ordered]@{
        command = 'zipalign -c -p 4'
        exitCode = 0
        output = @($alignmentOutput)
    }
    signature = [ordered]@{
        command = 'apksigner verify --verbose --min-sdk-version 24'
        exitCode = 0
        output = @($signatureOutput)
    }
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
}
($manifest | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath "$OutputApk.manifest.json" -Encoding UTF8

Remove-Item -LiteralPath $stagingApk -Force
Remove-Item -LiteralPath $alignedApk -Force
Write-Host "Built and verified package-renamed APK: $OutputApk"
