# `wzry` 协议逆向分阶段方案

## 边界与结论

- 本报告只读参考 `D:\project\poxxiao`，未修改该目录，也未解压 `D:\project\wzry\3.81.1.67.zip`。
- `poxxiao` 的协议编号、消息名、native 偏移和资源格式均属于“星之破晓”，不能直接套用到当前 `wzry` 游戏；能复用的是流程、工具链和脚本结构。
- 当前 `zip_inventory.txt` 为空，压缩包清单尚未完成。主线程应先用支持 ZIP64 的工具生成完整文件清单，再进入 APK 静态审计。

## 分阶段路线

### 1. 安全解包与清单化

1. 生成 `3.81.1.67.zip` 的 SHA-256 和完整 ZIP64 文件清单，确认 APK 实际路径、大小、压缩方式与压缩包根目录编码。
2. 只解出 `AndroidManifest.xml`、`*.dex`、`lib/*/`、`assets/`、`resources.arsc` 和少量配置文件，不一次性解压 8.3GB 压缩包。
3. 用 `aapt/aapt2` 获取包名、版本、ABI、组件、权限、明文网络配置和 debuggable 状态。
4. 建立 `reports/protocol_evidence.md`，所有编号和字段结论必须引用来源文件、哈希或反编译位置。

### 2. 客户端静态定位

1. 用 `jadx-1.5.6` 反编译 dex，检索 protobuf、HTTP/TCP/KCP、WebSocket、methodId、请求分发和回调符号。
2. 若是 Unity IL2CPP，用 `Il2CppDumper` 解析 native 符号与 `global-metadata.dat`，优先定位网络序列化、请求注册表和服务器地址配置。
3. 在 assets 与 native 库中查找 `FileDescriptorSet`、`.proto`、message id 表、加密配置和内置服务器地址。
4. 输出候选协议通道、帧格式、编码器/解码器、加密层和 methodId 注册表。

### 3. 描述符与编号还原

1. 若能提取 descriptor，则按 `poxxiao/server/src/schema.mjs` 的方式合并 `FileDescriptorSet`，并复制 `export-inventory.mjs` 的思路生成消息索引、结构和哈希。
2. 如果 descriptor 被拆分或私有化，则从 Java/Kotlin/native 注册表提取编号、符号、请求/响应消息名，再结合 protobuf wire 解码推断字段。
3. 建立请求/响应配对规则，并区分客户端请求、服务端响应、通知和上报，避免把响应编号简单当作“请求编号 + 1”。
4. 输出 `protocol/message-ids.tsv`、`protocol/message-types.tsv`、`protocol/descriptors/` 与可机器校验的 schema 报告。

### 4. 非侵入式设备观测

本阶段只读观察，不安装、不卸载、不 kill、不 push/pull、不修改设备配置。

1. `adb connect 192.168.5.102:5555` 后收集设备 ABI、Android 版本、root 状态、前台包名、应用数据路径和监听端口。
2. 若设备已 root，可只读查看应用私有配置与日志；如需抓包，优先在开发机上运行 `mitmproxy` 或 `tcpdump` 转发代理，避免改动客户端。
3. 先观察登录、版本检查、资源下载、心跳、进房、战斗和结算的最小路径，记录 methodId、方向、长度、时间戳和依赖顺序。
4. TLS 流量不能仅凭状态码判断协议；需要证书、SNI、握手和客户端证书校验方式，再决定是否需要 Frida 动态 hook。

### 5. 本地服务端与改包闭环

1. 先实现回环 HTTP/TCP 网关的“记录 + 匹配 + 回放”模式，再逐个实现登录、心跳和进入主界面所需的最小响应。
2. 协议处理器按 `poxxiao/server/src/game-adapter.mjs` 的 methodId 分发模式拆分，但具体路由必须来自 `wzry` 证据。
3. 若客户端必须改包，先复制 `poxxiao/android/mobile-standalone/Build-EmbeddedApk.ps1` 的安全流程：原包哈希、最小替换、清除旧签名、`zipalign`、`apksigner sign/verify`。
4. 每实现一个协议都补单元测试和真机回放，形成静态证据、服务端实现、真机截图/日志、数据库回读四类证据。

