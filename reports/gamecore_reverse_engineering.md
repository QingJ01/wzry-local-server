# libGameCore.so 静态逆向报告

## 结论

- `libGameCore.so` 是 AArch64 ELF64 共享库，大小 58,805,320 字节，SHA-256 为 `58e36f26973c05b2998f50c206a992176d33afb271f2d4289f2d49d0883708e5`。
- 动态符号表完整可解析：559 个符号，其中 320 个定义、239 个未定义导入。除 C++ 运行时与 LZ4 外，还保留 `GameCoreInfo_*`、`SGC_GetPlayer*`、`PushCsBuffer` / `PopFifoCppPackBuffer` 等业务桥接导出。
- `socket`、`connect`、`send`、`recv` 是明确导入，证明 `libGameCore.so` 内存在直接 BSD socket 通路；但静态证据尚未定位到调用点、网关地址或帧解析函数。
- 字符串中出现 `ELF_HOOK_BRIDGE_il2cpp_init`、`ELF_HOOK_BRIDGE_MetadataCache_Register`、`ELF_HOOK_BRIDGE_LoadMetadataFile`、`stub_recv`、`stub_send`、`g_tprt_pfn_array` 和 `libunpacker_otheralign.so`。这些是保护/加固桥接特征，说明不能把当前文件布局当作无壳 ELF 直接做 IL2CPP 注册表恢复。
- 可读字符串中没有明文游戏网关、账号域名、protobuf 字段、消息 ID 表或帧格式；账号、商城、对战业务名称主要保存在 `global-metadata.dat` 的 C# 字符串中，而非 `libGameCore.so` 的 native 字符串。
- 因此，静态阶段可以确认 native socket 通路、C#/C++ 打包缓冲桥和对局结算导出；不能确认具体连接目标、帧格式、消息 ID、加密算法或分发函数。后续必须以动态 hook 与双端字节流验证。

## 置信度规则

- **高**：ELF 结构、动态符号、字符串偏移等可直接复现的证据。
- **中**：由符号名/导入/跨文件关系做出的合理定位，尚缺调用链或运行时验证。
- **低**：只有类比或间接推断，不能作为 patch 依据。

## Binary identity

| 属性 | 值 |
| --- | --- |
| APK | `workspace/apk/3.81.1.8.apk` |
| APK SHA-256 | `a016d941a3d7ba0a8fc976dae6fe744efec85835a16dd10928b65a9c7e19ee5d` |
| Entry | `lib/arm64-v8a/libGameCore.so` |
| Size | 58,805,320 |
| SHA-256 | `58e36f26973c05b2998f50c206a992176d33afb271f2d4289f2d49d0883708e5` |
| ELF class / endian | ELF64 / little-endian |
| Machine | `0xB7` / 183 / AArch64 |
| ELF type | `ET_DYN` / 3 |
| Entry point | `0xBF3CA0` |
| Program headers | 9 |
| Sections | 22 |

## ELF structure

### Program headers

| Index | Type | Flags | File offset | Vaddr | File size | Memory size | Align |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | `PT_LOAD` | R | `0x0` | `0x0` | `0x320F0F0` | `0x320F0F0` | `0x10000` |
| 1 | `PT_LOAD` | R+X | `0x320F0F0` | `0x32203B0` | `0x5FD988` | `0x7A9FA8` | `0x10000` |
| 2 | `PT_DYNAMIC` | R+W | `0x3638A60` | `0x363F850` | `0x1B0` | `0x1B0` | `0x8` |
| 3 | `PT_NOTE` | R | `0xBEF2E8` | `0xBEF2E8` | `0x24` | `0x24` | `0x4` |
| 4 | `PT_GNU_EH_FRAME` | R | `0x241E9C8` | `0x241E9C8` | `0x2416F4` | `0x2416F4` | `0x4` |
| 5 | `PT_GNU_STACK` | RW | `0x0` | `0x0` | `0x0` | `0x0` | `0x10` |
| 6 | `PT_LOAD` | R | `0x3810800` | `0x39C8900` | `0x2710` | `0x2710` | `0x10000` |
| 7 | `PT_LOAD` | R+X | `0x3810800` | `0x39DF7B0` | `0x35B8` | `0x35C8` | `0x10000` |
| 8 | `PT_LOAD` | R+W | `0x3810800` | `0x39FF960` | `0x46A4` | `0x46A4` | `0x4000` |

第 6–8 个 `PT_LOAD` 复用同一文件偏移但映射到不同虚拟地址。这是该库当前布局的重要特征；改变文件大小或 section 布局会显著提高重打包风险。

### Key sections

