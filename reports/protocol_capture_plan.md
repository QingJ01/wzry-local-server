# WZRY protocol capture plan

## Objective

Locate the real account, battle, and shop network flows without guessing protocol IDs or frame formats. The main thread owns every ADB action; this plan and its scripts are prepared for that operator to execute.

## Current evidence

- Package: `com.tencent.tmgp.sgame`, version `3.81.1.8`.
- Client core networking is native Unity IL2CPP; Java has no game frame implementation.
- Known plaintext control planes are MSDK, TDM Router, GCloud RemoteConfig, and GTrace.
- The game gateway, account flow, battle flow, shop flow, encryption, compression, and message IDs remain unproven.

## Process socket ownership

Run only while the game is at the screen under investigation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\project\wzry\tools\Observe-ProcessSockets.ps1 `
  -Serial 192.168.5.102:5555 `
  -Package com.tencent.tmgp.sgame
```

The script reads:

- `pidof com.tencent.tmgp.sgame`
- `/proc/<pid>/status` for UID
- `/proc/<pid>/fd` for socket inodes
- `/proc/<pid>/net/{tcp,tcp6,udp,udp6}` filtered by those inodes

It writes a host-side JSON file and makes no device configuration or filesystem changes.

## Socket sampling sequence

1. Start the original APK and wait at the login screen.
2. Run `Observe-ProcessSockets.ps1`; classify port 443 as HTTPS control plane and other remote endpoints as game candidates.
3. Repeat after each user action: account login, lobby load, room/match, battle entry, shop open, purchase attempt.
4. Compare endpoint and socket-inode changes; stable non-443 endpoints are protocol candidates.
5. Save one JSON evidence file per action and record the UI state in its filename or the report.

## Read-only tcpdump option

If a compatible `tcpdump` is already present, the main thread can stream to the host without writing a capture file on the Android device:

```powershell
$adb = 'D:\project\poxxiao\tools\android-sdk\platform-tools\adb.exe'
& $adb -s 192.168.5.102:5555 exec-out su -c 'tcpdump -i any -s 0 -U -w -' `
  > D:\project\wzry\workspace\observations\wzry-actions.pcap
```

Constraints:

- `exec-out` must preserve binary output; verify the resulting file with a local pcap reader.
- If Android lacks tcpdump, do not install or push it without explicit approval.
- `iptables`/nftables NFLOG capture changes packet-processing rules and is not a read-only option; do not use it in this phase.

## Frida option

`tools/frida/wzry-network.js` is a ready template for main-thread use after explicit approval. It hooks:

- `connect` to log target family/address/port
- `send` and `recv` to log direction, descriptor, length, and first 64 bytes

Run it from the project root, replacing tool versions and server paths as needed:

```powershell
frida -U -f com.tencent.tmgp.sgame -l D:\project\wzry\tools\frida\wzry-network.js --no-pause
```

Frida changes process state and can trigger anti-debug. Use it only when `/proc` and tcpdump cannot identify the endpoint or frame boundary.

## Account traffic

Collect samples at these UI states:

1. App first screen before login.
2. Login page rendered.
3. Login submitted and result displayed.
4. Lobby loaded.

Pass criteria:

- The same non-443 endpoint appears in at least two login attempts, or DNS/socket evidence identifies the account gateway.
- First request bytes are stable enough to identify a header and length field.
- Response direction and request/response pairing can be distinguished.
- Account identifiers are not logged in plaintext; the capture stores bytes, not decoded personal data.

Fail state: only MSDK/TDM/GCloud HTTPS traffic is observed. Do not implement an account game handler.

## Battle traffic

Collect samples at these UI states:

1. Room or match screen.
2. Matching submitted.
3. Battle loading.
4. First 30 seconds in battle.
5. Settlement.

Pass criteria:

- A distinct endpoint or connected socket persists through battle loading.
- Bidirectional packet rates increase during battle.
- A length field predicts complete packet boundaries across at least three samples.
- A command or sequence field groups repeated requests and responses consistently.

Fail state: only HTTP telemetry is visible. The battle protocol remains unproven.

## Shop traffic

Collect samples at these UI states:

1. Shop closed.
2. Shop opened.
3. Item list loaded.
4. Purchase confirmation opened.
5. Purchase submitted and result displayed.

Pass criteria:

- Shop open correlates with at least one request/response pair.
- Item list and purchase actions are distinguishable by command, sequence, body length, or endpoint.
- Purchase response precedes the UI result and is reproducible across two sessions.
- Any balance mutation has a corresponding response before persistence in a local implementation.

Fail state: shop data may be locally cached. Do not claim shop protocol completion.

## Frame-format evidence table

Every candidate protocol report must include:

| Evidence | Requirement |
| --- | --- |
| Endpoint | IP, port, family, socket inode |
| Direction | request, response, or notification |
| Timing | Timestamp relative to UI action |
| Length | Captured bytes and inferred full packet length |
| Header | Candidate magic, version, command, sequence fields |
| Stability | At least three comparable samples |
| Encryption | Randomness, stable magic, or known crypto behavior |
| UI correlation | Exact screen/action when captured |

No server game handler is implemented until this table has sufficient evidence.

## Acceptance gates

- Account: endpoint, login request/response boundary, session/token exchange, and persistent account state are proven.
- Battle: match, battle join, bidirectional frame, and settlement flows are proven and reproducible.
- Shop: list, purchase request/response, balance, and inventory mutation are proven and reproducible.
- Device: the main thread verifies installation, app launch, and local backend observability on `192.168.5.102:5555`.
- Tests: socket/Frida script checks, server unit tests, and end-to-end protocol tests all pass.
