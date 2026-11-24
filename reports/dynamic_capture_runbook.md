# WZRY dynamic capture runbook

## Scope and non-negotiable boundaries

This runbook explains how the main-thread operator can safely collect account, battle, and shop traffic evidence on Android device `192.168.5.102:5555`. The target package is `com.tencent.tmgp.sgame`, version `3.81.1.8`.

This document is operational guidance only. It is not evidence that account, battle, or shop traffic has been captured, and it does not authorize an implementation of game handlers.

Always obey these boundaries:

- Only the main thread executes ADB, `su`, application control, or Frida commands.
- Keep the installed original APK and its data intact. Do not patch, reinstall, clear data, change hosts, proxy settings, DNS, certificates, packet-filter rules, or device configuration.
- Run one observation mode at a time. `/proc` observation is read-only; tcpdump needs an existing device binary and still requires explicit approval; Frida changes process state and has the highest anti-debug risk.
- Stop and roll back if the game exits, reports an integrity/debugging error, shows suspicious security prompts, freezes for more than a few seconds, or if account progress appears abnormal.
- Never expose real account tokens or personal information in reports. Hook logs are raw byte previews and must stay under `workspace/observations/frida/`.
- A failed or ambiguous action is negative evidence. Record it and restore the UI; do not repeat account purchases or battle actions.

## Operator preparation

Run all commands from `D:\project\wzry` in a new PowerShell session. Keep manual game actions in one device window and use a separate terminal for commands so each action can be timestamped.

Set local paths once:

```powershell
$ProjectRoot = 'D:\project\wzry'
$AdbPath = 'D:\project\poxxiao\tools\android-sdk\platform-tools\adb.exe'
$Device = '192.168.5.102:5555'
$Package = 'com.tencent.tmgp.sgame'
Set-Location $ProjectRoot
```

Before changing any UI state, record a baseline:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\Observe-Client.ps1 `
  -Serial $Device -Seconds 60
```

Verify that the device is online but do not proceed if the target is already running:

```powershell
& $AdbPath -s $Device get-state
& $AdbPath -s $Device shell pidof $Package
```

Expected readiness:

- `get-state` returns `device`.
- `pidof` returns no process ID before a launch.
- The game is signed into the operator's disposable account, has no pending purchase, and is not in a live battle.
- The device battery, network, and screen timeout permit the planned sequence.

## Game start and stop

Start from a clean process state and launch only once:

```powershell
& $AdbPath -s $Device shell monkey -p $Package `
  -c android.intent.category.LAUNCHER 1
```

Wait manually until the expected screen is fully rendered. Do not issue another launch command if the first succeeds.

For controlled stops, first return to a safe UI state: cancel matchmaking, leave any training or battle room, close the purchase dialog, and return to the lobby or login screen. Then:

```powershell
& $AdbPath -s $Device shell am force-stop $Package
```

Use `force-stop` only at a safe boundary. Do not use it while an account mutation, purchase, matchmaking, battle, or settlement is pending. If the game already exited, do not relaunch during rollback; record the exit and the evidence captured before it.

## Read-only process socket ownership

Run this only when the target screen is visible. One file represents one UI state:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\Observe-ProcessSockets.ps1 `
  -Serial $Device -Package $Package
```

Default output is under `workspace\observations\process-sockets\`. Immediately rename or copy each JSON so its filename identifies the state:

```powershell
Copy-Item .\workspace\observations\process-sockets\com.tencent.tmgp.sgame-<stamp>.json `
  .\workspace\observations\process-sockets\01-login-screen.json
```

Interpretation:

- The script records the process ID, UID, socket inodes, and matching `/proc/<pid>/net/{tcp,tcp6,udp,udp6}` rows.
- An established non-443 remote endpoint is a game candidate. Port 443 alone is control-plane HTTPS evidence, not a game protocol proof.
- A socket inode seen in the process fd list is stronger evidence than a same-UID global `/proc/net` row. Do not attribute connections without that inode match.
- Compare consecutive JSON files for endpoint persistence and new sockets caused by the UI action.
- Do not write conclusions from a single sample. The account, battle, and shop gates below require repeated evidence.

## Frida server deployment boundary

Frida changes the target process and can trigger anti-debug. Do not deploy or start it unless `/proc` and an approved existing tcpdump cannot answer the question.

Before deployment, the main thread must obtain explicit approval and check:

- Host CLI and device server versions match.
- Architecture and Android version are compatible.
- The server binary already exists in a known operator-controlled location.
- The operator accepts that Frida injection may terminate the game or damage the account session.

The current operator-controlled server asset is:

- Host: `D:\project\poxxiao\work\period-formula-research\tools\frida-server-17.27.5-android-arm64`
- SHA-256: `02CB10FF691ADC60EFF69450C99D9296B0A285F89374D6DB8F8BD2B8A82F5967`
- Device path: `/data/local/tmp/wzry-frida-server-17.27.5`
- Binding: `127.0.0.1` only, paired with an exact ADB port forward.

