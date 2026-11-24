# Houdini Self-SIGKILL Hook Prototype

## Purpose

Intercepts the `kill/tgkill/tkill` host syscalls emitted by `libhoudini.so`
when the guest-ARM process tries to self-`SIGKILL`. Loaded into
`com.tencent.tmgp.sgame` via Zygisk/LSPosed `dlopen`.

## Evidence basis

`reports/houdini_selfkill_analysis_20261124.md`:
- Syscall trampoline entry `0x5001d0` = `mov rax,rdi; syscall; ret`
  (bytes `E9 6B 00 00 00` → `0x500240`).
- Decision fn `0x324e80` logs `houdini [SIGKILL] kill:` then issues the real
  host `syscall` through the same trampoline family.

## Architecture

- **Language**: Rust `#![no_std]` `cdylib`, `panic = "abort"`.
- **Target**: `x86_64-linux-android` (the host ISA; the game itself is ARM64
  running under Houdini translation).
- **Hook point**: `libhoudini.so` + `0x5001d0` — the shared syscall
  trampoline stub that all guest `svc` instructions funnel through.
- **Patch**: overwrite the first 5 bytes of `0x5001d0` with `jmp rel32`
  to our Rust `hook_syscall_stub`.
- **Filter**: only syscalls `kill(62)`, `tkill(200)`, `tgkill(234)` are
  inspected; only `pid==getpid()` + `signo==9` are suppressed (returns 0).
  All other syscalls pass through to the real `syscall` instruction.

## Build

```powershell
cd native_hook
cargo build --target x86_64-linux-android --release
```

Requires `rustup target add x86_64-linux-android` and the `sysroot/`
symlinked/pulled Android system libs (`libc.so`, `libdl.so`, `liblog.so`,
`libm.so`, `libunwind.so`).

Output: `target/x86_64-linux-android/release/libwzry_houdini_selfkill_hook.so`
(~27 KB, `ET_DYN x86_64`).

## Install (via Zygisk / LSPosed)

The `.so` must be loaded into the `sgame` process **before** `libhoudini.so`
begins translating guest code. Two options:

### Option A — Zygisk Next module (recommended)

1. Push the `.so` to the device:
   ```powershell
   adb -s 192.168.5.101:5555 push `
     target/x86_64-linux-android/release/libwzry_houdini_selfkill_hook.so `
     /data/local/tmp/
   ```

2. Create a minimal Zygisk Next module:
   ```
   /data/adb/modules/wzry_hook/
   ├── module.prop
   ├── zygisk/
   │   └── arm64-v8a.so   ← our x86_64 .so (Zygisk loads host ISA)
   └── sepolicy.rule    (optional, if needed)
   ```

   `module.prop`:
   ```
   id=wzry_hook
   name=WZRY Houdini Self-Kill Hook
   version=1.0
   versionCode=1
   author=local
   description=Suppress self-SIGKILL from Houdini syscall trampoline
   ```

3. Reboot or `magisk --denylist` / Zygisk reload so the module is picked up.

### Option B — LSPosed `dlopen` injection

If LSPosed is already active and has a `lib*` hooking API, call
`dlopen("/data/local/tmp/libwzry_houdini_selfkill_hook.so", RTLD_NOW)` inside
the `sgame` process context, then invoke `zygisk_module_entry()`.

## Verify

```powershell
# Check hook counters after game launch
adb -s 192.168.5.101:5555 shell "cat /data/local/tmp/wzry_hook_counters.bin | xxd"
# Expected: 8-byte LE [hooked=1][intercepted=N][passthru=M]
```

## Uninstall / Rollback

```powershell
# Remove the module directory and reboot
adb -s 192.168.5.101:5555 shell "rm -rf /data/adb/modules/wzry_hook"
# or just delete the pushed .so
adb -s 192.168.5.101:5555 shell "rm /data/local/tmp/libwzry_houdini_selfkill_hook.so"
adb -s 192.168.5.101:5555 reboot
```

## Safety / Rollback

- The hook does **not** modify `/system` or any APK file.
- It patches **only 5 bytes** of `libhoudini.so` in-memory at `0x5001d0`.
- If the module is removed and the device rebooted, the original
  `libhoudini.so` is fully restored.
- The hook is scoped to `com.tencent.tmgp.sgame` via `/proc/self/cmdline`
  check — other processes are unaffected.

## Known limitations

- Only the `0x5001d0` trampoline entry is patched. If `libhoudini.so` has
  other inline `syscall` emission sites not going through this stub, they
  are not covered.
- The `ORIG_BYTES` check (`E9 6B 00 00 00`) is a guard against wrong base
  address or a different `libhoudini.so` build. If the check fails, the
  hook silently does nothing.
- Counters are written to `/data/local/tmp/wzry_hook_counters.bin` — requires
  the target process to have write access to that path (usually OK under
  Zygisk context).

## Next steps

1. Install via Zygisk module on `192.168.5.101:5555`.
2. Cold-launch `sgame`, poll `/data/local/tmp/wzry_hook_counters.bin` to
   confirm `hooked=1`.
3. Run >200 s survival test — assert no `houdini [SIGKILL]` in logcat and
   process stays `fg TOP`.
4. If stable, proceed to login/lobby/shop/battle Frida capture phases.
