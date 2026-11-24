param(
    [string]$OutputApk = "$PSScriptRoot\build\wzry-lsposed-hook.apk",
    [string]$ToolsRoot = 'D:\project\poxxiao\tools',
    [string]$AndroidJar = 'D:\Android\Sdk\platforms\android-35\android.jar',
    [string]$KeyStore = "$PSScriptRoot\..\client\keys\wzry-debug.keystore",
    [string]$KeyAlias = 'wzry-debug',
    [string]$KeyPassword = 'wzry-local-debug',
    [switch]$SkipNative,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Set-ZipEntryCompressionMethod {
    param(
        [System.IO.Compression.ZipArchiveEntry]$Entry,
        [string]$Method
    )

    # .NET exposes no public setter. The field backing the read is the
    # non-public `_storedCompressionMethod` (ushort): 0=Stored, 8=Deflate.
    $prop = [System.IO.Compression.ZipArchiveEntry].GetProperty(
        'CompressionMethod',
        [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic
    )
    if ($prop -and $prop.CanWrite) {
        $prop.SetValue($Entry, [Enum]::Parse($prop.PropertyType, $Method), $null)
        return
    }
    $field = [System.IO.Compression.ZipArchiveEntry].GetField(
        '_storedCompressionMethod',
        [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic
    )
    $value = [int16](if ($Method -eq 'Stored') { 0 } else { 8 })
    $field.SetValue($Entry, $value)
}

# d8.bat and apksigner need JAVA_HOME — point at the poxxiao java17 runtime.
if (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
    $env:JAVA_HOME = Join-Path $ToolsRoot 'java17'
}

# java17 is a JRE (no javac); jdk10 ships javac, D:\Android\jdk-17 also does.
# Prefer jdk10 for javac, java17 for keytool/apksigner runtime — either works.
$javacCandidates = @(
    (Join-Path $ToolsRoot 'jdk10\bin\javac.exe'),
    'D:\Android\jdk-17.0.19+10\bin\javac.exe',
    (Join-Path $ToolsRoot 'java17\bin\javac.exe')
)
$javac = $javacCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$javaHome = Join-Path $ToolsRoot 'java17'
$java = Join-Path $javaHome 'bin\java.exe'
$keytool = Join-Path $javaHome 'bin\keytool.exe'
$buildTools = Join-Path $ToolsRoot 'android-sdk\build-tools\36.1.0'
$d8 = Join-Path $buildTools 'd8.bat'
$aapt2 = Join-Path $buildTools 'aapt2.exe'
$zipalign = Join-Path $buildTools 'zipalign.exe'
$apksignerJar = Join-Path $buildTools 'lib\apksigner.jar'

foreach ($tool in @($javac, $java, $keytool, $d8, $aapt2, $zipalign, $apksignerJar, $AndroidJar)) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) {
        throw "Required tool not found: $tool"
    }
}

$out = Join-Path $PSScriptRoot 'build'
$classesDir = Join-Path $out 'classes'
$dexDir = Join-Path $out 'dex'
$compiledRes = Join-Path $out 'compiled-res'
New-Item -ItemType Directory -Force -Path $classesDir, $dexDir, $compiledRes | Out-Null

# 1) Native payload (Rust cdylib → lib/x86_64/libwzry_houdini_selfkill_hook.so)
$nativeSo = Join-Path $out 'native\libwzry_houdini_selfkill_hook.so'
if (-not $SkipNative) {
    $sysroot = Join-Path $PSScriptRoot 'sysroot'
    New-Item -ItemType Directory -Force -Path $sysroot | Out-Null
    foreach ($lib in 'libc.so','libdl.so','liblog.so','libm.so') {
        $src = Join-Path "$PSScriptRoot\..\native_hook\sysroot" $lib
        if (Test-Path -LiteralPath $src) {
            Copy-Item -LiteralPath $src -Destination (Join-Path $sysroot $lib) -Force
        }
    }
    Push-Location $PSScriptRoot
    try {
        cargo build --target x86_64-linux-android --release
        if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }
    }
    finally { Pop-Location }
    New-Item -ItemType Directory -Force -Path (Split-Path $nativeSo) | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'target\x86_64-linux-android\release\libwzry_houdini_selfkill_hook.so') -Destination $nativeSo -Force
}

# 2) javac — compile module sources; provided/ Xposed stubs go on the
#    classpath but are excluded from the packaged dex (LSPosed rejects
#    APKs that embed de.robv classes).
#    classesDir is wiped first so stale classes from earlier package names
#    (e.g. com.wzry.houdini_hook) cannot leak into the dex.
Get-ChildItem -Recurse -Path $classesDir -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
$javaSources = Get-ChildItem -Recurse -Filter *.java -Path (Join-Path $PSScriptRoot 'src') |
    Where-Object { $_.FullName -notmatch '\\lib\.rs$' } |
    ForEach-Object { $_.FullName }
