# Houdini 自 SIGKILL — R3b 执行计划 — 2026-11-24

任务：`/root/r3_evidence_synthesizer`。目标设备 `192.168.5.101:5555`（MuMu x86_64 + Houdini ARM64 翻译，Android 15，KernelSU + Zygisk）。包 `com.tencent.tmgp.sgame` `3.81.1.8`，当前安装 method0 debug 签名 build。本报告纯证据综合，不改设备、不改代码、不猜调用点。

## 一、已证实事实（Evidence-Grade P0）

按证据强度排序，每条都有对应 logcat/JSONL 证据：

1. **死亡主机制 = 进程内自 `SIGKILL`，经 Houdini worker 发出。**
   决定性日志 `houdini [<tid>] [SIGKILL] kill: pid = <game_pid>, tid = <worker_tid>, signo = 9`。发送 tid 与被杀 pid 属于同一进程 → 进程内 worker 线程对自身发 `kill(9)`。
   - E3 `reports/kill_tracer_e3_20261124.md`：该 `[%s] kill: pid = %d, tid = %d, signo = %d` 格式字符串在 `libhoudini.so` 文件偏移 `0x69f069` 实证，发射器是 `libhoudini.so` 的翻译 syscall 处理器。

2. **外部 force-stop 是独立的次要机制，与自 SIGKILL 不同。**
   `Force stopping com.tencent.tmgp.sgame ... from pid <瞬态PID>` 与 `installPackageLI / pkg removed` 属 MuMu 平台层（`com.mumu.acc`/`com.mumu.store`），对原签名 B0 与 method0 一视同仁。

3. **R1 已完成且结论确定：外部查杀排除后，自 SIGKILL 仍然存在。**
   `.101` 上 `com.mumu.acc`/`com.mumu.store` 已 `pm disable-user`（enabled=3），`workspace/experiments/r1-method0-20261124.jsonl` 记录：method0 冷启动 21:21:31，21:22:32.750 `houdini [6029] [SIGKILL] kill: pid=5983 tid=6029 signo=9` —— 外部查杀消失后，进程仍在 ~63 秒自杀。**R1 排除成功，剩余阻塞是进程内自检。**

4. **签名/重打包不是触发源。**
   B0 = 腾讯原签名、零内容改动 APK 同样被平台层杀死（`reports/signature_integrity_verdict.md`）；Experiment A 的"130 秒存活"经复核是同一外部查杀群体的计时方差，非签名效应。

5. **Frida-server 与 root/zygisk 挂载可见性均已排除为触发源。**
   E1：杀掉 `wzry-frida-server` 后两轮冷启动仍 ~60s 自 SIGKILL。E2：KernelSU `just_umount` 已是全局最强，`/proc/<sgame>/mounts` 0 条 root/module 痕迹，sgame 本无 root —— 无独立变量可加。

6. **自杀点不在 `libtersafe.so` 静态代码里。**
   R3 `reports/tersafe_call_analysis.md`：`libtersafe.so` 的 `BL`/`SVC`/`ADRP`/`BLR`/`BR` 全部 0 次（调用经 `B <thunk>` 跳板间接化）；`kill` 仅剩 2 处通用尾调用辅助（`0x26309c`、`0x2792f4`），`abort`/`_exit`/`syscall` 0 调用点；`ApkAbort`/`mtcj_*` 字符串零静态引用（运行时解密表）。改 `libtersafe` 打不中真正自杀点。

7. **Frida 用户态 hook 对该 kill 不可见。**
   E3 证明 kill syscall 与 Houdini 日志均由 guest-ARM 代码经 JIT 翻译成真实 x86 `syscall`/`write` 直接发射，`Interceptor` 无法观测；`Stalker` 会冻结进程（`tracing stop`），已拒绝。

8. **剩余可见检测面 = Houdini 翻译层本身。**
   `ro.dalvik.vm.isa.arm64=x86_64`、`ro.dalvik.vm.native.bridge=libnb.so`、`ro.build.hv.platform=vbox`、`qemu.hw.mainkeys=1`；`/proc/<sgame>/maps` 含 `libhoudini.so`/`libnb.so`/`libnblog.so`。这些在进程内可读且不可被 denylist/HMA 隐藏。

