param(
    [Parameter(Mandatory = $true)]
    [string]$Apk
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Apk).Path)
try {
    $entry = $archive.GetEntry('AndroidManifest.xml')
    if (-not $entry) {
        throw 'AndroidManifest.xml was not found in APK.'
    }
    $stream = $entry.Open()
    try {
        $memory = [System.IO.MemoryStream]::new()
        $stream.CopyTo($memory)
        $manifestText = [System.Text.Encoding]::Unicode.GetString($memory.ToArray())
    }
    finally {
        $stream.Dispose()
    }
}
finally {
    $archive.Dispose()
}

$redirected = $manifestText.Contains('http://127.0.0.1:19620/gtrace/get_traceid_list?xxxxxxxx')
$original = $manifestText.Contains('https://cloudctrl.gcloud.qq.com/gtrace/get_traceid_list')
if (-not $redirected -or $original) {
    throw "Control-plane redirect verification failed. redirected=$redirected original=$original"
}

Write-Host 'Control-plane redirect verification passed.'
