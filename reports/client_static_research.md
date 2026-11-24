# 客户端静态逆向与最小修改点报告

## 结论

- APK 固定为 `com.tencent.tmgp.sgame`，版本 `3.81.1.8` / `381010801`，入口 `com.tencent.tmgp.sgame.SGameActivity`，SHA-256 为 `A016D941A3D7BA0A8FC976DAE6FE744EFEC85835A16DD10928B65A9C7E19EE5D`。
- 客户端是 Unity IL2CPP。Java 入口只负责 SDK 和 Unity 初始化；游戏登录、网关选择和帧协议主要在受保护的 `libGameCore.so` / `libil2cpp.so` 中。
- Java/assets 中没有发现直接可改的战斗网关地址。`assets/msdkconfig.ini` 与资源中的 MSDK 地址只影响账号/平台 SDK；`GCloud.GCloudCore.RemoteConfigUrl`、TDM Router 和 GTrace 只影响 GCloud 配置、遥测与调度控制面。
- 原始包内明确控制面地址：
  - MSDK release：`https://ap6.ssl.msdk.qq.com`
  - TDM formal router：`https://hc2.tdm.qq.com:8013/tdm/v2/route`
  - GCloud remote config：`https://cloudctrl.gcloud.qq.com`
  - GTrace：`https://cloudctrl.gcloud.qq.com/gtrace/get_traceid_list`
- 游戏网关不在这些明文配置中，不能把 `dnsconfig.ini` 或 `msdkconfig.ini` 当作本地服地址的唯一修改点。

## 证据

### APK 与入口

- `workspace/analysis/apk_index.txt`：687 个条目，包含 3 个 dex、`arm64-v8a` 与 `armeabi-v7a` native 库、Unity IL2CPP metadata。
- `workspace/analysis/manifest_tree.txt`：Manifest、权限、入口、meta-data 与 URL。
- `workspace/analysis/jadx/sources/com/tencent/tmgp/sgame/SGameActivity.java`：入口 Activity，仅设置 Apollo/MSDK 平台信息并调用 Unity 启动。
- `workspace/analysis/jadx/sources/com/tencent/tmgp/Common/SmobaEx.java`：加载 `gcloudcore`、`MSDKSystem`、`apollo` 等 SDK，随后进入 Unity。
- `workspace/analysis/jadx/sources/com/tencent/abase/TX.java`：通过 Manifest meta-data 初始化 GCloudCore，`SolidConfigReader` 读取的也是 Manifest meta-data。

### 配置来源

- `assets/msdkconfig.ini`：`MSDK_ENV=release`；没有配置最终游戏网关。
- `workspace/analysis/aapt2_resources.txt`：MSDK 环境地址与 GCloud/TDM 标识。
- `assets/dnsconfig.ini`：HTTP-DNS 服务与开关，不等于登录/战斗网关。
- Manifest `GCloud.GCloudCore.RemoteConfigUrl`、`GCloud.GCloudCore.GTraceUrl` 与 TDM Router 是明确的 HTTP 控制面入口。
- 关键资源值：
  - `gcloud_AppId=1212338883`
  - `gcloud_AppKey=eae14641fb4d9dc8637a827ae138ff26`
  - `tdm_AppChannel=sgame_android`
  - `tdm_Protocol=TCP`

### Native 状态

- `libgcloudcore.so` 未被剥符号，包含 `ConfigureImpl::SetUrl`、`CGCloudCore::SetRemoteConfigUrl`、`WWWTaskBase::SetUrl`、TEA/对称加解密、URLRequest 等 GCloud 控制面实现。
- `libGameCore.so` 与 `libil2cpp.so` 基本被剥符号；只保留动态导入（`socket`、`connect`、`send`、`recv` 等）和少量异常/运行时符号。可读字符串没有明文网关、登录、protobuf、帧协议字段，说明字符串和元数据被保护或加密。
- Il2CppDumper 识别 metadata v23 / IL2CPP 24.1，但自动定位 CodeRegistration/MetadataRegistration 失败，输出 `This file may be protected`；当前不能安全假设任何 IL2CPP 方法名或偏移。

## 协议判断

- 已确认控制面包括 HTTPS：MSDK、TDM Router、GCloud RemoteConfig/GTrace。
- Manifest 中 `tdm_Protocol=TCP` 说明遥测/调度链路存在 TCP 模式，但不足以证明游戏帧协议帧格式。
- Java 层没有游戏 Socket 客户端实现；核心逻辑在 native。真实通道可能是 GCloud/自研 TCP 或 UDP/KCP 组合，必须通过动态观测确认。
- 静态阶段不能还原消息 ID、帧格式、压缩与加密；不能开始编写具体游戏 handler。

## 最小可验证客户端修改方案

优先级从低风险到高风险：

1. **只观测安装原包**：先把原 APK 安装到 `192.168.5.102:5555`，用 ADB 日志和系统连接记录确认首包网络目标。这是后续所有 patch 的基线。
2. **控制面重定向**：优先替换资源/Manifest 中的 MSDK、TDM Router、RemoteConfig/GTrace 为本机地址，并用 ADB reverse 验证客户端请求。适合先打通 HTTP 观测。
3. **动态 Hook**：在确认真实网关选择函数后，用 Frida hook native `connect`/`send`/`recv`，记录 host、port、帧长度和方向。动态 Hook 用于定位，不建议作为最终交付形态。
4. **Native/IL2CPP patch**：只有拿到稳定协议证据和目标偏移后才做。禁止盲扫替换或猜测偏移。

## 建议脚本

- `client/scripts/Build-WzryApk.ps1`：输入原 APK 与 patch 清单，执行替换、清除签名、zipalign、签名、`apksigner verify`。
- `client/scripts/Patch-ControlPlane.ps1`：最小化替换 MSDK/TDM/RemoteConfig 地址并生成 build manifest。
- `client/scripts/Observe-Device.ps1`：显式 `-s 192.168.5.102:5555`，执行 ADB reverse、安装/启动、logcat 过滤、只读连接采集。

## 当前风险

- 修改 Manifest/resource 需要重编译二进制 XML 或替换整个 `resources.arsc`，风险高于 assets 替换。
- 原包只有 V1 签名；在 Android 15 上建议重新签 V2/V3，并保持 versionCode 不变。
- 客户端可能包含签名校验、资源完整性校验或反调试。安装未验证的 patch 前必须保留原包和构建 manifest。
- 静态分析尚不能证明任何游戏业务协议；后续后端应先实现观测网关，而不是伪造登录成功。
