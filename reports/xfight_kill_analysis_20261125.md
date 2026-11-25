# xfight 拉起 / sgamx 被 kill 机制静态分析报告

**日期**: 2026-11-25
**对象**: vivo V2238A (PD2238) 上的 `com.tencent.tmgp.sgamx` v4（`wzry-version-gate-localdebug-sgamx-v4.apk`）
**任务**: 判定 License 静置 ~30-52s 后 sgamx 被 kill、前台被 `com.tencent.xfight/com.shenyi.local.BootActivity` 接管的机制归属——sgamx 主动拉起 vs 设备侧策略
**方法**: 纯静态分析。不触设备、不点击、不运行时注入。证据全部来自本仓库 artifacts 与 APK 字节。

---

## 结论（先行）

**xfight 拉起与 sgamx 被 kill 不是 sgamx 应用内逻辑发起的。** 判定为**设备侧行为**，最大嫌疑是 vivo 游戏中心/游戏空间栈（`com.vivo.gamespace` / `com.vivo.gamewatch` / `com.vivo.gamecube*` / `com.vivo.game`）或 launcher 的"游戏恢复/前台游戏保活"策略；sgamx 进程既不包含也无法拼出 `com.tencent.xfight` / `com.shenyi.local` 的任何引用。

置信度分级：

| 命题 | 判定 | 置信度 |
|------|------|--------|
| sgamx APK 中存在对 xfight 的显式引用（包名/组件/deep link/字符串常量） | **否** | 确定（字节级全覆盖扫描） |
| sgamx 进程在运行时能凭代码中已有字符串拼出 `com.tencent.xfight` 并 startActivity | **不可能** | 确定（子串 `xfight`/`shenyi` 本身即不存在，无从拼接） |
| xfight 拉起方在 sgamx 应用内 | **否** | 高 |
| xfight 拉起方在设备侧（vivo 游戏栈 / launcher / 系统） | **是** | 高（排除法 + 进程证据 + 历史复现） |
| 具体是 vivo 哪个组件 | 未唯一锁定 | 中（需一次带事件的动态取证，见末节"建议"） |

---

## 1. 核心证据：sgamx v4 APK 中不存在任何 xfight/shenyi 引用

用新写的 `tools/scan_apk_component_refs.mjs` 对 v4 APK 做字节级扫描。该工具解析 zip central directory，逐项 decompress 后在原始字节中查找目标串（UTF-8），STORED 大文件按 4MiB 块 + 256B 重叠扫描防跨界漏检。

### 1.1 扫描覆盖完整性

`workspace/analysis/xfight_scan_v4.json`：

- APK SHA256: `9D8423BCFE6BC3DD11D6E15DCB45DF8086872E8299C9A1C6CC77F5582406D81A` — 与 `artifacts/smoke-v4/REPORT.md` 记录完全一致，确认扫的就是设备上跑的那个包
- zip entries: **687/687 全部扫描，0 跳过**
- 扫描压缩字节量: 975,473,182 / 文件总 978,347,601（差额为 zip 结构开销、local header 与 `.idsig` 等非 entry 区，全部 entry 数据本身 100% 覆盖）
- 3 个 DEX（`classes.dex`/`classes2.dex`/`classes3.dex`）、`resources.arsc`、`AndroidManifest.xml`、全部 so（含 157MB 的 `lib/arm64-v8a/libil2cpp.so`、58MB 的 `libGameCore.so`）、全部 assets 均覆盖

### 1.2 扫描结果

| 目标串 | 命中数 |
|--------|--------|
| `com.tencent.xfight` | **0** |
| `xfight` | **0** |
| `com.shenyi.local` | **0** |
| `shenyi` | **0** |

`verdict: NO_MATCH`。

### 1.3 阳性对照（证明扫描器不是恒零）

同一 APK 扫已知必含串：`com.tencent.tmgp.sgame` + `SGameActivity` → **30 hits**。扫描器工作正常，零命中是真实阴性而非工具失灵。

### 1.4 嵌套插件包递归扫描

v4 APK 内嵌 4 个 zip/apk（游戏内动态下发容器），静态扫描器不递归。已提取到 `workspace/analysis/nested_zips/` 并分别重跑：

