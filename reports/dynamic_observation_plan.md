# 动态协议观测实施计划

## 目标

在不修改应用和设备配置的前提下，先确定 `com.tencent.tmgp.sgame` 的真实连接目标，再确认控制面与游戏帧通道，最后提取帧边界。当前阶段只允许 ADB 只读采集，主线程统一执行设备命令。

## 已知静态事实

- APK：`3.81.1.8`，SHA-256 `A016D941A3D7BA0A8FC976DAE6FE744EFEC85835A16DD10928B65A9C7E19EE5D`。
- 明文控制面包括：
  - MSDK：`https://ap6.ssl.msdk.qq.com`
  - TDM Router：`https://hc2.tdm.qq.com:8013/tdm/v2/route`
  - GCloud RemoteConfig/GTrace：`https://cloudctrl.gcloud.qq.com`
- 游戏网关和帧格式未知；不能把 HTTP-DNS 或 MSDK 配置当作游戏协议证据。

## 阶段 1：只读连接基线

命令：

```powershell
Set-Location D:\project\wzry
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\Observe-Client.ps1 -Serial 192.168.5.102:5555 -Seconds 60
``+

产物：

- `workspace/observations/device-state-*.txt`
- `workspace/observations/logcat-before-*.txt`
- `workspace/observations/logcat-live-*.txt`
- `workspace/observations/tcp-before-*.txt`
- `workspace/observations/tcp-after-*.txt`
- `workspace/observations/tcp6-before-*.txt`
- `workspace/observations/tcp6-after-*.txt`
- `workspace/observations/processes-*.txt`

解析：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\Parse-ProcNet.ps1 -Path .\workspace\observations\tcp-after-*.txt
```

通过流程：

1. 采集前后存在新增或持续连接。
2. 能通过 PID/socket inode 将连接归属到游戏进程。
3. 区分 443 控制面连接与非 443 游戏候选连接。

## 阶段 2：启动后的最小观测

主线程确认允许启动后：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\Observe-Client.ps1 -Serial 192.168.5.102:5555 -Seconds 120 -StartApp
```

重点检查：

- `logcat` 中 MSDK/TDM/GCloud/DNS/connect 错误。
- 游戏建立连接的时间顺序。
- 443 HTTPS 控制面与非 443 TCP/UDP 候选。
- 应用是否在登录前退出或触发证书/完整性校验。

## 阶段 3：进程归属

只读 root 命令（主线程执行）：

```powershell
D:\project\poxxiao\tools\android-sdk\platform-tools\adb.exe -s 192.168.5.102:5555 shell pidof com.tencent.tmgp.sgame
D:\project\poxxiao\tools\android-sdk\platform-tools\adb.exe -s 192.168.5.102:5555 shell su -c "ls -l /proc/<pid>/fd | grep socket"
```

将 fd 的 socket inode 与 `/proc/net/tcp*` 的 inode 列关联。输出中必须记录 PID、UID、inode、本地/远端地址和状态。

## 阶段 4：可选抓包

当前缺少 `mitmdump`、`frida`、`tcpdump`、`tshark`。使用前需要主线程确认并按以下优先级选择：

1. **tcpdump**：最适合确认完整 TCP/UDP 目标与首包字节，但需要向设备放置二进制，属于设备修改。
2. **mitmproxy**：适合控制面 HTTPS；需要代理与 CA 配置，且可能遇到证书固定。
3. **Frida**：适合 hook `connect/send/recv` 并输出方向、长度、返回值和前 64 字节；会修改进程状态，反作弊风险最高。

推荐次序：tcpdump 首包观测 → Frida 精确定位 → mitmproxy 仅用于控制面。三者都未安装，不应并行引入。

## 阶段 5：帧格式判定

必须满足：

- 至少 3 次独立连接样本。
- 明确方向、时间、字节长度。
- 首包字节稳定或有可解释差异。
- 长度字段能预测整包边界。
- 相同命令号样本结构一致。

输出字段建议：

| 字段 | 证据 |
| --- | --- |
| Magic | 首字节稳定性 |
| Header length | 固定前缀与包长差异 |
| Body length | 字段值与实际收包边界 |
| Sequence | 双向递增或响应配对 |
| Command | 分组聚合后的稳定值 |
| Encryption/Compression | 首包随机性和长度变化 |

在以上证据齐前，后端只允许保留协议无关观测网关，不实现具体游戏 handler。
