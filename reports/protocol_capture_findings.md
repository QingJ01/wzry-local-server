# Protocol capture findings

## Current evidence

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
