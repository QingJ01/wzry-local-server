# LSPosed Houdini Self-SIGKILL Module

Injected into `com.tencent.tmgp.sgame` by LSPosed at `handleLoadPackage`
time — when `libhoudini.so` is already mapped by the native bridge —
and applies the 3-byte in-memory patch that suppresses the guest
self-`kill(pid, SIGKILL)` path.

## Evidence

`reports/houdini_hook_validation_20261124.md` — `libhoudini.so` `0x324eef`
(`mov edi, 0xba`, reached only for signo==9) → `jmp 0x3250b3`
(function tail returns 0). Non-9 signals unchanged.

## Build

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\lsposed_hook\Build-LsposedHookApk.ps1
```

Prereqs (auto-resolved): `D:\project\poxxiao\tools\java17`,
`D:\project\poxxiao\tools\android-sdk\build-tools\36.1.0`,
`D:\Android\Sdk\platforms\android-35\android.jar`, Rust
`x86_64-linux-android` target (reuses `native_hook/sysroot`).

Output: `lsposed_hook/build/wzry-lsposed-hook.apk` (signed with the
`wzry-debug` keystore shared with the client pipeline).

## Install / enable

```powershell
adb -s 192.168.5.101:5555 install -r .\lsposed_hook\build\wzry-lsposed-hook.apk
# Then EITHER enable in the LSPosed manager UI, OR insert the rows
# directly (works around a manager app that fails to enumerate the pkg):
#
#   sqlite3 /data/adb/lspd/config/modules_config.db <<'SQL'
#   INSERT OR REPLACE INTO modules       VALUES('com.wzry.houdinihook','<apk_path>');
#   INSERT OR REPLACE INTO modules_state VALUES('com.wzry.houdinihook',0,1,0);
#   INSERT OR REPLACE INTO scope         VALUES('com.wzry.houdinihook','com.tencent.tmgp.sgame',0);
#   SQL
#
# <apk_path> = output of `pm path com.wzry.houdinihook` minus 'package:'.
# Then REBOOT — lspd caches the module list at boot; a force-stop of the
# target alone does not pick up a newly installed module.
```

## Verify

```powershell
adb -s 192.168.5.101:5555 logcat -d | grep wzry_hook
# expect per process:
#   wzry_hook: handleLoadPackage for com.tencent.tmgp.sgame
#   wzry_hook: cmdline probe: <pre-initialized>...
#   wzry_hook: houdini selfkill patch applied @0x324eef
#   wzry_hook: install result=true state=1
# sgame must stay alive past ~60 s without a `houdini [SIGKILL]` line.
```

## Uninstall

```powershell
adb -s 192.168.5.101:5555 uninstall com.wzry.houdinihook
# or disable the module in LSPosed and reboot.
```

The patch is in-memory only — `/system` and the APK are untouched.

## Verified result (2026-11-24, .101 MuMu)

- `handleLoadPackage` fires in both `sgame` main process and
  `:xg_vip_service`; the payload loads via `System.load(...)` fallback
  `/data/local/tmp/libwzry_houdini_selfkill_hook.so`.
- `install result=true state=1` → 3-byte patch applied at
  `libhoudini.so+0x324eef`; process survives past 60 s with no
  `houdini [SIGKILL]` event.
- The earlier native `/proc/self/cmdline` package filter was removed:
  at hook time cmdline is still `<pre-initialized>` (zygote hasn't set
  the process name yet), so it always failed.
