# Protocol capture findings

Generated: 2026-11-24T12:19:20.042Z

This report merges process-owned socket observations and Frida socket events. It records endpoint, direction, and length evidence only. It does not infer frame headers, command IDs, encryption, compression, or schemas from static names or byte previews.

## Evidence status

- Process-socket snapshots: **13**
- Process-owned connections: **50**
- Frida files: **19**
- Frida events: **2585**
- Outbound socket events: **170**
- Inbound socket events: **1471**
- Attached socket hooks: **196**
- Missing socket hooks: **0**
- Unowned socket-data events: **1588**
- Evidence completeness: **insufficient-for-protocol-recovery**

Raw byte previews are not copied into this report. They remain only in local capture files.

## Endpoint evidence

The `game-candidate` label means only that the endpoint is non-HTTP and process/socket or Frida evidence observed it. It is not a proven game gateway.

| Endpoint | Sources | Classification | Confidence | Out / In | Actual length range | Phase |
| --- | --- | --- | --- | ---: | --- | --- |
| 112.64.237.108:443 | frida | http-control-plane | low | 3 / 4 | 93–4545 | cold-start, unlabeled |
| 112.80.129.248:443 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| 112.82.203.33:8081 | frida | game-candidate | low | 8 / 12 | 0–1083 | cold-start |
| 112.86.240.27:443 | frida | http-control-plane | low | 5 / 5 | 93–5108 | cold-start, unlabeled |
| 113.200.41.235:443 | frida, process-socket | http-control-plane | medium | 3 / 3 | 85–4235 | unlabeled |
| 113.201.242.87:443 | frida, process-socket | http-control-plane | medium | 1 / 15 | 23–13452 | cold-start, unlabeled |
| 113.56.189.162:443 | frida, process-socket | http-control-plane | medium | 10 / 6 | 0–5077 | cold-start, unlabeled |
| 113.56.189.246:443 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| 114.222.112.57:443 | frida, process-socket | http-control-plane | medium | 3 / 3 | 93–3961 | cold-start, unlabeled |
| 116.128.169.123:443 | frida, process-socket | http-control-plane | medium | 9 / 12 | 93–4096 | cold-start, unlabeled |
| 116.128.171.60:443 | frida | http-control-plane | low | 10 / 5 | 31–5084 | cold-start |
| 116.172.77.88:443 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| 122.96.96.179:10012 | frida | game-candidate | low | 0 / 0 | n/a | cold-start |
| 122.96.96.251:10012 | frida | game-candidate | low | 0 / 0 | n/a | unlabeled |
| 123.139.99.91:443 | frida, process-socket | http-control-plane | medium | 3 / 4 | 242–2824 | cold-start, unlabeled |
| 123.139.99.91:80 | frida, process-socket | http-control-plane | medium | 3 / 4 | 196–3495 | cold-start, unlabeled |
| 127.0.0.1:19620 | frida, process-socket | local-adb-reverse | medium | 48 / 48 | 126–5473 | cold-start, unlabeled |
| 140.206.161.106:443 | frida | http-control-plane | low | 3 / 3 | 93–5366 | cold-start |
| 140.206.162.159:443 | frida | http-control-plane | low | 25 / 209 | 0–5084 | cold-start |
| 140.207.121.93:8081 | frida | game-candidate | low | 1 / 2 | 0–624 | cold-start |
| 140.207.57.214:443 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| 153.3.150.103:443 | frida, process-socket | http-control-plane | medium | 3 / 3 | 93–5099 | cold-start, unlabeled |
| 182.254.116.117:80 | frida | http-control-plane | low | 14 / 15 | 4–220 | cold-start, unlabeled |
| 220.196.141.37:20000 | frida | game-candidate | low | 8 / 1108 | 0–1280 | cold-start |
| 52.193.139.123:80 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| 59.83.207.176:10012 | frida | game-candidate | low | 0 / 0 | n/a | cold-start |
| 59.83.208.219:443 | frida | http-control-plane | low | 3 / 3 | 51–3020 | cold-start, unlabeled |
| 59.83.209.214:443 | frida, process-socket | http-control-plane | medium | 4 / 4 | 93–5630 | cold-start, unlabeled |
| 8.8.8.8:65535 | frida | game-candidate | low | 0 / 0 | n/a | cold-start |
| 91.99.139.123:80 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| 2000:0:0:0:0:0:0:0:65535 | frida | game-candidate | low | 0 / 0 | n/a | cold-start |

