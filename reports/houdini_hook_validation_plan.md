# Houdini self-SIGKILL hook — validation plan — 2026-11-24

设备 `192.168.5.101:5555`（MuMu x86_64 + Houdini，Android 15，KernelSU + Zygisk Next + LSPosed）。目标：验证一个 host 侧拦截方案能否让 `com.tencent.tmgp.sgame`（method0 build，`versionCode=381010801`）存活超过 ~60 s 自 `SIGKILL` 窗口，以便进入登录/大厅/商城/对战的协议捕获。**本文件是计划，不执行任何步骤。**

## 前置确认（每次实验前核对）

- `adb -s 192.168.5.101:5555 get-state` = `device`。
- `adb -s 192.168.5.101:5555 reverse --list` 含 `tcp:19620/19621/19622`。
- Rust 后端在 `127.0.0.1:19620/19621` LISTENING，`GET /health` 全 `ok`。
- 已 `POST /local/session` 绑定 `debug101`（accountId 3），无凭据 `/game/events` 返回 200。
- `com.mumu.acc` / `com.mumu.store` 维持 `enabled=3`（disabled，R1 实验态），排除外部 force-stop 变量。**收尾必须恢复**：`adb -s 192.168.5.101:5555 shell pm enable com.mumu.acc` + `pm enable com.mumu.store`。

## 判定标准（单一变量，一次只验一件事）

每个 run 记录 `workspace/experiments/<tag>-<yyyymmdd-hhmmss>.jsonl` + `*.logcat.txt`。

| 结果 | 判据 |
| --- | --- |
| **存活** | `pidof com.tencent.tmgp.sgame` 连续 ≥ 200 s 返回同一 pid，logcat 无 `houdini [*] [SIGKILL] kill: pid=<self>`、无 `Process ... has died: fg TOP`、无 `am force-stop com.tencent.tmgp.sgame` |
| **拦截生效但被替代** | 无 `SIGKILL kill:` 日志，但出现 `SIGABRT`/`exit_group`/进程仍死 → 说明 kill 被拦但 teardown 走别路，需扩大拦截面 |
| **未拦截** | logcat 仍有 `houdini [SIGKILL] kill: pid=<self>` 且 pid 死亡 → hook 未命中路径（内联 syscall / 其他跳板） |
| **污染** | 出现 `am force-stop` 或外部 pid 干预 → 该 run 作废，先确认 mumu 组件仍 disabled |

失败判定行写入 result json：`verdict = survived | bypassed-teardown | not-intercepted | polluted`。

## 阶段 A — baseline（每轮 hook 变更前必须先跑，证明当前状态仍 ~60 s 自杀）

```powershell
$adb = "D:\Android\Sdk\platform-tools\adb.exe"
$ser = "192.168.5.101:5555"
& $adb -s $ser shell "pm list packages -d | grep mumu"        # 确认 acc/store 仍 disabled
& $adb -s $ser shell "logcat -c"
& $adb -s $ser shell "am force-stop com.tencent.tmgp.sgame"
& $adb -s $ser shell "am start -W -n com.tencent.tmgp.sgame/.SGameActivity"
```

随后 90 s 内每 5 s 采：`pidof com.tencent.tmgp.sgame`、`dumpsys activity lru`（TOP 状态）、`pidof xg_vip_service`。预期 ~55–75 s 出现 `houdini [tid] [SIGKILL] kill: pid=<self>` 且 pid 消失 → baseline 成立。若 baseline 意外存活，说明环境已变，停止实验重新归因。

同时记录自杀线程 tid：`logcat -d` 中 `houdini ... SIGKILL` 行的 tid，供阶段 C 对照同一 tid 是否被 hook 日志记录。

## 阶段 B — 安装 hook（可回滚）

依赖 `houdini_hook_engineer` 交付物。安装路径按交付类型二选一：

- **Zygisk 模块**（首选）：`adb -s 192.168.5.101:5555 push module.zip /data/local/tmp/` → `su -c "ksud module install /data/local/tmp/module.zip"`（或 Zygisk Next UI）→ 模块 scope 只列 `com.tencent.tmgp.sgame` → `adb -s 192.168.5.101:5555 reboot`（或按交付说明重启 zygote）。
- **bind-mount patched libhoudini**（备选，风险更高，仅当 Zygisk 不可行）：`su -c "mount --bind /data/local/tmp/libhoudini.patched.so /system/lib64/libhoudini.so"`。全局 bind 会影响所有 arm64 进程，必须记录在案，优先限定 sgame mount namespace。

