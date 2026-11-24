# WZRY protocol call-chain and hook-point map

## Scope and confidence

This report combines the APK `3.81.1.8` native libraries, IL2CPP metadata, and the existing read-only observation plans. It does **not** claim that account, battle, or shop protocol traffic has been captured. No numeric game message ID, game gateway, frame header, or game-frame encryption algorithm is proven yet.

Confidence levels:

- **High**: directly reproducible ELF symbol, import, metadata string, or hash evidence.
- **Medium**: a named function or boundary is a strong candidate but lacks a runtime call chain.
- **Low**: semantic inference only; never use it as a patch basis.

Offset semantics:

- ELF offsets in this report are virtual addresses relative to the module load base. At runtime, resolve them as `Module.findBaseAddress(module) + offset`.
- Undefined imports have no static address in the importing library. Resolve them through the exporting module, normally `libc.so`.
- `global-metadata.dat` offsets are file/string-blob offsets. They are not native code addresses.

## Evidence identity

| Artifact | Size | SHA-256 | Static result |
| --- | ---: | --- | --- |
| `workspace/apk/3.81.1.8.apk` | 460,348,136 | `A016D941A3D7BA0A8FC976DAE6FE744EFEC85835A16DD10928B65A9C7E19EE5D` | Fixed APK identity |
| `lib/arm64-v8a/libGameCore.so` | 58,805,320 | `58E36F26973C05B2998F50C206A992176D33AFB271F2D4289F2D49D0883708E5` | Game core bridge and socket imports |
| `lib/arm64-v8a/libil2cpp.so` | 157,700,152 | `A77F2DFAC82FAEEF1CC291867245C0365C9345B8DFF5668F7170A5EE4AC7C89D` | IL2CPP runtime, connector semantics in metadata |
| `lib/arm64-v8a/libgcloudcore.so` | 1,493,792 | `1707EED6CE1EF8AC0F0229061595087B34E4B2FA79E926511EF7BD4320E11588` | HTTP control plane and TEA implementations |
| `assets/bin/Data/Managed/Metadata/global-metadata.dat` | 41,405,108 | `C64EC24DBB1FEBC3F1EDF9CD6F38F572B7EA767A0EFB548DDD5425EB3F48E99B` | Metadata v23 / IL2CPP 24.1; protected registration |

Il2CppDumper identifies metadata v23 and IL2CPP 24.1, but cannot recover `CodeRegistration` or `MetadataRegistration`; it reports that the file may be protected. `libGameCore.so` also contains `ELF_HOOK_BRIDGE_*`, `g_tprt_*`, and `stub_send` / `stub_recv` strings. Therefore static metadata alone must not be treated as a complete method or message-ID registry.

## Candidate call chains

### Game-frame chain

The strongest static model is:

```text
C# ApolloConnector / LobbyConnector / lobby message handlers
  -> libil2cpp.so runtime
  -> libGameCore.so C#/C++ pack-buffer bridge
  -> libc socket / connect / send / recv
  -> game gateway
```

This is a model, not a proven call chain. The bridge exports and socket imports are high-confidence evidence; the arrows between them require a runtime backtrace.

### GCloud control-plane chain

The separate GCloud chain is:

```text
Manifest / C# / Java SDK configuration
  -> libgcloudcore.so UrlRequest / WWWTask / ConfigureImpl
  -> HTTPS control plane
```

Known endpoints are MSDK, TDM Router, GCloud RemoteConfig, and GTrace. GCloud TEA and symmetric encryption are control-plane candidates until a game-frame buffer is shown to call them.

## Static hook candidates

### `libGameCore.so`