9. **死亡时序 = 延迟 worker，约 60 秒窗口。**
   多次观测 ~9s/~21s/~60s/~63s/~64s/~101s 不等，主群体 ~60s。`xg_vip_service` 子进程总在主进程前 ~1s 自杀 → 整个进程组被同一判定清除。

10. **`adb.exe` 不在 PATH**，必须用 `D:\Android\Sdk\platform-tools\adb.exe`；所有命令必须显式 `-s 192.168.5.101:5555`。

## 二、未证实假设（按可信度排序）

| 假设 | 依据 | 证伪方法 |
| --- | --- | --- |
| **H1 — TenProtect 在 `libhoudini`/`libnb` 内做环境/完整性自检** | 自杀点在翻译层；`libtersafe` 静态排除；TP 组件齐全 | 在 `libhoudini.so`/`libnb.so` 找到 `kill`/`tgkill`/`exit_group` 发射点或自检分支 |
| **H2 — 自检读 `libhoudini` maps/`ro.dalvik.vm.isa.arm64`/`vbox`/`qemu` 指纹** | 这些指纹在 denylist 外且进程内可读 | 隐藏其中一个指纹后复测是否仍死 |
| **H3 — 自检是固定 60s 定时器，与具体检测输入无关** | 时序主群体 ~60s 且与 frida/root 无关 | 若 H1/H2 都不成立，则倾向定时判定 |
| **H4 — `:20000`（`220.196.141.37:20000`）是真实游戏网关** | 唯一非 443 有双向字节候选；帧头有 `43 66 aa` + `len≈actualLength−2` | 需进程稳定后复现 ≥3 连接且归属证实 |
| **H5 — methodId 4375/184355/184357/186201 对应对战/商城语义** | 来自 poxxiao 参考工程迁移假设 | 必须靠 methodId↔wire 同毫秒关联证实，当前为 0 证据 |

## 三、三个可逆最小实验（按优先级排序，均在 `.101` 执行）

> 公共回滚约束：每步独立可逆；所有 adb 显式 `-s 192.168.5.101:5555`；目标 = 进程前台存活 >180s。

### 实验 R3b-1 — 静态定位 `libhoudini.so`/`libnb.so` 的 kill 发射点【首选，零设备改动】

- **做法**：`adb -s 192.168.5.101:5555 pull /system/lib64/libhoudini.so`、`libnb.so`、`libnblog.so` 到 `workspace/analysis/security/houdini101/`，复用 `tools/analyze_tersafe_calls.mjs` 做 `B→thunk→PLT` 两级解析，定位 `kill`/`tgkill`/`exit_group`/`abort` 的跳板与真实调用点。
- **证据基线**：`libhoudini.so` 已证实含 `[%s] kill: pid=...` 格式串（`0x69f069`）。
- **Stop criteria**：找到 ≥1 个带原始字节 + 反汇编上下文 + 证据链的调用点，输出 `reports/houdini_call_analysis.md` + 候选 `nativePatches` manifest 草案（先 `-WhatIf`，不构建）。
- **产物**：`workspace/analysis/security/houdini101/`、`reports/houdini_call_analysis.md`。
- **风险**：`libhoudini` 是 NetEase 授权 Intel Bridge，ARM 库，分析器可直接复用；但若自杀由 JIT 动态生成代码发出（非静态 PLT 路径），静态可能再次落空 → 进入 R3b-2。

### 实验 R3b-2 — 单线程 Stalker / 硬件断点抓 JIT 返址【中，需 frida，设备可逆】

- **做法**：不 broad `Stalker.follow`（已证冻结）。改为：① 先 attach 跑 `tools/frida/run-kill-trace.mjs` 记录 `thread-spawn`/`clone` 锁定死亡 worker tid；② 仅对该 tid 做 one-shot `Stalker.follow` 或 ptrace `PTRACE_SETREGS` 硬件断点在翻译 `syscall` 站点上，取返址归因到具体翻译段。
- **前置**：frida-server 需重新拉起（E1 已杀）；R1 状态保持（mumu 已禁）。
- **Stop criteria**：拿到死亡 tid 的返址 + 所属翻译代码段 + 对应 guest-ARM 指令偏移 → 反推自检点；若 2 次尝试仍冻结/抓不到，放弃动态路径。
- **产物**：`workspace/experiments/r3b2-<stamp>.jsonl` + `.logcat.txt`。
- **风险**：Stalker/硬件断点本身是反调试触发面，可能提前自杀；只做 one-shot、限定单 tid。