## `poxxiao` 可复用内容

### 高优先级

- `server/src/schema.mjs`：读取 `.bytes` 中的 `FileDescriptorSet`，合并去重、校验冲突并构建 protobufjs Root；可直接迁移。
- `server/protocol/export-inventory.mjs`：生成消息索引、结构 JSON、输入哈希和真机请求观测 TSV；结构可直接复用。
- `server/protocol/protocol-coverage.mjs` 与 `audit-unmatched.mjs`：覆盖统计、缺口分级和路由证据方法可复用。
- `work/apk-static-audit/analyze.js` 与输出目录：APK 内容分类、哈希清单、manifest 组件统计的审计模式可复用。
- `android/mobile-standalone/Build-EmbeddedApk.ps1` 和 `Install-MobileBundle.ps1`：APK 改包、签名、root 校验、私有目录写入、端口 reverse 和真机部署流程可改造。

### 参考但不直接移植

- `server/src/server.mjs`、`game-adapter.mjs`、`frame-relay.mjs`：架构和测试方式有价值，具体编号和业务逻辑不能复用。
- `docs/客户端协议/`：可作为输出格式和覆盖判定口径的模板，不作为当前协议证据。
- `tools/optional/qtsvfsmgr-src` 与 `work/extract-*.mjs`：资源容器、LZ3/LZ4/Oodle/Zstd 思路可参考，需先确认 `wzry` 实际资源格式。

## 需要补充的工具

- Windows 版支持 ZIP64 的解压工具，如新版 `7-Zip`、`bsdtar` 或可用 Python 标准库环境；现有系统 `tar` 对超大 ZIP 的表现需先验证。
- `mitmproxy` 或 `tcpdump`：开发机侧抓包和代理观测。
- `Frida` + `frida-server`：仅在静态和代理观测不足时，用于 hook 编码前后、methodId 分发、地址选择和 TLS 校验；使用前需用户确认并明确设备改动范围。
- `protobuf` 官方工具链或 Node/Python protobuf 运行时：descriptor 解码和 schema 导出。
- 网络协议分析工具：Wireshark/tshark 可选，便于 KCP/TCP 字节流分帧。

## 最小协议验证清单

| 验证项 | 通过标准 |
| --- | --- |
| APK 清单 | 原始 ZIP/APK SHA-256 固定；能列出目标 APK、dex、native 库、assets 和 manifest |
| 包信息 | `aapt/aapt2` 输出包名、版本、主 Activity、ABI、权限和网络配置 |
| 网络通道 | 明确 HTTP、HTTPS、TCP、UDP/KCP、WebSocket 中实际使用的通道和端口 |
| 帧格式 | 明确 magic、长度、序列号、methodId、压缩、加密和 protobuf 边界 |
| 协议编号 | 至少还原登录、版本、心跳、进房、结算 5 条链路的编号和方向 |
| Schema | 请求/响应能被 protobufjs 或等价运行时编码解码，字段名有静态证据 |
| 本地网关 | 客户端请求到达本地服务器，日志记录 methodId 和原始字节 |
| 登录闭环 | 客户端能停留主界面或进入目标本地场景，不依赖官方服务器 |
| 真机验证 | ADB 日志、服务端日志、抓包或截图证明请求由 `192.168.5.102:5555` 设备发出 |
| 回归测试 | 每个 protocol handler 有单元测试；关键链路重启服务端后行为一致 |

## 推荐下一步

1. 主线程先生成完整 ZIP64 清单并定位 APK。
2. 复用 `poxxiao` 的 ADB、`aapt2`、`jadx` 和 `Il2CppDumper` 做 APK 静态审计。
3. 根据静态结果确定是否需要 `mitmproxy/tcpdump` 或 Frida，再经用户确认后进行设备观测。
