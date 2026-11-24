# Version gate capture audit — 2026-11-24

任务：`/root/version_gate_protocol_auditor`。范围只审计现有证据，不改代码、不猜测协议。

## 结论

- 强制版本公告由客户端启动时 GCloud 配置通道触发，不是当前 Rust 服务端产生的游戏协议响应。
- 版本元数据请求已证明为 `GET https://cloudctrl.gcloud.qq.com/cfgpush/getConfig?...`，但 method0 APK 把它等长重写到 `http://127.0.0.1:19620/padxxxxx/cfgpush/getConfig?...`。
- Frida 捕获到该本地请求返回 `HTTP/1.1 404`；logcat 中 `on_get_new_version` 仍能拿到 `9.2.1.7` 配置，说明版本配置未完全来自本地 404。
- 公告内容文件是独立 HTTP GET 到 `image.smoba.qq.com`：`GET /Announcement/9.2.1.7/SGame_Announcement_9.2.1.7_1.txt`，未被 control-plane patch 重定向。
- 客户端版本：`3.81.1.8`；远端公告版本：`9.2.1.7`；`IncompatibleResourceVersion` 为 `3.81.1.67`。

## 已证明证据

| 时间（UTC） | 来源 | 方向 | 长度 | URL / 字段 | 归属 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-24 20:33:22 CST | `workspace/experiments/20261124-203151-B0-tencent-sig-original.logcat.txt:1555` | outbound | n/a | `app_ver=3.81.1.8`, `bid=com.tencent.tmgp.sgame` | B0/PID 19357 | GCloud `comParams` 完整 JSON |
| 2026-11-24 20:33:22 CST | `workspace/experiments/20261124-203151-B0-tencent-sig-original.logcat.txt:1556` | outbound | n/a | `https://cloudctrl.gcloud.qq.com/cfgpush/getConfig?com_params=...` | B0/PID 19357 | 原始未 patch endpoint |
| 2026-11-24 20:13:54 CST | `workspace/observations/cold-start-round2-logcat.txt:866` | internal | n/a | `CVersionUpdateSystem.StartVersionUpdate` | method0/PID 25301 | 版本检查启动 |
| 2026-11-24 20:13:54 CST | `workspace/observations/cold-start-round2-logcat.txt:881` | internal | n/a | `CVersionUpdateSystem.StartCheckAppVersion` | method0/PID 25301 | App 版本检查启动 |
| 2026-11-24 20:13:55 CST | `workspace/observations/cold-start-round2-logcat.txt:1015` | internal | n/a | `cmd=on_get_new_version` | method0/PID 25301 | 版本消息回调 |
| 2026-11-24 20:13:55 CST | `workspace/observations/cold-start-round2-logcat.txt:1017` | inbound-to-client | n/a | `AnnouncementUrl=http://image.smoba.qq.com/Announcement/9.2.1.7/...` | method0/PID 25301 | 公告 URL 模板 |
| 2026-11-24 20:13:55 CST | `workspace/observations/cold-start-round2-logcat.txt:1017` | inbound-to-client | n/a | `IncompatibleResourceVersion=3.81.1.67` | method0/PID 25301 | 资源兼容版本字段 |
| 2026-11-24 20:13:56 CST | `workspace/observations/cold-start-round2-logcat.txt:1038` | internal | n/a | `isNeedUpdating=1` | method0/PID 25301 | 强制更新判定 |
| 2026-11-24 20:13:56 CST | `workspace/observations/cold-start-round2-logcat.txt:1040` | internal | n/a | `downloadAppVersion=9.2.1.7` | method0/PID 25301 | 服务器要求 App 版本 |
| 2026-11-24 20:13:56 CST | `workspace/observations/cold-start-round2-logcat.txt:1056` | internal | n/a | `downloadAppSize=458025698` | method0/PID 25301 | 下载包大小 |
| 2026-11-24T12:12:54Z | `workspace/observations/frida/cold-start-round2-20261124-201241.ndjson:26` | outbound | 768 | `GET /padxxxxx/cfgpush/getConfig?com_params=...app_ver...` | method0/PID 25301, inode 1256693 | 本地重写后配置请求 |
| 2026-11-24T12:12:54Z | `workspace/observations/frida/cold-start-round2-20261124-201241.ndjson:27` | inbound | 126 | `HTTP/1.1 404` | method0/PID 25301, inode 1256693 | 本地服务未实现该路径 |
| 2026-11-24T12:17:47Z | `workspace/observations/frida/cold-start-round3-20261124-201735.ndjson:1785` | outbound | 768 | `GET /padxxxxx/cfgpush/getConfig?com_params=...` | method0/PID 46368, inode 3732637 | 复现同一请求 |
| 2026-11-24T12:17:44Z | `workspace/observations/frida/cold-start-round3-20261124-201735.ndjson:1643` | connect | n/a | `123.139.99.91:80` | method0/PID 46368, inode 3733394 | `image.smoba.qq.com` HTTP 连接 |
| 2026-11-24T12:17:44Z | `workspace/observations/frida/cold-start-round3-20261124-201735.ndjson:1644` | outbound | 243 | `GET /Announcement/9.2.1.7/SGame_Announcement_9.2.1.7_1.txt` | method0/PID 46368, inode 3733394 | 公告正文请求 |
| 2026-11-24T12:17:44Z | `workspace/observations/frida/cold-start-round3-20261124-201735.ndjson:1645` | inbound | 536 | `HTTP/1.1 200 OK` | method0/PID 46368, inode 3733394 | 公告响应头 |
| 2026-11-24T12:17:44Z | `workspace/observations/frida/cold-start-round3-20261124-201735.ndjson:1646` | inbound | 3495 | 公告内容前缀被截断 | method0/PID 46368, inode 3733394 | 公告正文数据 |
| 2026-11-24T12:18:29Z | `workspace/observations/cold-start-round3-logcat.txt:1033` | internal | n/a | `on_get_new_version` + `AnnouncementUrl=9.2.1.7` | method0/PID 46368 | 与 wire HTTP 公告下载时序一致 |

