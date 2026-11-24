# Live acceptance matrix — 2026-11-24

## Overall status

**Not accepted.** The repository is clean and all current automated tests pass, but the real patched client has not yet been observed reaching the local Rust backend. Account, battle, and shop acceptance still require protocol evidence and real client flows.

## Current evidence

| Requirement | Status | Evidence | Next action |
| --- | --- | --- | --- |
| Repository state | Pass | `main` is synchronized with `origin/main` at `a693096`; only temporary `tools/workspace/` remains untracked | Remove or ignore temporary tool workspace when its owner confirms it is disposable |
| Rust service | Pass | `GET /health` returned database/http/frame/protocol all `ok`; `GET /debug/observations` returned `{}` | Keep this Rust service as the local backend for client captures |
| Device connection | Pass | ADB reports `192.168.5.102:5555 device`; all checks used the explicit serial | Continue using only this device serial |
| ADB reverse | Pass | `19620`, `19621`, and `19622` mappings are active | Keep mappings while testing the client |
| APK build | Pass | `client/Test-Pipeline.ps1` passed; `wzry-control-plane-store-fixed.apk` was built with entry-order and Store-policy checks | No action |
| Control-plane patch | Pass | `client/Test-ControlPlanePatch.ps1 -Apk client/builds/wzry-control-plane-store-fixed.apk` passed | No action |
| Device installation | Not accepted | Device has package `3.81.1.8`, but it has not yet been verified as the new store-fixed build; the previous audit identified the installed SHA-256 as the older patched-working build | Install and verify `wzry-control-plane-store-fixed.apk`, then record its device-side hash |
| Client reaches local backend | Not proven | `/debug/observations` is empty; no captured HTTP/socket request is attributed to the game | Complete a cold-start capture with the client foreground and Rust service active |
| Dynamic capture | Blocked | Earlier target launch survived at least 29.44 seconds, but `com.tencent.xfight` occupied the foreground; no target-owned socket inode mapping or Frida payload exists | Close the unrelated policy dialog, launch `.SGameActivity` explicitly, and capture cold start with Frida |
| Account end-to-end | Not proven | Only internal account API tests pass; no client login request/response evidence | Capture at least two safe login sessions and prove endpoint, direction, timing, framing, and response behavior |
| Battle end-to-end | Not proven | Only internal battle API tests pass; no room/battle/settlement client evidence | Capture a safe training flow and prove persistent endpoint, bidirectional frames, and stable boundaries |
| Shop end-to-end | Not proven | Only internal shop API tests pass; no shop/list/purchase client evidence | Capture two shop sessions; do not buy without explicit authorization |
| Protocol recovery | Not proven | Static reports provide anchors only; no gateway, frame header, command ID, encryption, or schema is recovered | Analyze real Frida JSONL with `tools/correlate_protocol_capture.mjs`; do not guess values |
| Rust tests | Pass | `cargo fmt --check`; `cargo test` completed with 18 tests passing | Re-run after protocol handlers change |
| Client tests | Pass | Pipeline and control-plane patch tests passed | Re-run after reinstall or patch changes |
| Static/reverse tests | Pass | Native patch, GameCore, IL2CPP, protocol capture, observation, and correlation tests all passed | Re-run after analysis-tool changes |

## Test snapshot

- Rust: 18 passed.
- Client pipeline: passed.
- Control-plane patch verification against `wzry-control-plane-store-fixed.apk`: passed.
- Native patch plan: passed.
- GameCore analyzer: passed.
- IL2CPP analyzer: passed.
- Protocol capture scripts: passed.
- Observation scripts: passed.
- Protocol correlation: passed.

## Required acceptance order

1. Install `client/builds/wzry-control-plane-store-fixed.apk` and verify the installed package.
2. Launch `com.tencent.tmgp.sgame/.SGameActivity` explicitly and keep it foregrounded.
3. Capture cold start with the active Rust backend and Frida network hooks.
4. Confirm `/debug/observations` or Frida evidence contains a request from the game.
5. Recover endpoint and framing evidence before implementing any client-compatible protocol.
6. Validate real account, battle, and shop flows independently with reproducible evidence.
7. Re-run the complete test suite and update this matrix before claiming acceptance.
