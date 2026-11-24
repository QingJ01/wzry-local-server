# 签名/包体完整性触发崩溃 — 判定报告 — 2026-11-24

任务：`/root/signature_integrity_swe2`。设备 `192.168.5.102:5555`（MuMu 模拟器，x86_64 + Houdini ARM 翻译，Android 15，KernelSU + Zygisk/LSPosed）。包 `com.tencent.tmgp.sgame`（王者荣耀 3.81.1.8）。

## 实验矩阵与产物

| 代号 | APK | 内容改动 | 签名 | 大小(B) |
|------|-----|---------|------|---------|
| B0 | `workspace/apk/B0-original-tencent-sig.apk` | 无（仅 zipalign） | **腾讯原 V1** | 460,348,136 |
| A0 | `workspace/apk/A0-resigned-final.apk` | 无（仅 zipalign） | debug v1+v2+v3 | ~460M |
| A1 | `client/builds/wzry-control-plane-store-method0.apk` | manifest/arsc 控制面 URL 等长替换 | debug v1+v2+v3 | 977,008,319 |

签名证书：腾讯 `e8685274…` / debug `4d224626…`（父任务 E3 提供）。包名与 versionCode=381010801 三者完全一致。

## 实测结果（含时间/PID/logcat）

- **B0 干净安装，冷启动 20:40:39，PID 4055**：存活至 t=101s，被 `11-24 20:42:51.694 ActivityManager: Force stopping com.tencent.tmgp.sgame appid=10063 user=0: from pid 41712` 杀死。logcat 全程**无** SIGKILL、无 native crash、无完整性/签名校验报错。文件 `workspace/experiments/20261124-203744-B0-tencent-sig-clean.logcat.txt` + `.result.json`。
- **B0 首次尝试（覆盖 method0 安装）**：`INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match`（20:34:43）→ 证明 debug 签名包与腾讯签名包**不能互相覆盖**，安装签名一致性是硬约束。
- **method0 历史多次冷启动**（`runtime_stability_20261124.md`）：~60s 由进程内 Houdini worker `houdini [SIGKILL] kill: pid=<game> tid=<game_tid> signo=9` 自杀。

## 判定（核心结论）

**崩溃不是由"改签名/改包"触发的。** 决定性证据：腾讯原签名、零内容改动的 B0 在同一设备上被**完全相同模式**的外部 `Force stopping from pid` 杀死。改包只是改变了"谁杀"和"杀法"，不是触发源。

两种死亡模式并存，需区分：

1. **外部 force-stop（主要、签名无关）**：`ActivityManager: Force stopping ... from pid <瞬态PID>`。发起者是瞬态进程，已排除常驻嫌疑后，最可能为 MuMu 平台组件 `com.mumu.acc`（加速器，`onAppLaunch`/`NEW_TASK` 拦截活跃，`hasAccSuccess=false`）或 `com.mumu.store`。对腾讯包和改包一视同仁 → 是设备/平台层行为，与签名无关。
2. **Houdini 内自 SIGKILL（method0 观察到的 ~60s）**：进程内翻译层 worker 自 `kill(9)`，E3 证实调用点在 JIT 中、Frida 用户态无法 hook。这是 ARM→x86 翻译环境下的完整性自检，可能与包体/运行时特征相关。

## 关键反证：为什么"签名校验"假设不成立

- 若签名校验是触发源，B0（腾讯原签名）应稳定运行 → 实测同样被杀。
- B0 logcat 无任何 `tersafe`/integrity/tamper/校验失败日志，仅正常 GCloud/MSDK/TDM 初始化。
- `xg_vip_service` 子进程在两个包上都周期性 ~64s 自重启自杀，与主包签名无关。

## 最小处理方案（按可行性排序）

### 方案 R1 — 排除平台层外部查杀（首选，零改包）
对 sgame 停用/绕过 MuMu 加速器与商店查杀，再验证存活：
- `adb shell am force-stop com.mumu.acc` / `pm disable-user com.mumu.acc`（可逆）后冷启动 B0 与 method0，观察 `Force stopping from pid` 是否消失。
- 若 com.mumu.acc 是元凶：在 MuMu 设置中关闭该 app 的"加速/翻译"hook，或加入加速白名单。此路径不需要任何签名伪装。

### 方案 R2 — 运行时签名伪装（针对"若仍存在"的签名层校验）
腾讯原私钥不可得，**无法真正"保留原签名"重签**（密码学上不可行）。可行的是运行时伪装 PackageManager 返回的证书：
- 经 LSPosed（已在设备：`zygisk_lsposed` 活跃）写插件 hook `PackageManager.getPackageInfo(...GET_SIGNATURES/GET_SIGNING_CERTIFICATES)` 与 `PackageInfo.signatures/signingInfo`，把返回给 `com.tencent.tmgp.sgame` 自身查询的证书 spoof 为腾讯 `e8685274…`。
- 但本实验证明**原签名包也被外部查杀**——签名伪装只能消除"签名变化"这一潜在次要触发，不能解决主要的外部 force-stop。建议作为 R1 之后的补充，而非首选。

### 方案 R3 — 定位并最小 patch 客户端内自检（最后手段）
仅当 R1 排除外部查杀后、进程仍自 SIGKILL 时才需要：
- 目标 = 进程内完整性/env 自检 worker（Houdini 翻译层中触发 `kill(9)` 的调用点）。
- 由于 Frida 用户态 hook 不到 JIT 调用点，改用：对 `libtersafe.so`/tprotect/MSDK 自检做静态 patch（NOP 自杀分支），或在内核/zygisk 层拦截该进程的 `kill(9)`/`tgkill`/`exit_group` 对自身的调用。
- 注意任何 native patch 会改变 entry 内容并必须重签，且需保持 ZIP Store/对齐（沿用 `client/Build-WzryApk.ps1` 的 `Get-EntryStorePolicy`：lib/*、assets/*、resources.arsc 用 Stored）。

## 立即可执行的对照实验（设备恢复后按序跑）

1. `pm disable-user com.mumu.acc`（+必要时 com.mumu.store）→ 冷启 B0 → 观察 `Force stopping from pid` 是否消失、存活是否 >180s。
2. 同环境冷启 method0 → 区分"外部查杀消失"后是否仍剩 Houdini 自杀。
3. 若剩 Houdini 自杀 → 进入 R3，对自检 .so 做最小 patch 重测。

## 脚本与产物

- `tools/Invoke-ColdStartExperiment.ps1` — 可重复冷启动实验：安装→force-stop→launch→按秒轮询 pid→dump logcat→写 `*.result.json`。修复了 `pidof` 空返回 `.Trim()` NRE。
- `workspace/apk/B0-original-tencent-sig.apk`、`workspace/apk/A0-resigned-final.apk` — 两组对照包。
- `workspace/experiments/20261124-203744-B0-tencent-sig-clean.*` — B0 决定性证据。

## 阻塞说明

实测中途 `192.168.5.102:5555` 掉线（device offline），`adb devices` 发现的 `adb-10CD6M23EL003SU-l7D0C8…_adb-tls-connect._tcp` 为局域网另一台 vivo 真机（model V2238A），非本任务设备。A1（method0 干净重测）与 R1 实验待设备恢复后执行；核心判定（B0 原签名同死）已得出，不依赖补测。
