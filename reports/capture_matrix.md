# Dynamic capture matrix

Generated: 2026-11-24T11:57:18.112Z

This report indexes observed capture rounds per UI phase and evaluates them against the runbook gates. A phase is **complete** only when its minimum rounds are met with process-owned, bidirectional, phase-specific evidence. Nothing here asserts a protocol field is proven.

## Phase status

| Phase | Min rounds | Observed rounds | Complete rounds | Status |
| --- | ---: | ---: | ---: | --- |
| cold-start | 2 | 0 | 0 | pending |
| login | 2 | 0 | 0 | pending |
| lobby | 2 | 0 | 0 | pending |
| shop | 2 | 0 | 0 | pending |
| battle | 2 | 0 | 0 | pending |

## Round detail

### cold-start

Gate: A successful round needs a PID/UID-owned socket snapshot plus a Frida session-started event. No non-443 game endpoint is expected at this phase.

- No observed rounds yet.

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
| sockets | workspace\observations\process-sockets\00-cold-start-lifecycle.json | cold-start | 0 | 0 owned, pid n/a |
| sockets | workspace\observations\process-sockets\com.tencent.tmgp.sgame-20261124-191554.json | unlabeled | 1 | 1 owned, pid 14166 |
| sockets | workspace\observations\process-sockets\com.tencent.tmgp.sgame-20261124-192300.json | unlabeled | 1 | 1 owned, pid 15250 |
| sockets | workspace\observations\process-sockets\com.tencent.tmgp.sgame-20261124-192953.json | unlabeled | 1 | 1 owned, pid 16101 |
| sockets | workspace\observations\process-sockets\com.tencent.tmgp.sgame-20261124-193503.json | unlabeled | 1 | 1 owned, pid 17193 |
| sockets | workspace\observations\process-sockets\com.tencent.tmgp.sgame-20261124-194400.json | unlabeled | 1 | 1 owned, pid 19097 |
| sockets | workspace\observations\process-sockets\current-manifest-20261124-154213-normalized.json | unlabeled | 0 | 0 owned, pid 53389 |
| sockets | workspace\observations\process-sockets\current-manifest-20261124-154213.json | unlabeled | 0 | 0 owned, pid 53389 |
| sockets | workspace\observations\process-sockets\post-consent-20261124.json | consent | 1 | 1 owned, pid 17193 |
| http | workspace\observations\post-consent-20261124-http-observations.json | consent | 221 | 200:3,401:218 |

## Blockers

- Phases without enough proven rounds: cold-start, login, lobby, shop, battle.
