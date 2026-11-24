# 本地服务器架构设计

## 结论

建议采用 **Node.js 24 ESM + 原生模块零依赖** 的双通道架构：

- HTTP JSON API 负责账号、登录、大厅、房间、配置、协议消息和调试接口。
- TCP 帧服务负责战斗同步、帧广播、断线重连候选通道和原始帧观测。
- SQLite WAL 负责账号、角色、库存、战绩、房间/对局状态和协议观测数据。
- 协议层先用“消息 ID + protobuf descriptor + JSON 调试投影”建立闭环，再逐步替换成客户端原生二进制格式。

参考 `D:\project\poxxiao\server` 证明该架构可行，但协议号、消息结构、战斗帧格式和客户端补丁均不能直接套用。当前项目必须从 `3.81.1.67.zip` 提取 APK 后重新逆向。

## 参考工程可借鉴点

| 参考 | 价值 | 当前项目适配 |
| --- | --- | --- |
| HTTP `19620` + TCP `19621` | 客户端控制面与实时帧面分离 | 建议默认沿用端口，但通过配置注入客户端 |
| `frame-relay.mjs` | TGCP/LockStep 子集、分片解析、帧历史、回放 | 先实现可测试的解码器，不做完整战斗裁判 |
| `server.mjs` | 认证、事件轮询、原版消息桥接、健康检查 | 保留事件 epoch 机制，接口按当前客户端重定 |
| `schema.mjs` | protobuf descriptor 加载和消息 ID 映射 | 当前协议描述符需重新提取 |
| 大量 `*.test.mjs` | 协议契约、分片、状态和持久化测试 | 优先为帧解析、认证、房间、事件建测试 |
| SQLite WAL + 事务 | 账号和战斗数据安全 | 不要简单复制参考 schema，只保留基础设计 |

## 项目结构

```text
server/
  package.json
  config/default.json
  data/local.sqlite
  protocol/
    descriptors/
    message-ids.tsv
  src/
    main.mjs
    http-server.mjs
    frame-server.mjs
    router.mjs
    lobby.mjs
    schema.mjs
    accounts.mjs
    rooms.mjs
    events.mjs
    protocol-router.mjs
    persistence.mjs
  test/
    frame-parser.test.mjs
    accounts.test.mjs
    rooms.test.mjs
    protocol-contract.test.mjs
    recovery.test.mjs
```

`main.mjs` 只做启动装配，不承载业务。每个模块保持小文件和显式边界，避免重演参考项目中 `server.mjs` 过大的问题。

## HTTP 服务

默认绑定 `127.0.0.1:19620`，真机联调时通过 ADB reverse 暴露到设备侧：

```powershell
adb reverse tcp:19620 tcp:19620
adb reverse tcp:19621 tcp:19621
```

建议接口：

| 方法与路径 | 职责 |
| --- | --- |
| `GET /health` | HTTP/TCP/数据库/协议注册状态、epoch、版本 |
| `POST /accounts`、`/sessions` | 注册、登录、异步密码派生 |
| `GET /me`、`/profile` | 账号与原版结构资料 |
| `POST /game` | 原版 `{methodId, body}` 消息适配 |
| `GET /game/events` | 事件轮询，支持 `after` 和 `epoch` |
| `POST /rooms`、`/match` | 建房与匹配 |
| `GET /debug/protocol/messages` | 已观测消息、错误和调用统计 |
| `GET /debug/battles/{id}/frames` | 帧历史和回放观测 |

必须实现统一 `ApiError(status, code, message)`，统一 413/400/401/404/409/500 JSON 响应。事件轮询重启后使用新 epoch，客户端需清空旧游标并重新拉取快照。

## TCP 帧服务

默认绑定 `127.0.0.1:19621`。第一阶段只做观测与转发，不尝试完整模拟服务端战斗。

设计要求：

1. 独立二进制解码器，明确最大包长、命令号、序列号、extra/body 字段。
2. 输入缓冲必须处理 TCP 分片、粘包、半包和异常长度；超限连接立即断开并记录。
3. 每个对局分配一次性 frame ticket，绑定 `serverId + roomId + slot + accountId`，防止跨房重放。
4. 维护有界帧历史和输入去重，用于回放、诊断和断线恢复。
5. 状态机：`loading → running → settling → settled → closed`，断线不立即销毁对局。
6. 所有转发数据写入 JSONL 摘要日志，敏感字段不落盘；完整二进制帧可配置为限速采样。

## SQLite 设计

基础表：

