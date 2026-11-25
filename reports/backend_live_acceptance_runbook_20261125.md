# 真实客户端闭环验收 Runbook — 2026-11-25

**作者**：`/root/acceptance_planner_swe2`（只读设计，未改代码、未碰设备、未猜协议）。
**前置假设**：sgamx 的 `Resource license(type=layout, pkg=com.tencent.tmgp.sgamx)` 阻断已由他人解除（本 runbook 不覆盖 license 修复本身，也不验证其修复方式）；version-gate patch 是否生效需要在 Stage 1 现场判定。
**目标设备**：vivo V2238A（Android 16, arm64），被测包 `com.tencent.tmgp.sgamx` 3.81.1.8（`client/builds/wzry-version-gate-localdebug-sgamx-v3.apk`，SHA-256 `7DEA7EE8…62AD7`）。serial 运行时经 `WZRY_CAPTURE_SERIAL` 注入（当前 mDNS TLS 条目形如 `adb-10CD6M23EL003SU-…._adb-tls-connect._tcp`，每次执行前用 `adb devices` 实测，不要硬编码）。
**采集矩阵**：`tools/config/sgamx_capture_matrix.json`（phase：cold-start/login/lobby/shop/battle，各 minRounds=2；评估器 `tools/capture_matrix.mjs`，命令示例 `node tools/capture_matrix.mjs --config tools/config/sgamx_capture_matrix.json --markdown reports/capture_matrix_sgamx.md`）。
**铁律**：
- 不实现、不断言任何协议字段；`POST /game` 保持 501 是正确行为，直到采集矩阵证明真实 methodId。
- 不改 `server/`、`tools/` 代码来"迁就"观测结果；观测缺口记录为缺口。
- 不触碰 `192.168.5.101:5555`（MuMu，offline）；不触碰正式包 `com.tencent.tmgp.sgame`。
- 不在设备上执行任何未在此列出的写操作；每轮采集只读 + 已批准的 frida/adb-reverse 路径。

---

## 0. 证据分界：26 个 Rust 测试已证明什么、真实客户端还必须证明什么

### 0.1 后端 26/26 测试已证明（`server/tests/`，`cargo test`）

**账号域（`domain_http.rs`）**
- 注册/登录/`GET /accounts/me` 全流程：`account_register_login_and_profile_flow`（初始 balance=1000）。
- 重名注册 409：`duplicate_account_is_rejected`。
- 事件账本按 `after` 游标增量返回且需有效会话：`game_event_polling_requires_a_valid_session`（注册+登录产生 2 条事件，`after=2` 返回空）。
- local session 三种鉴权路径（Bearer / `localToken` 查询参数 / loopback 默认绑定）+ `allow_loopback_game_sessions=false` 时 401 + `after` 非数字 400：`local_game_session_supports_query_and_default_polling`。
- loopback 下未知 Bearer 回退到默认绑定账号：`local_game_session_authorizes_unknown_bearer_on_loopback`。
- 无 token 的敏感路由一律 401：`account_battle_and_shop_requests_require_valid_token`。

**房间/对战状态机（`domain_http.rs` + `server/src/domain.rs`）**
- create(lobby) → join → ready×2 → owner start(需 ≥2 人且全 ready，非 owner 409) → running → frame → settle(仅参与者) → get(frames 持久化)：`battle_room_ready_start_frame_and_settle_flow`。
- `GET /rooms` 返回成员数/状态且鉴权：`list_rooms_returns_created_rooms_for_member`。

**商城域**
- `/shop/items` 3 件、`purchase` 扣减 balance+入库+下单、余额不足 409、quantity=0/溢出 400：`shop_purchase_updates_balance_inventory_and_orders`。

**传输/观测层**
- 帧解析：整帧、分片、粘包、bad magic 拒绝、超限拒绝（`frame_parser.rs` 5 个）。
- HTTP 流读取：Content-Length 精确读取、超限拒绝（`http_stream.rs`）。
- `/health` 全 ok、未知路由 JSON 404、`/debug/observations` 只读、观测日志 10k 上限、未知 methodId 501 且入观测、`/game/events` 无 domain service 时 404、body 超限 413（`http_server.rs` 7 个）。
- 并发客户端服务（`integration.rs`）；观测 JSONL 导出与 10k 截断（`observation_export.rs`）。

**结论**：服务端**作为本地调试闭环**的账号/房间/对战/商城语义与事件账本行为已被充分证明。`GameEvents.room=null`、`messages=[]` 是有意留空（无客户端证据，不猜）。

