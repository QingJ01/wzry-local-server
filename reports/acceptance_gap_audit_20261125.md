# Acceptance gap audit — 2026-11-25

Scope: reconcile `reports/acceptance_matrix_live.md` against all evidence produced after
2026-11-24 20:19 (v3 rename build, version-gate native patch, LSPosed Houdini hook,
.101 offline event, vivo fallback device). **No unverified item is marked pass.**

## Headline deltas since the matrix

- `wzry-version-gate-localdebug-sgamx-v3.apk` exists, is signed (v2+v3), keeps the
  libapollo 3-byte version-gate patch, and is **installed on the vivo V2238A** as
  `com.tencent.tmgp.sgamx` (`versionCode=381010801`, `firstInstallTime=2026-11-25 07:33`).
- MuMu emulator `192.168.5.101:5555` is still `offline` (verified now); every
  capability tied to it (LSPosed hook, ADB reverse, Frida attach, method0 control-plane)
  is **unavailable**, not just degraded.
- LSPosed Houdini self-SIGKILL hook is **proven on .101** (`state=1`, process survived
  >90 s) but the proof is tied to the emulator's Houdini translation layer. The vivo
  phone has no Houdini, so the kill vector that hook addressed does not transfer.
- Version-gate patch correctness is proven at the byte/signature level only; there is
  **no runtime evidence** the announcement is skipped on vivo.

## Per-requirement status

| Requirement | Evidence level now | What is proven | Remaining steps |
| --- | --- | --- | --- |
| Account | **Not proven** | Internal API tests only. No client login request/response on any device. | Install v3 on vivo and reach a login UI (needs version-gate bypass confirmed), or restore .101. Then capture ≥2 labeled login sessions with endpoint/direction/framing/response evidence. |
| Battle | **Not proven** | Internal API tests only. No room/battle/settlement frames from a client. | Same as account, then capture a safe training match: persistent endpoint, bidirectional frames, stable message boundaries. |
| Shop | **Not proven** | Internal API tests only. | Capture two shop sessions on the real client; no purchase without explicit authorization. |
| Real client | **Partial, device-blocked** | v3 coexist APK installs and verifies on vivo (`com.tencent.tmgp.sgamx` 3.81.1.8). It was **not launched** — no process or UI evidence. On .101 the method0 client reached the backend but was killed by the version announcement. | Launch sgamx on vivo and record whether the forced-update announcement appears; if patched out, proceed to login. If announcement persists, next patch point is `OnGetNewVersionInfo` `0x44ba58` (documented in `version_gate_native_patch.md`). |
| Local backend | **Pass, stale** | Last proven healthy at 2026-11-24 21:30 baseline (`/health` all ok, `/game/events` 200, `19620/19621` listening). | Re-verify on this workstation: `cargo test`, `curl http://127.0.0.1:19620/health`. State is probably unchanged but not re-checked today. |
| Device | **Regressed** | Primary `.101` offline since ~23:29 (all recovery attempts failed; adbd hung, no app-layer response on any port). Fallback vivo V2238A (`adb-10CD6M23EL003SU…`, Android 16, arm64) is connected and carries both the stock `sgame` 12.1.1.1 and our `sgamx` 3.81.1.8. | Restore .101 only via host-side MuMu/adbd restart. vivo path needs ADB-reverse equivalents (`adb reverse` works on real devices) and a decision on hooking strategy since Houdini hook is emulator-only. |

## Item-level reconciliation

- **v3 rename package** — built (`docs/package-rename-audit.md`), verified
  (aapt2 packagename `sgamx`, launchable activity stays `com.tencent.tmgp.sgame.SGameActivity`,
  11 equal-length AXML edits, zipalign + apksigner v2/v3, 683 untouched entries byte-identical,
  libapollo patch SHA preserved). **Installed on vivo at 07:33.** Status: proven for
  build+install, unproven for launch/flow.
- **Version gate** — 3-byte `libapollo.so` patch (`0x4f368c/90/98`, `ldrb`→`movz`) built into
  `wzry-version-gate-signed.apk` and carried into v3. True-Store rebuild fixed by
  `tools/build_native_patch_apk.mjs`. Status: static evidence high; **runtime bypass
  unverified on vivo** (announcement may still render; fallback patch point documented).
- **Houdini hook** — LSPosed path proven on .101 (self-SIGKILL window passed, state=1).
  Audit fixes landed (`HookEntry` fail-closed payload path, package-name fix). Status:
  proven **on .101 only**; irrelevant to vivo (native arm64, no Houdini).
- **.101 offline** — confirmed still offline now; last baseline healthy 21:30, recovery
  report 23:43 marks it `unrecoverable_remote` requiring host-side emulator/adbd restart.
- **vivo backup device** — usable: `adb devices` shows it `device`, sgamx installed,
  stock sgame intact. Open questions: whether Frida server is present/arm64-matched,
  whether ADB reverse mappings were recreated for this serial, whether the vivo stock
  sgame 12.1.1.1 is even the same train as 3.81.1.8 (it is a different major version —
  the sgamx install is the only comparable target).

## Matrix rows that need correcting when .101 recovers

- `Device connection`, `ADB reverse`, `Client reaches local backend`, `Dynamic capture`
  were all recorded against `192.168.5.102:5555`/`.101` and are **not currently
  reproducible**. They should stay "Pass"/"Cold-start complete" only as historical
  evidence, with a live-status annotation pointing here.
- `APK build`, `Control-plane patch`, `Rust tests`, `Client tests`, `Static/reverse
  tests` remain pass — nothing invalidated them.
- `Account/Battle/Shop end-to-end`, `Protocol recovery` remain **Not proven**; no new
  evidence changes that.

## Recommended acceptance order (updated)

1. Pick the device path: (a) restore .101 via host-side MuMu restart, or (b) commit to
   vivo with sgamx v3 (arm64, needs its own hook strategy; Houdini hook does not apply).
2. On the chosen device, launch and record whether the "年度版本" announcement appears —
   this is the single gate before any login/lobby/shop/battle capture.
3. Only after the announcement is bypassed: capture labeled login, lobby, shop, battle
   phases with Frida + `/proc/net/tcp` snapshots; cold-start is already proven at 2/2
   on .101 but must be re-proven on vivo if that becomes the device.
4. Recover endpoint/framing evidence before implementing any client-compatible
   account/battle/shop protocol.
5. Re-run the full suite and refresh `acceptance_matrix_live.md` before claiming
   acceptance.