`tools\frida\Run-NetworkCapture.ps1` implements the approved temporary deployment surface only. It validates the target serial, records the server hash and timestamps, binds loopback, removes the exact ADB forward, and deletes only the exact temporary server path during cleanup. Install the matching CLI with:

```powershell
npm --prefix .\tools\frida\ install
```

### 2026-11-24 runtime status

- The host CLI is installed locally at `tools\frida\node_modules\.bin\frida.cmd` and pinned to `17.27.5`.
- The matching arm64 server asset and hash above were located and verified.
- The target package and ADB reverse mappings were already installed and active.
- `su -c id`, and even ordinary shell commands containing `su`, blocked without output on `192.168.5.102:5555`; normal ADB commands such as `get-state` remained responsive.
- Because root execution is required to deploy the server, Frida injection was not attempted and no game traffic was captured.
- The interrupted deployment did not create a server process, a Frida server file, or a new ADB forward. Do not retry root commands until KernelSu authorization is restored interactively.

Alternative evidence collection while root is unavailable:

1. Run the read-only `/proc` socket observer on an already running, operator-launched game.
2. Capture screenshots and operator timestamps for UI states.
3. Confirm the local service identity and `/health` state, but do not treat internal HTTP tests as game-protocol evidence.
4. Revisit Frida only after an operator confirms KernelSu grants shell access and `su -c id` returns promptly.

Allowed deployment surface, if explicitly approved:

- Place the server binary in an operator-chosen temporary location, such as `/data/local/tmp/frida-server`.
- Make it executable for the invoking shell only.
- Start it with a non-default port, run the session, stop it, and remove the temporary binary.

The following is a boundary illustration only; exact paths and versions must be selected by the main thread:

```powershell
# Approved illustration only: versions and paths are operator-selected.
& $AdbPath -s $Device push <matching-frida-server-binary> /data/local/tmp/frida-server
& $AdbPath -s $Device shell su -c 'chmod 700 /data/local/tmp/frida-server'
& $AdbPath -s $Device shell su -c '/data/local/tmp/frida-server -l 127.0.0.1:<unused-port> &'
```

Do not add init scripts, services, permanent binaries, environment changes, proxy configuration, or package changes. Do not use a public/default listening port without checking the device network policy. Prefer `127.0.0.1` and an ADB port forward if the CLI requires it.

## Hook execution and log preservation

Use Frida only for a launch from cold start. The template is `tools\frida\wzry-network.js`; it hooks `connect`, `send`, and `recv`, records the descriptor and target, and prints a 64-byte hex preview.

Before launching, create a timestamped log:

```powershell
$RunId = Get-Date -Format 'yyyyMMdd-HHmmss'
$FridaLogDirectory = Join-Path $ProjectRoot 'workspace\observations\frida'
New-Item -ItemType Directory -Force -Path $FridaLogDirectory | Out-Null
$FridaLog = Join-Path $FridaLogDirectory "$RunId.ndjson"
```

The main thread chooses the matching host CLI invocation. The template form is:

```powershell
frida -U -f $Package `
  -l .\tools\frida\wzry-network.js `
  --no-pause *>> $FridaLog
```

Label every capture file with its UI phase so the correlator and capture matrix can
group evidence by phase; unlabeled captures cannot satisfy a phase gate. Prefix the
output `.ndjson` filename with one of `cold-start`, `login`, `lobby`, `room`,
`battle`, `shop`, `settlement`, `consent`, or `first-screen`, for example
`login-20261124-194343.ndjson`. When using `Run-NetworkCapture.ps1 -Action run`,
rename the produced `$runId.ndjson` to include the phase prefix immediately after
the session ends:

```powershell
$log = powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\frida\Run-NetworkCapture.ps1 `
  -Action run -CaptureSeconds 90