| 嵌套包 | entries 扫描 | xfight/shenyi 命中 |
|--------|--------------|---------------------|
| `assets/livesdk/plugin.apk` | 2528/2528 | 0 |
| `assets/grobot_plugin.apk` | 75/75 | 0 |
| `assets/GRobotSDK_NBPackage.zip` | 118/118 | 0 |
| `assets/MidasPay.zip` | 3/3 | 0 |

### 1.5 推论

`com.tencent.xfight` 这个包名在 sgamx 里**连一个字符片段都不存在**（`xfight`/`shenyi` 子串零命中）。因此 sgamx 在运行时没有任何途径构造出指向 xfight 的 Intent——无论是显式 `setComponent`/`setPackage`、`android.intent.action.VIEW` deep link，还是 WebView URL 跳转。排除"sgamx 主动 startActivity 拉起 xfight"的全部静态可能性。

补充：dex 中确实含 `startActivity`（16 处）、`killProcess`（5 处）、`android.intent.action.VIEW`（3 处）等通用 API 名字符串——这些是引擎/SDK 自带能力面，但它们的操作数里不存在 xfight，故与本次接管无调用链关系。

---

## 2. logcat 形态与"主动拉起"假设的矛盾

`artifacts/smoke-v4/REPORT.md` 记录两次启动的 kill 轨迹（`am_kill`/`wm_pause` 行因测试中途 `logcat -c` 未留存于文件，仅存于报告转述；此处仅基于已转述的事实做逻辑分析，不再二次断言）：

```
SGameActivity Displayed → License 渲染 → WebView sandboxed_process0 启动
→ 5-8s 后 wm_pause_activity userLeaving=true
→ am_kill [0,<pid>,sgamx,700,"stop com.tencent.tmgp.sgamx due to stop by <killerPid>"]
→ com.tencent.xfight/com.shenyi.local.BootActivity Displayed +126~152ms
```

三个细节指向设备侧而非应用侧：

1. **`BootActivity Displayed +152ms / +126ms` 是 warm/cold 之间偏快的启动**。对照 sgamx `SGameActivity` 首次 `+532ms`/`+500ms`。更关键的是 `artifacts/smoke-v3/ps.txt` 证明 **`com.tencent.xfight`（PID 2747）在 sgamx 启动前数小时（02:15:10）就已常驻**，且 `xfight` 内部还跑着一个 `libshenyi_node.so --no-warnings src/server.mjs` 的 Node 子进程（PID 17928）。一个本来就活着、测试前就被 `BatteryStatsService` 反复记为前台视频表面的应用，在 sgamx 被杀后立刻回到前台，符合"系统把用户最近的游戏重新提到前台"的恢复行为，而非"sgamx 显式 startActivity 冷启动了一个它压根不知道的应用"。
2. **`am_kill` subreason 700**。这对应 Android `ActivityManagerService` 的 kill 类型编码，killer PID（21651/22667）每次不同且短命。sgamx 若自杀走 `Process.killProcess(self)`/`System.exit`，不会以"stop com.tencent.tmgp.sgamx **due to stop by** <外部pid>"的措辞入账——该措辞的语义就是"应外部进程请求而 stop"。（注：此条依赖报告转述的日志原文；v4 未留存原始行，标为旁证而非直接证据。）
3. **`wm_pause_activity userLeaving=true` 不构成"sgamx 主动跳转"的证据**。该标志只表示系统认为用户要离开当前 Activity——当第三方/系统向 xfight 发起 startActivity、或 sgamx 被 force-stop 前的任务栈重排，同样会产生 userLeaving=true 的 pause。它不能反推发起方。

---

## 3. 设备侧嫌疑栈：vivo 游戏中心组件群（进程级证据）

`artifacts/smoke-v3/ps.txt`（2026-11-25 07:33 采集，v4 测试前两小时，同一台 vivo V2238A）显示以下常驻进程：

| 进程 | UID | 性质 |
|------|-----|------|
| `com.vivo.gamespace` | u0_a175 | vivo 游戏空间（用户态） |
| `com.vivo.game` | u0_a287 | vivo 游戏中心（用户态） |
| `com.vivo.gamewatch` | **system** | vivo 游戏 watchdog，系统权限 |
| `com.vivo.gamecube` / `:daemon` / `:assistantui` | **system** | vivo 游戏魔盒/助手，系统权限守护 |
| `com.tencent.xfight` | u0_a365 | 目标接管方，02:15 起常驻 |
| `libshenyi_node.so … src/server.mjs` | u0_a365（父 2747=xfight） | xfight 内嵌 Node 服务 |