| Section | Address | Offset | Size | Meaning |
| --- | ---: | ---: | ---: | --- |
| `.hash` | `0x39C9DE8` | `0x3810BE8` | `0x10BC` | Dynamic symbol hash |
| `.dynsym` | `0xBE9AE0` | `0xBE9AE0` | `0x3468` | 559 ELF64 symbols |
| `.dynstr` | `0xBEF108` | `0xBEF108` | `0x2EDB` | Dynamic string table |
| `.rela.dyn` | `0x238` | `0x238` | `0xBE9D08` | Dynamic relocations |
| `.rela.plt` | `0xBEF8E8` | `0xBEF8E8` | `0x1F20` | PLT relocations |
| `.plt` | `0xBEF990` | `0xBEF990` | `0x14B0` | PLT |
| `.text` | `0xBF3CA0` | `0xBF3CA0` | `0x17C0D84` | Main executable mapping |
| `.rodata` | `0x23BB2E0` | `0x23BB2E0` | `0x5DA78` | Read-only data |
| `.dynamic` | `0x363F850` | `0x3638A60` | `0x1B0` | Dynamic tags |
| `.got` | `0x3640390` | `0x3638BE0` | `0x27468` | GOT |
| `.got.plt` | `0x365D588` | `0x36595E8` | `0xA60` | GOT.PLT |
| `.data` | `0x365F5D0` | `0x365DFF0` | `0x1B7B48` | Data |
| `.bss` | `0x381DBD0` | `0x3814B18` | `0x1AA6A8` | Zero-filled runtime data |

Section table begins at `0x3820600`，实际文件大小为 `0x3814B48`。节表偏移超出文件末尾，但解析出的 22 个节头与 `.dynsym`、`.dynstr`、`.text`、`.dynamic` 等 PT_LOAD/PT_DYNAMIC 数据完全一致，说明该发布 ELF 的静态节表信息被移动/拼接，不能信任节表自身作为唯一结构来源；应优先以程序头和动态段定位数据。证据见 `gamecore_analysis.json` 的 `sectionHeaderTableOffset`。

## Dynamic symbols

### Business and bridge exports

| Virtual address | Symbol | Static confidence | Interpretation |
| ---: | --- | --- | --- |
| `0x1D898D8` | `GameCoreInfo_IsDebugCore` | 高 | Core build/debug metadata |
| `0x1D898EC` | `GameCoreInfo_Revision` | 高 | Core revision |
| `0x1D89900` | `GameCoreInfo_CoreHash` | 高 | Core integrity hash |
| `0x1D8991C` | `GameCoreInfo_SGWGUIDHash` | 中 | SGW/TDR identifier metadata |
| `0x1D89938` | `GameCoreInfo_TDRGUIDHash` | 中 | TDR protocol identifier metadata |
| `0x1D8994C` | `SGC_GetPlayerSettleData` | 中 | Player settlement data bridge |
| `0x1D89960` | `SGC_GetPlayerReportQuitACNTData` | 中 | Quit/account report data bridge |
| `0x1D89974` | `SGC_GetPlayerTLogData` | 中 | Player telemetry/log data bridge |
| `0x1D89988` | `SGC_GetPlayerMapExInfo` | 中 | Map/battle extension data bridge |
| `0x1DBF734` | `FlushCsImmediatePackBuffer` | 中 | C# immediate pack buffer flush |
| `0x1DBF758` | `PushCsBuffer` | 中 | C# buffer handoff to C++ |
| `0x1DBF780` | `CommitCsBuffer` | 中 | Commit packed buffer |
| `0x1DBF7CC` | `PopFifoCppPackBuffer` | 中 | C++ FIFO pack buffer read |
| `0x1DBF7F0` | `PushCppImmediatePackBuffer` | 中 | C++ immediate pack buffer write |
| `0x1DBF80C` | `SFFlushCppImmediatePackBuffer` | 中 | C++ pack buffer flush |
| `0x1DBF844` | `SFPushCsImmediatePackBuffer` | 中 | C# immediate pack buffer write |
| `0x2352504` | `JNI_OnLoad` | 高 | Android JNI entry |
| `0x1E24140` | `UnityPluginLoad` | 高 | Unity native plugin lifecycle |
| `0x1E2418C` | `UnityPluginUnload` | 高 | Unity native plugin lifecycle |

这些符号证明 `libGameCore.so` 是 Unity/C# 与 C++ 游戏核心之间的主桥接层。`GameCoreInfo_TDRGUIDHash` 与 `SGW` 命名进一步表明其与协议/TDR 结构相关，但只凭符号名不能确定帧编码或消息 ID 分发表。定位置信度为中。

