# Protocol next steps — 2026-11-24

任务：`/root/protocol_evidence_auditor`（纯离线证据复核，未触碰设备与 Rust 协议代码）。
输入：`workspace/observations/**`、`workspace/experiments/**`、`reports/capture_matrix.md`、
`reports/protocol_capture_findings.md`、`tools/correlate_protocol_capture.mjs`、`tools/capture_matrix.mjs`。

## 复核范围

- Frida ndjson 19 个文件 / 2585 事件（170 out / 1471 in socket-data）。
- 进程 socket 快照 13 个 / 50 条 UID 10061 连接。
- HTTP 观测：`post-consent-20261124-http-observations.json`（221 条）、`s2-http-observations.json`（179 条）。
- 本报告只陈述已观测事实；不推断 methodId、帧边界或 schema。

## Endpoint 分层（区分 loopback / HTTPS / 候选）

| 层级 | Endpoint | 已观测证据 | 判定 |
| --- | --- | --- | --- |
| Loopback | `127.0.0.1:19620` | frida + process-socket 双源，48/48 双向，内容为 `padx`/`notice`/`mlog` 上报与 `/game/events` 轮询 | **本地控制面，非游戏协议** |
| Loopback | `127.0.0.1:27042` | `latest-run.json` 记录的 adb forward | Frida 管理通道，勿计入流量分析 |
| HTTPS | `*:443` 多个（MSDK/TDM/GCloud） | TLS `16 03`/`17 03` 握手与应用数据，双向 | 遥测控制面，密文内协议不可见 |
| 遥测候选 | `112.82.203.33:8081`、`140.207.121.93:8081` | 双向有字节；payload 含 `TYPE_COMPRESS`、`bea_key`、明文 `getaddrinfo cgi.connect.qq.com` 与 XML 头 | 带压缩标记的遥测/上报通道；**不是游戏语义帧** |
| 候选（connect-only） | `122.96.96.179:10012`、`122.96.96.251:10012`、`59.83.207.176:10012` | 各出现 1 次 `connect`，无 socket-data 字节 | 候选待证；缺字节与归属证据 |
| 候选（有字节） | `220.196.141.37:20000` | round3 一个 inode `3704591`：4 个出站数据帧（151/140/227/77B）+ 4 个入站数据帧（125/126/143/1280B） | 当前最强非 443 有字节候选；**仅 1 轮出现，未被 socket 快照证实归属** |
| 噪声 | `8.8.8.8:65535`、`2000::65535` | connect-only，端口 65535 | 探测/DNS 通道，非游戏协议 |

关键修正：`capture_matrix` 里 `220.196.141.37:20000` 记为 `8 / 1108` 双向事件——其中
1108 条入站是 `recv`/`recvfrom` 的 **空轮询（actualLength = 0 或 -1）**，真实带字节入站帧只有
125/126/143/1280B 四条（recvfrom 与 recv 各计一次，实际 4 个唯一帧）。

## :20000 帧结构观察（仅为记录，不作结论）

出站唯一帧头字节：`4366aa000000<len16le>00 0000<flags8> 10e686012000<flags16>`。

- `43 66 aa 00` 前缀在 4 个出站帧中重复；入站帧以 `aa 00 00 00` 起头。
- 出站偏移 4..7 为小端帧长（`95150000`→149、≈151-2；`2a150000`→138；`51150000`→225；`2b150000`→75），
  即字段值 ≈ actualLength − 2。
- 同一连接上同时出现 151→125、140→126、227→143、77→1280 的 out→in 邻接对，间隔约 180–430ms。
- 整个序列只持续约 0.6s（`12:17:42.114` → `12:17:42.728`），随后无重连。

这是首个"带长度字段、双向成对"的可比样本，但**样本只有一轮一次连接**，
且该连接未在进程 socket 快照中出现（快照时刻该 socket 已关闭或尚未建立）。

## methodId ↔ socket 同毫秒关联核查

`s2-http-observations.json` 中 4 条 `POST /game` 501 与 4 条 methodId 记录时间戳**完全同毫秒**：

| POST /game bytes | methodId 记录 bytes | methodId | 时刻 (UTC) |
| ---: | ---: | ---: | --- |
| 371 | 35 | 4375 | 11:52:00.738 |
| 365 | 29 | 186201 | 11:52:00.740 |
| 451 | 114 | 184357 | 11:52:01.252 |
| 443 | 106 | 184355 | 11:52:01.752 |

结论：methodId 记录与 `POST /game` 是同一次 HTTP 请求的两个观测条目（body methodId 字段 + HTTP
行）。这些请求来自**补丁客户端打到本地服务的帧通道轮询**，不是来自真实网关的 wire 流量；
它们证明的是"客户端帧通道会 POST `{methodId, body}` 到本地 19620"，不证明任何线上协议字段。
同一时段没有对应的 Frida 会话在跑（最近的 unlabeled 捕获结束于 11:38:43），因此**无法做
methodId ↔ wire 字节级关联**——这正是当前最大的证据缺口。

## 各阶段缺失证据与最小实验