## Protocol findings

| Finding | Status | Evidence restriction |
| --- | --- | --- |
| Gateway endpoint | not proven | A non-HTTP endpoint is only a candidate; repeated process-owned observations or a runtime connect backtrace is required. |
| Frame boundary | not recovered | Only observed socket read/write lengths are recorded; no header interpretation is permitted without managed pack/unpack evidence. |
| Direction evidence | partial | Directions come only from hooked socket calls and are not semantic request/response labels. |
| Length evidence | partial | Lengths are syscall results and may contain partial frames, coalesced frames, or non-protocol bytes. |
| Command ID | not recovered | The static commandId field is not mapped to bytes or numeric values. |
| Encryption / compression | not recovered | No pre-cipher and post-cipher buffers, compression boundary, or repeated call-chain evidence is present. |

## Flow gates

| Flow | Status | Bidirectional | Process-owned | Repeated socket evidence |
| --- | --- | --- | --- | --- |
| account | needs-semantic-confirmation | true | true | true |
| battle | needs-semantic-confirmation | true | true | true |
| shop | needs-semantic-confirmation | true | true | true |

A `needs-semantic-confirmation` gate still cannot pass: every flow requires consistent command grouping and a response-before-state-change sequence. No flow is complete in this report unless those conditions and the runbook gates are explicitly added.

## Static anchor correlation

Static anchors are listed as correlation targets. Correlation requires runtime call stacks, matching phases, and socket events; it is not established merely because a capture exists.

| Flow / role | Anchor | Static confidence | Dynamic correlation |
| --- | --- | --- | --- |
| account | SCPKG_CMD_GAMELOGINRSP | high | not correlated |
| battle | SCPKG_MATCH_RSP | high | not correlated |
| battle | SCPKG_MULTGAME_BEGINFIGHT | high | not correlated |
| shop | SCPKG_CMD_SHOPDETAIL | high | not correlated |
| shop | SCPKG_CMD_SHOPBUY | high | not correlated |
| libGameCore.so import: endpoint | connect | high | not correlated |
| libGameCore.so import: outbound | send | high | not correlated |
| libGameCore.so import: inbound | recv | high | not correlated |
| libGameCore.so export: managed-pack-buffer | PushCsBuffer | medium | not correlated |
| libGameCore.so export: native-pack-buffer | PopFifoCppPackBuffer | medium | not correlated |
| libil2cpp.so metadata: connector | LobbyConnector | medium | not correlated |
| libil2cpp.so metadata: dispatch-field | commandId | high | not correlated |

## Data quality

- 2 supplied socket JSON file(s) were skipped because they were not valid socket snapshots.
- At least one Frida file has no recognized UI phase in its filename.
- Capture parsing encountered 1 invalid JSONL line(s).
- 1588 Frida socket-data event(s) lack matching process-owned fd/inode evidence.
- Invalid Frida JSONL lines: **1**.
- Invalid socket snapshot skipped: workspace\observations\process-sockets\00-cold-start-lifecycle.json: Expected a JSON object in workspace\observations\process-sockets\00-cold-start-lifecycle.json
- Invalid socket snapshot skipped: workspace\observations\process-sockets\current-manifest-20261124-154213.json: Socket snapshot workspace\observations\process-sockets\current-manifest-20261124-154213.json has no connections array

## Current blockers

- No numeric message-ID registry is proven.
- No complete frame header, length layout, sequence layout, or command encoding is proven.
- No pre/post encryption or compression boundary is proven.
- No runtime backtrace connects a socket call to a managed connector, pack-buffer export, or semantic message handler.
- No account, battle, or shop response-before-state-change sequence is proven.
