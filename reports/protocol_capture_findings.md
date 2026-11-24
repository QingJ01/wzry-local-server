# Protocol capture findings

Generated: 2026-11-24T12:14:37.020Z

This report merges process-owned socket observations and Frida socket events. It records endpoint, direction, and length evidence only. It does not infer frame headers, command IDs, encryption, compression, or schemas from static names or byte previews.

## Evidence status

- Process-socket snapshots: **11**
- Process-owned connections: **29**
- Frida files: **18**
- Frida events: **753**
- Outbound socket events: **75**
- Inbound socket events: **74**
- Attached socket hooks: **180**
- Missing socket hooks: **0**
- Unowned socket-data events: **141**
- Evidence completeness: **insufficient-for-protocol-recovery**

Raw byte previews are not copied into this report. They remain only in local capture files.

## Endpoint evidence

The `game-candidate` label means only that the endpoint is non-HTTP and process/socket or Frida evidence observed it. It is not a proven game gateway.

| Endpoint | Sources | Classification | Confidence | Out / In | Actual length range | Phase |
| --- | --- | --- | --- | ---: | --- | --- |
| 112.64.237.108:443 | frida | http-control-plane | low | 3 / 4 | 93–4545 | cold-start, unlabeled |
| 112.80.129.248:443 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| 112.82.203.33:8081 | frida | game-candidate | low | 3 / 5 | 0–1067 | cold-start |
| 112.86.240.27:443 | frida | http-control-plane | low | 5 / 5 | 93–5108 | cold-start, unlabeled |
| 113.200.41.235:443 | frida, process-socket | http-control-plane | medium | 3 / 3 | 85–4235 | unlabeled |
| 113.201.242.87:443 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| 113.56.189.162:443 | frida, process-socket | http-control-plane | medium | 9 / 5 | 0–5077 | cold-start, unlabeled |
| 113.56.189.246:443 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| 116.128.169.123:443 | frida, process-socket | http-control-plane | medium | 6 / 8 | 93–2808 | cold-start, unlabeled |
| 116.172.77.88:443 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| 122.96.96.179:10012 | frida | game-candidate | low | 0 / 0 | n/a | cold-start |
| 122.96.96.251:10012 | frida | game-candidate | low | 0 / 0 | n/a | unlabeled |
| 123.139.99.91:443 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| 123.139.99.91:80 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| 127.0.0.1:19620 | frida, process-socket | local-adb-reverse | medium | 27 / 27 | 126–1865 | cold-start, unlabeled |
| 140.206.161.106:443 | frida | http-control-plane | low | 3 / 3 | 93–5366 | cold-start |
| 140.207.121.93:8081 | frida | game-candidate | low | 1 / 2 | 0–624 | cold-start |
| 140.207.57.214:443 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| 182.254.116.117:80 | frida | http-control-plane | low | 9 / 9 | 4–220 | cold-start, unlabeled |
| 52.193.139.123:80 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
| 59.83.208.219:443 | frida | http-control-plane | low | 3 / 3 | 51–3020 | cold-start, unlabeled |
| 59.83.209.214:443 | process-socket | http-control-plane | low | 0 / 0 | n/a | unlabeled |
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
- 141 Frida socket-data event(s) lack matching process-owned fd/inode evidence.
- Invalid Frida JSONL lines: **1**.
- Invalid socket snapshot skipped: workspace\observations\process-sockets\00-cold-start-lifecycle.json: Expected a JSON object in workspace\observations\process-sockets\00-cold-start-lifecycle.json
- Invalid socket snapshot skipped: workspace\observations\process-sockets\current-manifest-20261124-154213.json: Socket snapshot workspace\observations\process-sockets\current-manifest-20261124-154213.json has no connections array

## Current blockers

- No numeric message-ID registry is proven.
- No complete frame header, length layout, sequence layout, or command encoding is proven.
- No pre/post encryption or compression boundary is proven.
- No runtime backtrace connects a socket call to a managed connector, pack-buffer export, or semantic message handler.
- No account, battle, or shop response-before-state-change sequence is proven.

## Evidence grading (analyst layer, 2026-11-24)

This section grades what the current evidence actually proves. It is an analyst overlay on the machine tables above; it does not weaken any "not proven" status. Grades: **P0** = contradicts protocol recovery, **P1** = observed but insufficient, **P2** = candidate requiring correlation, **P3** = hypothesis only.

