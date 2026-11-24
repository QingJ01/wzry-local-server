# APK 改包流水线方案

## 结论

`D:\project\poxxiao` 中的 Android 工具链可以直接复用；当前游戏资源包是特殊 ZIP 结构，不能直接用通用解压工具假设路径。已确认安装包为 ZIP 内的 `安装包/3.81.1.8.apk`，包名 `com.tencent.tmgp.sgame`，版本 `3.81.1.8` / `381010801`。原 APK 当前校验为 V1 签名、未启用 V2/V3 签名，4 字节对齐校验通过。

不要复用 poxxiao 的 native 补丁、偏移、协议号或包名；它的价值是流程、工具和脚本结构。

## 当前事实

- 源压缩包：`D:\project\wzry\3.81.1.67.zip`
- 源压缩包 SHA-256：`D6E5215CA4FEBDC37DA7BF1C93A27C5FCB7725138459834A2380078F36EAD5FA`
- APK ZIP 条目：`安装包/3.81.1.8.apk`
- APK 大小：`460,348,136` 字节
- APK SHA-256：`A016D941A3D7BA0A8FC976DAE6FE744EFEC85835A16DD10928B65A9C7E19EE5D`
- 包名：`com.tencent.tmgp.sgame`
- 版本：`3.81.1.8` / `381010801`
- 主 ABI：`arm64-v8a`，同时包含 `armeabi-v7a`
- 游戏核心 native：`lib/arm64-v8a/libil2cpp.so`、`lib/arm64-v8a/libGameCore.so`、`lib/arm64-v8a/libunity.so`
- 网络相关 native：`lib/arm64-v8a/libtransceiver.so`、`libgcloud` 相关库可能存在于后续下载资源或插件包中，不能凭 poxxiao 经验假设
- 明确配置：`assets/dnsconfig.ini` 只包含 HTTP-DNS 服务器，不是登录/游戏网关地址；`assets/msdkconfig.ini` 为 MSDK 环境/日志配置，也不是最终服务器地址

源压缩包的 ZIP64 元数据存在非标准字段，通用工具可能只读到截断清单。应使用按签名扫描/按中央目录逐项解析的专用提取脚本，而不是先解压 8.3GB 全部内容。

## 可复用工具路径

- ADB：`D:\project\poxxiao\tools\android-sdk\platform-tools\adb.exe`
- AAPT：`D:\project\poxxiao\tools\android-sdk\build-tools\36.1.0\aapt.exe`
- AAPT2：`D:\project\poxxiao\tools\android-sdk\build-tools\36.1.0\aapt2.exe`
- ZipAlign：`D:\project\poxxiao\tools\android-sdk\build-tools\36.1.0\zipalign.exe`
- APKSigner：`D:\project\poxxiao\tools\android-sdk\build-tools\36.1.0\lib\apksigner.jar`
- Java 17：`D:\project\poxxiao\tools\java17\bin\java.exe`
- Keytool：`D:\project\poxxiao\tools\java17\bin\keytool.exe`
- Node.js：`D:\project\poxxiao\tools\node\node.exe`

## 阶段 1：安装包提取

1. 输入前先校验源压缩包 SHA-256，必须等于上面的值。
2. 解析 ZIP 中央目录，查找名称为 `安装包/3.81.1.8.apk` 的条目；名称必须按 UTF-8 解码，不要依赖当前控制台代码页。
3. 读取该条目的本地文件头，计算数据偏移：`30 + nameLength + extraLength`。
4. 校验压缩方法为 Store（method 0）、压缩大小等于未压缩大小，再按数据范围写出 APK。
5. 校验 APK 大小和 SHA-256，写入产物清单。

这一步应做成幂等脚本。脚本不应解析整个资源包，也不应在失败后留下半成品输出。

### 实际提取记录

- 执行日期：2026-11-24
- 提取脚本：`D:\project\wzry\workspace\tools\extract_wzry_apk.mjs`
- 输出文件：`D:\project\wzry\workspace\apk\3.81.1.8.apk`
- 输出大小：`460,348,136` 字节
- 输出 SHA-256：`A016D941A3D7BA0A8FC976DAE6FE744EFEC85835A16DD10928B65A9C7E19EE5D`
- 提取方式：校验源压缩包 SHA-256 后，逆向扫描 ZIP 中央目录并定位目标条目；校验本地文件头、Store 压缩方法和数据边界后按范围写出。
- 结果：校验通过；未解压其他资源，未修改设备。

复现命令：

```powershell
Set-Location D:\project\wzry
D:\project\poxxiao\tools\node\node.exe .\workspace\tools\extract_wzry_apk.mjs
```

## 阶段 2：服务器地址注入策略

按优先级尝试，禁止一开始就 native patch：

1. **设备侧可覆盖配置**：用只读 ADB 探测应用私有目录、外部数据目录和下载资源目录中的配置文件。若客户端运行时会生成服务器配置，优先通过 root 备份/替换这些配置，避免修改 APK。
2. **APK 内配置/资源补丁**：静态搜索 APK 与下载资源中的域名、IP、网关列表。只有发现明确的登录/调度配置时，才替换对应 assets 或资源条目。
3. **动态 Hook**：在确认调用链后用 Frida 等工具在连接建立处重写 host；这适合定位，不建议作为最终交付方案。
4. **Smali/Java 层 patch**：如果地址在 Java/Kotlin 层生成，用 jadx 定位并生成最小 smali patch。
5. **Native/IL2CPP patch**：最后手段。先由协议逆向任务产出 `libil2cpp.so`、`libGameCore.so` 或网络库的精确调用点、字符串和偏移，再按 ABI 分别 patch，不允许盲扫替换。

