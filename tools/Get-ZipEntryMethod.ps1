param(
    [Parameter(Mandatory = $true)]
    [string]$ZipPath,

    [Parameter(Mandatory = $true)]
    [string]$EntryPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $ZipPath))
for ($offset = 0; $offset -le $bytes.Length - 60; $offset++) {
    if ($bytes[$offset] -ne 0x50 -or $bytes[$offset + 1] -ne 0x4b -or
        $bytes[$offset + 2] -ne 0x03 -or $bytes[$offset + 3] -ne 0x04) {
        continue
    }

    $nameLength = [System.BitConverter]::ToUInt16($bytes, $offset + 26)
    $entryName = [System.Text.Encoding]::UTF8.GetString($bytes, $offset + 30, $nameLength)
    if ($entryName -ne $EntryPath) {
        continue
    }

    [System.BitConverter]::ToUInt16($bytes, $offset + 8)
    return
}

throw "ZIP entry not found: $EntryPath"
