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

---

# Kill-attribution audit — 2026-11-24 (session 4, read-only)

Device `192.168.5.102:5555`. All evidence gathered via `adb`/`su` reads and `logcat -d`/`dumpsys`; no persistent system config touched, no service disabled, no app force-stopped. Package `com.tencent.tmgp.sgame` was already dead when this audit started (last death 19:56:17), so the audit inspects the recorded death window, not a new run.

## Attribution result (final)

- The dominant and now **proven** kill is a self-inflicted `SIGKILL` inside the game process, delivered through Houdini. Decisive line: `19:56:17.686  houdini [21217] [SIGKILL] kill: pid = 21187, tid = 21217, signo = 9`. The sender `tid 21217` belongs to the game's own process (PID 21187). ~0.5 s later `19:56:18.210 AccServiceManager.onAppClose` and `AccInterceptManager.onAccInterceptConfirm hasAccSuccess = false` only record the death — they do not cause it.
- `AccServiceManager.onAppLaunch` fires *after* the app's own first logs (Houdini init at `15.272` vs `onAppLaunch` at `15.817`), and `onAccInterceptConfirm` logs `hasAccSuccess = false` — com.mumu.acc's accelerator intercept **observes** `sgame` but never accelerates it and never kills it.
- The earlier `Force stopping com.tencent.tmgp.sgame from pid 4076 / 20274` was a *different, rarer* path (external `am force-stop`). It is not the cause of the recurring ~20–60 s foreground deaths. PIDs 4076/20274 were transient and gone by inspection time; no persistent user-space killer for `sgame` exists on this device.
- The two `tombstone_16/17` shell `Shutdown thread` SIGSEGVs are UID-2000 `uiautomator`/`adb` x86 shutdown artifacts, unrelated.

## Per-component audit

