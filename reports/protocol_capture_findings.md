# Protocol capture findings

## Current evidence

As of the 2026-11-24 15:42 CST snapshot:

- The target process `com.tencent.tmgp.sgame` was alive as PID `53389`, but the foreground window was the unrelated `com.tencent.xfight` privacy-policy activity.
- The only available socket evidence was a non-root global table: established HTTPS connections existed, but no `/proc/<pid>/fd` inode mapping proved they belonged to the game.
- No Frida JSONL file was produced, so no hook attach, connect, direction, or byte length evidence exists.
- No process-owned endpoint, gateway, frame boundary, message ID, encryption boundary, account flow, battle flow, or shop flow is proven.

The normalized quality result is stored locally in `workspace/analysis/protocol-capture/correlation-current.json`; raw captures remain under `workspace/observations/`.

Do not upgrade the global HTTPS endpoints or the process liveness observation into protocol evidence. The next valid capture must keep the target UI in the foreground and capture root-readable fd/inode ownership, or produce a complete Frida session log.

- `workspace/observations/` contains no real process-socket or Frida capture set at the time of this report.
- The only existing observation is `workspace/observations/sample-proc-net.txt`, a small fixture used by `tools/Test-ObserveScripts.ps1`; it is not game traffic.
- No gateway, frame header, message ID, encryption, compression, account, battle, or shop schema is recovered.

## Correlation tool

Use `tools/correlate_protocol_capture.mjs` to merge future captures without guessing protocol semantics:

```powershell
node .\tools\correlate_protocol_capture.mjs `
  --sockets .\workspace\observations\process-sockets `
  --frida .\workspace\observations\frida `
  --output .\workspace\analysis\protocol-capture\correlation.json `
  --markdown .\reports\protocol_capture_findings.md
```

The tool emits:

- Input file identity, size, and SHA-256.
- Process-owned endpoint evidence from `Observe-ProcessSockets.ps1`.
- Frida endpoint, direction, socket function, and syscall length evidence from `wzry-network.js`.
- Endpoint classifications: local server, HTTP control plane, or **game candidate only**.
- Per-flow evidence gates for account, battle, and shop.
- Explicit `not proven` / `not recovered` findings for gateway, frame, command ID, and encryption.

The tool also reports evidence quality:

- Whether Frida hook attach events and missing-export events were recorded.
- How many socket-data events have matching process fd/inode ownership.
- How many supplied socket JSON files are not valid socket snapshots and are therefore skipped.

The tool intentionally does **not** parse bytes, derive frame boundaries, map semantic names to numeric IDs, or infer encryption. Those claims require runtime call-stack and buffer-boundary evidence.

## Static anchors

The correlation targets are maintained in `tools/config/protocol_anchor_catalog.json`. They include:

- `libGameCore.so` socket imports and C#/C++ pack-buffer exports.
- IL2CPP connector and `commandId` semantic anchors.
- Account, battle, and shop `SCPKG_*` names.

These are high- or medium-confidence static anchors, but none is dynamically correlated until a capture contains the matching phase, socket event, and call stack.

## Evidence gates

Every flow remains blocked until the corresponding runbook gate is satisfied:

- **Account**: repeated process-owned endpoint evidence, request/response timing, stable framing, command grouping, and response-before-state-change.
- **Battle**: endpoint continuity across room/loading/battle, bidirectional rates, stable framing under fragmentation, distinct frame/input/settlement evidence, and reproducibility.
- **Shop**: distinct open/list/purchase actions, response before UI or state mutation, and balance/inventory confirmation.

See `reports/dynamic_capture_runbook.md` and `reports/protocol_call_chain.md` for the full capture and confidence rules.