Rename-Item $log "login-$(Split-Path $log -Leaf)"
```

If an ADB-forwarded server port is required, replace `-U` with the matching host CLI option for that port; do not invent a port. Record the exact invocation, Frida versions, server path, server port, start time, stop time, and UI states in a run note.

Preservation rules:

- Treat every stdout/stderr line as evidence. Never overwrite a previous run log.
- Keep hook logs under `workspace\observations\frida\`.
- Do not paste raw previews into issues or reports. Redact account identifiers if they become visible.
- Stop collection by ending the Frida session from the CLI, then manually return the game to a safe UI state and stop it at a safe boundary.
- Run `Observe-ProcessSockets.ps1` only after the Frida session has ended, so `/proc` evidence remains read-only and is not mixed with active injection.

## Minimum trigger paths

For each path, complete one safe repetition before considering a second. Keep socket JSON and hook evidence separated by UI state. Do not perform a real purchase unless the main thread explicitly authorizes it and the item is intentionally disposable.

### Account path

1. Record `00-app-first-screen` with sockets.
2. Open the login page; record `01-login-page`.
3. Submit login once; record `02-login-submit`.
4. When the result is visible, record `03-login-result`.
5. Wait for the lobby; record `04-lobby-loaded`.

Pass evidence requires a repeated non-443 endpoint across two login sessions, request/response direction and timing, and a stable length or boundary hypothesis. If only MSDK/TDM/GCloud HTTPS appears, account protocol work remains unproven.

### Battle path

Use training mode or the lowest-risk local battle mode when available. Never enter ranked or account-affecting battle during a first capture.

1. Record `10-lobby-baseline`.
2. Open the room or match screen; record `11-room-open`.
3. Start matching only when it is safe; record `12-match-submit`.
4. During battle loading, record `13-battle-loading`.
5. In the first 30 seconds of battle, collect hook evidence without changing settings; do not run a socket snapshot during active battle if it would delay controls.
6. At settlement, record `14-settlement`.
7. Return to the lobby and record `15-lobby-return`.

Pass evidence requires a persistent socket or distinct endpoint, increased bidirectional traffic during battle, at least three comparable frame samples, and a length, sequence, or command field that consistently explains boundaries. A telemetry-only capture fails the gate.

### Shop path

Do not buy a non-refundable, limited, or account-visible item during a first pass.

1. Record `20-lobby-closed`.
2. Open the shop; record `21-shop-open`.
3. Wait for the item list; record `22-item-list-loaded`.
4. Open a purchase confirmation; record `23-purchase-confirm-open`.
5. If explicitly authorized, submit one disposable purchase and record `24-purchase-submit`.
6. Record the UI result as `25-purchase-result`.
7. Reopen the shop once to test list-load reproducibility.

Pass evidence requires request/response correlation, distinguishable list and purchase actions, and a response that precedes the UI result in two sessions. If traffic occurs only while opening a cached list, shop protocol work remains unproven.

## Result determination

Track progress against the minimum rounds with the capture matrix evaluator. It
indexes phase-tagged socket snapshots, Frida captures, and HTTP observations, groups
them into independent rounds, and reports which gates are met:

```powershell
node .\tools\capture_matrix.mjs `
  --output .\workspace\observations\capture-matrix.json `
  --markdown .\reports\capture_matrix.md
```

Use this evidence table for each candidate protocol:

| Evidence | Account requirement | Battle requirement | Shop requirement |
| --- | --- | --- | --- |
| Endpoint | Repeated non-443 endpoint across two sessions | Persistent or distinct battle endpoint | Stable shop or list endpoint |
| Ownership | PID, UID, and socket inode match | PID, UID, and socket inode match | PID, UID, and socket inode match |
| Timing | Login action and response correlate | Loading/battle phases correlate | Open/list/purchase/result correlate |
| Direction | Request and response distinguishable | Bidirectional rate increases | Request/response before UI result |
| Boundary | Stable header or length hypothesis across 3 samples | Length predicts full boundary across 3 samples | List and purchase structures differ |
| Reproducibility | Two login sessions | Two safe battle sessions | Two shop sessions, with purchase only if authorized |

Classify outcomes as:

- **Captured endpoint only:** PID/UID/inode and remote address are proven. Protocol remains unknown.
- **Captured frame:** stable direction, timing, length, and comparable samples are proven. Magic, command, sequence, encryption, and semantics may still be unknown.
- **Proven flow:** endpoint, boundary, request/response pairing, persistence or mutation, and reproducibility are all proven.
- **Failed:** control-plane HTTPS only, missing ownership, ambiguous direction, unstable boundary, or a non-reproducible result.

Never promote a local server handler based on endpoint evidence alone. Until the account, battle, and shop gates pass, the only permitted server work is protocol-agnostic observability.

## Rollback and cleanup

At any failure, abnormal UI state, or end of a planned path:

1. Stop the Frida host CLI first. Confirm the process no longer injects the game.
2. If a server was started, stop the Frida server by its exact operator-selected mechanism. Do not issue a blind `killall` on a shared device.
3. If a temporary server binary was pushed, remove only that exact file:

```powershell
& $AdbPath -s $Device shell su -c 'rm -f /data/local/tmp/frida-server'
```

4. Remove any temporary ADB port forward by its exact specification. Do not reverse all device network settings blindly.
5. Return the game to a safe screen, cancel pending actions, finish or safely exit battle, and stop the app at a safe boundary.
6. Recheck `pidof $Package`; no process should remain after a deliberate stop.
7. Record the exit condition, timestamps, evidence filenames, exact cleanup commands, and any UI security message.
8. If the game exits unexpectedly, do not relaunch immediately. Wait for the operator to review the evidence and decide whether another cold-start session is safe.

No device rollback is required for `Observe-ProcessSockets.ps1` itself. It only reads `/proc` and writes JSON on the host.

## Static validation

The runbook is checked by `tools\Test-ProtocolCaptureScripts.ps1`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\tools\Test-ProtocolCaptureScripts.ps1
```

This validates the socket script syntax, required `/proc` attribution logic, Frida hook tokens, protocol-plan sections, and the runbook's safety and rollback requirements. Passing it means the documents and script templates are internally consistent; it does not mean traffic was captured.
