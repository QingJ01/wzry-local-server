# 客户端动态观测方案

本目录的脚本只读采集设备状态、logcat 和 `/proc/net/tcp*`。它们不安装、卸载、启动、kill、修改配置或写入设备私有目录。主线程可以按需要单独执行启动命令，避免多个代理同时争夺 ADB。

## 当前证据

- 包名：`com.tencent.tmgp.sgame`
- 入口：`com.tencent.tmgp.sgame.SGameActivity`
- 明文控制面：MSDK、TDM Router、GCloud RemoteConfig/GTrace，全部为 HTTPS。
- 游戏网关与帧协议不明；`assets/msdkconfig.ini` 与 `dnsconfig.ini` 不能当作游戏网关证据。
- 客户端网络实现位于 native 层，Java 层没有可直接观测的帧逻辑。

## 推荐顺序

1. **只读连接基线**
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\Observe-Client.ps1 -Serial 192.168.5.102:5555 -Seconds 60
   ```
   脚本写入 `workspace/observations`，包含采集前后的 `/proc/net/tcp`、`tcp6`、logcat 与设备属性。

2. **格式化连接表**
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\Parse-ProcNet.ps1 -Path .\workspace\observations\tcp-after-*.txt
   ```

3. **归属进程**
   - 用 `adb -s 192.168.5.102:5555 shell pidof com.tencent.tmgp.sgame` 找 PID。
   - 用 root 只读执行：
     ```text
     su -c 'ls -l /proc/<pid>/fd | grep socket'
     su -c 'for inode in <inode1> <inode2>; do grep -R "$inode" /proc/net/tcp /proc/net/tcp6; done'
     ```
   - 将 socket inode 与 `/proc/net/tcp*` 的 `inode` 列关联，得到游戏专属 IPv4/IPv6 远端地址。

4. **启动后观测**
   主线程确认可以启动应用时，加 `-StartApp` 并延长采样：
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\Observe-Client.ps1 -Serial 192.168.5.102:5555 -Seconds 120 -StartApp
   ```

## DNS 与 TLS 目标

`logcat` 中过滤域名、DNS、`connect`、`GCloud`、`MSDK`、`TDM`：

```powershell
Select-String -Path .\workspace\observations\logcat-live-*.txt -Pattern 'msdk|gcloud|tdm|dns|connect|socket|https?://'
```

系统日志通常不能解出 HTTPS body，但可以确认 SDK 错误、证书校验和域名。若日志没有足够线索，再引入抓包工具。

## 可选工具

当前机器缺少 `mitmdump`、`frida`、`tcpdump` 和 `tshark`。不要在未确认需求前安装。

### mitmproxy

适合控制面 HTTP/HTTPS，不适合未还原的 TCP/KCP 游戏帧。最小安装：

```powershell
npm -v
winget install --id mitmproxy --accept-source-agreements --accept-package-agreements
```

使用时需要配置 Android 代理和安装 mitmproxy CA；这属于设备配置修改，必须先明确允许。对启用证书固定的 HTTPS，mitmproxy 可能失败，需要后续 Frida 定位校验点。

### tcpdump

设备有 root，可以只读采集网卡流量。优先找设备自带 `tcpdump`；没有则需为 `arm64-v8a` 交叉编译静态版本并 push 到临时目录。`tcpdump` 会触碰设备文件系统，不属于当前脚本范围。

示例（仅说明，不要直接执行）：

```text
su -c '/data/local/tmp/tcpdump -i any -s 0 -w /data/local/tmp/wzry.pcap'
```

### Frida

适合定位 `connect/send/recv` 与 host 选择，但会修改进程运行状态。确认协议边界前只作为下一步选项。最小工具链：

```powershell
npm install -g frida-tools
```

再获取与设备架构匹配的 `frida-server`，root 启动后注入。此操作修改设备，必须由主线程在明确授权后执行。

## 帧格式确认

在取得原始字节前，不得假设协议。验证顺序：

1. 从 socket 目标区分控制面 HTTPS 与游戏 TCP/UDP。
2. 记录每次连接的第一批字节（connect 后 5 秒内）。
3. 对比双向数据流：找出 magic、长度、序列号、命令号、压缩/加密前缀。
4. 统计首包大小分布和相邻包相关性；不要用单包猜测。
5. 找到明确长度字段后再实现解码器测试。

## 输出要求

每轮观测必须保存：

- 采集时间与命令。
- 设备序列号、应用版本、是否启动、采集时长。
- 游戏进程 PID 与 UID。
- `/proc/net/tcp*` 前后对照。
- logcat 原文和过滤结果。
- 若有抓包：原始文件 SHA-256、长度、时间范围和解析脚本。
- 明确标注“已证实 / 未证实 / 需要下一步工具”。