要点：

- `gamewatch`/`gamecube` 以 **system uid** 运行，持有 force-stop 他应用、startActivity、读取任务栈的全部权限，是 killer PID 的合理来源。
- vivo 游戏空间的产品逻辑包含"游戏挂机/后台保护/切回最近游戏/游戏排行推荐"等前台调度功能；`gamecube:assistantui` 的存在说明游戏助手悬浮/调度能力处于激活态。
- 测试全程无人工点击（v4 REPORT 明确），排除用户手动切回。

---

## 4. 历史复现：同一接管行为此前被多次记录，且与 sgamx/sgame 版本无关

`reports/dynamic_capture_session_20261124.md`（2026-11-24，**另一台 MuMu 模拟器**、不同的包、早于 v4 构建一天）：

> "records a monkey launch for `com.tencent.xfight`, not the target package, and the target activity being moved to the background"
> "`monkey -p com.tencent.tmgp.sgame` is not reliable on this device: the later lifecycle log shows monkey resolving and launching `com.tencent.xfight`."

`reports/vivo_v3_smoke_evidence.md`（v3 测试，vivo 同机）：

> 前台 `mCurrentFocus` 始终为 `com.tencent.xfight/com.tencent.wedo.WeDoActivity`；sgamx 从未出现在前台。

两点推论：

- xfight 抢前台**跨设备（MuMu + vivo）、跨包版本（v3/v4/原版 sgame）、跨启动方式（monkey/adb am/手动）复现**——若是 sgamx v4 特有逻辑，不可能在 v4 构建前一天的 MuMu 上用原版 sgame 复现。这从时间上证伪"sgamx 版本门控拉起 xfight"的假设。
- 两台设备共同点：都装了 `com.tencent.xfight` 且它都是"用户最近玩过的游戏"。行为模式吻合 launcher/游戏中心的"恢复最近游戏"而非任何应用内逻辑。

---

## 5. 排除其他假设

| 假设 | 判定 | 依据 |
|------|------|------|
| sgamx 显式 startActivity 拉起 xfight | **排除** | 第 1 节：APK 字节中无 `xfight`/`shenyi` 任何片段，Intent 无从构造 |
| sgamx WebView/deep link 跳转 xfight | **排除** | 同上；deep link 仍需目标 scheme/host 字符串，不存在 |
| sgamx 资源/manifest 声明了与 xfight 的组件交互 | **排除** | `AndroidManifest.xml` 无 xfight/shenyi；intent-filter scheme 仅 `wx*`/`tencent*`/`smoba*`/`qwallet*`/`tpns`（manifest_tree.txt / jadx resources） |
| sgamx 自杀（System.exit / killProcess(self)）后 launcher 恰好恢复 xfight | **部分兼容但不能解释 am_kill 措辞** | v4 无 System.exit/FATAL 证据；`due to stop by <pid>` 语义为外部请求 |
| 病毒/三方恶意软件 | 无证据、不排除 | ps.txt 未见可疑非系统进程；非本次分析范围 |
| **vivo 游戏栈/launcher 策略（恢复最近游戏 + 清理"非游戏"前台）** | **最符合全部证据** | 进程在场、权限足够、跨设备跨版本复现、sgamx 内无任何触发面 |

唯一尚存的不确定点：killer PID 21651/22667 的精确包归属未被当场记录（v4 未抓 ps -ef 快照，logcat 也因 `logcat -c` 缺 `am_start` 行）。这影响"具体到哪个 vivo 组件"的归因，不影响"非 sgamx 主动"的主结论。

---

## 6. 调用链（基于现有证据可确认的部分）

```
[确定] adb/手动 start com.tencent.tmgp.sgamx/.SGameActivity
   → SGameActivity 启动，License 对话框渲染
   → License 内嵌 WebView 加载，sandboxed_process0 fork
[确定] 静置 30-52s（无任何输入）
   → 设备侧某 system 权限组件（vivo 游戏栈嫌疑）发起任务栈重排/force-stop
[确定] wm_pause_activity SGameActivity (userLeaving=true)
[确定] am_kill sgamx，subreason 700，措辞 "due to stop by <killerPid>"
[确定] com.tencent.xfight/com.shenyi.local.BootActivity Displayed（warm，进程本就在）
   → xfight WeDoActivity 大厅前台

[证伪] sgamx --(startActivity/deep link/WebView)--> xfight   ← 静态不可能
```

