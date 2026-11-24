# Live acceptance matrix — 2026-11-24

## Overall status

**Not accepted.** All current automated tests pass, the corrected ZIP Store APK is installed, and the real patched client now reaches the local Rust backend through `/game/events`. Account, battle, and shop acceptance still require real client flows and proven protocol semantics.

## Current evidence

| Requirement | Status | Evidence | Next action |
| --- | --- | --- | --- |
| Repository state | Pass | `main` is synchronized with `origin/main`; only temporary `tools/workspace/` remains untracked | Remove or ignore temporary tool workspace when its owner confirms it is disposable |
| Rust service | Pass | `GET /health` returned database/http/frame/protocol all `ok`; `/game/events` now returns HTTP 200 with an empty event page | Keep this Rust service as the local backend for client captures |
| Device connection | Pass | ADB reports `192.168.5.102:5555 device`; all checks used the explicit serial | Continue using only this device serial |
| ADB reverse | Pass | `19620`, `19621`, and `19622` mappings are active | Keep mappings while testing the client |
| APK build | Pass | `client/Test-Pipeline.ps1` passed; `wzry-control-plane-store-fixed.apk` was built with entry-order and Store-policy checks | No action |
| Control-plane patch | Pass | `client/Test-ControlPlanePatch.ps1 -Apk client/builds/wzry-control-plane-store-fixed.apk` passed | No action |
| Device installation | Pass | `client/builds/wzry-control-plane-store-method0.apk` installed successfully with `adb install -r`; `resources.arsc` is ZIP method 0, `zipalign -c -p 4` passes, and APK Signature Schemes v1/v2/v3 verify | Keep this APK as the current installed build |
| Client reaches local backend | Partial pass | Repeated `GET /game/events?after=0&epoch=1` requests from the foreground client reached Rust on 19620; the new session handler can authorize a default local account, but the installed APK still polls without a token and receives 401 | Patch or inject the event-session identity without guessing production credentials, then confirm HTTP 200 in the live client |
| Dynamic capture | Partial pass | Session 2: with `/local/session` bound (loopback `/game/events` → 200), consent→permissions→确定 chain repeated; PID 20314 owned socket inode 1196769 to 116.77.172.88:443, then houdini issued `SIGKILL` ~9 s after the permissions confirm (19:51:39) — this run had no external `Force stopping` line | Root-cause the Houdini SIGKILL on the post-permissions transition before resuming UI progression; keep treating 401-only polling and server-side 501s as non-evidence |
| Account end-to-end | Not proven | Only internal account API tests pass; no client login request/response evidence | Capture at least two safe login sessions and prove endpoint, direction, timing, framing, and response behavior |
| Battle end-to-end | Not proven | Only internal battle API tests pass; no room/battle/settlement client evidence | Capture a safe training flow and prove persistent endpoint, bidirectional frames, and stable boundaries |
| Shop end-to-end | Not proven | Only internal shop API tests pass; no shop/list/purchase client evidence | Capture two shop sessions; do not buy without explicit authorization |
| Protocol recovery | Not proven | Static reports provide anchors only; no gateway, frame header, command ID, encryption, or schema is recovered | Analyze real Frida JSONL with `tools/correlate_protocol_capture.mjs`; do not guess values |
| Rust tests | Pass | `cargo fmt --check`; `cargo test` completed with 22 tests passing after the local-session change | Re-run after protocol handlers change |
| Client tests | Pass | Pipeline and control-plane patch tests passed | Re-run after reinstall or patch changes |
| Static/reverse tests | Pass | Native patch, GameCore, IL2CPP, protocol capture, observation, and correlation tests all passed | Re-run after analysis-tool changes |

## Test snapshot

- Rust: 22 passed.
- Client pipeline: passed.
- Control-plane patch verification against `wzry-control-plane-store-fixed.apk`: passed.
- Native patch plan: passed.
- GameCore analyzer: passed.
- IL2CPP analyzer: passed.
- Protocol capture scripts: passed.
- Observation scripts: passed.
- Protocol correlation: passed.

## Required acceptance order

1. Add an authorization-aware `/game/events` identity path so event polling can be correlated to a local account session without guessing client credentials.
2. Capture labeled cold-start, login, lobby, shop, and safe battle phases with Frida and process-socket snapshots.
3. Prove inbound direction and correlate Frida descriptors with target-owned socket inodes.
4. Recover endpoint and framing evidence before implementing any client-compatible account, battle, or shop protocol.
5. Validate real account, battle, and shop flows independently with reproducible evidence.
6. Re-run the complete test suite and update this matrix before claiming acceptance.
