# Native 重打包补丁方案

## Scope

本方案定义 `libGameCore.so`、`libil2cpp.so` 等 native entry 的可审计修改流程。它只接受已经由逆向报告证实的精确文件偏移，不提供模糊搜索、字符串替换或盲扫能力。

## Modification strategies

| 策略 | 适用场景 | 风险与限制 |
| --- | --- | --- |
| 等长字节替换 | 修改 AArch32/AArch64 指令、常量 IP、端口、函数内 short branch | 最安全；不改变 ELF 大小、偏移、符号表和 ZIP entry 大小。必须确认新指令编码、条件标志和执行上下文 |
| Inline hook/trampoline | 替换函数入口为跳转并复制原指令到新代码区 | 需要额外可执行空间；若涉及 PC-relative、Thumb/AArch64 指令边界、重定位或 CFI，必须逐指令修正。禁止未验证的通用 trampoline 生成器 |
| ELF 段扩展 | 增加代码段、hook trampoline、数据表 | 改变 section/segment 偏移，可能破坏签名前完整性假设、加载器和某些安全校验；实现成本高 |
| IL2CPP metadata patch | 修改 `global-metadata.dat` 字符串或方法数据 | 只适用于已确认 metadata 版本和布局；哈希、header、索引和校验字段必须同步更新 |
| 新增独立 helper library + linker patch | 需要大量新逻辑时 | 需要修改 ELF 动态链接结构，风险高，当前阶段禁止 |

首选顺序是配置/资源补丁 → Java/smali 补丁 → 等长 native patch → trampoline → ELF 段扩展。账号、对战、商城的服务器地址应优先走配置重定向；只有无法通过控制面或业务网关配置生效时才 patch native。

## Build-WzryNativePatch.ps1

脚本位于 `tools/Build-WzryNativePatch.ps1`。

清单格式：

```json
{
  "nativePatches": [
    {
      "entryPath": "lib/arm64-v8a/libGameCore.so",
      "offset": 123456,
      "originalBytesHex": "100080D2",
      "replacementBytesHex": "1F2003D5",
      "evidence": "reports/gamecore_reverse_engineering.md#connect-entry"
    }
  ]
}
```

执行流程：

1. 校验源 APK SHA-256。
2. 解析 `nativePatches`；`entryPath` 只允许 `lib/*`。
3. 在 ZIP entry 解压后的内容中校验 `offset + length` 范围。
4. 比较 `originalBytesHex` 与实际字节，必须完全一致。
5. `replacementBytesHex` 长度必须与原字节一致。
6. 输出 staging APK 时按原始 ZIP 目录表顺序重建 entry，不按名称排序，`lib/*`、`assets/*`、`resources.arsc` 使用 Store 策略，其他 entry 使用 Deflate。
7. `zipalign -f -p 4` 后用 `apksigner --min-sdk-version 24` 签名；仅在输入 APK 已包含 `AndroidManifest.xml` 或用户提供了对应二进制 manifest entry 时执行完整签名与验证。
8. 执行 `apksigner verify --verbose` 和 `zipalign -c -p 4`。
9. 写出 `<output>.manifest.json`，包含源 APK 哈希、输出 APK 哈希、每个 entry 的原/补丁后 SHA-256、偏移、长度和证据链接。

`-WhatIf` 只做所有输入和原始字节校验，不写出 APK。

## Exact offset requirements

每个 patch 必须提供：

- APK 哈希和 entry 哈希。
- entry 内文件偏移，不是 ZIP 偏移。
- 原始字节和替换字节的十六进制。
- 逆向报告中的函数/指令解释、反汇编上下文和调用链证据。
- 明确说明指令集、函数入口、运行路径和 ABI。
- 对账号、对战、商城消息流的可观测影响。

禁止从字符串搜索结果、相似游戏偏移或猜测规则推导 patch。没有原始字节完整匹配时脚本必须失败，不得降级为模糊替换。

## Account, battle, and shop call sites

| 目标系统 | 优先调用点 | 需要的证据 |
| --- | --- | --- |
| 账号 | 地址选择、`connect` 入口、MSDK/GCloud 登录回调 | 静态偏移、Frida `connect/send/recv` 捕获、登录响应结构 |
| 对战 | 网关地址选择、帧编码/解码入口、消息 ID 分发 | 双端帧方向、长度、序列号、房间/开局状态机日志 |
| 商城 | HTTP 控制面、商品列表请求、余额/购买响应 | 请求路径、响应 schema、订单/库存持久化结果 |

在业务网关确认前，只允许补丁控制面地址和连接目标，不允许伪造账号、对战或商城成功响应。

## Prohibitions

- 禁止 patch `resources.arsc` 或 Java 入口之外的 entry；native patch 只允许 `lib/*`。
- 禁止使用未经验证的通配替换、模糊搜索或偏移推断。
- 禁止修改 ELF 大小或 section 布局，除非另有专项方案和测试。
- 禁止在同一构建中混合控制面二进制补丁与 native 补丁，避免归因困难。
- 禁止把本地观测成功描述为业务功能完成；验收必须来自真机请求、后端状态和自动化测试。

## Verification

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\Test-NativePatchPlan.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\Build-WzryNativePatch.ps1 `
  -SourceApk .\workspace\apk\3.81.1.8.apk `
  -PatchManifest <native-patch.json> `
  -OutputApk .\workspace\apk\native-patched.apk `
  -WhatIf
```

构建后还必须运行 `tools/Compare-ApkZipLayout.ps1`，确认除目标 native entry 和签名文件外无其他差异。