| Virtual address | Candidate | Confidence | Purpose |
| ---: | --- | --- | --- |
| `0x1D898D8` | `GameCoreInfo_IsDebugCore` | High | Core build metadata |
| `0x1D898EC` | `GameCoreInfo_Revision` | High | Core revision |
| `0x1D89900` | `GameCoreInfo_CoreHash` | High | Core integrity identity |
| `0x1D8991C` | `GameCoreInfo_SGWGUIDHash` | Medium | SGW/TDR protocol identity |
| `0x1D89938` | `GameCoreInfo_TDRGUIDHash` | Medium | TDR protocol identity |
| `0x1D8994C` | `SGC_GetPlayerSettleData` | Medium | Settlement boundary |
| `0x1D89960` | `SGC_GetPlayerReportQuitACNTData` | Medium | Quit/account report boundary |
| `0x1D89974` | `SGC_GetPlayerTLogData` | Medium | Player telemetry boundary |
| `0x1D89988` | `SGC_GetPlayerMapExInfo` | Medium | Map/battle extension boundary |
| `0x1DBF734` | `FlushCsImmediatePackBuffer` | Medium | C# immediate buffer flush |
| `0x1DBF758` | `PushCsBuffer` | Medium | C# to C++ buffer handoff |
| `0x1DBF780` | `CommitCsBuffer` | Medium | Packed-buffer commit |
| `0x1DBF7CC` | `PopFifoCppPackBuffer` | Medium | C++ FIFO buffer read |
| `0x1DBF7F0` | `PushCppImmediatePackBuffer` | Medium | C++ immediate buffer write |
| `0x1DBF80C` | `SFFlushCppImmediatePackBuffer` | Medium | C++ immediate flush |
| `0x1DBF844` | `SFPushCsImmediatePackBuffer` | Medium | C# immediate buffer write |
| `0x1E24140` | `UnityPluginLoad` | High | Native plugin lifecycle |
| `0x1E2418C` | `UnityPluginUnload` | High | Native plugin lifecycle |
| `0x2352504` | `JNI_OnLoad` | High | Android JNI entry |
| `0x23781C0` | `LZ4_compress_default` | High export / low game use | Compression capability |
| `0x237BD78` | `LZ4_decompress_safe` | High export / low game use | Decompression capability |

Undefined imports in `libGameCore.so`: `socket`, `connect`, `send`, `recv`, `select`, `poll`, `read`, `write`, `writev`, and `close`. These prove direct BSD socket capability, but not which business call site uses them.

### `libil2cpp.so`

| Virtual address | Candidate | Confidence | Purpose |
| ---: | --- | --- | --- |
| `0x77F42C0` | `il2cpp_init` | High | IL2CPP initialization boundary |
| `0x77F4428` | `il2cpp_resolve_icall` | High | Runtime call resolution |
| `0x77F4458` | `il2cpp_assembly_get_image` | High | Runtime image traversal |
| `0x77F44A4` | `il2cpp_class_get_methods` | High | Runtime method enumeration |
| `0x77F47E4` | `il2cpp_domain_get` | High | Runtime domain access |
| `0x77F47F0` | `il2cpp_domain_get_assemblies` | High | Runtime assembly enumeration |
| `0x77F49AC` | `il2cpp_method_get_name` | High | Runtime method naming |
| `0x77F4AE4` | `il2cpp_string_new` | High | Managed string creation |
| `0x77F4B08` | `il2cpp_thread_attach` | High | Runtime thread attachment |

Undefined imports include `socket`, `connect`, `send`, `sendto`, `recvfrom`, `read`, `write`, `writev`, `poll`, `close`, and `shutdown`. The absence of a plain `recv` import does not disprove receive traffic: `recvfrom` and `read` cover common receive paths.

### `libgcloudcore.so`

| Virtual address | Candidate | Confidence | Purpose |
| ---: | --- | --- | --- |
| `0x5B668` | `GCloud::ABase::TeaEncryptECB` | High export / medium game relation | Control-plane TEA |
| `0x5B744` | `GCloud::ABase::TeaDecryptECB` | High export / medium game relation | Control-plane TEA |
| `0x5B814` | `GCloud::ABase::TeaEncryptECB3` | High export / medium game relation | Control-plane TEA |
| `0x5B8EC` | `GCloud::ABase::TeaDecryptECB3` | High export / medium game relation | Control-plane TEA |
| `0x5B9BC` | `GCloud::ABase::oi_symmetry_encrypt` | High export / medium game relation | Control-plane symmetric encryption |
| `0x5BC48` | `GCloud::ABase::oi_symmetry_decrypt` | High export / medium game relation | Control-plane symmetric decryption |
| `0x5BE4C` | `GCloud::ABase::oi_symmetry_encrypt2_len` | High export / medium game relation | Encrypted-length helper |
| `0x5BE78` | `GCloud::ABase::oi_symmetry_encrypt2` | High export / medium game relation | Control-plane symmetric encryption |
| `0x5C1BC` | `GCloud::ABase::oi_symmetry_decrypt2` | High export / medium game relation | Control-plane symmetric decryption |
| `0x78878` | `ABase::WWWTaskBase::WWWTaskBase` | High export | HTTP task lifecycle |
| `0x78020` | `ABase::WWWTaskBase::GetUrl` | High export | HTTP URL access |
| `0x78038` | `ABase::WWWTaskBase::SetUrl` | High export | HTTP URL mutation |
| `0x7A9A0` | `ABase::UrlRequest::Initialize` | High export | HTTP request setup |
| `0x7AF38` | `ABase::UrlRequest::Get` | High export | HTTP GET |
| `0x7B24C` | `ABase::UrlRequest::Post` | High export | HTTP POST |
| `0x8508C` | `GCloud::ConfigureImpl::SetUrl` | High export | RemoteConfig URL mutation |
| `0x86B14` | `GCloud::ConfigureImpl::Request` | High export | RemoteConfig request |