---

## 7. 产物

| 文件 | 说明 |
|------|------|
| `tools/scan_apk_component_refs.mjs` | 可复用静态扫描器：任意 APK × 任意目标串的字节级引用扫描，含覆盖率与阳性对照逻辑 |
| `workspace/analysis/xfight_scan_v4.json` | v4 APK 扫描原始报告（含 SHA256、687/687 覆盖、0 hits） |
| `workspace/analysis/nested_zips/` | 4 个嵌套插件包提取件，均已单独扫描为零命中 |

---

## 8. 建议下一步（如需锁定具体 vivo 组件）

此为**动态取证**建议，超出本次纯静态范围，供后续决策：

1. 复现时不执行 `logcat -c`，全程抓 unfiltered logcat，重点保留 `am_start`（含 callingUid/callingPid）、`wm_new_task`、`am_kill` 原始行——可直接读出 killer PID 对应进程名。
2. kill 发生瞬间 `ps -ef | grep <killerPid>` 或事前 `ps -ef` 快照比对，锁定 21651/22667 归属。
3. `dumpsys package com.vivo.gamewatch / com.vivo.gamecube` 查其 permission 与 component，确认是否声明 force-stop/startActivity 能力（只读）。
4. 对照实验：同一台 vivo 卸载/停用游戏空间后复测；或在无 xfight 的设备上复测——若 sgamx 不再被杀/接管，即可闭环"设备侧游戏栈"归因。
5. 单独补一组"License 点同意后"的对照：若点击同意后正常进入且不再被杀，则 vivo 策略可能针对"长时间停在非游戏画面的游戏包"做回收；这对验收用例的编写（应尽快点击同意）有直接指导意义。

---

## 9. 动态/静态证据冲突（必须直面的未决问题）

本节在本报告主体完成后追加，记录一处**无法调和的证据冲突**。它不动摇第 1 节的字节级事实，但确实动摇"xfight 拉起方必在设备侧"这一推断在「点击同意」路径上的普适性。**在补齐下述取证前，任何一侧结论都不应作为最终归因。**

### 9.1 冲突双方

**动态侧**：`artifacts/smoke-v4-agree/REPORT.md` Round2 时间线断言——License 点击同意后 1.4s，`wm_create_activity com.tencent.xfight/com.shenyi.local.BootActivity`（09:40:47.870）紧随 `wm_pause_activity sgamx userLeaving=true`（09:40:47.873），且 `am_proc_start xfight … next-top-activity`（09:40:47.894）。报告据此判定"sgamx **主动 startActivity** 拉起 xfight BootActivity 是铁证：sgamx 内部存在 License 同意后跳转到 xfight 的逻辑"。

**静态侧**：本报告第 1 节——同一 SHA256 的 v4 APK 字节级全覆盖扫描（687/687 entries，含全部 DEX、全部 so、全部 assets、4 个嵌套插件包各自递归重扫）中，`com.tencent.xfight`、`xfight`、`com.shenyi.local`、`shenyi` **四个目标串均为 0 命中**，且有阳性对照证明扫描器非恒零。

两侧证据针对**同一台设备、同一 APK（SHA256 `9D8423BC…D81A`）、同一天**，结论却直接互斥：若 sgamx 代码中连 `xfight`/`shenyi` 一个字符片段都不存在，它不可能用显式 Intent（`setComponent`/`setPackage`/deep link/字符串拼接中的任何一种）指名拉起 `com.tencent.xfight/com.shenyi.local.BootActivity`。

### 9.2 为何不能简单二选一