### 0.2 必须由真实客户端证明（26 个测试证明不了的）

| 待证事项 | 为什么测试证明不了 |
| --- | --- |
| sgamx 进程能越过 license 点后的 version-gate 检查点且不弹强制更新公告 | patch 只有字节级静态证据；logcat 从未到达 `CVersionUpdateSystem` |
| 客户端登录请求的真实 endpoint、方向、时序、帧格式、响应语义 | 服务端 API 是自定 JSON，不是真实游戏协议；`/padx/*` 目前 404 |
| 大厅基线流量形态（区分常驻控制面 socket 与阶段特有 socket） | 需要进程归属的 `/proc/net/*` + frida 双向数据 |
| 商城列表加载/购买确认的请求-响应因果（响应先于 UI 结果） | 缓存流量与真实交易流量只有在真机上才能区分 |
| 训练对战的持久/独立对战 endpoint、双向帧节奏、≥3 个可比帧样本 | 服务端 `/battles/*` 是本地模型，与真实帧协议无关 |
| `/game/events` 轮询回路在真实客户端上的端到端可用性 | method0 patch 的静态 Bearer 在 .101 上证明过，vivo/sgamx 上从未证明 |
| 任何 methodId 的语义 | 目前只有 4 个 501 观测（4375/184355/184357/186201），wire 编码与来源未证 |

---

## 1. 验收总门（Go/No-Go）

按顺序执行；任何一步 No-Go 则停止并回滚到"安全态"（§9），记录为缺口，不跳阶段。

| # | 门 | Go 判据 |
| --- | --- | --- |
| G0 | 后端健康 | `cargo test` 26/26；`GET /health` 全 `ok`；`19620/19621` LISTEN |
| G1 | license 已解除 | sgamx 启动后存活 >5 s 且无 `Resource license … not found`、无 `System.exit(-1)` |
| G2 | version-gate 不阻断 | logcat 无强制更新公告 UI；流程到达登录或更新检查点后继续 |
| G3 | 采集链路就位 | frida-server 运行、`WZRY_CAPTURE_SERIAL/PACKAGE` 正确、adb reverse 19620/19621/19622 就位 |
| G4 | cold-start 2/2 | 评估器报告 cold-start complete（进程归属 socket 快照 + session-started） |

G1 若失败：license 未真正解除，回到修复方，本 runbook 终止。
G2 若失败且公告仍出现：按 `reports/version_gate_native_patch.md` 的备选 patch 点（`OnGetNewVersionInfo` `0x44ba58`）交回修复方；不在本 runbook 内现场补丁。

---

## 2. 阶段设计总览

每个阶段统一包含六个字段：**API（服务端触点）/ 客户端操作 / 观测断言 / 两轮采集 / 回滚 / 禁止事项**。两轮采集指同一阶段的两次**独立会话**（冷启动间隔 ≥5 分钟或显式 force-stop 后重进），文件命名必须带 phase 前缀（评估器靠文件名分相，如 `login-round1-sgamx-….ndjson`），证据目录用矩阵配置的：

- sockets → `workspace/observations/process-sockets-sgamx/`
- frida → `workspace/observations/frida-sgamx/`
- http → `workspace/observations/`

服务端观测侧用 `GET /debug/observations`（内存 10k 上限，分页返回最近 1000；需要归档时用 `export_observations_jsonl` 导出）。

---

## 3. Stage 0 — 环境与后端基线（无设备操作之外的预检）

**API**
- `GET /health` → `status/http/frame/database=ok`，`protocol="observing"`，`epoch=1`。
- `POST /local/session` `{"accountId":<id>}` → 绑定 loopback 默认会话，拿 `localToken`（先 `POST /accounts/register`+`login` 造一个调试账号，例如 `vivo-acceptance`）。
- `GET /game/events?after=0`（不带凭据）→ 200 且 events 含该账号 `account.registered/account.logged_in`——证明 loopback 回退路径活着。

**客户端操作**：无（此阶段不启动 sgamx）。

**观测断言**
- `adb reverse --list` 在 vivo serial 上含 `tcp:19620/19621/19622`（缺则补建；adb reverse 在真机可用，见 `reports/adb_reverse_verification_20261124.md`——注意该证据来自 .101，vivo 上需现场重证）。
- frida-server arm64 版本与设备匹配并在跑（vivo 无 Houdini，.101 的 LSPosed Houdini hook **不适用**，不要迁移该假设）。
- `/debug/observations` 基线快照导出存档（作为后续对比的 t0）。

