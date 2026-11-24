# Houdini self-SIGKILL hook — .101 实测验证报告 — 2026-11-24

任务 `/root/hook_install_tester`。设备 `192.168.5.101:5555`（MuMu x86_64 + Houdini，Android 15，KernelSU + Zygisk Next + LSPosed）。目标：让 `com.tencent.tmgp.sgame`（method0，`versionCode=381010801`）越过 ~60 s 自 `SIGKILL` 窗口。**结论：三条注入路径均在实测中排除，自杀仍未拦截。**

## Baseline（原状态，干净环境）

- `com.mumu.acc`/`com.mumu.store` 维持 disabled。
- method0 冷启动 PID 2171，`fg TOP`，**76 s 被 `houdini [2218] [SIGKILL] kill: pid=2171, tid=2218, signo=9` 自 SIGKILL**（`Zygote: Process 2171 exited due to signal 9`）。

## Patch 证据（已生成可复用字节）

`libhoudini.so`（x86_64，9,656,096 B，MD5 `6a24a9c3b5e8af76447771fcf76aa6ff`）自杀决策函数 `0x324e80`：

- `0x324ee9: 41 83 fd 09` = `cmp r13d, 9`（`r13d`=signo）
- `0x324eed: 75 40` = `jne 0xaf`（非 9 → `0x324f2f` 正常信号处理路径）
- `0x324eef: bf ba 00 00 00` = `mov edi, 0xba`（**SIGKILL 处理块入口，仅 signo==9 到达**）
- `0x3250b3: 89 d8` = `mov eax, ebx`（函数尾，`ebx`=0 → return 0）

**等长 patch（3 字节）**：`0x324eef` `bf ba 00 00 00` → `e9 bf 01 00 00`（`jmp 0x3250b3`，rel32=0x1bf）。signo==9 直接 return 0，跳过 kill 日志与 syscall；SIGABRT(6) 走 `0x324ee7` 独立分支、其它信号走 `0xaf` 不受影响。

产物：`workspace/analysis/security/houdini101/libhoudini.sigkill_patch.so`（MD5 `0428457293454090be7e543f1cb45a76`，仅 3 字节差异）。

## 排除路径 1 — Zygisk 注入 .so（不可行）

`/data/adb/modules/wzry_hook/zygisk/x86_64.so`（`native_hook/` Rust cdylib）：

- 模块注册：重启 `zn-daemon` 可注册 `wzry_hook 64`；链接修复后 `anon map wzry_hook` 成功；sentinel 确认 `zygisk_module_entry` 被执行。✅
- **失败点**：`install_hook` 报 `houdini base not found` —— entry 在 specialize 阶段调用时 `libhoudini.so` 尚未 dlopen。❌
- 延迟方案全失败：`pthread_create` 在 zygote 上下文段错误；`nanosleep` 轮询仍早于加载；`clone` 线程可行但静态栈超 loader `reserved address space` 上限，`mmap` 栈后 entry 返回前 libhoudini 仍未映射 → loader `munmap`。
- **根因**：Zygisk specialize 时机永远早于 native bridge 加载 `libhoudini.so`，且无合法延迟回调让代码驻留。

## 排除路径 2 — bind-mount patched libhoudini（不可行）

- init namespace 生效但 app 进程加载即 SIGSEGV（uptime 2 s，guest `arm64 regs` dump）。
- **根因**：Android app `unshare(CLONE_NEWNS)` 独立 mount namespace 看不到 init bind-mount；`/data/local/tmp` 的 `shell_data_file` label 不允许 app `exec`，bind-mount 保留源 inode+label。

## 排除路径 3 — KSU systemless 单文件替换（不可行）

- KSU magic mount 只 overlay 目录不 overlay 单文件；`system/lib64/` 整目录 bind 会覆盖其它系统库。
- `post-fs-data.sh` 的 `mount --bind` 仍在 init namespace（同路径 2 根因）。

## 最小可行下一步（按可行性排序）

1. **LSPosed 模块（首选）**：`XposedInit init_v4 com.tencent.tmgp.sgame` 已在进程内运行。写 LSPosed 模块 `handleLoadPackage` 里 `System.load("/data/local/tmp/libwzry_houdini_selfkill_hook.so")`，此刻 `libhoudini.so` 已映射，`install_hook()` 直接命中。复用 `native_hook/` 的 patch 逻辑（`find_houdini_base`+`install_hook`），只需 JNI 暴露一个 `install()` 符号。
2. **Zygisk companion**：`zn-zygisk-companion64` 已在跑，companion 可在 app post-specialize 对目标进程 `ptrace` 注入 `dlopen`，时机晚于 libhoudini 加载。工程更复杂。
3. **Root ptrace injector**：`su` daemon 等 `pidof sgame` 后 `ptrace(ATTACH)` + `dlopen`。受 `libtersafe` 反 ptrace 风险，需先验证 `TracerPid`/dumpable。

**当前 .101 状态（已回滚）**：`wzry_lib`/`wzry_hook` 已删，`libhoudini.so` 恢复原 md5，`com.mumu.acc`/`com.mumu.store` 已 `pm enable`，无残留 bind-mount。`native_hook/` 源码保留 clone/pthread/nanosleep 三种尝试与 logcat 自报，可直接作 LSPosed 注入 payload 复用。