$providedSources = Get-ChildItem -Recurse -Filter *.java -Path (Join-Path $PSScriptRoot 'provided') |
    ForEach-Object { $_.FullName }
& $javac -encoding UTF-8 -source 8 -target 8 -bootclasspath $AndroidJar -d $classesDir ($javaSources + $providedSources)
if ($LASTEXITCODE -ne 0) { throw "javac failed ($LASTEXITCODE)" }

# 3) d8 — package ONLY our com.wzry classes into a jar.
$jar = Join-Path $out 'classes.jar'
$jarTool = Join-Path $javaHome 'bin\jar.exe'
if (-not (Test-Path $jarTool)) { $jarTool = Join-Path (Split-Path $javac -Parent) 'jar.exe' }
& $jarTool cf $jar -C $classesDir com\wzry
if ($LASTEXITCODE -ne 0) { throw "jar failed ($LASTEXITCODE)" }
& $d8 --min-api 27 --output $dexDir $jar
if ($LASTEXITCODE -ne 0) { throw "d8 failed ($LASTEXITCODE)" }
$dex = Join-Path $dexDir 'classes.dex'
if (-not (Test-Path $dex)) { throw "classes.dex not produced" }

# 4) aapt2 — compile resources then link into a base APK.
$resZip = Join-Path $compiledRes 'res.zip'
& $aapt2 compile --dir (Join-Path $PSScriptRoot 'res') -o $resZip
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed ($LASTEXITCODE)" }

$baseApk = Join-Path $out 'base.apk'
& $aapt2 link -o $baseApk -I $AndroidJar `
    --manifest (Join-Path $PSScriptRoot 'AndroidManifest.xml') `
    --java $out $resZip
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed ($LASTEXITCODE)" }

# 5) Assemble final APK: base + classes.dex + assets/xposed_init + lib/*.so
$staging = Join-Path $out 'staging.apk'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path $staging) { Remove-Item $staging -Force }
Copy-Item -LiteralPath $baseApk -Destination $staging
$zip = [System.IO.Compression.ZipFile]::Open($staging, 'Update')
try {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $dex, 'classes.dex') | Out-Null
    # xposed_init lives in assets/ — LSPosed reads it as a module resource.
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $PSScriptRoot 'assets\xposed_init'), 'assets/xposed_init') | Out-Null
    if (Test-Path $nativeSo) {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $nativeSo, 'lib/x86_64/libwzry_houdini_selfkill_hook.so',
            [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
}
finally { $zip.Dispose() }

if ($WhatIf) { Write-Host "Validated tools and staged $staging (WhatIf)"; return }

# 6) zipalign + sign
if (Test-Path $OutputApk) { Remove-Item $OutputApk -Force }
$aligned = "$OutputApk.aligned"
# zipalign -f -p 4 aligns STORED .so to 4KB pages (extractNativeLibs=false
# needs the entry offset page-aligned for the runtime to mmap it).
& $zipalign -f -p 4 $staging $aligned
if ($LASTEXITCODE -ne 0) { throw "zipalign failed ($LASTEXITCODE)" }

# extractNativeLibs=true: the installer unpacks the .so to
# /data/app/*/lib/x86_64/ and loadLibrary resolves it there — no
# in-APK mmap requirement, so a deflated entry is fine.
& $zipalign -c -p 4 $aligned
if ($LASTEXITCODE -ne 0) { throw "zipalign verify failed ($LASTEXITCODE)" }

& $java -jar $apksignerJar sign --ks $KeyStore --ks-key-alias $KeyAlias `
    --ks-pass "pass:$KeyPassword" --key-pass "pass:$KeyPassword" `
    --out $OutputApk $aligned
if ($LASTEXITCODE -ne 0) { throw "apksigner sign failed ($LASTEXITCODE)" }
& $java -jar $apksignerJar verify --verbose $OutputApk
if ($LASTEXITCODE -ne 0) { throw "apksigner verify failed ($LASTEXITCODE)" }
Remove-Item $aligned -Force

[ordered]@{
    outputApk = (Resolve-Path $OutputApk).Path
    outputSha256 = (Get-FileHash $OutputApk -Algorithm SHA256).Hash
    nativeIncluded = (Test-Path $nativeSo)
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json | Set-Content "$OutputApk.manifest.json" -Encoding UTF8
Write-Host "Built LSPosed module: $OutputApk"
