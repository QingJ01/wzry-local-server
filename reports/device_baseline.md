# 192.168.5.102:5555 设备基线报告

采集时间：2026-11-24（本地时区）

## 连接状态

- ADB：`D:\project\poxxiao\tools\android-sdk\platform-tools\adb.exe`
- 目标：`192.168.5.102:5555`
- 连接结果：成功，状态为 `device`
- 注意：本机 ADB 同时还连接了 `192.168.5.100:5555`、`192.168.5.101:5555` 和一台 USB/无线混合连接设备，后续命令必须显式使用 `-s 192.168.5.102:5555`。

## 设备信息

- 型号：`YOK-AN10`
- 产品/设备：`York`
- Android：15（SDK 35）
- 构建类型：`user`
- CPU ABI：`x86_64,arm64-v8a,x86`
- 内核：`Linux localhost 6.1.90-perf+ aarch64`
- 屏幕：1080x1920，密度 280
- 存储：`/data` 共 126G，已用 1.0G，可用 118G
- Wi-Fi 地址：`192.168.5.102/24`
- SELinux：`Permissive`

## Root 状态

- Shell 用户：`uid=2000(shell)`，上下文 `u:r:shell:s0`
- `su -c id`：`uid=0(root)`，上下文 `u:r:ksu:s0`
- KernelSu 已安装：`me.weishu.kernelsu`

结论：设备具备可验证 root 能力，可支持只读私有目录检查、应用部署和动态调试；本次按要求未执行任何写操作。

## 当前前台与监听

- 前台：`app.lawnchair/.LawnchairLauncher`
- 游戏相关进程：未发现
- TCP 监听：仅 `*:5555`（ADB 服务），未发现游戏或本地服务端口

## 应用包

疑似关键词（`sgame`、`wzry`、`moba`、`honor`、`tencent`、`king`、`pvp` 等）未匹配到包。

第三方包完整清单：

- `com.sankuai.meituan`
- `me.weishu.kernelsu`
- `org.frknkrc44.hma_oss`

结论：该设备当前未安装疑似目标游戏，后续需要安装改写后的 APK 或提供原始 APK 的准确包名后再采集运行时基线。

## 私有数据目录权限

- `/data/data`：`drwxrwx--x system system`
- `/data/user/0`：`drwxrwx--x system system`
- 普通 shell 只能进入/枚举受限，root 可访问；当前没有目标应用数据目录可检查。

## 调试建议

1. 所有 ADB 操作显式指定 `-s 192.168.5.102:5555`，避免误操作同网段其他设备。
2. 安装前先记录 APK SHA-256，并在设备上回读校验。
3. 使用 root 执行只读抓包/文件枚举时，仍避免 `rm`、`kill`、覆盖写入。
4. 设备有 118G 可用空间，足够安装 8.34G 压缩包中的资源和 APK。
5. 由于目标包未安装，下一步应在获取并解析 APK 后，用 `aapt dump badging` 确认包名、版本、入口 Activity 和 ABI。
