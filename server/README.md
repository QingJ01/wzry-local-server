# wzry-local-server

Rust 本地观测服务端，为后续客户端协议逆向和本地闭环提供最小 HTTP/TCP 基础。

## 运行

```powershell
cargo run --release
```

默认监听：

- HTTP: `127.0.0.1:19620`
- Frame TCP: `127.0.0.1:19621`

可用环境变量覆盖地址：

```powershell
$env:WZRY_HTTP_ADDR = "127.0.0.1:19620"
$env:WZRY_FRAME_ADDR = "127.0.0.1:19621"
```

## 接口

- `GET /health`：服务健康状态。
- 账号：`POST /accounts/register`、`POST /accounts/login`、`GET /accounts/me`。
- 对战：`POST /rooms`、`/rooms/join`、`/rooms/ready`、`/battles/start`、`/battles/frame`、`/battles/settle`、`/battles/get`。
- 商城：`GET /shop/items`、`GET /shop/profile`、`POST /shop/purchase`。
- `POST /game`：观测 `{ "methodId": ..., "body": ... }`，未知协议返回 `501` 并记录。
- `GET /debug/observations`：只读查看 HTTP/TCP 观测记录。

观测记录包含来源、字节数、状态和 Unix 毫秒时间戳。`/debug/observations` 只返回最近 1,000 条，内存审计日志最多保留 10,000 条；`wzry_local_server::export_observations_jsonl` 可导出最近 10,000 条 JSON Lines。观测只证明请求到达本地服务，不表示已解码或验证客户端协议。

认证接口使用 `Authorization: Bearer <token>`。

## 测试

```powershell
cargo fmt --check
cargo test
```

当前测试覆盖账号/对战/商城领域流、帧分片/粘包/超限、HTTP JSON 错误、Content-Length 精确读取、并发客户端、观测接口、观测日志上限和 JSONL 导出。