## 未证明点

- `/padxxxxx/cfgpush/getConfig` 返回 404 后，`on_get_new_version` 的 `m_custom_str` 仍出现，当前证据不足以判断它来自哪条线上 HTTPS 响应、缓存、兜底内置配置，还是另一控制面返回。
- `9.2.1.7` 与 `IncompatibleResourceVersion=3.81.1.67` 的 wire 响应字段未直接捕获，只看到 logcat 解析结果。
- 本地服务端能否通过 `/padxxxxx/cfgpush/getConfig` 返回兼容配置尚不可确认；需要先证明客户端接受的响应 schema 与签名/校验规则。
- 公告页面可单独被本地 `image.smoba` 重定向欺骗，但没有证据表明这会让 `isNeedUpdating` 变 0。

## 缺口与最小采集步骤（设备恢复后）

1. 保持 LSPosed Houdini hook 与 ADB reverse，不启动游戏前导出 `logcat -c`。
2. 启动 `tools/frida/run-network-capture.mjs` attach 模式，文件命名 `version-gate-round1-...`；同时启动 `/proc/net/tcp{,6}` 和 `/proc/<pid>/fd` 高频快照。
3. 在 `logcat` 中抓取 `StartCheckAppVersion` 到 `OnGetNewVersionInfo` 的完整 3 秒窗口。
4. 同时导出 Rust `/debug/observations`，确认本地 `/padxxxxx/cfgpush/getConfig` 404 的时间戳与 `on_get_new_version` 时间戳。
5. 若要证明公告欺骗路径，只允许新增一个变量：把 `image.smoba.qq.com` 等长重写到 `127.0.0.1:19620/announcement` 后重测；不要同时改版本响应。
6. 判定停止条件：
   - `on_get_new_version` 不再出现或 `isNeedUpdating=0` → 版本配置被证明可控；
   - 公告请求仍 200 但页面消失 → 公告资源不是强制门禁本身；
   - 仍 `downloadAppVersion=9.2.1.7` → 继续静态定位 `CVersionUpdateSystem` 数据流。

## 不能做的推断

- 不能把 `AnnouncementUrl` 当成“版本门禁接口”；它只是公告资源模板。
- 不能把 `:20000` 或 `:10012` 直接认定为版本/游戏网关；二者仍只有候选证据。
- 不能伪造 `on_get_new_version` schema；必须先拿到真实响应字节或静态解析结构。