**两轮采集**：不需要（这是预检）。

**回滚**：无状态修改；若 reverse/frida 布置失败，停止，不进入 Stage 1。

**禁止事项**
- 禁止在这个阶段启动 sgamx"试试看"——未绑定 local session 前的客户端轮询会污染事件游标基线。
- 禁止改 `AppState::default()` 里的 `allow_loopback_game_sessions`（它是 loopback 兼容路径的开关，改动即改变被测系统）。

---

## 4. Stage 1 — cold-start + license/version-gate 通过性（G1/G2/G4）

**API**
- 无新增服务端交互预期；若客户端 method0 patch 生效，可见 `GET /game/events?after=0&epoch=1` 带静态 Bearer 轮询到达（200）。`/padx/comm/cloud_center_ctl/`、`/padx/logcollect/mlog`、`/padx/notice/gather_data` 预期 404——这是**正确的**（路由未实现），其存在本身证明控制面重写生效。

**客户端操作**
1. force-stop sgamx（确保冷启动）。
2. frida attach 模式启动采集：`WZRY_CAPTURE_SERIAL=<vivo serial>`、`WZRY_CAPTURE_PACKAGE=com.tencent.tmgp.sgamx`，`node tools/frida/run-network-capture.mjs <log> 90 attach`（脚本对 sgamx 已用 `com.tencent.tmgp.sgame.SGameActivity` 全限定组件名）。
3. 首屏同意/权限弹窗按最少必要处理（只点必须点的，记录每一步）。
4. **不要登录**。到达登录页或更新公告即停。

**观测断言**
- logcat 无 `Resource license(type=layout, pkg=com.tencent.tmgp.sgamx) is not found`、无 `System.exit called, status: -1`（对照 `reports/vivo_v3_smoke_evidence.md` 的阻断指纹）。
- 进程存活 >90 s（越过 .101 时代的 cold-start kill window；vivo 无 Houdini，预期不自杀，但必须实测）。
- 记录是否出现"年度版本"强制更新公告：出现则 G2 No-Go；未出现且能停在登录页，则 version-gate patch **首次获得运行时证据**（这才是 patch 生效的证明，此前只有字节级证据）。
- `Observe-ProcessSockets.ps1` 快照：PID/UID 归属的 socket ≥1；frida ndjson 有 `session-started`。
- 非 443 endpoint 在此阶段**不预期**出现；出现则记录为候选，不断言语义。

**两轮采集**：round1/round2 各一次完整冷启动，间隔 ≥5 分钟且 force-stop。两轮都需满足矩阵 cold-start 门（进程归属 + session-started）。**注意**：cold-start 在 .101 已 2/2，但那是 sgame+emulator；sgamx+vivo 必须重证，矩阵的 `completedRounds` 从 0 起算。

**回滚**：force-stop sgamx；停 frida 采集（进程自然到期或 kill node）；reverse 映射保留（无设备态副作用）。若出现反复自杀/ANR，导出 logcat 全文存档后停止。

**禁止事项**
- 禁止点登录按钮、禁止输入账号。
- 禁止在 vivo 上尝试 LSPosed/Houdini hook 路径。
- 禁止把"公告未出现"在单轮证据下写成结论——需两轮一致。

---

## 5. Stage 2 — login（账号协议证据）

**API**
- 服务端无对应真实协议实现（`POST /game` 仍 501）。预期观测：若登录链路走控制面重写，可能出现新的 `/padx/*` 或 `/game` methodId 501 记录——逐条记录 methodId/bytes/timestamp，**不实现**。
- 本地回路对照（可选、明确标注为"本地回路验证"而非真实协议）：用 Stage 0 的调试账号演示 `register→login→/accounts/me→/game/events` 闭环，证明服务端侧无恙——但这只是 26 个测试已证明之事的现场复现，不计入客户端证据。

**客户端操作**
1. 在登录页使用**专用测试账号**（绝不使用主账号/正式账号；凭证不入报告，只记事实）。
2. 提交登录，记录精确到秒的动作时间戳（采集日志对照用）。
3. 登录结果（成功/失败/错误码）截图 + logcat。

**观测断言**（满足矩阵 login 门）
- 双向数据（`requiresBidirectionalData`）：登录动作 ±10 s 内出/入方向 socket-data 事件簇。
- 重复 endpoint（`requiresRepeatedEndpoint`）：同一非 443 endpoint 在**两个独立会话**都出现且与登录时序相关；若仅见 MSDK/TDM/GCloud 443 HTTPS，则账号协议**未证**（矩阵原文）。
- 方向与时序必须与登录动作相关（提交后出方向先发，响应在 UI 结果前到达）。
- 进程归属快照 ≥1/轮。

