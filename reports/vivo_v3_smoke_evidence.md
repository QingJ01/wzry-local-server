# vivo 真机 v3 (sgamx) 安装/启动证据审计

**审计时间**: 2026-11-25（Asia/Shanghai）
**范围**: 只读审计，未触碰设备配置、未修改共享文件；`192.168.5.101:5555`（MuMu emulator，offline）按约定完全不碰。
**设备**: vivo V2238A / PD2238, Android 16 (SDK 36)，ADB serial `adb-10CD6M23EL003SU-l7D0C8 (3)._adb-tls-connect._tcp`（mDNS TLS 连接，transport_id 28；同一物理设备也出现在 transport_id 26/27 的重复 mDNS 条目下）。
**被测 APK**: `client/builds/wzry-version-gate-localdebug-sgamx-v3.apk`，SHA-256 `7DEA7EE8E32ACF7FD3ED48C9FD6E67D6C690E7010576C9A18460B5E56D062AD7`（与构建记录一致）。

## 结论速览

- `com.tencent.tmgp.sgamx` v3.81.1.8 **已安装且仍在设备上**（共存安装，正式 `sgame` 12.1.1.1 未受影响）。
- 启动在 ~250ms 内被 **资源 license 校验** 拦死：`Resource license(type=layout, pkg=com.tencent.tmgp.sgamx) is not found`，随后 `System.exit(-1)` 自杀。
- **这是当前唯一已证实的启动阻断**；进程从未走到渲染任何 UI。
- **version-gate patch（libapollo.so 3 处 patch）未被测试到 UI 阶段**——libapollo.so 确实被加载，但进程在加载后即退出，版本公告检查（`CVersionUpdateSystem`）从未执行。version-gate patch 的有效性在本次启动中**既未被证实也未被否定**。
- 无 crash、无 tombstone、无 ANR、无 FATAL EXCEPTION；是程序主动 `System.exit(-1)`，不是系统杀进程。
- 登录页、大厅、版本公告 UI：**均未到达**。

## 安装状态（设备实时查询）

| 项 | 值 | 证据 |
|---|---|---|
| `com.tencent.tmgp.sgamx` | **已安装** | `pm path` → `/data/app/~~koV06yJSGjQnrJparEfBEQ==/com.tencent.tmgp.sgamx-QShPf6715AJGFBRvv26RIg==/base.apk` |
| versionCode / versionName | `381010801` / `3.81.1.8` | `dumpsys package` |
| minSdk / targetSdk | 16 / 29 | `dumpsys package` |
| firstInstallTime | `2026-11-25 07:33:03` | `dumpsys package`（与 smoke 报告安装时间一致） |
| `com.tencent.tmgp.sgame`（正式包） | 仍安装，`versionCode=1201010103` / `12.1.1.1` | `pm path` + `dumpsys`——共存安装验证通过 |

## 运行状态（设备实时查询）

- `ps -ef \| grep sgamx` → **空**：sgamx 进程当前不在运行。
- `ps -ef \| grep sgame` → **空**：正式包也未在运行。
- `dumpsys window mCurrentFocus` → `com.tencent.xfight/com.tencent.wedo.WeDoActivity`：前台被另一个腾讯游戏（SurfaceView 游戏，与本次测试无关）占用；sgamx 从未出现在前台。

## 启动失败证据链（`artifacts/smoke-v3/logcat-launch.txt`）

两次启动（07:33:50、07:34:11）产生完全一致的轨迹：

1. 进程 `cent.tmgp.sgamx` (pid 20613) 正常 fork，nativeloader 依序加载全部 native 库——`libtprt`、`libPcdnTegTransSdk`、`libgcloudcore`、`libTDataMaster`、`libMSDKSystem`、**`libapollo.so`（line 150，加载 ok）**、`libMsdkAdapter`、`libCrashAdapter`、`libtgpa`、`libAkDelayWG`、`libmain` —— **全部加载成功，无 native 加载失败**。
2. `SGame_Activity: ISLivingVersion0` → `SGameActivity: webviewres com.tencent.tmgp.sgamx`（line 173–177）。
3. **阻断点**（line 178–199）：

   ```
   java.lang.Exception: Resource license(type=layout, pkg=com.tencent.tmgp.sgamx) is not found
       at com.tencent.msdk.tools.ResID.loadIdentifierResource(ResID.java:11)
       at com.tencent.tmgp.Common.WebViewResID.init(WebViewResID.java:77)
       at com.tencent.tmgp.Common.SmobaEx.onCreate(SmobaEx.java:799)
       at com.tencent.tmgp.sgame.SGameActivity.onCreate(SGameActivity.java:29)
       at android.app.Activity.performCreate(...)
   ```

   异常在 `SGameActivity.onCreate` → `SmobaEx.onCreate` → `WebViewResID.init` → `ResID.loadIdentifierResource` 抛出。MSDK 的 WebView 资源 ID 解析依赖一个 **license 注册表**（按 `type=layout` + `pkg` 查找），`sgamx` 包名在该注册表中无条目。