```sql
accounts(id, name, salt, password_hash, display_name, created_at)
sessions(token, account_id, expires_at)
players(account_id, level, exp, created_at, updated_at)
rooms(id, number, owner_id, map_id, mode_id, state, created_at, expires_at)
room_members(room_id, account_id, slot, role_id, ready, joined_at)
battles(id, room_id, server_id, map_id, mode_id, state, started_at, ended_at)
battle_members(battle_id, account_id, slot, ticket_hash, last_frame)
events(id, account_id, method_id, payload_json, created_at)
protocol_messages(method_id PRIMARY KEY, name, direction, descriptor_id, implemented)
protocol_observations(id, method_id, request_size, response_size, status, duration_ms, created_at)
battle_frames(battle_id, frame_no, payload, PRIMARY KEY(battle_id, frame_no))
gameplay_records(battle_id, account_id, result, score, settled_at)
```

要求：

- `PRAGMA journal_mode=WAL`，事务覆盖库存、结算和状态变更。
- 外键开启；所有索引围绕 `account_id + created_at`、`battle_id + frame_no`、`method_id + created_at`。
- 对局运行态保留在内存，只持久化可恢复状态和最终结果，避免高频帧每条写库。
- 数据库文件备份必须同时处理主库、WAL 和 SHM。

## 配置

`server/config/default.json`：

```json
{
  "http": {"host": "127.0.0.1", "port": 19620},
  "frame": {"host": "127.0.0.1", "port": 19621},
  "database": "data/local.sqlite",
  "limits": {
    "httpBodyBytes": 65536,
    "maxPacketBytes": 1048576,
    "frameHistoryBytes": 33554432,
    "eventsPerAccount": 1000
  },
  "protocol": {
    "descriptors": "protocol/descriptors",
    "unknownMessagePolicy": "observe"
  }
}
```

环境变量覆盖：`WZRY_HTTP_PORT`、`WZRY_FRAME_PORT`、`WZRY_DB`、`WZRY_PROTOCOL_TRACE`。

启动脚本：

```powershell
# server/Start-LocalServer.ps1
node src/main.mjs
```

包脚本：

```json
{
  "scripts": {
    "start": "node src/main.mjs",
    "test": "node --test test/*.test.mjs"
  }
}
```

优先使用 Node 24 内置 `node:sqlite`，避免 native 依赖；protobufjs 只在确认当前协议确为 protobuf 后引入。

## 协议演进路线

### 阶段 1：只读观测

- 提取 APK，确认网络库、登录协议、序列化格式、服务器地址和帧通道。
- 实现消息 ID 注册表和 JSONL 观测。
- 未知消息返回确定错误，不允许静默伪造成功。

### 阶段 2：最小登录闭环

- 完成账号、session、基础资料和事件轮询。
- 客户端能进入主界面，但明确标记未实现菜单为 501。
- 建立协议契约测试和请求回放测试。

### 阶段 3：大厅与房间

- 实现好友、房间、准备、选角、匹配。
- 保持房间状态持久化，进程重启后可恢复大厅态。
- 验证两客户端状态一致性。

### 阶段 4：帧通道

- 用真实客户端捕获帧协议，完成解码/编码单元测试。
- 先转发和记录，后实现输入排序、去重和有界历史。
- 不宣称完整战斗可玩，直到有独立状态校验或可靠一致性报告。

### 阶段 5：玩法服务

- 按 UI 调用频率逐个实现库存、邮件、商城、任务、成长和战绩。
- 每个消息必须有 schema、契约测试、持久化测试和真机截图/日志证据。
- 高风险结算必须事务化并防止重复提交。

## 测试与里程碑

最小可测试里程碑：

1. 服务启动、健康检查、优雅退出。
2. 账号注册/登录/session 过期/密码并发派生。
3. HTTP body 超限与非法 JSON 错误。
4. TCP 分片、粘包、半包、超限包解析。
5. 房间创建、加入、离开、重复加入和进程重启恢复。
6. 事件 epoch 变化后客户端重新同步。
7. 已知协议消息契约测试。
8. 未知协议消息返回 501 并记录 observation。
9. 两端真机进入同房间并保持心跳。
10. 帧通道完成一次可回放的双端数据流。

验收标准：

- `npm test` 全绿。
- `/health` 显示 HTTP、TCP、数据库、协议注册表正常。
- 真机能访问 `127.0.0.1:19620` 和 `127.0.0.1:19621`。
- 每个阶段都有明确“已验证/未验证”清单，不把转发成功说成战斗成功。

## 风险与边界

- 当前 APK 未提取，协议和帧格式不能假设为参考项目相同。
- 不应为了过 UI 伪造不可持久化的成功响应。
- 本地服务只绑定本机和 ADB reverse，不对局域网开放。
- 战斗裁判、反作弊和完整状态一致性属于后期目标，不阻塞登录/大厅闭环。