These functions are useful for separating HTTPS control-plane traffic from game-frame traffic. They are not game protocol handlers.

## Metadata call-chain and dispatch anchors

`tools/analyze_il2cpp.mjs` parses metadata v23 with fixed record layouts and verifies target type records before printing their methods and fields. It emits:

- `il2cpp_analysis.json`: artifact hashes, table boundaries, target inventories, runtime exports, imports, and string-literal hits.
- `target-index.txt`: method index, name, token, and parameters, plus field index and name.
- `string-hits.txt`: string-literal evidence used in this section.

The fixed v23 record sizes are `methods=56`, `parameters=16`, `fields=16`, `typeDefinitions=104`, `images=24`, and `assemblies=32` bytes. String and raw data regions have no fixed record size. The script is a reproducibility aid, not a runtime method-address resolver.

`global-metadata.dat` contains the managed names that are absent from native strings. Important file/string offsets:

| Metadata offset | Anchor | Confidence | Meaning |
| ---: | --- | --- | --- |
| `0x5DBF8` | `- BeginConnectHost:` | High | DNS/host connection logging path |
| `0x5DCB6` | ` BeginConnectSocket:` | High | Socket connection logging path |
| `0x5DCF7` | `SocketConnectState:` | High | Connection state machine |
| `0x5DDD1` | `ConnectAlternateIp` | High | Alternate-address selection |
| `0x5DE34` | `_bodyLength` | High | Receive body-length field |
| `0x5DEF9` | `StartAsyncReceive Complete` | High | Async receive completion |
| `0x5DF5E` | `StartAsyncReceive... totalReceiveDataLength` | High | Receive length accounting |
| `0x5DFEC` | `StartAsyncSend Complete` | High | Async send completion |
| `0x5E03C` | `StartAsyncSend... totalSendDataLength` | High | Send length accounting |
| `0x5E118` | `alreadyReadBodyLength / totalReadLength` | High | Framing/reassembly candidate |
| `0x619F5` | `SetSecurityInfo encyptMethod / keyMakingMethod / dh` | High | Security negotiation log |
| `0x11A0C9` | `LobbyConnector` / `TDR Unpack lobbyMsg Error` | High | Lobby protocol boundary |
| `0x11A21B` | `LobbyConnectorService_SvrConnect...` | High | Lobby server connection state |
| `0x11A904` | `LobbyLogin_OnLoginSuccess` and login events | High | Login state machine |
| `0x16B9C5` | `dwSenderID ... dwCmdType ... TDR Unpack UGC_CMD_PKG` | High | Sender/command unpack boundary |
| `0x213A55` | `DestroyApolloConnector` | High | Connector lifecycle |
| `0x214B35` | `ApolloConnector` | High | Managed connector name |
| `0x214CC4` | `SetSecurityInfo` | High | Security method name |
| `0x214DFD` | `ReadUdpData` | High | UDP read method name |
| `0x237AFB` | `BeginConnectHost` | High | Connect method name |
| `0x237B1D` | `BeginConnectSocket` | High | Connect method name |
| `0x237D1D` | `StartAsyncReceive` | High | Receive method name |
| `0x237D57` | `StartAsyncSend` | High | Send method name |
| `0x237E90` | `_bodyLength` field name | High | Framing field name |
| `0x2381A4` | `commandId` | High | Dispatch identifier field name |
| `0x421EA7` | `LobbyConnector` | High | Managed connector type name |
| `0x62CBFF` | `OnLobbyConnectorFailed` | High | Connector failure callback |

The presence of `commandId`, `dwCmdType`, `dwMsgID`, `MsgID`, and TDR pack/unpack strings makes a command/ID dispatcher highly likely. The numeric mapping is still unknown.

