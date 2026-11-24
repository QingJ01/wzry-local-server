# Kill-path tracer (E3) — call-site attribution — 2026-11-24

## Objective
Trace `kill`/`raise`/`pthread_kill`/`tgkill`/`abort` in `com.tencent.tmgp.sgame`
(method0 APK, NetEase MuMu x86_64 + Houdini ARM translation) with the fixed
Frida **attach** mode, before the permission confirm, to attribute the
~9 s post-confirm self-termination to a concrete call site. Also evaluate two
hypotheses raised by the operator: (a) signature/package modification trigger,
(b) Houdini/emulator environment trigger.

## Tooling (new, does not touch `tools/frida/wzry-network.js`)

- `tools/frida/wzry-kill-trace.js` — attach-mode tracer. Hooks libc
  `kill/raise/pthread_kill/tgkill/sigqueue/abort/exit/_exit/_Exit/quick_exit`,
  `syscall()` filtered to kill/tkill/tgkill/exit/exit_group, every write-family
  export + `__android_log_*` (to capture the Houdini `[SIGKILL] kill: pid=...`
  log emission), and `pthread_create`/`clone` to record worker-thread TIDs.
  Records timestamp, caller return-address + module + offset + DebugSymbol,
  thread id, and an ACCURATE native backtrace per event.
- `tools/frida/run-kill-trace.mjs` — attach-only runner (launches via `am start`,
  attaches by pid, writes NDJSON + `.metadata.json`, emits `session-detached`).
- `tools/Test-KillTrace.ps1` — 32 static checks (all PASS).

## Runs (device 192.168.5.102:5555)

| Run | PID | Outcome | Evidence |
|-----|-----|---------|----------|
| a   | 23524 | died ~2.9s post-confirm; no houdini line, no `Force stopping` | tracer: session-detached only |
| b   | 20343 | died ~9s post-confirm | logcat `houdini [20610] [SIGKILL] kill: pid=20343, tid=20610, signo=9` |
| c   | 46368 | killed ~10s in | logcat `Killing 46368 ... from pid 18301` (external am) |
| d   | 26897 | survived ~60s; SIGKILL logged but not delivered | logcat `houdini [27142] [SIGKILL] kill: pid=26897, tid=27142` (proc stayed TOP) |
| e3  | 26897 | Stalker test — **froze** process in `t (tracing stop)` | tracer unusable; reverted |
| e4  | 54745 | killed pre-consent | logcat `Force stopping ... installPackageLI` + `pkg removed` |
| e5  | 19357 | died ~5s post-confirm | logcat `Killing 19357 ... from pid 32604` (external am) |

## Key findings

1. **Two/three distinct kill mechanisms coexist** — do NOT conflate them:
   - **Self-SIGKILL** (runs b, d): a Houdini translator worker *inside* the game
     pid issues `kill(<self>,9)`. Thread id == a `thread-spawn`/`clone` event in
     our own log => same-process integrity check. ~1 in 3 runs; ~5–9s post-confirm.
   - **External `am force-stop`** (runs c, e5): `Killing ... from pid <transient>`
     — a short-lived `am`/`pm`/`sh` process (MuMu acc / store). Different mechanism.
   - **Package reinstall** (run e4): `installPackageLI`/`pkg removed` at 20:32:30
     killed it AND reinstalled the APK (`pm path` codePath changed). MuMu store
     is suspected; transient installer pid already gone.

2. **The self-SIGKILL is invisible to userspace hooks** — across a–e5, NO
   libc `kill/tgkill/syscall/write/writev/__android_log_*` hook fired for the
   fatal signal. Both the syscall AND the Houdini log line are emitted by
   guest-ARM code translated to real x86 `syscall`/`write` instructions inside
   JIT code => `Interceptor` cannot see them. `Stalker` could, but froze the
   process (`tracing stop`) and is itself an anti-debug trip => rejected.

3. **Call-site attribution achieved at the thread level**: the kill worker is a
   thread spawned inside the game pid (our `thread-spawn`/`clone` log records
   the creator stack for the same TID that appears in `houdini [tid]`). The
   emitter is `libhoudini.so`'s translated syscall handler (proof: the exact
   `[%s] kill: pid = %d, tid = %d, signo = %d` format string at file offset
   `0x69f069` in `libhoudini.so`, base `0x7fb6e6491000`).

4. **Signature/package hypothesis — ruled out as the primary trigger by the
   B0 control** (`reports/signature_integrity_verdict.md`):
   - The Tencent-signed, zero-content-change B0 APK also died on the same MuMu
     device after ~101 s, through the signature-agnostic external
     `Force stopping ... from pid` path.
   - The certificate difference remains a detectable secondary surface, but the
     original signed package dying removes it as the primary explanation.

5. **Houdini/emulator hypothesis — plausible co-trigger**: the env is plainly
   an emulator (MuMu `York`/`YOK-AN10` spoofed as HONOR/Vivo; `libhoudini.so`,
   `libtcb.so`, `com.mumu.acc` accelerator, `libnb`). Emulator detection would
   fire on the same delayed worker. Cannot be separated from signature check
   without an unmodified-cert device or a cert-spoof control.

## What did NOT get caught and why
- Exact JIT `syscall` RIP offset inside libhoudini: not capturable by
  `Interceptor`; `Stalker` froze the target. The thread-level attribution +
  the libhoudini format-string proof are the strongest non-freezing evidence.
- The transient external `from pid` killer (MuMu acc/store shell) exits before
  `ps`/cmdline can read it; needs a `logcat`-triggered `/proc/<pid>` watcher.

## Recommendations
- First isolate the MuMu-side killer with the reversible R1 control:
  `pm disable-user com.mumu.acc` (and, if necessary, `com.mumu.store`), then
  rerun B0 and method0. This does not require changing the APK.
- If the in-process Houdini `SIGKILL` remains after the external killer is
  removed, patch the native integrity/emulator check or, only then, add a
  secondary PackageManager signature spoof. The B0 result means signature
  spoofing alone should not be expected to stabilize the client.
- To capture the JIT call site without Stalker: hardware breakpoint on the
  translated `syscall` site (ptrace `PTRACE_SETREGS`/hwbp) or a one-shot
  `Stalker` follow restricted to the single worker TID once identified.
- Do NOT treat `am force-stop`/`installPackageLI` deaths as the integrity
  check — they are MuMu-side and need their own mitigation.
