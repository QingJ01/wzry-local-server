# 验收审计（2026-11-24）

## 结论

当前项目尚未达到整体验收标准。仓库测试全部通过，目标设备 `192.168.5.102:5555` 上可确认已安装本地控制面补丁 APK，ADB reverse 与本地服务健康检查均有效；但真实客户端协议、账号/对战/商城的端到端闭环仍未被证明。不能把内部 HTTP API 测试通过或静态逆向结果等同于客户端验收完成。

本次审计没有修改业务代码，也没有提交或推送任何未确认的并行工作文件。

## 验收矩阵

| 项目 | 状态 | 证据 | 结论 |
| --- | --- | --- | --- |
| Git 仓库与身份 | 通过 | `main` 同步 `origin/main`；最近提交为 `196edce` | 基础仓库健康 |
| Rust 服务端单元/集成测试 | 通过 | `cargo fmt --check`；`cargo test`：18 个测试全部通过 | 内部账号、对战、商城 API 逻辑正常 |
| 客户端管线测试 | 通过 | `client\Test-Pipeline.ps1`、`client\Test-ControlPlanePatch.ps1` 均输出 passed | 构建与控制面补丁工具自检正常 |
| 静态逆向工具测试 | 通过 | GameCore、IL2CPP、NativePatchPlan、ProtocolCapture、ObserveScripts 全部通过 | 静态分析工具可复现 |
| JS 语法 | 通过 | `node --check tools/analyze_gamecore.mjs`、`node --check tools/analyze_il2cpp.mjs` | 分析器语法有效 |
| Whitespace | 通过 | `git diff --check` | 无空白错误 |
| 设备连接 | 通过 | `adb devices` 显示 `192.168.5.102:5555 device` | 指定设备在线 |
| 客户端安装 | 通过 | `pm path` 返回 base.apk；versionName `3.81.1.8`；versionCode `381010801` | 目标设备存在游戏 |
| 安装包身份 | 通过 | 设备 APK SHA-256 为 `88205F4C859510B9B85364311EA10B7A1E4B1D18B47C23229B3BD2782CA89049`，等于 `workspace/apk/wzry-patched-working-sign.apk` | 已安装的是已验证的 patched-working 包 |
| ADB reverse | 通过 | `tcp:19620 -> tcp:19620`、`tcp:19621 -> tcp:19621`、`tcp:19622 -> tcp:19620` | 本地端口映射存在 |
| 本地 HTTP 服务健康 | 通过 | `GET /health` 返回 `ok: true`，epoch `d0f04a83-8a5e-4be6-b7e3-e5110cf82c16` | 当前 Node 服务在线 |
| 只读观测端点 | 阻塞 | 对 `GET /debug/observations` 的原始请求返回 `401 Unauthorized` / `{"error":"需要登录"}` | 当前 19620 服务不是仓库 Rust 服务端；需确认该 Node 服务的设计或切换到 Rust 服务 |
| 客户端实际请求观测 | 未完成 | 当前观测文件只包含设备状态、logcat、proc/net 快照和 UI 截图；没有协议请求证据 | 尚未证明客户端到达本地后端 |
| 动态 socket/Frida 捕获 | 未完成 | `workspace/observations/process-sockets/` 不存在，未发现 Frida JSONL 捕获 | 需要继续动态捕获 |
| 游戏网关/帧格式/消息 ID | 未完成 | 静态报告只给出高置信语义锚点，未证明端点、帧头、序列、命令 ID 或加密 | 禁止猜测协议 |
| 账号系统端到端 | 未完成 | 仅有内部 API 测试通过，没有真实客户端登录闭环 | 未验收 |
| 对战系统端到端 | 未完成 | 仅有内部 API 测试通过，没有真实客户端房间/战斗/结算闭环 | 未验收 |
| 商城系统端到端 | 未完成 | 仅有内部 API 测试通过，没有真实客户端商城查询/购买闭环 | 未验收 |
| 可复现 APK 正式输出 | 风险 | `wzry-patched-working-sign.apk` 已验证；`wzry-control-plane-debug-store.apk` 与其大小/哈希不同 | 正式构建脚本仍需修复并复现成功布局 |
| Frida 运行时 | 进行中 | 并行工作流已添加部署脚本和依赖文件，但尚未完成捕获；这些文件未纳入本审计提交 | 需要单独验证 |

## 运行时差异说明

端口 `19620/19621` 由 PID `26164` 占用，命令行为：

```text
"D:\project\poxxiao\tools\node\node.exe" src/server.mjs
```

该进程不是 `server\target\debug\wzry-local-server.exe`。因此，本次 `/health` 成功和 `/debug/observations` 401 都只描述当前 Node 服务，不能作为 Rust 服务端验收证据。下一步应确认 `src/server.mjs` 的用途与认证规则，或停止它并按仓库配置启动 Rust 服务后重新执行健康检查与观测检查。

## 证据快照

- 目标设备：`192.168.5.102:5555`（同一 ADB 实例还有其他设备，审计命令均显式指定目标）。
- 设备包路径：`/data/app/~~8aMMzytWqOBoN2SxUaTn6w==/com.tencent.tmgp.sgame-vIciRPJuyovvzjqBU9O3qA==/base.apk`。
- 设备与本地 patched-working APK SHA-256：`88205F4C859510B9B85364311EA10B7A1E4B1D18B47C23229B3BD2782CA89049`。
- 原始 APK：`workspace/apk/3.81.1.8.apk`，SHA-256 `A016D941A3D7BA0A8FC976DAE6FE744EFEC85835A16DD10928B65A9C7E19EE5D`。
- 当前游戏进程存在：`com.tencent.tmgp.sgame`，UID `u0_a61`。
- 现有观测目录：`device-state-20261124-152421.txt`、`logcat-before-20261124-152421.txt`、`tcp/tcp6` 快照、`sample-proc-net.txt`、`ui/pre-capture.png`；没有已归档的登录/大厅/房间/战斗/商城协议捕获。

## 下一步

1. 修复 `client/Build-WzryApk.ps1`，让正式输出复现 `wzry-patched-working-sign.apk` 的 entry 顺序与 Store 压缩策略。
2. 明确 19620 当前 Node 服务与 Rust 服务的关系；必要时切换运行时并重新验证 `/health` 和 `/debug/observations`。
3. 按 `reports/dynamic_capture_runbook.md` 完成 socket/Frida 捕获，覆盖冷启动、登录页、大厅、房间和商城状态。
4. 用捕获证据推导端点、帧边界、方向、长度、序列和命令编码；在证据不足前不得实现猜测协议。
5. 为每个已证明的消息添加 Rust 协议测试，再逐步实现真实账号、房间/战斗/结算、商城响应。
6. 只有 patched 客户端安装、真实客户端请求到达本地服务、账号/对战/商城流程和全量测试都得到证据后，才能进行总体验收。
