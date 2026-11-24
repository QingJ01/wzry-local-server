# WZRY 最小控制面重定向补丁方案

## 目标

在不修改 native 库、不重建二进制资源结构的前提下，把客户端启动阶段的四个明文控制面请求重定向到本机 `19620`，用于验证 ADB reverse 与本地后端的观测闭环。此补丁不改变游戏登录网关，也不伪造任何业务协议。

## 可替换地址

| 位置 | 原地址 | 替换地址 | 长度 |
| --- | --- | --- | --- |
| `AndroidManifest.xml` | `https://hc2.tdm.qq.com:8013/tdm/v2/route` | `http://127.000.000.001:19620/tdm/v2/rout` | 40 |
| `AndroidManifest.xml` | `https://cloudctrl.gcloud.qq.com`（出现 2 次：RemoteConfig 与 GTrace 前缀） | `http://127.000.000.001:19620xxx` | 31，替换 2 处 |
| `AndroidManifest.xml` | `https://cloudctrl.gcloud.qq.com/gtrace/get_traceid_list` | `http://127.000.000.001:19620/gtrace/get_traceid_listxxx` | 55 |
| `resources.arsc` | `https://ap6.ssl.msdk.qq.com` | `http://127.000.000.01:19620` | 27 |

所有替换保持原始字符串长度不变，因此不会改变字符串池、资源表偏移或 Manifest 结构。Manifest 字符串使用 UTF-16LE，`resources.arsc` 中的 MSDK 地址使用 UTF-8。`127.000.000.01` 是等长表示法，按 IPv4 解析等价于 `127.0.0.1`；目标是让设备通过 `adb reverse tcp:19620 tcp:19620` 访问开发机本地后端。

## 文件

- 补丁清单：`client/patches/control-plane.json`
- 清单校验：`client/Test-ControlPlanePatch.ps1`
- 构建入口：`client/Build-WzryApk.ps1`

清单包含 `source.apkSha256`，构建脚本会先验证源 APK 哈希。每个二进制替换要求精确命中一次，不允许模糊或多次替换。

## 构建与验证

先用 `-WhatIf` 只做哈希、清单和替换计划校验，不写出 APK：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\project\wzry\client\Build-WzryApk.ps1 `
  -SourceApk D:\project\wzry\workspace\apk\3.81.1.8.apk `
  -OutputApk D:\project\wzry\client\builds\wzry-control-plane-debug.apk `
  -PatchManifest D:\project\wzry\client\patches\control-plane.json `
  -WhatIf
```

通过后去掉 `-WhatIf` 构建并签名：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\project\wzry\client\Build-WzryApk.ps1 `
  -SourceApk D:\project\wzry\workspace\apk\3.81.1.8.apk `
  -OutputApk D:\project\wzry\client\builds\wzry-control-plane-debug.apk `
  -PatchManifest D:\project\wzry\client\patches\control-plane.json
```

构建产物必须通过 `apksigner verify --verbose` 和 `zipalign -c -p 4`，并生成 `<output>.manifest.json`。构建 manifest 会记录每个 entry 的原 SHA-256、新 SHA-256、替换计数和操作类型。

## 真机安装与回滚

目标设备固定为 `192.168.5.102:5555`，由 `Install-WzryDbg.ps1` 执行：

1. `adb reverse tcp:19620 tcp:19620`
2. `adb reverse tcp:19621 tcp:19621`
3. 安装前记录 `pm path com.tencent.tmgp.sgame`
4. `adb install -r -d <patched-apk>`
5. 安装后回读 APK 哈希并保存日志

回滚方案：

- 保留原包 `workspace/apk/3.81.1.8.apk`，其 SHA-256 为 `A016D941A3D7BA0A8FC976DAE6FE744EFEC85835A16DD10928B65A9C7E19EE5D`。
- 需要回滚时先停止应用，再用原 APK 执行 `adb install -r -d`。
- Android 会拒绝直接降签名安装；由于调试设备有 root，如遇签名不一致，可先卸载调试包再安装原包。卸载会删除应用数据，该调试设备当前没有目标应用历史数据，风险可控。

## 安全边界

- 不修改 `libGameCore.so`、`libil2cpp.so` 或任何 native 偏移。
- 不把 `dnsconfig.ini` 当作游戏网关配置。
- 不声称完成登录闭环；本补丁只验证控制面请求是否到达本地后端。
- 若客户端存在资源完整性校验，安装后可能失败；失败时应收集 logcat 并回滚，而不是继续增加补丁。