## Semantic message anchors

These names identify candidate request/response classes, not numeric IDs:

| Flow | Metadata anchor | Metadata offset |
| --- | --- | ---: |
| Account | `SCPKG_CMD_GAMELOGINRSP` | `0x2F066C` |
| Account | `SCPKG_CMD_GAMELOGOUTRSP` | `0x2F0494` |
| Account | `SCPKG_CMD_GAMELOGINLIMIT` | `0x2F0E20` |
| Account | `SCPKG_CMD_LOGINFINISHNTF` | `0x2F0E67` |
| Account | `SCPKG_GAMELOGINDISPATCH` | `0x2F3976` |
| Account | `SCPKG_NTF_ACNT_REGISTER` | `0x2F3998` |
| Account | `SCPKG_NTF_ACNT_INFO_UPD` | `0x2F3A17` |
| Account | `SCPKG_ACNTDETAILINFO_RSP` | `0x2FDF9E` |
| Battle | `SCPKG_MULTGAME_BEGINLOAD` | `0x2F2643` |
| Battle | `SCPKG_MULTGAME_BEGINFIGHT` | `0x2F2801` |
| Battle | `SCPKG_MATCH_RSP` | `0x2FEBE6` |
| Battle | `SCPKG_START_MULTI_GAME_RSP` | `0x2FEF60` |
| Battle | `SCPKG_GAME_OVER_RSP` | `0x2F3929` |
| Battle | `SCPKG_SUBGAME_OVER_RSP` | `0x2F394D` |
| Shop | `SCPKG_CMD_SHOPBUY` | `0x2FA869` |
| Shop | `SCPKG_CMD_SHOPDETAIL` | `0x2FA8B7` |
| Shop | `SCPKG_NTF_CLRSHOPBUYLIMIT` | `0x2FA887` |
| Shop | `SCPKG_NTF_SHOPTIMEOUT` | `0x2FA8FB` |
| Shop | `SCPKG_ACNT_SHOP_DISCOUNT_PACKBUYINFO_NTF` | `0x310AF6` |
| Currency | `CS_ACNTINFO_UPD_COIN` | `0x27CA61` |
| Currency | `CS_ACNTINFO_UPD_DIAMOND` | `0x27CA76` |

Do not map these names to IDs by enumeration order, protobuf descriptor convention, or the reference project. They are labels to correlate with observed command fields.

## Static-to-dynamic route

### 1. Establish process-owned endpoints

Use `tools/Observe-ProcessSockets.ps1` at each UI state. The required ownership tuple is:

```text
PID + UID + fd -> socket inode -> /proc/<pid>/net/{tcp,tcp6,udp,udp6} -> remote endpoint
```

A 443 endpoint is control-plane evidence. A persistent non-443 endpoint is a game candidate, not a protocol proof.

### 2. Capture raw socket I/O

Use `tools/frida/wzry-network.js` only from a cold start and only after the operator explicitly approves Frida. The script emits one JSON object per line with:

- ISO-8601 timestamp.
- Descriptor and resolved peer endpoint.
- Direction: `outbound` or `inbound`.
- Requested and actual byte lengths.
- Up to 64 bytes of hexadecimal preview, with truncation flag.
- Calling function: `send`, `sendto`, `write`, `writev`, `recv`, `recvfrom`, or `read`.

The script tracks `socket`, `connect`, and close/reuse, and resolves the peer with `Socket.peerAddress(fd)` at I/O time. This prevents attributing ordinary file I/O to the protocol.

### 3. Recover call sites

At a stable game endpoint, attach backtraces to `connect`, outbound, and inbound calls. For each useful PC:

1. Record module name, module base, PC, and return address.
2. Compute `module_offset = PC - module_base`.
3. Separate `libGameCore.so`, `libil2cpp.so`, and `libc.so` frames.
4. Repeat for at least three comparable samples.

Promote a candidate only when the same module offset appears across the same UI action. Backtraces through protection wrappers are expected and must not be discarded silently.

### 4. Locate the framing and dispatch boundary

Correlate the raw byte stream with metadata logging anchors:

- Length: `_bodyLength`, `totalReceiveDataLength`, `alreadyReadBodyLength`, `totalReadLength`.
- Connection: `BeginConnectHost`, `BeginConnectSocket`, `SocketConnectState`.
- Dispatch: `commandId`, `dwCmdType`, `dwMsgID`, `TDR Unpack`.

