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

    [securestring]$KeyPassword
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-FileSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
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

$patch = Get-Content -Raw -LiteralPath $PatchManifest | ConvertFrom-Json
$entries = @($patch.entries)
$changes = @()

$stagingApk = "$OutputApk.staging"
Copy-Item -LiteralPath $SourceApk -Destination $stagingApk

try {
    if ($entries.Count -gt 0) {
        $compressedArchive = [System.IO.Compression.ZipFile]::Open($stagingApk, 'Update')
        try {
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
                    $oldHash = Get-FileSha256 $entrySpec.sourcePath
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
        Add-Type -AssemblyName System.IO.Compression.FileSystem
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