4. `System.exit called, status: -1` → `AndroidRuntime: VM exiting with result code -1`（line 200–201）。自杀在异常抛出后 ~1ms 内完成，距进程创建 <300ms。

## 各审计项判定

| 审计项 | 判定 | 证据 |
|---|---|---|
| 是否已安装 | ✅ 已安装，共存成功 | `pm path`/`dumpsys` 实时确认；正式 `sgame` 12.1.1.1 不受影响 |
| 版本公告是否消失 | ⚠️ **无法判定** | 进程从未到达 `CVersionUpdateSystem` 检查点；logcat 中无 `on_get_new_version`、无公告 UI——但这是 license 阻断的副作用，**不能**作为 version-gate patch 生效的证据 |
| 登录/大厅是否到达 | ❌ 未到达 | `mCurrentFocus` 始终为 `xfight`；`ui-dump.xml`/`screenshot.png` 均显示 xfight SurfaceView，无 sgamx UI；`ps.txt` 无 sgamx 进程 |
| 崩溃原因 | ✅ 已定位 | `Resource license(type=layout, pkg=sgamx) is not found` → `System.exit(-1)`。非 crash/tombstone，是 MSDK WebViewResID 初始化对包名的主动拒绝 |
| 崩溃类型 | 自杀（deliberate exit），非系统 kill、非 SIGKILL、非 ART crash | 无 `FATAL EXCEPTION`；`/data/tombstones` 最新条目属于 `xfight`（2026-11-24 11:37，预存，与本测试无关） |

## 阻断点根因分析（独立确认）

- `WebViewResID.init`（`com.tencent.tmgp.Common`，SmobaEx 父类 onCreate 调用链）通过 `ResID.loadIdentifierResource("layout", pkgName)` 查 MSDK 内置的 license→资源映射。该映射以**包名为 key**。
- v3 构建把 root `manifest package` 改成 `sgamx`（共存必须），但 **layout 类 license 字符串仍硬编码为 `sgame`**（或在 MSDK jar/dex 资源表里无 `sgamx` 条目）→ 查表 miss → 抛 Exception → `System.exit(-1)`。
- 这与 v2 的 `ClassNotFoundException`（launchable-activity 类名被改名）和 v1 的 `INSTALL_FAILED_DUPLICATE_PERMISSION` 是**三个不同的、递进的阻断点**；v3 已越过安装和前两个运行时阻断，停在第三层。

## 缺口（未验证项）

1. **version-gate patch 未验证**：libapollo.so 加载了但 patch 是否阻止版本公告未测试到——需要先把 license 阻断解掉，让流程走到版本检查点。当前不能宣称“版本公告消失”是 patch 生效。
2. **登录/大厅/支付全链路**：完全未触达。
3. **license 表位置未定位**：是 MSDK jar（`com.tencent.msdk.tools.ResID` / `WebViewResID`）内置映射、还是 APK assets/res 里的 license 文件按包名索引，需要逆向 dex 确认补丁点（等长改 `sgame`→`sgamx` 或给 `sgamx` 注册一份 license）。
4. **workspace/experiments 无 v3 新证据**：`ui2.xml`–`ui10.xml`（01:34–01:46）是更早一轮 vivo launcher/桌面 UI dump（package=`com.bbk.launcher2`/vivo 系统），与 sgamx 无关；`live-20261124-*` 是 .101 emulator 旧证据。v3 的完整 UI/logcat 证据集中在 `artifacts/smoke-v3/`。
5. **设备端 license 修复未做**：本任务只读，未尝试任何补丁。

## 证据文件索引

- `artifacts/smoke-v3/REPORT.md` — smoke tester 原始报告（install + 两次 launch + 2 分钟观察）。
- `artifacts/smoke-v3/logcat-launch.txt` — 关键崩溃轨迹（本报告引用行号对应此文件）。
- `artifacts/smoke-v3/logcat-final.txt` / `logcat-early.txt` — 观察期前后快照（无 sgamx 活动）。
- `artifacts/smoke-v3/ui-dump.xml`、`screenshot.png` — T+3s 前台 = xfight，证明 sgamx 无 UI。
- `artifacts/smoke-v3/ps.txt` — 无 sgamx 进程。
- `docs/package-rename-audit.md` — v1/v2/v3 构建策略与已知风险（v3 的 license 阻断在其“IL2CPP 包名校验/资源冲突”风险列表中已预警）。
- 设备实时查询命令（只读，无写操作）：`pm path`、`dumpsys package`、`ps -ef`、`dumpsys window`。
