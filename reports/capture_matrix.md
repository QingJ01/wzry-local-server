# Dynamic capture matrix

Generated: 2026-11-24T12:19:09.405Z

This report indexes observed capture rounds per UI phase and evaluates them against the runbook gates. A phase is **complete** only when its minimum rounds are met with process-owned, bidirectional, phase-specific evidence. Nothing here asserts a protocol field is proven.

## Phase status

| Phase | Min rounds | Observed rounds | Complete rounds | Status |
| --- | ---: | ---: | ---: | --- |
| cold-start | 2 | 2 | 2 | complete |
| login | 2 | 0 | 0 | pending |
| lobby | 2 | 0 | 0 | pending |
| shop | 2 | 0 | 0 | pending |
| battle | 2 | 0 | 0 | pending |

## Round detail

### cold-start

Gate: A successful round needs a PID/UID-owned socket snapshot plus a Frida session-started event. No non-443 game endpoint is expected at this phase.

| Round window | Artifacts | Owned conns | Out / In | Non-443 connects | Checks | Complete |
| --- | --- | ---: | --- | ---: | --- | --- |
| 2026-11-24T12:10:40.210Z – 2026-11-24T12:14:27.336Z | 6 | 23 | 58 / 58 | 6 | processOwnership, bidirectional, repeatedEndpoint, socketSnapshot, sessionStarted | true |
| 2026-11-24T12:17:38.322Z – 2026-11-24T12:19:03.617Z | 3 | 21 | 95 / 1397 | 7 | processOwnership, bidirectional, repeatedEndpoint, socketSnapshot, sessionStarted | true |

### login

Gate: If only MSDK/TDM/GCloud HTTPS (443) appears, account protocol remains unproven. Direction and timing must correlate with the login action.

- No observed rounds yet.

### lobby

Gate: Baseline is needed to distinguish persistent control-plane sockets from phase-specific game sockets.

- No observed rounds yet.

### shop

Gate: Pass needs request/response correlation and a response that precedes the UI result in two sessions. Cached-list traffic alone fails the gate.

- No observed rounds yet.

### battle

Gate: Pass needs a persistent or distinct battle endpoint, increased bidirectional traffic, and at least three comparable frame samples. Telemetry-only capture fails.

- No observed rounds yet.

## Evidence index

| Kind | File | Phase | Events / Records | Notes |
| --- | --- | --- | ---: | --- |
| frida | workspace\observations\frida\20261124-174251.ndjson | unlabeled | 0 | no events |
| frida | workspace\observations\frida\20261124-174448.ndjson | unlabeled | 0 | no events |
| frida | workspace\observations\frida\20261124-174612.ndjson | unlabeled | 0 | no events |
| frida | workspace\observations\frida\20261124-174921.ndjson | unlabeled | 1 | no events |
| frida | workspace\observations\frida\20261124-175114.ndjson | unlabeled | 45 | session only |
| frida | workspace\observations\frida\20261124-175310.ndjson | unlabeled | 19 | 3out/0in |
| frida | workspace\observations\frida\20261124-175537.ndjson | unlabeled | 16 | session only |
| frida | workspace\observations\frida\20261124-191803.ndjson | unlabeled | 16 | session only |
| frida | workspace\observations\frida\20261124-193120.ndjson | unlabeled | 19 | session only |
| frida | workspace\observations\frida\20261124-193403.ndjson | unlabeled | 19 | session only |
| frida | workspace\observations\frida\20261124-193511.ndjson | unlabeled | 19 | session only |
| frida | workspace\observations\frida\20261124-193842.ndjson | unlabeled | 19 | session only |
| frida | workspace\observations\frida\20261124-194115.ndjson | unlabeled | 0 | no events |
| frida | workspace\observations\frida\20261124-194143.ndjson | unlabeled | 0 | no events |
| frida | workspace\observations\frida\20261124-194343.ndjson | unlabeled | 58 | 3out/3in |
| frida | workspace\observations\frida\adb-reverse-probe.ndjson | unlabeled | 91 | 11out/13in |
| frida | workspace\observations\frida\cold-start-round1-20261124-201037.ndjson | cold-start | 359 | 52out/52in |
| frida | workspace\observations\frida\cold-start-round2-20261124-201241.ndjson | cold-start | 72 | 6out/6in |
| frida | workspace\observations\frida\cold-start-round3-20261124-201735.ndjson | cold-start | 1832 | 95out/1397in |
| sockets | workspace\observations\process-sockets\00-cold-start-lifecycle.json | cold-start | 0 | 0 owned, pid n/a |
| sockets | workspace\observations\process-sockets\cold-start-round1-sockets-20261124-201054.json | cold-start | 1 | 1 owned, pid 23524 |
| sockets | workspace\observations\process-sockets\cold-start-round1-sockets-20261124-201212.json | cold-start | 1 | 1 owned, pid 24156 |
| sockets | workspace\observations\process-sockets\cold-start-round2-sockets-20261124-201301.json | cold-start | 10 | 10 owned, pid 24399 |
| sockets | workspace\observations\process-sockets\cold-start-round2-sockets-20261124-201425.json | cold-start | 11 | 11 owned, pid 25301 |
| sockets | workspace\observations\process-sockets\cold-start-round3-sockets-20261124-201757.json | cold-start | 10 | 10 owned, pid 10745 |
| sockets | workspace\observations\process-sockets\cold-start-round3-sockets-20261124-201901.json | cold-start | 11 | 11 owned, pid 46368 |
| sockets | workspace\observations\process-sockets\com.tencent.tmgp.sgame-20261124-191554.json | unlabeled | 1 | 1 owned, pid 14166 |
| sockets | workspace\observations\process-sockets\com.tencent.tmgp.sgame-20261124-192300.json | unlabeled | 1 | 1 owned, pid 15250 |
| sockets | workspace\observations\process-sockets\com.tencent.tmgp.sgame-20261124-192953.json | unlabeled | 1 | 1 owned, pid 16101 |
| sockets | workspace\observations\process-sockets\com.tencent.tmgp.sgame-20261124-193503.json | unlabeled | 1 | 1 owned, pid 17193 |
| sockets | workspace\observations\process-sockets\com.tencent.tmgp.sgame-20261124-194400.json | unlabeled | 1 | 1 owned, pid 19097 |
| sockets | workspace\observations\process-sockets\current-manifest-20261124-154213-normalized.json | unlabeled | 0 | 0 owned, pid 53389 |
| sockets | workspace\observations\process-sockets\current-manifest-20261124-154213.json | unlabeled | 0 | 0 owned, pid 53389 |
| sockets | workspace\observations\process-sockets\post-consent-20261124.json | consent | 1 | 1 owned, pid 17193 |
| http | workspace\observations\post-consent-20261124-http-observations.json | consent | 221 | 200:3,401:218 |
| http | workspace\observations\s2-http-observations.json | unlabeled | 179 | 200:22,400:1,401:147,404:1,501:8; methodId 4375,184355,184357,186201 |