### 实验 R3b-3 — x86-only / 单指纹隐藏对照【低，需改包或属性，设备可逆】

- **做法**：两条子路径取其一，均为独立变量 —
  - **(a) x86-only 加载**：若 APK/环境允许强制 x86 native 路径（无 arm64 so 时走 x86），绕开 Houdini；当前 APK 只有 `arm64-v8a`/`armeabi-v7a`，无 `x86_64` → 需评估是否能注入 x86 stub 或不可行则跳过。
  - **(b) 单指纹隐藏**：用 LSPosed/Zygisk 对 `sgame` 隐藏 `ro.dalvik.vm.isa.arm64`/`libhoudini` maps 条目之一（一次只藏一个变量），冷启动复测。
- **Stop criteria**：(a) 若存活 >180s → 证明 Houdini 特定，可直接定型 x86-only 交付；(b) 若藏某个指纹后存活 → 定位检测输入。
- **产物**：`workspace/experiments/r3b3-<stamp>.jsonl` + 结果 JSON。
- **风险**：(a) 需要新 patch build（等长约束）；(b) LSPosed 注入本身是检测面，可能适得其反。

## 四、统一 Stop Criteria 与决策门

| 门 | 条件 | 动作 |
| --- | --- | --- |
| G1 | R3b-1 找到可信静态调用点 | → 生成 `nativePatches` manifest，`Build-WzryNativePatch.ps1 -WhatIf` 验证，再构建安装做 >180s 生存测试 |
| G2 | R3b-2 拿到 JIT 返址 | → 归因到 `libhoudini`/`libnb` 具体段，回到静态 patch 路径（G1） |
| G3 | R3b-3a x86-only 存活 >180s | → 直接定型 x86-only 客户端交付路径，跳过 native patch |
| G4 | 三个实验全部落空 | → 结论 = 定时判定或 JIT 动态自检，上报需要设备外方案（真机 arm64 或内核层拦截） |

## 五、R3 落地后的接续（仅当进程存活 >180s）

按 `reports/protocol_next_steps_20261124.md` 与 `reports/acceptance_matrix_live.md` 顺序执行：

1. `login-roundN` attach 捕获 2 轮 + 同秒 socket 快照 + `/debug/observations` 导出，做 methodId↔wire 同毫秒关联。
2. `lobby`/`shop`/`battle` 各 2 轮标签化捕获；`:20000` 与 `:10012` 族复现验证。
3. 仅在帧边界/方向/归属全证后，才实现真实账号/对战/商城协议 handler。
4. 全部验收后恢复 `com.mumu.acc`/`com.mumu.store` 启用状态，更新 `reports/acceptance_matrix_live.md`。

## 六、证据文件索引

- `workspace/experiments/r1-method0-20261124.jsonl` — R1 决定性证据。
- `reports/tersafe_call_analysis.md` — `libtersafe` 静态排除。
- `reports/kill_tracer_e3_20261124.md` — E3 归因 + `libhoudini` 格式串定位。
- `reports/signature_integrity_verdict.md` — 签名/改包排除。
- `reports/runtime_stability_20261124.md` — E1/E2 + 检测面清单。
- `workspace/experiments/device101-baseline-20261124-213030.json` — `.101` 基线。
- `reports/protocol_next_steps_20261124.md` — 后续协议捕获计划。

## 七、当前设备状态（需收尾恢复）

`.101` 上 `com.mumu.acc`/`com.mumu.store` 处于 `enabled=3`（disabled，R1 实验态）。全部实验结束后执行：
```
adb -s 192.168.5.101:5555 shell pm enable com.mumu.acc
adb -s 192.168.5.101:5555 shell pm enable com.mumu.store
```
