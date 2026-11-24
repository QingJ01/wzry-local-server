# Runtime restore and stability investigation — 2026-11-24 (session 3)

## Scope

Device `192.168.5.102:5555` (NetEase MuMu emulator, x86_64, Houdini ARM translation, Android 15, Magisk-rooted, LSPosed/Zygisk present). Package `com.tencent.tmgp.sgame`, method0 APK `wzry-control-plane-store-method0.apk`. No login input, purchase, battle, or root-level system modification.

## Runtime restore (task 1)

- Rust server restarted at 19:49:17 on `127.0.0.1:19620` (HTTP) and `127.0.0.1:19621` (frame). `/health` returns all-ok.
- ADB reverse verified: `tcp:19620→19620`, `tcp:19621→19621`, `tcp:19622→19620` on device.
- `POST /accounts/register {"username":"debug","password":"debug123"}` → `accountId=1`, `balance=1000`.
- `POST /local/session {"accountId":1}` → `localToken=local-1-2`, binds the loopback default session.

### The `/game/events` 401 root cause and fix

- Extended the HTTP observation to append ` auth=bearer` when a request carries `Authorization: Bearer` (server/src/main.rs). Live evidence then showed every client poll as `GET /game/events?after=0&epoch=1 ... auth=bearer` — the patched APK injects a static bearer credential that the service did not recognize, so `game_session_account_id` returned `Unauthorized` (401) even though a default loopback session was bound.
- Fix (server/src/domain.rs): when `allow_loopback_game_sessions` is enabled and a provided bearer token is not recognized, the service now falls back to `default_local_account_id` instead of hard-failing. A no-token request with no bound session still returns 401, and disabling loopback sessions still returns 401 for the same request.
- New regression test `local_game_session_authorizes_unknown_bearer_on_loopback` (server/tests/domain_http.rs) covers both the loopback-allowed 200 and the disabled 401.
- Verified live: after rebuild + restart + re-bind, client polls changed from `401` to `200` at 19:57:5x. This is the first real client→Rust `200` path (`{"epoch":1,"events":[],"messages":[],"resetRequired":false,"room":null}`).
- `cargo test`: 25 tests pass, 0 failures.

## Stability investigation (task 2)

### Device environment

- `ro.product.device=York`, `model=YOK-AN10`, `brand=HONOR` — a HONOR fingerprint spoofed over MuMu. `ro.product.cpu.abi=x86_64`, `abilist=x86_64,arm64-v8a,x86`; ARM64 executes through `/system/lib64/libhoudini.so` (version 7, NetEase-MuMu-licensed Intel Bridge).
- Root present: `wzry-frida-server-17.27.5` on loopback:27042, `lspd`, `zygisk_lsposed`, `zygisksu` daemons; `su` works.
- Magisk modules: `Yurikey` (keybox fetch + target list), `Violet` （紫罗兰， writes HMA config + hourly `tricky_store/target.txt` regeneration), `hma_oss_zygisk` (Hide My AppList), `zygisk_lsposed`, `zygisksu`, `Automatic_brick_rescue`.
- `/data/adb/tricky_store/target.txt` contains `com.tencent.tmgp.sgame` and `com.tencent.xfight`; Violet's hourly task regenerates it from `pm list packages -3`.

### The earlier "force-stop from pid 4076 / 20274" attribution

- The two `sh` daemons (PID 1923/1924) are Yurikey's `auto_fetch_loop.sh`, idle (`state=idle`, `interval_sec=0`) — they only tick a config file and never kill anything. `kill_all.sh`/`kill_google_process.sh` target Google and detector packages only, not `sgame`.
- No user-space killer is visible in a 90-tick `ps -A` capture spanning the 19:55–19:56 death window; only kernel workers appear around the kill tick.
- Remaining suspect for the *external* `am force-stop` seen at 19:50:36: `com.mumu.acc` (PID 2019) hosting `AccServiceManager`/`AccInterceptManager` — MuMu's accelerator service that receives `onAppLaunch`/`onAppClose` for `sgame` and can force-close apps it cannot accelerate. It logged `onAppClose` immediately after both deaths. This is an inference, not proven — the direct `from pid` numbers (4076, 20274) were transient processes already gone by the time of inspection.

### The dominant kill mode is self-SIGKILL, not force-stop

- Three runs now show `houdini [tid] [SIGKILL] kill: pid = <game>` with **no** `Force stopping` line:
  - 19:51:39 — PID 20314 killed ~21 s after cold start (~9 s after permission confirm).
  - 19:56:17 — PID 21187 killed 62 s after cold start while foreground `TOP`; focus fell back to `app.lawnchair`.
- SIGKILL is sent from inside the process (Houdini logs the sender tid as part of the game process). This is consistent with an in-app environment/integrity check (emulator, su, frida, or HMA detection) calling `kill(9)` or `abort`, not with an external `am`/`ActivityManager` force-stop.
- The earlier `tombstone_16`/`tombstone_17` "Houdini SIGSEGV in Shutdown thread" worry is resolved: both tombstones are **`uiautomator`** (cmdline `uiautomator`, uid 2000) crashing in `__cxa_finalize`/`exit` — a benign x86 uiautomator shutdown artifact, unrelated to the game or to Houdini translating the game.
- Implication: `am force-stop` mitigation (watchdogs, blockers) will not stabilize the client. The fix must be in the client patch (neutralize the self-check) or in the environment (remove the trigger: frida-server visibility, su presence, or MuMu's accelerator hook). The timing variance (~9 s, ~21 s, ~62 s post-confirm) suggests the check fires on a delayed worker, not at a fixed lifecycle point.

## Evidence files

- `workspace/observations/ui/runtime-stability-20261124.png` — post-death launcher screenshot.
- `workspace/observations/runtime-stability-20261124-logcat.txt` — 6000-line dump covering 19:50–19:57 (register/session, launch, two death windows, `auth=bearer` 200 polls).
- `workspace/observations/pslog-20261124.txt` — 90-tick `ps -A` capture spanning the 19:56 kill (copied from `/data/local/tmp/pslog.txt`).
- `/debug/observations` JSON — 435+ recorded polls; last 12+ are `status=200 ... auth=bearer`.

## Next steps

- Capture a full game-side logcat from launch to death filtered on the game PID to find the check's log lines before the SIGKILL (e.g., `tprotect`, `msdk`, `AntiCheat`, `terrible`, `env`, `emulator`, `houdini`, `root` tags).
- Diff `su`/`magisk` visibility: the game may check `su` in PATH, `magisk` props, `frida` port 27042, or `libhoudini` maps entries. Each is a separate patch/hide lever.
- Only after the process survives past the self-check window (target: >180 s foreground) should login/lobby progression resume; otherwise UI state never persists.