**两轮采集**：`login-round1-sgamx-*` / `login-round2-sgamx-*`，独立会话。两轮都过门 → 评估器 login complete。

**回滚**：force-stop；若账号被锁定/异常，停止并记录，不重复尝试（防风控升级）；测试账号停用。

**禁止事项**
- 禁止真实短信/扫码登录主账号；禁止使用任何付费或带资产账号。
- 禁止根据单包猜测登录帧格式（帧格式确认流程见 `tools/observe_client.md` 第 1-5 条：先分控制面/游戏面、记首字节、对比双向流、统计分布、找到明确长度字段后再谈解码）。
- 禁止实现任何 methodId handler 来"配合"观测到的 501。

---

## 6. Stage 3 — lobby（基线）

**API**：同 Stage 2，无新增。预期 lobby 阶段的常驻 socket 集在此建立基线。

**客户端操作**：登录成功后不做任何点击，大厅静置 60-90 s。

**观测断言**
- 记录大厅稳态 socket 集合（哪些常驻、哪些断开）——这是后续 room/shop/battle 阶段区分"阶段特有 socket"与"常驻控制面 socket"的对照组（矩阵原文）。
- 双向数据 + 重复 endpoint 门同 login。

**两轮采集**：`lobby-round1/2-sgamx-*`。两轮过门 → lobby complete。

**回滚**：登出或 force-stop；无额外状态。

**禁止事项**：禁止在大厅阶段点进商城/对战/活动页面——任何额外点击都会污染基线。

---

## 7. Stage 4 — shop（商城协议证据）

**API**
- 服务端对照模型（已由测试证明）：`GET /shop/items`（hero300/skin800/chest100）、`/shop/profile`、`POST /shop/purchase`（balance 校验、quantity>0、溢出检查、409 余额不足）。**这些端点不是真实客户端协议**，仅作为本地回路对照存在。
- 真实客户端侧预期：商城打开/列表加载可能产生新 methodId 501 或新 `/padx/*` 404——记录，不实现。

**客户端操作**
1. 大厅 → 商城页打开（记录时间戳）。
2. 浏览物品列表（记录时间戳）。
3. 走到**购买确认弹窗为止**，不点最终确认（除非事先获得对一次性低价物品的明确书面授权——当前无此授权）。

**观测断言**（矩阵 shop 门）
- 请求/响应因果：响应必须先于 UI 结果（列表渲染/价格显示）到达，两轮皆然；纯缓存列表流量（无请求直接渲染）**判失败**。
- 双向 + 重复 endpoint + 进程归属同前。

**两轮采集**：`shop-round1/2-sgamx-*`。第二轮需复现同一 endpoint 与因果序。

**回滚**：取消购买弹窗返回大厅；force-stop。未发生真实购买则无资产回滚问题。

**禁止事项**
- **禁止完成任何真实购买**（无明确授权；矩阵原文 "No real purchase unless explicitly authorized for a disposable item"）。
- 禁止用正式账号进商城。

---

## 8. Stage 5 — battle（训练对战，最低风险）

**API**
- 服务端对照模型（已由测试证明）：rooms lobby → join/ready → owner start（≥2 人全 ready）→ running → frame → settle → room 终态 settled。真实客户端不会调用这些端点；它们只证明服务端语义。
- 真实对战流量预期走独立 TCP/UDP endpoint（非 HTTP），frida `socket-data` 是主要证据源；服务端 frame TCP 端口 19621 仅观测 `WZ` magic 的本地帧格式，与真实协议无关。

**客户端操作**
1. 仅进入**训练营/人机/最低风险模式**（矩阵原文 "Training or lowest-risk battle only"）。
2. 完成一场短对局或至少 3-5 分钟对战内停留。
3. 结算页出现后退出。

**观测断言**（矩阵 battle 门）
- 存在持久或明确独立的对战 endpoint（与 lobby 基线对比新增）。
- 对战期间双向流量显著高于 lobby 基线。
- ≥3 个可比帧样本（时序间隔/尺寸分布可比）；纯遥测流量（只有上报无对战数据）**判失败**。
- 进程归属 + 两轮重复 endpoint。

**两轮采集**：`battle-round1/2-sgamx-*`，两局独立对战。

**回滚**：对局结束正常退出；force-stop。训练模式无排位/资产影响，无需额外回滚。