## Candidate evidence

Candidate rows index the strongest protocol-adjacent signals observed so far. They are correlation targets, not proven fields; a `candidate` or `observed-501` status asserts observation only.

| Kind | Subject | Phase | Strength | Missing | Status |
| --- | --- | --- | --- | --- | --- |
| endpoint | 112.82.203.33:8081 | cold-start | connect observed + data bytes | process-owned inode match; repeat across sessions | candidate |
| endpoint | 122.96.96.179:10012 | cold-start | connect observed | socket bytes on this endpoint; process-owned inode match; repeat across sessions | candidate |
| endpoint | 122.96.96.251:10012 | unlabeled | connect observed | socket bytes on this endpoint; process-owned inode match; repeat across sessions | candidate |
| endpoint | 140.207.121.93:8081 | cold-start | connect observed + data bytes | process-owned inode match; repeat across sessions | candidate |
| endpoint | 2000:0:0:0:0:0:0:0:65535 | cold-start | connect observed | socket bytes on this endpoint; process-owned inode match; repeat across sessions | candidate |
| endpoint | 220.196.141.37:20000 | cold-start | connect observed + data bytes | process-owned inode match; repeat across sessions | candidate |
| endpoint | 59.83.207.176:10012 | cold-start | connect observed | socket bytes on this endpoint; process-owned inode match; repeat across sessions | candidate |
| endpoint | 8.8.8.8:65535 | cold-start | connect observed | socket bytes on this endpoint; process-owned inode match; repeat across sessions | candidate |
| http-methodId | methodId 184355 | unlabeled | 1 obs, status 501, bytes 106 | request path/body; wire command mapping; client-side origin | observed-501 |
| http-methodId | methodId 184357 | unlabeled | 1 obs, status 501, bytes 114 | request path/body; wire command mapping; client-side origin | observed-501 |
| http-methodId | methodId 186201 | unlabeled | 1 obs, status 501, bytes 29 | request path/body; wire command mapping; client-side origin | observed-501 |
| http-methodId | methodId 4375 | unlabeled | 1 obs, status 501, bytes 35 | request path/body; wire command mapping; client-side origin | observed-501 |

## Evidence gaps

- Non-443 endpoint(s) 122.96.96.251:10012, 2000:0:0:0:0:0:0:0:65535, 8.8.8.8:65535, 122.96.96.179:10012, 59.83.207.176:10012 observed only at connect level; no socket bytes recorded on them.
- HTTP 501 methodId(s) 4375, 184355, 184357, 186201 recorded by the local server; their wire encoding, request path, and client origin are unproven.
- No runtime backtrace ties any socket call to a managed connector or pack-buffer export.
- No response-before-state-change sequence recorded for account, shop, or battle flows.

## Blockers

- Phases without enough proven rounds: login, lobby, shop, battle.