`dnsconfig.ini` 只影响 HTTP-DNS，改它不等于改游戏网关；不能把它当作唯一改包点。

## 阶段 3：APK 修改

参考 `D:\project\poxxiao\android\mobile-standalone\Build-EmbeddedApk.ps1`，但需要为本项目重写参数和校验：

1. 复制原 APK 到输出路径；如果输出已存在则失败，不做覆盖。
2. 按清单替换或新增条目，每个条目记录原 SHA-256 和新 SHA-256。
3. 删除 `META-INF/MANIFEST.MF` 以及 `META-INF/*.SF`、`*.RSA`、`*.DSA`。
4. `zipalign -f -p 4` 生成对齐文件，替换未对齐中间产物。
5. 使用专用本地 keystore 签名；不要使用 poxxiao 的 keystore。
6. `apksigner verify --verbose` 必须通过。

建议签署 V2，当前原 APK 只有 V1。若目标系统 Android 11+，V2 是必要保险；不要仅依赖 V1。

## 阶段 4：签名与对齐验证

每次构建输出至少记录：

- 原 APK SHA-256
- 修改后 APK SHA-256
- 签名方案验证结果
- `zipalign -c -p 4` 退出码
- 包名、versionCode、versionName
- 修改条目列表：路径、旧哈希、新哈希、操作类型

推荐命令：

```powershell
$aapt dump badging <apk>
$zipalign -c -p 4 <apk>
$java -jar $apksigner verify --verbose <apk>
```

## 阶段 5：设备安装与回滚

目标设备：`192.168.5.102:5555`。

安装前必须做只读基线：

```powershell
adb -s 192.168.5.102:5555 get-state
adb -s 192.168.5.102:5555 shell pm path com.tencent.tmgp.sgame
adb -s 192.168.5.102:5555 shell dumpsys package com.tencent.tmgp.sgame
```

回滚策略：

1. 如果设备已有同包名应用，先保存 `pm path`、versionCode、签名摘要和用户数据状态。
2. 先安装到可回滚的调试设备，不要直接覆盖用户主力环境。
3. 失败时卸载调试包会连带删除应用数据；如需保留数据，必须先明确导出/备份，Android 对私有数据通常不能完整可靠备份。
4. 尽量保持 versionCode 不变，通过 `adb install -r -d` 覆盖；修改 package/versionCode 会让升级和回滚关系更复杂。
5. 安装后用 `aapt dump badging` 与设备端 `pm path` 哈希比对，确认实际安装产物。

安装脚本可参考 `Install-MobileBundle.ps1` 的 root 探测、UID 解析、SELinux 上下文处理、`adb reverse` 和启动流程，但必须移除它对 poxxiao 包名和固定 native 补丁的假设。

## 产物与清单

建议目录：

```text
client/
  original/3.81.1.8.apk
  patches/
  builds/
  keys/
  manifests/build-<timestamp>.json
```

构建清单 JSON 至少包含：

```json
{
  "source": {
    "archive": "D:/project/wzry/3.81.1.67.zip",
    "archiveSha256": "D6E5215CA4FEBDC37DA7BF1C93A27C5FCB7725138459834A2380078F36EAD5FA",
    "apkEntry": "安装包/3.81.1.8.apk",
    "apkSha256": "A016D941A3D7BA0A8FC976DAE6FE744EFEC85835A16DD10928B65A9C7E19EE5D"
  },
  "package": "com.tencent.tmgp.sgame",
  "versionCode": 381010801,
  "versionName": "3.81.1.8",
  "changes": [],
  "signature": {},
  "alignment": {},
  "outputSha256": ""
}
```

## 下一步

1. 编写并验证专用 APK 提取脚本，不保留 `zip_inventory.txt`、全量中央目录扫描等临时产物。
2. 由协议逆向任务确认登录/调度地址来源和最小修改点。
3. 编写 `Build-WzryApk.ps1`，从提取、补丁、对齐、签名到验证完全幂等。
4. 在设备只读基线完成后再实现 `Install-WzryApk.ps1`，并加入安装前哈希确认和失败回滚说明。


## 完整性触发排查（2026-11-24）

- 判定报告：eports/signature_integrity_verdict.md — 实验证明改签名/改包**不是**崩溃触发源（腾讯原签名 B0 同样被外部 force-stop 杀死）。
- 冷启动实验脚本：	ools/Invoke-ColdStartExperiment.ps1（安装→launch→按秒轮询 pid→dump logcat→写 result.json）。
- 对照产物：workspace/apk/B0-original-tencent-sig.apk（原签名 zipalign）、workspace/apk/A0-resigned-final.apk（仅重签）。
- 重要安装约束：腾讯签名包与 debug 重签包**不能互相 install -r 覆盖**，会 INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match；切换签名前必须 db uninstall 清场（会丢应用数据）。