### Network imports

| Symbol | Static confidence | Meaning |
| --- | --- | --- |
| `socket` | 高 | BSD socket creation import |
| `connect` | 高 | TCP/UDP connect import |
| `send` | 高 | Socket send import |
| `recv` | 高 | Socket receive import |
| `select` / `poll` | 高 | Multiplexed I/O imports |
| `fcntl` / `ioctl` | 中 | Non-blocking/control path candidates |
| `read` / `write` / `writev` | 中 | Generic I/O, cannot prove socket use |
| `mprotect` / `mmap` / `dlopen` / `dlsym` | 高 | Memory and dynamic loading primitives; also common packer behavior |

静态结论：`libGameCore.so` 本身具备完整 socket 客户端原语，业务网关不必须经过 `libgcloudcore.so`。但导入符号本身不能证明调用链或连接目标；调用点定位为低置信度，需要动态 backtrace。

### Protection and IL2CPP bridge evidence

File-offset string evidence:

| File offset | String |
| ---: | --- |
| `0xBEFC42` | `g_tprt_pfn_array` |
| `0xBEFC53` | `ELF_HOOK_BRIDGE_InitializeAllMethodMetadata` |
| `0xBEFC7F` | `ELF_HOOK_BRIDGE_InitializeMethodMetadata` |
| `0xBEFCA8` | `ELF_HOOK_BRIDGE_JNI_OnLoad` |
| `0xBEFCC3` | `ELF_HOOK_BRIDGE_LoadMetadataFile` |
| `0xBEFCE4` | `ELF_HOOK_BRIDGE_MetadataCache_Register` |
| `0xBEFD0B` | `ELF_HOOK_BRIDGE_il2cpp_init` |
| `0xBEFD27` | `ELF_HOOK_BRIDGE_unity_readblocksinfo` |
| `0xBEE014` | `g_tprt_ori_array` |
| `0xBEE025`–`0xBEEFFD` | `stub_*` wrappers |
| `0xBEF090` | `stub_recv` |
| `0xBEF09A` | `stub_send` |
| `0xBEFF2A` | `libtprt.so` |
| `0xBEFF5B` | `libunpacker_otheralign.so` |

相同字符串集合在文件尾部映射区 `0x38108F5`–`0x3810C0E` 再次出现，与复用文件偏移的第 6–8 个 `PT_LOAD` 呼应。这解释了 Il2CppDumper 在 metadata v23 / IL2CPP 24.1 下仍无法恢复 CodeRegistration/MetadataRegistration 的现象：启动路径经过保护桥和运行时改写，而不是普通静态注册表。

保护评估：

- 字符串与业务方法名被大量集中保存在 `global-metadata.dat`，`libGameCore.so` 的 native 可读字符串几乎不包含业务语义。
- `stub_recv` / `stub_send` 与 `g_tprt_*` 暗示 socket 和文件/时间函数可能被保护器转发或包装，直接替换 PLT/GOT 不一定等价于替换业务调用。
- `mprotect`、`dlopen`、`dlsym`、`mmap` 与尾部映射段组合符合运行时解包/修复行为。
- 静态证据支持“加固/运行时修复”结论；具体壳实现、hook 数组和 unpack 顺序为低置信度，需要动态验证。

## String and keyword analysis

`extractStrings` 提取 50,954 个长度至少 5 的 ASCII 字符串。分类计数：

| Group | Count |
| --- | ---: |
| Network | 7 |
| Protocol | 26 |
| Crypto | 7 |
| Account | 0 |
| Battle | 18 |
| Shop | 12 |

这些计数包含大量误报，例如 `__frame_state_for`、`LZ4_createStreamDecode`、随机字节中的 `TEamX`。因此不能把关键词命中当作协议或加密证据。

明确的网络字符串只有 `connect`、`select`、`socket`、`stub_recv`、`stub_send` 及其尾部副本。没有明文 host、port、URL、protobuf、KCP、AES、TEA、账号、商城或消息 ID 命名。

### LZ4

`libGameCore.so` 导出完整 LZ4 压缩/解压 API，例如 `LZ4_compress_default`（`0x237E350`）和 `LZ4_decompress_safe`（`0x237BD78`）。这证明本地包含压缩能力，但不能证明游戏帧使用 LZ4；帧压缩判定为低置信度。

## Relationship with libgcloudcore.so and libil2cpp.so