- **动态"主动拉起"是推断而非直接观测**。`wm_pause_activity userLeaving=true` 只说明系统认为sgamx 前台 Activity 正在离开，**不记录发起方 PID/UID**；本设备 logcat 全程**没有 `START u0` / `am_start_activity` 行**（已核实 `r2_logcat_stream.txt` 全量 0 命中），而该 tag 才是唯一携带 callingPid/callingUid 的记录。缺了它，"sgamx 发起"与"第三方（vivo 游戏栈/xfight 自身的 RuntimeService/launcher）恰好在点击后 1.4s 发起"在现有日志形态下**不可区分**。
- **静态零命中同样存在逃逸面**（必须如实列出）：
  1. sgamx 可在运行时**从网络/本地配置文件下发**目标包名（il2cpp 游戏逻辑大量热更新），静态扫描扫不到不落盘的内容；
  2. 目标串可被**加密/编码存储**（xor/base64/自定义编码），字节扫描天然免疫；
  3. sgamx 可通过 **implicit Intent**（如 `android.intent.action.MAIN` + category + 由系统解析）间接命中 xfight——但 BootActivity 的 `wm_create_activity` 记录 action=MAIN，不能排除"某方以 MAIN action 显式/隐式拉起"；
  4. xfight 自身在设备上有常驻 `RuntimeService`（logcat 中可见其 stop/start 记录）与 `libshenyi_node` 服务，具备**监听前台应用变化后自行 re-order 到前台**的能力，此时发起方根本不在 sgamx。
- **Round1 与 Round2 形态互相矛盾**：同一份动态报告中 Round1 点击同意后 sgamx 停在权限页 35s、死亡后 xfight 是 `wm_resume_activity`（恢复既有任务）而非 create——若"License 同意回调里硬编码跳 xfight"成立，Round1 应当同样 1.4s 跳走。两轮行为分叉本身说明**该跳转不是确定性硬编码路径**，更接近外部竞态（谁在前台变化窗口期抢到任务栈）或条件触发。

### 9.3 当前能下的唯一结论

**不能下结论。** 具体说：

- "sgamx 主动拉起 xfight"**未被证明**（缺 callingPid 证据，且与静态扫描矛盾）；
- "设备侧拉起 xfight"**在点击同意路径上同样未被证明**（不能排除 sgamx 运行时动态构造 Intent 的逃逸面）;
- 在「静置未点击」路径上，本报告主体"设备侧 kill + xfight 被动恢复前台"的推断仍然成立——因为该路径下根本不存在 sgamx 的任何交互触发窗口，且 Round1/2 点击路径两轮均无 `am_kill` 行，与静置路径形态本质不同，两者是**独立的死亡/接管路径**，不可互相借用证据。

### 9.4 归因所需的最低取证集（缺一不可）

下一次复现（点击同意路径）必须同时保留以下原始证据，任何一项缺失都无法归因：

1. **原始 `START u0` 行**：需用 `adb shell logcat -b events -v threadtime` 全程抓取并**不得** `logcat -c`。若设备/版本不输出 `START u0`，则需 `am_start_activity` 或等效含 callingPid 的 event。拿到它即可一行读出拉起方 PID→包名，直接终结争议。
2. **拉起瞬间前后的 `ps -ef` 快照**（建议 1s 粒度循环采集落盘）：用于把 callingPid 映射到进程名。当前 `r2_t*_ps.txt` 是 10s+ 粒度且只 grep 了 sgamx/xfight，21651/22667 这类短命 killer PID 根本捕不到。
3. sgamx 进程内存中是否存在运行时下发的 xfight 字符串：可在复现期间对 sgamx 进程 `cat /proc/<pid>/maps` + 内存扫描 `xfight`（只读），或 hook `android.app.Activity.startActivity`/`Instrumentation.execStartActivity` 打印 Intent 与调用栈。
4. 对照实验：复现前先 `am force-stop com.tencent.xfight` 并确认其全部进程（含 RuntimeService/libshenyi_node）消亡，再跑点击流程——若 BootActivity 仍被拉起，则拉起方必在 sgamx 或系统；若不再出现，则强烈指向 xfight 自身常驻服务自拉。

在以上证据补齐前，本报告对「点击同意后 xfight 接管」路径**不做归因结论**，仅确认：sgamx 点击同意后的死亡（`am_proc_died [...,2]`）两轮均无外部 killer，属静默退出，与静置路径的外部 kill 是两种独立死法。

---

## 附：证据强度声明

- 第 1 节（APK 无引用）为**确定性结论**：字节级、全覆盖、有阳性对照、SHA256 与设备侧记录一致。
- 第 2/3/4 节（设备侧归因）为**高置信推断**：基于排除法 + 在场进程 + 跨设备复现，非直接抓包 killer。
- 第 9 节（动态/静态冲突）为**未决问题**：点击同意路径的 xfight 拉起方归属在现有证据下不可判定，已列出归因所需的最低取证集。
- 未做任何猜测性断言；killer PID 具体归属明确标注为未锁定。
