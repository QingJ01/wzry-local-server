# Dynamic capture — cold-start rounds (2026-11-24, attach mode)

## Scope

Two labeled cold-start rounds on device `192.168.5.102:5555` for package
`com.tencent.tmgp.sgame` (method0 APK, `3.81.1.8`), using the repaired Frida
attach path. No consent-confirm (`确定`) tap, no login, no purchase, no battle.
The app was left at or before the version-announcement screen and force-stopped
at a safe boundary after each round.

## Runtime preconditions

- Rust local service healthy on `127.0.0.1:19620` (HTTP) and `127.0.0.1:19621`
  (frame TCP); `GET /health` returns all-`ok`, `GET /game/events?after=0&epoch=1`
  returns `200` with the bound loopback session.
- ADB reverse `19620`, `19621`, `19622` active; ADB forward `27042` active.
- Frida server `wzry-frida-serv` 17.27.5 deployed at
  `/data/local/tmp/wzry-frida-server-17.27.5`, bound to `127.0.0.1:27042`,
  started under `su` with KernelSu `ksu` context. Root shell confirmed via
  `su -c 'id'` → `uid=0(root)`.
- The server process exits between captures and was restarted per round via
  `Run-NetworkCapture.ps1 -Action start`.

## Round 1 — `cold-start-round1-*`

- Launch: attach mode, `am start -n com.tencent.tmgp.sgame/.SGameActivity`
  (COLD). Initial PID **23524**, UID **10061**.
- Frida capture `cold-start-round1-20261124-201037.ndjson` (75 s, attach):
  `session-started`, 16 `hook-attached`, 87 `socket`, 81 `connect`,
  104 `socket-data` (**52 outbound / 52 inbound**), 70 `socket-close`.
- Connect endpoints observed: 19620 loopback (POST `/tdm/v2/route` and
  `/padx/notice/gather_data/` telemetry to the local backend), many `:443`
  MSDK/TDM control-plane, `:8081`, `:80`. No game gateway proven.
- UI: user-agreement (`同意`) consent screen, confirmed via
  `cold-start-round1-ui.xml` ("腾讯游戏用户协议和隐私政策"). **No `确定` tap.**
- Socket snapshots:
  - `cold-start-round1-sockets-20261124-201054.json`: PID 23524, 15 socket fds,
    1 process-owned tcp6 connection (`87.242.201.113:443`, inode 1242138).
  - `cold-start-round1-sockets-20261124-201212.json`: PID **24156**, 3 socket
    fds, 1 owned connection — the process was killed by Houdini and restarted
    during the 75 s window.
- Artifacts: `ui/cold-start-round1-20261124-2011.png`,
  `cold-start-round1-logcat.txt`, Frida metadata JSON.

## Round 2 — `cold-start-round2-*`

- Force-stop, then attach launch. Initial PID **24399**, UID **10061**.
- Frida capture `cold-start-round2-20261124-201241.ndjson` (75 s, attach):
  `session-started`, 15 `connect`, 12 `socket-data` (**6 outbound / 6
  inbound**).
- UI dump during the round was only 1890 bytes (SurfaceView splash, before the
  consent dialog rendered); the end-of-round screenshot shows the "年度版本
  云梦有灵" version-announcement screen — i.e. post-consent, pre-login. The
  consent tap that advanced the UI was operator-performed; **no `确定` tap**.
- Process died and restarted again mid-round (final `pidof` = **25301**).
- Socket snapshots:
  - `cold-start-round2-sockets-20261124-201301.json`: PID 24399, 26 socket fds,
    10 owned connections.
  - `cold-start-round2-sockets-20261124-201425.json`: PID 25301, 25 socket fds,
    11 owned connections.
- Artifacts: `ui/cold-start-round2-20261124-2013.png`,
  `ui/cold-start-round2b-20261124-2014.png`, `cold-start-round2-ui.xml`,
  `cold-start-round2-logcat.txt`.

## Round 3 — `cold-start-round3-*` (spacing round)

Rounds 1 and 2 were captured within the matrix 120 s `roundGapMs` window, so the
evaluator merged them into a single round. A third cold-start was run after a
150 s idle gap so the matrix could count two independent rounds.

- Force-stop, then attach launch. Initial PID **10745**, UID **10061**.
- Frida capture `cold-start-round3-20261124-201735.ndjson` (75 s, attach):
  `session-started`, 111 `connect`, **1492 `socket-data`** (**95 outbound /
  1397 inbound**) — the largest bidirectional capture so far.
- Socket snapshots: `cold-start-round3-sockets-20261124-201757.json` (PID
  10745, 26 fds, 10 owned) and `cold-start-round3-sockets-20261124-201901.json`
  (PID 46368, post-restart).
- Artifacts: `ui/cold-start-round3-20261124-2018.png`,
  `cold-start-round3-ui.xml`, `cold-start-round3-logcat.txt`.

## Matrix result

`tools/capture_matrix.mjs` now reports **cold-start: 2 observed / 2 complete
rounds — `complete`**. Both rounds satisfy all gate checks: process ownership
(PID/UID-owned socket inode matched to `/proc/<pid>/net`), a Frida
`session-started` event, socket snapshots present, and bidirectional data.
Round-1 grouping merged rounds 1–2 into one window (12:10:40–12:14:27 UTC, 6
artifacts, 23 owned conns, 58 out / 58 in); round 3 formed the second window
(12:17:38–12:19:03 UTC, 3 artifacts, 21 owned conns, 95 out / 1397 in).

`tools/correlate_protocol_capture.mjs` regenerated
`reports/protocol_capture_findings.md` and
`workspace/observations/protocol-correlation.json`: 2585 Frida events, 170
outbound / 1471 inbound socket events, 50 process-owned connections across 13
snapshots. Evidence completeness remains `insufficient-for-protocol-recovery`
— no non-443 game gateway, frame boundary, or command field is proven by cold
start alone.

## Findings

- Attach mode is stable: three attach sessions in a row produced `session-started`
  plus inbound+outbound socket-data with descriptor/inode correlation. This is
  the reliable capture path after the Houdini spawn-gate fix.
- The game process still self-terminates during cold start: every round's
  `pidof` changed across the 75 s window (23524→24156, 24399→25301,
  10745→46368). The restart happens without a `确定` tap, so the Houdini
  `SIGKILL` window is triggered earlier than the previous post-permission
  estimate — the kill is part of cold-start, not gated on permissions.
- Cold-start traffic is telemetry/control-plane only: loopback `19620` TDM and
  `padx/notice` posts plus many `:443` MSDK endpoints. The only non-443
  non-loopback candidates are `*:8081` (8 out / 12 in) and `*:10012`
  (connect-only); neither is proven to be a game gateway.
- `/game/events` stayed `200` for the bound loopback session throughout; the
  Rust service never went down during any round.

## Boundaries kept

- No `确定` (permission confirm) tap in any round; the UI advanced only to the
  version-announcement screen at most.
- No login, purchase, matchmaking, or battle action.
- `am force-stop` used only at safe boundaries (consent/announcement screens,
  post-capture).
- No device config, hosts, proxy, DNS, cert, or package changes.

## Next safe step

With cold-start complete at 2 rounds, the next phase is **login** — but it is
blocked by the same Houdini `SIGKILL` that restarts the process during cold
start. Before login capture, stabilize the process past the kill window (the
kill fires even without the permission confirm) or accept that each captured
round may span two PIDs.