| Signal | Grade | What it proves | What it does not prove |
| --- | --- | --- | --- |
| `::ffff:113.200.41.235:443` TLS 3/3 (len 85–4235) | P1 | A hooked `sendto`/`recvfrom` carried TLS records on a process-owned fd (inode 1183151). | Which MSDK/TDM/control API it serves; any game payload. |
| `127.0.0.1:19620` local-adb-reverse 27/27 | P0-for-game | Our own `adb reverse` loopback to the local Rust server; all traffic is operator probes + `POST /game` 501 replays. | Not a game endpoint; proves only that the loopback channel works. |
| `122.96.96.251:10012` + `122.96.96.179:10012` connect-only | P2 | Two distinct hosts on the same non-443 port observed at `connect` level across sessions. | Any byte on the wire; whether it is the game gateway, a login CDN, or telemetry. |
| `140.207.121.93:8081`, `112.82.203.33:8081` with socket-data | P2 | Bidirectional bytes on a non-443 port; content is `TYPE_COMPRESS`/`getaddrinfo cgi.conn`-style MSDK/TGI binary telemetry, not a protobuf RPC. | Any game-frame semantics; the bytes are SDK telemetry, not `CSReq*` traffic. |
| HTTP 501 `methodId` 4375 / 184355 / 184357 / 186201 | P2 | The local server logged four distinct `methodId` values on its frame channel at 19:52:00–19:52:01 (bytes 35/29/114/106). | Client origin, request path/body, wire encoding, or any semantic meaning — these are server-side "not implemented" records. |
| `8.8.8.8:65535`, `2000:...:65535` connects | P0-for-game | Port 65535 is not a valid TCP service port; these are synthetic/Android-internal connect attempts, not a gateway. | Nothing about the game protocol. |

**Reading of the table:** the only endpoints with real bidirectional bytes are loopback (our own server) and `:8081` (SDK telemetry). The two `:10012` candidates and all `:443` control plane have zero data bytes. No captured frame, header, or command ID exists yet.

## Reference-project mapping (poxxiao) — hypothesis only

The four `methodId` values recorded by the local server were checked against the reference project `D:\project\poxxiao` (`docs/客户端协议/消息索引.tsv`, `协议覆盖.tsv`). **All mappings below are a "reference-project migration assumption" and are not evidence about this client.** poxxiao is a different game; reuse is limited to workflow, tooling, and file layout, never protocol numbers or semantics.

| Observed methodId | poxxiao semantic | poxxiao coverage | Migration hypothesis (not proven) |
| --- | --- | --- | --- |
| 4375 | `REQ_PVP_OPEN_TIME` → `CSReqPvpOpenTime` | probe-501, never routed | If (and only if) the frame channel reuses a poxxiao-style dispatch, this would be a PvP-open-time query. No client-side origin known. |
| 184355 | `REQ_GET_RANK_NODE` → `CSReqGetRankNode` | probe-501, never routed | Rank-node fetch; unproven. |
| 184357 | `REQ_GET_RANK_NODE_LIST` → `CSReqGetRankNodeList` | probe-501, never routed | Rank-node-list fetch; unproven. |
| 186201 | `REQ_GET_ROLE_HANDBOOK` → `CSReqGetRoleHandbook` | routed-200 in poxxiao | Role-handbook fetch; in poxxiao it is one of the few routed methods. Unproven here. |

**Important caveats**
- `CSReqPvpOpenTime`, `CSReqGetRankNode*`, `CSReqGetRoleHandbook` do **not** appear in this client's `global-metadata` strings; there is no static anchor tying these names to the wzry client.
- The four methodIds reached the local server over its own `/game` frame channel; the client-side sender, the serialization, and whether the client even generated them (vs. a replay/probe) are all unknown.
- Treating the poxxiao mapping as a label for the wzry client would be a protocol guess and is explicitly disallowed by the runbook.

## Next-round capture design

Goal: convert exactly one P2 candidate into P1-with-semantics, or falsify it, without touching the device beyond passive capture and without modifying the Frida hooks.

1. **Resolve `:10012` first.** It is the only non-443, non-loopback endpoint seen twice. Required evidence: a `socket-data` event on `122.96.96.*:10012` (currently 0 bytes), its process-owned inode from a synchronous `/proc/<pid>/fd` snapshot taken inside the same round, and the `connect` backtrace. If a phase-tagged `login` or `lobby` capture shows bidirectional bytes on `:10012`, the gateway endpoint finding can move from `not proven` to `candidate→P1`.
2. **Phase-tag the capture filename.** Current Frida files are mostly `unlabeled`; the matrix gate requires phase-tagged rounds. Name the next file `<phase>-round<n>-<timestamp>.ndjson` (`login`, `lobby`) so `tools/capture_matrix.mjs` attributes it.
3. **Correlate methodId with socket bytes.** If the next run produces another HTTP 501 `methodId`, record the wall-clock and match it against any same-millisecond `socket-data` event on a non-loopback endpoint. A matched pair upgrades `observed-501` to a wire-length candidate; the poxxiao label stays a hypothesis until a request body is captured.
4. **Do not pursue `:8081` for game protocol.** It is SDK telemetry; keep it only as a timing oracle.
5. **Gate checklist per round:** PID/UID/inode snapshot at the same second as the Frida `connect` + one `socket-data` in each direction on the candidate endpoint + the phase label in the filename.

## Data quality notes for this grading pass

- 141 of 149 socket-data events lack a matching process-owned inode; the owned subset is concentrated on `113.56.189.162:443`, `116.172.77.88:443`, and loopback. No non-443 endpoint has owned bytes.
- The `8.8.8.8:65535`/`2000:...:65535` connects and the `AF_1` (Unix) sockets are Android-internal noise and are excluded from candidacy.
- Report regenerated by `tools/correlate_protocol_capture.mjs` against all Frida files / socket snapshots present at grading time (753 events, 75 outbound / 74 inbound socket-data, 29 process-owned connections); the grading, mapping, and design sections are analyst additions and are not produced by the tool.