通用前置阻塞：Houdini 自 `SIGKILL`（约 60–75s 窗口，R1 已排除外部 force-stop 后仍发生）。
所有后续实验都受该窗口限制；建议每个 round 控制在 <60s 或确认 R3 patch 后再跑长会话。

### login（0/2）

- 缺：任意一次到达登录提交动作的 UI；任何非 443 登录 socket 的字节；socket 快照与 Frida inode 归属同时命中。
- 最小实验：进程稳定后，运行 `login-roundN-<stamp>` 前缀的 attach 捕获 2 轮，每轮在登录点击前后各做 1 次 `Observe-ProcessSockets.ps1` 快照（文件名也带 `login-` 前缀），使 inode 归属与 wire 事件同轮命中。

### lobby（0/2）

- 缺：大厅持久 socket 基线；无法区分常驻控制面 socket 与阶段 socket。
- 最小实验：进入大厅后 2 轮 `lobby-roundN-<stamp>` 捕获 + 首尾 socket 快照，目标是确认 `:10012` 族或 `:20000` 族是否作为持久连接复现。

### shop（0/2）

- 缺：商城打开/列表加载的请求-响应时序对；response-before-UI-result 序列。
- 最小实验：大厅稳定后 `shop-roundN-<stamp>` 2 轮；仅打开与列表加载，不做购买；对每次列表加载记录 UI 时间戳，与 wire 事件毫秒级对齐。

### battle（0/2）

- 缺：对战专用持久端点；≥3 个可比帧样本；双向流量增强证据。
- 最小实验：仅训练/最低风险模式，`battle-roundN-<stamp>` 2 轮；先证明持久端点，再谈帧样本。未授权前不进真实对战。

### methodId ↔ wire 关联（跨阶段）

- 缺：同毫秒内的 `POST /game` 观测 + 进程 Frida socket-data（`POST /game` 的 wire 字节）。
- 最小实验：客户端帧通道活跃时跑 `login-roundN` attach 捕获 + 同时导出 `/debug/observations`；
  `POST /game` 的 HTTP 字节会出现在 `127.0.0.1:19620` 的 socket-data 中，与 methodId 记录对齐即可
  建立"本地帧通道 ↔ methodId"映射，作为后续真实网关协议的参照（仍不是线上证明）。

## 可复现采集命令

```powershell
# 1) attach 模式 Frida 捕获（需先有 frida-server 在 loopback:27042）
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\frida\Run-NetworkCapture.ps1 `
  -Action run -Attach -CaptureSeconds 60

# 2) 立即给输出文件加阶段前缀（矩阵要求文件名含阶段标签）
Rename-Item "workspace\observations\frida\<runId>.ndjson" `
  "login-round1-<runId>.ndjson"

# 3) 进程 socket 快照（同轮、同秒级）
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\Observe-ProcessSockets.ps1 `
  -Serial 192.168.5.101:5555 -Package com.tencent.tmgp.sgame
Rename-Item "workspace\observations\process-sockets\com.tencent.tmgp.sgame-<stamp>.json" `
  "login-round1-<stamp>.json"

# 4) HTTP 观测导出（含 methodId 记录）
curl.exe -s http://127.0.0.1:19620/debug/observations `
  -o workspace\observations\login-round1-http-observations.json

# 5) 汇总评估
node .\tools\correlate_protocol_capture.mjs `
  --sockets workspace\observations\process-sockets `
  --frida workspace\observations\frida `
  --output workspace\observations\protocol-correlation.json `
  --markdown reports\protocol_capture_findings.md
node .\tools\capture_matrix.mjs `
  --output workspace\observations\capture-matrix.json `
  --markdown reports\capture_matrix.md
```

## 建议的最小下一步（排序）

1. **等 R3 patch 或稳定方案落地** — 60s 死亡窗口是 login/lobby/shop/battle 全部前置条件。
2. **login-round1 首轮 attach 捕获**：确认 `:10012`/`:20000` 是否复现，并把 `POST /game`
   methodId 轮询与 `127.0.0.1:19620` wire 字节做同毫秒对齐。
3. **若 `:20000` 复现且归属证实**：收集 ≥3 个同端点连接的 out→in 帧对，验证
   `字段@4..7 = actualLength − 2` 的长度假设是否稳定，再讨论帧边界（仍不涉及 command/语义）。
4. **`:10012` 族若复现**：优先抓首字节确认是否为同一帧格式（`43 66 aa` / `aa 00`），
   再判断是否同协议不同端口（如 itop 网关族 vs `:20000`）。

## 数据质量备注

- `process-sockets/00-cold-start-lifecycle.json` 与 `current-manifest-20261124-154213.json`
  不是合法快照（correlator 已正确跳过并记录）。
- `frida/*.ndjson.stderr` 与多个空 ndjson 属正常空轮，不扣分。
- unlabeled 捕获（`20261124-*.ndjson`）无法满足阶段 gate；今后一律用阶段前缀命名。
- `reports/capture_matrix.md` 的 `:20000` "1108 inbound" 计数建议后续在 correlator 里
  拆分 `actualLength > 0` 的数据帧计数，避免空轮询放大字节证据权重。