安装后立即核验加载：查 `/proc/<sgame_pid>/maps` 中 hook 库/patched 库路径，以及 logcat 中 hook 自报标签。

## 阶段 C — 200 s 生存验证

重复阶段 A 的启动序列，观察窗改为 200 s，每 5 s 采样。采集项：

- `pidof com.tencent.tmgp.sgame`（连续性，pid 变更即判污染/重启）
- logcat 中 hook 自报 `swallowed kill signo=9 pid=..`（证明命中而非 check 没跑）
- `/proc/<pid>/task/*/stat` utime/stime 采样——worker tid 应继续累积 CPU（证明线程没死只是 kill 被吞）
- `/proc/<pid>/maps` 快照（确认 houdini 仍加载，hook 生效是 syscall 层而非阻止加载）
- `dumpsys activity processes`（确认 fg TOP）
- Rust 侧 `GET /debug/observations` 导出到 `workspace/observations/hook-run-<ts>.json`，看客户端 `/game/events` 轮询是否持续满 200 s

**注意**：拦截 `kill(9)` 后 check 线程可能改用 `abort()`/`exit_group()`——`libhoudini.so` PLT 有 `abort` 导入、可用户态 hook。若阶段 C 报 `bypassed-teardown`，回工程师处加 `abort/exit_group` 同条件过滤再测，属预期迭代不算失败。

## 阶段 D — 存活后衔接捕获矩阵（只有通过阶段 C 才执行）

进程稳定存活后立刻按 `tools/frida/run-network-capture.mjs` 的 **attach** 模式（勿用 spawn，spawn 触发早期崩溃）做带相位标签采集，每段 ≥ 60 s、各自独立轮：

| 轮次 | 相位标签 | 操作 | 目的 |
| --- | --- | --- | --- |
| 1–2 | `login` | 到登录页停留 | 登录网关 endpoint + methodId |
| 3–4 | `lobby` | 进大厅 | 大厅/房间流量 |
| 5–6 | `shop` | 开商城、拉列表 | 商城 endpoint（**不购买**） |
| 7–8 | `battle-safe` | 训练营/低风险开局 | 对战帧同步端点 |

每轮同步采：`frida.ndjson`（含 inode）、`/proc/net/tcp{,6}` + `/proc/<pid>/fd` 快照、`/debug/observations` 导出、截图 + `uiautomator dump`。文件名按 `login-round1-<ts>-*` 约定，供 `tools/capture_matrix.mjs` 计轮。

**关联缺口提醒**：采集窗口内必须**同时**有 Frida 会话和 `/debug/observations` 导出，才能做 methodId ↔ wire 字节同毫秒关联——上次 501 methodId 时段没有 Frida 在跑，这次必须叠加。

## 阶段 E — 收尾/回滚（每次实验结束必做，无论成败）

```
adb -s 192.168.5.101:5555 shell "pm enable com.mumu.acc"
adb -s 192.168.5.101:5555 shell "pm enable com.mumu.store"
```

- Zygisk 模块：`ksud module remove <id>` 或 UI 禁用 → reboot。
- bind-mount：`su -c "umount /system/lib64/libhoudini.so"`。
- `adb -s 192.168.5.101:5555 shell "am force-stop com.tencent.tmgp.sgame"` 清场。
- `<tag>-*` jsonl/logcat/result 留盘 `workspace/experiments/`（不提交）；结论写回 `reports/acceptance_matrix_live.md` 的 Dynamic capture 行。

## 风险与边界

- **不做真实购买**；`battle-safe` 只用训练营/人机。
- hook 只过滤 `signo==9 && pid==getpid()`，不吞其它信号/进程，避免影响系统翻译。
- 若 Zygisk hook 与 bind-mount 两个方案都 `not-intercepted`，说明 kill 不走 `0x5001d0` 系跳板而是内联翻译 → 停止用户态迭代，上报需内核/syscall 层方案（KernelSU kpm）。
- 存活 ≠ 检测被中和：checker 可能延迟复检。任何 >200 s 存活轮都要再延长观察到 ≥ 400 s 一次，确认不是延迟自杀。