**禁止事项**
- **禁止排位、禁止任何影响账号的PVP**（矩阵原文 "Never ranked or account-affecting battle during a first capture"）。
- 禁止在帧格式未证前实现任何 frame decoder——`tools/observe_client.md` 的五步确认流程全部走完前，`server/src/frame.rs` 的 `WZ` magic 只是本地占位格式。

---

## 9. 跨阶段统一规则

**两轮采集的执行纪律**
- 每轮 = 独立会话（force-stop → 冷启动 → 走到目标 phase）。
- 文件名必须含 phase token（评估器 `inferPhase` 靠前缀/`-<phase>-` 分相，unknown 一律 unlabeled 不计入）。
- 每轮至少 1 个进程归属 socket 快照 + 1 条 frida session-started；缺任一则该轮作废。
- 两轮间检查 `/debug/observations` 增长，导出归档。

**观测断言的通用证据链**
- frida ndjson：`session-started`、`connect`、`socket-data`（out/in 计数）、`socket-close`、descriptor/inode 关联。
- socket 快照 JSON：`processId/uid/connections[]`（`Observe-ProcessSockets.ps1` 输出 schema）。
- HTTP 观测：`methodId/command/sequence/bytes/status/recordedAtUnixMs`。
- 三类证据按时间戳对齐（`tools/correlate_protocol_capture.mjs` 做关联，锚点目录 `tools/config/protocol_anchor_catalog.json`——锚点只是关联目标，不是已证字段）。

**回滚总原则**
- 所有采集设备侧只读 + frida attach（进程级注入，force-stop 即消失）+ adb reverse（`adb reverse --remove` 可逐条移除）。
- 每阶段结束：force-stop sgamx → 停 frida 采集 → 导出该阶段全部证据 → 更新矩阵评估。
- 服务端内存态：重启即清零（accounts/rooms/orders/events 全内存）——这是设计内的 debug 语义；若某阶段要求服务端状态跨重启保留，当场记录为**新缺口**，不临时加持久化。

**禁止事项总表**
- 禁止修改 `server/`、`tools/` 任何代码来迁就观测（包括"加一条路由试试"）。
- 禁止实现 methodId handler、frame decoder、任何协议语义。
- 禁止碰 .101、禁止碰正式 sgame、禁止 LSPosed/Houdini 路径迁移到 vivo。
- 禁止主账号登录、真实购买、排位对战。
- 禁止将"未观察到公告"单轮证据升级为结论；禁止把 501/404 观测写成协议结论。
- 禁止把 serial 硬编码进任何新文件（一律 `WZRY_CAPTURE_SERIAL` 运行时注入）。

---

## 10. 验收出口判据

全部满足才可宣称"真实客户端闭环验收通过"：

1. `capture_matrix.mjs --config tools/config/sgamx_capture_matrix.json` 报告 cold-start/login/lobby/shop/battle **五相全部 complete**（各 2/2）。
2. version-gate 跳过公告有两轮一致的运行时证据。
3. 每阶段的 endpoint/direction/timing/framing 证据经 `correlate_protocol_capture.mjs` 关联成册，候选 endpoint 从"candidate"升级为有进程归属+跨会话重复的观测。
4. `reports/acceptance_matrix_live.md` 刷新，Account/Battle/Shop 行从 "Not proven" 改为有证据支撑的状态；任何仍缺项保持 "Not proven" 并写明缺口。
5. `cargo test` 26/26 与全部 `tools/Test-*.ps1` 重跑通过（证明验收过程未污染服务端/工具链）。

任一不满足：不是失败，是"尚未验收"——按缺口列表回到对应阶段。

---

## 11. 与既有证据的衔接（防止重复劳动）

- cold-start 在 .101/sgame 已 2/2 complete（`reports/capture_matrix.md`）——**不可继承**到 sgamx/vivo，但采集手法（attach 模式、inode 关联、相位命名）已验证可用，直接复用。
- `/game/events` loopback 回路在 .101 证明过客户端轮询可达（`reports/adb_reverse_verification_20261124.md`）；sgamx 是否携带同样的 method0 控制面重写需在 Stage 1 重证（v3 构建保留 libapollo patch SHA，但重写生效是运行时行为）。
- 4 个已观测 methodId（4375/184355/184357/186201）来自 sgame/.101，sgamx 上可能不同；只作历史参考，不作预期。
- vivo 上 frida-server 是否存在/arm64 匹配、reverse 映射是否已建，是 `reports/acceptance_gap_audit_20261125.md` 明确列出的开放问题——Stage 0 必须先回答再前进。