- `com.mumu.acc` (PID 2019, priv-app, `versionName=1.0.75`, targetSdk 33): foreground `.AccService` + `AccMsgReceiver`/`AccInterceptReceiver` + `RomSdkVpnService`. Receives `onAppLaunch`/`onAppClose`. Logs `hasAccSuccess=false` → it is passive here. **Not a killer.** It can `force-stop` apps it actively accelerates, but it has not accelerated `sgame`, so it is not the source of `pid 4076/20274`-style force-stops either (those came from `am`, uid 2000/1000).
- `Yurikey` (`service.sh`, `Yuri/`): `auto_fetch_loop.sh` idle (`state=idle,interval_sec=0`, only ticks `/data/adb/Yurikey/auto_status.txt`); `kill_all.sh`/`kill_google_process.sh` target Google + detector packages only (`vending,gsf,gms,keyattestation,nativecheck,riskdetector,hunter,holmes…`), **not** `sgame`. `target_txt.sh` writes `tricky_store/target.txt` (contains `sgame`) so TrickyStore serves a spoofed keybox to it. No game kill.
- `Violet` (`service.sh`): on boot writes the HMA config once, then an hourly loop regenerates `tricky_store/target.txt` from `pm list packages -3/-s` (union, keeps manual entries). No runtime kill of `sgame`.
- `HMA` (`hma_oss_zygisk` + `/data/misc/hide_my_applist*/config.json`): scope entry for `sgame` is present with `useWhitelist=true` + `白名单` template — hiding is **configured**, but the whitelist app list itself also contains `sgame` (it hides *other* apps *from* sgame's queries). HMA does not hide the detection surface that fires the self-SIGKILL.
- `TrickyStore`: `target.txt` = `{meituan, sgame, xfight}` (user-app scan). Supplies attestation answers; no kill role.
- `LSPosed` (`zygisk_lsposed`, `lspd`, `zn-zygisk-companion64`): `XposedInit init_v4` is visible inside the game process logs — a module is injected. That injection is a *detection input*, not the kill mechanism.
- `Houdini` (`/system/lib64/libhoudini.so` v7 NetEase, `ro.dalvik.vm.native.bridge=libnb.so`): it is the *messenger* of the SIGKILL. `nativebridge RedirectTranslator` err at `15.243` + `Found libhoudini version 7` shows the game's arm64 code runs under Houdini from the first frame.

## Detection-surface evidence (why the game self-SIGKILLs)

Read-observed facts the app's integrity/emulator check can see:

- `ro.build.hv.platform = vbox` and `qemu.hw.mainkeys = 1` — explicit virtual-hardware fingerprints that are NOT covered by Yurikey's property resets (which only cover boot/verity/debug/su props).
- `ro.dalvik.vm.isa.arm64 = x86_64` and `ro.dalvik.vm.native.bridge = libnb.so` — declares arm64 is emulated; an arm64-targeted game sees it is running under translation.
- `/proc/<pid>/maps` for `sgame` will list `libhoudini.so`/`libnb.so` (loaded at `15.272`) — an in-process tell.
- `wzry-frida-server-17.27.5` PID 18358 listening `127.0.0.1:27042` — a live frida port is a high-confidence self-kill trigger. `ps -A` shows it plainly.
- `/system/bin/su` present (Magisk su) + `su -c id` works → root is real; `ro.debuggable`/`ro.secure` props are reset to `0`/`1` but `su` binary + working `su` are still discoverable.
- Timing matches a delayed background check, not launch gating: `19:51` run killed ~21 s after start (~9 s after permission confirm); `19:55:15` run killed at `19:56:17` = 62 s after start. The check runs on a worker thread (the `tid` that issues the kill is a worker, not the main thread).

## Conclusion — most-likely stability levers (ranked)

The self-SIGKILL is an in-app anti-emulator/anti-tamper verdict. To survive past ~180 s foreground:

1. **Kill the frida port first** (cheapest, highest-confidence): `taskkill`/`kill` `wzry-frida-server` before launching `sgame` (revert = restart it). Port 27042 + `frida` maps are the loudest single tell.
2. **Hide `su`** for `sgame` only: add `sgame` to Magisk/ZygiskSu denylist so `su` + `magisk` props vanish for that process (revert = remove denylist entry).
3. **Neutralize the check in the client** (most durable): hook the game's env-scan worker — `tools/frida/run-kill-trace.mjs` already exists to capture the `kill(9)`/`abort`/`exit` call site + backtrace, which pinpoints the exact check to patch.
4. **Emulator-property masking** (partial, lower confidence): `vbox`/`qemu.hw.mainkeys`/native-bridge props are not in Yurikey's reset list; masking them is fragile and incomplete.

## Rollback-safe experiment checklist (no persistent config change)

Each step is independently reversible; run in order, cold-start `sgame` after each and measure foreground lifetime (target > 180 s):

- [ ] E1 — Kill frida-server: `adb shell su -c "kill 18358"` → cold start → time-to-death. Revert: relaunch frida-server.
- [ ] E2 — Add `sgame` to denylist: `adb shell magisk --denylist add com.tencent.tmgp.sgame` → reboot or `am force-stop` + cold start. Revert: `magisk --denylist rm`.
- [ ] E3 — Capture the kill site: `node tools/frida/run-kill-trace.mjs <log> 120` while frida is still up → records the exact native call site issuing `kill(9)` for surgical patching.
- [ ] E4 — If still dying, try running `sgame` with native bridge off / arm-only vs forcing x86 path — isolates whether the check is Houdini-specific.
- [ ] E5 — (diagnostic only, not a fix) disable `com.mumu.acc` VPN/acceleration for a run to confirm zero effect on the self-SIGKILL.

## Evidence pointers

- `logcat` lines above (19:55:15–19:56:18 window): Houdini init → `AccServiceManager.onAppLaunch` → `houdini [SIGKILL] kill: pid=21187 tid=21217` → `onAppClose`/`onAccInterceptConfirm hasAccSuccess=false`.
- `tools/frida/wzry-kill-trace.js` + `run-kill-trace.mjs` (untracked) — pre-built hook for E3.
- `/data/adb/modules/{Yurikey,Violet,hma_oss_zygisk,zygisk_lsposed,zygisksu}` — all inspected read-only.
- HMA scope for `sgame` confirmed (`useWhitelist` + `白名单`).