| Library | Role | Confidence |
| --- | --- | --- |
| `libgcloudcore.so` | GCloud/ABase 控制面：URL request、RemoteConfig、TDM/GTrace、MSDK account plugin、TEA/对称加解密符号 | 高 |
| `libGameCore.so` | Unity/C# ↔ C++ 游戏核心桥、打包缓冲、对局/结算数据、socket 原语 | 高 for role, 中 for具体业务 |
| `libil2cpp.so` | Unity IL2CPP runtime，导出 `il2cpp_init`（`0x77F42C0`）等标准 API | 高 |
| `global-metadata.dat` | C# 字符串/方法/资源语义的主要来源；包含账号、商城、对战、消息错误码和 UI 名称 | 高 |

`libgcloudcore.so` 的符号证据包括 `ABase::WWWTaskBase::SetUrl`、`ABase::UrlRequest::Get/Post`、`GCloud::ConfigureImpl::SetUrl`、`ABase::CGCloudCore::SetRemoteConfigUrl`、`GCloud::Plugin::MSDK::MSDKAccount`，以及 `TeaEncryptECB` / `TeaDecryptECB` 等。它更像 HTTP 控制面/SDK 支撑库；`libGameCore.so` 则保留游戏核心桥和 socket 原语。二者不能相互替代。

`global-metadata.dat` 中存在大量业务字符串，如 `ApolloHelper OnLogin`、`GetGoodsInfo`、`OnServerResDataNtf`、`SCPKG_*`、`CS_*`、商城错误码和结算/房间错误码。这说明协议语义可在 IL2CPP metadata 中继续定位，但 `libGameCore.so` 的静态导出本身没有暴露这些名称。

## Candidate hook points

这些是“候选观测点”，不是可写 patch 点。任何 patch 前必须先获得原始字节、调用链和运行时证明。

| Goal | Candidate | Confidence | Required evidence |
| --- | --- | --- | --- |
| 首次连接目标 | libc `connect`，以及 `stub_recv` / `stub_send` 保护包装 | 中 | Frida backtrace、sockaddr host/port、socket fd 表 |
| 发送帧 | libc `send`、`sendto`、`writev`、`stub_send` | 中 | 双向字节、长度、序列号、状态机事件 |
| 接收帧 | libc `recv`、`recvfrom`、`read`、`stub_recv` | 中 | 分片、半包、解压/解密前后的缓冲 |
| C#/C++ 缓冲边界 | `PushCsBuffer`、`CommitCsBuffer`、`PopFifoCppPackBuffer` | 中 | 调用栈、缓冲内容、线程 ID、时序 |
| 对局结算 | `SGC_GetPlayerSettleData` | 中 | 对局前后调用、结构体布局、结果字段 |
| IL2CPP 初始化 | `ELF_HOOK_BRIDGE_il2cpp_init`、`ELF_HOOK_BRIDGE_MetadataCache_Register` | 中 | 初始化时序、注册表指针、解包后内存镜像 |

优先顺序：`connect`/`send`/`recv` 动态观测 → `PushCsBuffer` / `PopFifoCppPackBuffer` 边界 → `SGC_*` 结算导出 → IL2CPP 注册表。不要从符号名直接生成等长 patch。

## Message ID and frame parsing status

静态阶段未恢复以下内容：

- 网关 host/port 或 URL。
- 帧头、长度、序列号、压缩标志和校验布局。
- 消息 ID 到 handler 的分发表。
- TEA/AES/XXTEA 等业务加密算法。
- 账号、商城、对战请求/响应 schema。

原因：

1. `libGameCore.so` 的业务字符串被迁移到 `global-metadata.dat` 或加密数据中。
2. 保护桥在运行时修复/转发关键 API。
3. ELF 尾部复用文件偏移的多段映射增加静态分析复杂度。
4. 未执行反汇编级调用链分析。

## Repro

```powershell
Set-Location D:\project\wzry
node --check .\tools\analyze_gamecore.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\Test-GamecoreAnalyzer.ps1
```

`Test-GamecoreAnalyzer.ps1` 会重新生成 `workspace/analysis/gamecore/` 中的 JSON、符号与导入证据，并断言二进制哈希、ELF 结构、关键导出和导入。`strings_filtered.txt` 仅保留为本地生成证据，不提交到 Git。

## Evidence index

- `workspace/analysis/gamecore/gamecore_analysis.json`
- `workspace/analysis/gamecore/dynamic_symbols.txt`
- `workspace/analysis/gamecore/undefined_imports.txt`
- `workspace/analysis/gamecore/keyword_hits.json`
- `workspace/analysis/gamecore/README.md`
- `workspace/analysis/libil2cpp.so.symbols.txt`（本地证据）
- `workspace/analysis/gcloud_symbols.txt`（本地证据）
- `workspace/analysis/global-metadata-strings.txt`（本地证据）
