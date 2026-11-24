param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$results = [ordered]@{}

function Assert-Contains {
    param(
        [string]$Path,
        [string]$Pattern,
        [string]$Name
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Missing file for ${Name}: $Path"
    }
    $text = Get-Content -Raw -LiteralPath $Path
    if ($text -notmatch $Pattern) {
        throw "$Name failed: expected pattern '$Pattern' in $Path"
    }
    $results[$Name] = 'PASS'
}

function Assert-NotContains {
    param(
        [string]$Path,
        [string]$Pattern,
        [string]$Name
    )
    $text = Get-Content -Raw -LiteralPath $Path
    if ($text -match $Pattern) {
        throw "$Name failed: forbidden pattern '$Pattern' in $Path"
    }
    $results[$Name] = 'PASS'
}

# 1. JNI export names must match the compiled Java package exactly.
$native = Join-Path $root 'src\lib.rs'
Assert-Contains $native 'Java_com_wzry_houdinihook_NativeInstall_install' 'jni-install-symbol'
Assert-Contains $native 'Java_com_wzry_houdinihook_NativeInstall_state' 'jni-state-symbol'
Assert-NotContains $native 'houdini_hook\.' 'no-underscore-package'

# 2. The runtime patch must be the proven 3-byte block, not the rejected
#    5-byte trampoline hook from the Zygisk prototype.
Assert-Contains $native 'PATCH_RVA: usize = 0x324eef' 'patch-rva'
Assert-Contains $native 'ORIG_BYTES: \[u8; 3\] = \[0xbf, 0xba, 0x00\]' 'orig-bytes'
Assert-Contains $native 'PATCH_BYTES: \[u8; 3\] = \[0xe9, 0xbf, 0x01\]' 'patch-bytes'
Assert-NotContains $native 'spawn_houdini_watcher|zygisk_module_entry' 'no-zygisk-entry'

# 3. Java entry must scope to sgame only and never silently run arbitrary
#    bytes from /data/local/tmp.
$hookEntry = Join-Path $root 'src\com\wzry\houdinihook\HookEntry.java'
Assert-Contains $hookEntry 'TARGET_PACKAGE = "com.tencent.tmgp.sgame"' 'scope-filter'
Assert-Contains $hookEntry 'System\.load\(soPath\)' 'system-load'
Assert-Contains $hookEntry 'UnsatisfiedLinkError' 'fail-closed'
Assert-NotContains $hookEntry 'System\.loadLibrary' 'absolute-load-only'

# 4. Manifest/module descriptors must declare LSPosed metadata and scope.
$manifest = Join-Path $root 'AndroidManifest.xml'
Assert-Contains $manifest 'xposedmodule' 'xposedmodule-meta'
Assert-Contains $manifest 'xposedscope' 'xposedscope-meta'
$scope = Join-Path $root 'res\values\xposed_scope.xml'
Assert-Contains $scope 'com.tencent.tmgp.sgame' 'scope-xml'
$init = Join-Path $root 'assets\xposed_init'
Assert-Contains $init 'com\.wzry\.houdinihook\.HookEntry' 'xposed-init'

# 5. Build script must keep de.robv stubs compile-time only, wipe classesDir,
#    and verify the final APK signature/alignment.
$build = Join-Path $root 'Build-LsposedHookApk.ps1'
Assert-Contains $build 'Get-ChildItem -Recurse -Path \$classesDir -ErrorAction SilentlyContinue \| Remove-Item' 'wipe-classes'
$buildText = Get-Content -Raw -LiteralPath $build
if (-not $buildText.Contains('jarTool cf $jar -C $classesDir com\wzry')) {
    throw "dex-scope failed: expected literal 'jarTool cf `$jar -C `$classesDir com\wzry' in $build"
}
$results['dex-scope'] = 'PASS'
Assert-Contains $build 'zipalign -c -p 4' 'zipalign-verify'
Assert-Contains $build 'verify --verbose \$OutputApk' 'apksigner-verify'

foreach ($key in $results.Keys) { Write-Host "[PASS] $key" }
Write-Host "All $($results.Count) lsposed hook static checks passed."
