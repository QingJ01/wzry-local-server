# ADB reverse local HTTP verification — 2026-11-24

Scope: confirm that local HTTP traffic over `adb reverse` is observable from both
the Rust server journal and a Frida attach capture on `192.168.5.102:5555`. No
`tools/frida/wzry-network.js` changes were made; the hook already emits
`socketClass: 'local-adb-reverse'`.

## Environment

- `adb reverse --list` already carried `tcp:19620 -> tcp:19620` (plus 19621/19622).
- Rust `wzry-local-server` was bound to `127.0.0.1:19620`; `allow_loopback_game_sessions`
  defaults on, so `GET /game/events?after=0` answers 200 without a bearer token.
- Device shell has no `curl`/`wget`; toybox `nc` was used for the device-side probe.
- Frida server `wzry-frida-server-17.27.5` already ran on `127.0.0.1:27042`.

## Live evidence

Device-side probe (toybox `nc`), while a 20 s Frida attach capture
(`workspace/observations/frida/adb-reverse-probe.ndjson`) was active:

```sh
printf 'GET /game/events?after=0 HTTP/1.0\r\n\r\n' | nc -w 3 127.0.0.1 19620
printf 'GET /health HTTP/1.0\r\n\r\n'                   | nc -w 3 127.0.0.1 19620
```

Both requests were recorded twice:

- Rust `GET /debug/observations` shows `GET /health HTTP/1.1` and
  `GET /game/events?after=0 HTTP/1.1` with status 200 at
  `recordedAtUnixMs` ≈ 1795522218938/1795522219019.
- The concurrent Frida attach capture logged `connect` to
  `AF_INET 127.0.0.1:19620` with `socketClass: 'local-adb-reverse'` plus
  bidirectional `socket-data` and `socket-close` events.

## App-side ADB reverse traffic (unexpected but verified)

The game process itself already polls the reverse endpoint. During the same
capture, `com.tencent.tmgp.sgame` issued repeated `POST` requests through
`127.0.0.1:19620` (descriptor 239, inode 1245702/1245714):

- `POST /padx/comm/cloud_center_ctl/?timestamp=…&appid=1104466820&sig=…`
- `POST /padx/logcollect/mlog?timestamp=…`
- `POST /padx/notice/gather_data/?timestamp=…`

Each `send`/`sendto` (~1353 B) was answered by a 126 B `HTTP/1.1 404` from the
Rust server, and the same requests appear in `/debug/observations`. This
confirms the patched client routes its control-plane calls over ADB reverse as
intended; 404 is expected because these `/padx/*` routes are not implemented.

## Correlator fix

`tools/correlate_protocol_capture.mjs` previously split one physical endpoint
into up to three records and misclassified the reverse endpoint:

- Frida `connect` events emit expanded IPv4-mapped IPv6 addresses such as
  `0:0:0:0:0:ffff:7f00:1`, while `socket-data` peer addresses look like
  `::ffff:127.0.0.1` or plain `127.0.0.1` (family `null` → `unknown`).
- `/proc/net/tcp6` prints each 32-bit word in host byte order, so the mapped
  loopback appeared as `0000000000000000FFFF00000100007F` — the previous
  big-endian `ipv6ToBytes` decode never recognised it.

Fixes (no hook changes):

- `canonicalAddress`/`canonicalFamily` now collapse `::ffff:a.b.c.d`,
  expanded `0:0:0:0:0:ffff:…`, and `family: unknown` peer addresses onto one
  `AF_INET` key; endpoint records store the canonical form.
- `parseProcAddress` decodes `/proc/net/tcp6` words little-endian per 32-bit
  word, so snapshot connections like `FFFF0000EB29C871` resolve to
  `113.200.41.235` and now merge with matching Frida events.
- `endpointClassification` labels loopback `local-adb-reverse` (was
  `local-server`), and `parseFridaEvent`/`recordEndpoint` retain the hook's
  `socketClass` field in a new `socketClasses` output list; a
  `local-adb-reverse` class overrides the classification when needed.

Result on live data: `127.0.0.1:19620` is now a single `local-adb-reverse`
endpoint with `frida+process-socket` sources, 81 Frida events, both directions,
medium confidence. `113.200.41.235:443` and `116.128.169.123:443` also merged
into `frida+process-socket` medium-confidence records.

## Regression tests

`tools/Test-ProtocolCorrelation.ps1` gained an ADB-reverse fixture: a tcp6
snapshot row (`…FFFF0000…0100007F`), an expanded-IPv6 `connect` event with
`socketClass: 'local-adb-reverse'`, and two `socket-data` events on
`::ffff:127.0.0.1:19620`. The test asserts a single canonical
`AF_INET 127.0.0.1:19620` endpoint classified `local-adb-reverse` with merged
`frida`+`process-socket` sources and retained `socketClasses`.

Passing: `Test-ProtocolCorrelation.ps1`, `Test-ProtocolCaptureScripts.ps1`,
`Test-CaptureMatrix.ps1`, `Test-ObserveScripts.ps1`, `Test-GamecoreAnalyzer.ps1`,
`Test-Il2CppAnalyzer.ps1`.

## Boundaries kept

- `tools/frida/wzry-network.js` untouched (no core hook edits).
- No changes under `tools/workspace/`; sibling-owned `capture_matrix.mjs` /
  `Test-CaptureMatrix.ps1` / regenerated reports were left for their owners.
- Probe used read-only `nc`; no device state was modified beyond the two
  loopback requests.
