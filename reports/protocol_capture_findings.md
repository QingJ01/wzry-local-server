# Protocol capture findings

Generated: 2026-11-24T12:05:09.948Z

This report merges process-owned socket observations and Frida socket events. It records endpoint, direction, and length evidence only. It does not infer frame headers, command IDs, encryption, compression, or schemas from static names or byte previews.

## Evidence status

- Process-socket snapshots: **7**
- Process-owned connections: **6**
- Frida files: **15**
- Frida events: **231**
- Outbound socket events: **6**
- Inbound socket events: **3**
- Attached socket hooks: **132**
- Missing socket hooks: **0**
- Unowned socket-data events: **3**
- Evidence completeness: **insufficient-for-protocol-recovery**

Raw byte previews are not copied into this report. They remain only in local capture files.

## Endpoint evidence

The `game-candidate` label means only that the endpoint is non-HTTP and process/socket or Frida evidence observed it. It is not a proven game gateway.

| Endpoint | Sources | Classification | Confidence | Out / In | Actual length range | Phase |
| --- | --- | --- | --- | ---: | --- | --- |
| 122.96.96.251:10012 | frida | game-candidate | low | 0 / 0 | n/a | unlabeled |
| 0:0:0:0:0:ffff:71c8:29eb:443 | frida | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| 0000:0000:0000:0000:FFFF:0000:57F2:C971:443 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| 0000:0000:0000:0000:FFFF:0000:EB29:C871:443 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| ::ffff:113.200.41.235:443 | frida | http-control-plane | low | 3 / 3 | 85–4235 | unlabeled |

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
- 3 Frida socket-data event(s) lack matching process-owned fd/inode evidence.
- Invalid Frida JSONL lines: **1**.
- Invalid socket snapshot skipped: workspace\observations\process-sockets\00-cold-start-lifecycle.json: Expected a JSON object in workspace\observations\process-sockets\00-cold-start-lifecycle.json
- Invalid socket snapshot skipped: workspace\observations\process-sockets\current-manifest-20261124-154213.json: Socket snapshot workspace\observations\process-sockets\current-manifest-20261124-154213.json has no connections array

## Current blockers

- No numeric message-ID registry is proven.
- No complete frame header, length layout, sequence layout, or command encoding is proven.
- No pre/post encryption or compression boundary is proven.
- No runtime backtrace connects a socket call to a managed connector, pack-buffer export, or semantic message handler.
- No account, battle, or shop response-before-state-change sequence is proven.
