param(
    [Parameter(Mandatory = $true)]
    [string]$ReferenceApk,

    [Parameter(Mandatory = $true)]
    [string]$CandidateApk,

    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-ApkLayout {
    param([string]$Path)

    $archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Path).Path)
    try {
        $entries = foreach ($entry in $archive.Entries) {
            [ordered]@{
                FullName = [string]$entry.FullName
                Length = [long]$entry.Length
                CompressedLength = [long]$entry.CompressedLength
                ContentSha256 = Get-EntrySha256 $entry
                LastWriteTime = $entry.LastWriteTime.UtcDateTime.ToString('o')
            }
        }
        [ordered]@{
            Path = (Resolve-Path -LiteralPath $Path).Path
            EntryCount = @($archive.Entries).Count
            Entries = @($entries)
        }
    }
    finally {
        $archive.Dispose()
    }
}

function Get-EntrySha256 {
    param([System.IO.Compression.ZipArchiveEntry]$Entry)

    $stream = $Entry.Open()
    try {
        $hash = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([System.BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '')
        }
        finally {
            $hash.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

$reference = Get-ApkLayout $ReferenceApk
$candidate = Get-ApkLayout $CandidateApk
$referenceMap = @{}
foreach ($entry in $reference.Entries) {
    $referenceMap[$entry.FullName] = $entry
}

$differences = foreach ($entry in $candidate.Entries) {
    $referenceEntry = $referenceMap[$entry.FullName]
    if (-not $referenceEntry) {
        [ordered]@{
            FullName = $entry.FullName
            Difference = 'added'
            ReferenceLength = $null
            CandidateLength = $entry.Length
            ReferenceCompressedLength = $null
            CandidateCompressedLength = $entry.CompressedLength
            ReferenceContentSha256 = $null
            CandidateContentSha256 = $entry.ContentSha256
        }
        continue
    }

    if ($referenceEntry.Length -ne $entry.Length -or
        $referenceEntry.CompressedLength -ne $entry.CompressedLength -or
        $referenceEntry.ContentSha256 -ne $entry.ContentSha256) {
        [ordered]@{
            FullName = $entry.FullName
            Difference = 'changed'
            ReferenceLength = $referenceEntry.Length
            CandidateLength = $entry.Length
            ReferenceCompressedLength = $referenceEntry.CompressedLength
            CandidateCompressedLength = $entry.CompressedLength
            ReferenceContentSha256 = $referenceEntry.ContentSha256
            CandidateContentSha256 = $entry.ContentSha256
        }
    }
}

$candidateMap = @{}
foreach ($entry in $candidate.Entries) {
    $candidateMap[$entry.FullName] = $entry
}
foreach ($entry in $reference.Entries) {
    if (-not $candidateMap.ContainsKey($entry.FullName)) {
        $differences += [ordered]@{
            FullName = $entry.FullName
            Difference = 'removed'
            ReferenceLength = $entry.Length
            CandidateLength = $null
            ReferenceCompressedLength = $entry.CompressedLength
            CandidateCompressedLength = $null
            ReferenceContentSha256 = $entry.ContentSha256
            CandidateContentSha256 = $null
        }
    }
}

$report = [ordered]@{
    Reference = $reference.Path
    Candidate = $candidate.Path
    ReferenceEntryCount = $reference.EntryCount
    CandidateEntryCount = $candidate.EntryCount
    Differences = @($differences)
}

$json = $report | ConvertTo-Json -Depth 8
if ($OutputPath) {
    $outputDirectory = Split-Path -Parent $OutputPath
    if ($outputDirectory) {
        New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
    }
    $json | Set-Content -LiteralPath $OutputPath -Encoding UTF8
}
$json