At this boundary, capture:

- Bytes before and after encryption or decryption.
- Bytes before and after compression or decompression.
- Command field and sequence field candidates.
- Handler callback return address.

Only then test a frame hypothesis. The current server parser's `0x575A` magic is a local test convention and is not evidence from this client.

### 5. Recover managed methods and IDs

Because static Il2CppDumper registration fails:

1. Attach after runtime unpacking and initialization.
2. Use `il2cpp_domain_get`, `il2cpp_domain_get_assemblies`, `il2cpp_class_get_methods`, and `il2cpp_method_get_name` to enumerate managed methods.
3. Match metadata names and indices from `tools/analyze_il2cpp.mjs`: `ApolloConnector`, `LobbyConnector`, `StartAsyncReceive`, `StartAsyncSend`, `SetSecurityInfo`, and `ReadUdpData`.
4. Match the already-indexed boundary types: `SgConnector` (send/receive callbacks), `FrameSynchr` (frame update and ping), `FrameWindow` (send/resend and holes), `CLoginSystem2` (login network handlers), and `CShopSystem` (shop request/receive handlers).
5. Hook the matched methods and record their native offsets.
6. Correlate method entry with command IDs and semantic message names.

Do not patch metadata or native code until this stage produces exact offsets and original bytes.

## Capture standards

### Common JSONL event

Every protocol observation should preserve:

```json
{
  "timestamp": "ISO-8601",
  "type": "socket-data",
  "direction": "outbound",
  "function": "send",
  "descriptor": 12,
  "endpoint": { "family": "AF_INET", "address": "203.0.113.10", "port": 8080 },
  "requestedLength": 128,
  "actualLength": 128,
  "previewHex": "first64bytes",
  "previewTruncated": true
}
```

Keep raw logs under `workspace/observations/frida/`. Do not paste raw previews into public reports if they may contain account tokens.

### Account gate

Pass only when all are true:

- Two independent login sessions reuse the same non-443 endpoint or a reproducible redirect chain.
- PID, UID, and socket inode attribute the connection to the game.
- Login action and response are distinguishable by direction and timing.
- A length or boundary hypothesis holds across at least three requests.
- A command field groups login, dispatch, and account-update observations consistently.
- Session/account mutation follows a response, never a request alone.

Expected semantic labels include `SCPKG_CMD_GAMELOGINRSP`, `SCPKG_GAMELOGINDISPATCH`, `SCPKG_CMD_LOGINFINISHNTF`, and `SCPKG_NTF_ACNT_INFO_UPD`.

### Battle gate

Pass only when all are true:

- A persistent or distinct endpoint/fd spans room, loading, and battle phases.
- Bidirectional rates increase during battle.
- Framing survives fragmentation and coalescing across at least three samples.
- Sequence or command fields distinguish frame, input, state, and settlement traffic.
- Match, loading, battle, and settlement observations are reproducible in two safe sessions.

Expected semantic labels include `SCPKG_MATCH_RSP`, `SCPKG_MULTGAME_BEGINLOAD`, `SCPKG_MULTGAME_BEGINFIGHT`, `SCPKG_GAME_OVER_RSP`, and `SGC_GetPlayerSettleData`.

### Shop gate

Pass only when all are true:

- Shop open, list load, and purchase actions are distinguishable by command, sequence, body length, or endpoint.
- Purchase response precedes the UI result.
- Balance/inventory mutation follows a response.
- The list and result are reproducible in two sessions.
- Any real purchase is explicitly authorized and intentionally disposable.

Expected semantic labels include `SCPKG_CMD_SHOPDETAIL`, `SCPKG_CMD_SHOPBUY`, `SCPKG_ACNT_SHOP_DISCOUNT_PACKBUYINFO_NTF`, `CS_ACNTINFO_UPD_COIN`, and `CS_ACNTINFO_UPD_DIAMOND`.

## Current blockers

- No game gateway endpoint is proven.
- No complete frame header, length layout, sequence, or command encoding is proven.
- No numeric message-ID registry is recovered.
- No game-frame encryption or compression call is proven.
- IL2CPP registration is protected and requires runtime method enumeration.
- The device is currently unobserved in this task; no dynamic evidence was added.

The next actionable step is an operator-run cold-start capture with `Observe-ProcessSockets.ps1`, followed by approved Frida JSONL capture and backtrace correlation.
