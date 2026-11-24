# R3b — Houdini 自 SIGKILL 归因分析 — 2026-11-24

设备 `192.168.5.101:5555`（MuMu x86_64 + Houdini ARM64 翻译，Android 15，rooted/KernelSU+Zygisk）。
任务 `/root/houdini_native_analyst`。继 R3 静态分析（`libtersafe.so` 无静态自杀路径）后，目标定位发射 `houdini [SIGKILL] kill:` 的真实代码。

## 分析对象（已 pull 到 `workspace/analysis/security/houdini101/`）

| 设备路径 | ELF | machine | 大小 |
|---|---|---|---|
| `/system/lib64/libhoudini.so` | 64-bit | x86_64 (62) | 9,656,096 |
| `/system/lib64/libtcb.so` | 64-bit | x86_64 | 1,411,800 |
| `/system/lib64/libnb.so` | 64-bit | x86_64 | 19,152 |
| `/system/lib64/libnbaio.so` | 64-bit | x86_64 | 42,120 |
| `/system/lib64/libnblog.so` | 64-bit | x86_64 | 235,424 |
| `/system/lib/libnb.so` | 32-bit | ARM(3) | 8,592 |

> 重要：翻译层是 x86_64 宿主代码，`tools/analyze_tersafe_calls.mjs` 的 AArch64 反汇编不可复用。本报告用独立 x86_64 字节级分析。

## 命中证据

### 1. 自杀日志字符串全部在 `libhoudini.so` `.rodata`

| file offset / va | 字符串 |
|---|---|
| `0x69f060` | `SIGKILL` |
| `0x69f068` | `[%s] kill: pid = %d, tid = %d, signo = %d` |
| `0x69f0ac` | `[%s] tkill: tid = %d, signo = %d` |
| `0x69f0f0` | `[%s] tgkill: pid = %d, tid = %d, signo = %d` |
| `0x69ff2c` | `[SIGABRT] abort, pc = 0x%lx, lr = 0x%lx` |

E3 抓到的 `houdini [6029] [SIGKILL] kill: pid = 5983, tid = 6029, signo = 9` 正是 `[%s] kill:` 这条。

### 2. `libhoudini.so` PLT 没有 kill/tgkill/syscall/ptrace

`.rela.plt` 共 56 项，与自杀相关的只有 `abort`(plt `0xb4fe0`)/`__cxa_atexit`/`__cxa_guard_abort`。
没有 `kill`/`tgkill`/`tkill`/`syscall`/`ptrace`/`signal` 导入。
→ 自 `kill(9)` 不走 PLT，而是 guest ARM `svc` 经 houdini 翻译为 host `syscall` 直发，与 E3「Frida 用户态 hook 抓不到 JIT 调用点」吻合。

### 3. syscall 翻译跳板表（唯一 host 侧统一入口）

`.text` `0x5001c0`–`0x5002e6` 按参数个数分档的 host `syscall` trampoline：

| 跳板入口 | jmp 目标 | 形态 |
|---|---|---|
| `0x5001d0` | `0x500240` | `mov rax,rdi; syscall; ret` |
| `0x5001e0` | `0x500250` | `+ mov rdi,rsi`（1 arg） |
| `0x5001f0` | `0x500260` | `+ mov rsi,rdx`（2 arg） |
| `0x500200` | `0x500270` | `+ mov rdx,rcx`（3 arg） |
| `0x500210` | `0x500280` | `+ r10=r8`（4 arg） |
| `0x500220` | `0x5002a0` | `+ r8=r9`（5 arg） |
| `0x500230` | `0x5002c0` | `+ r9=stack`（6 arg） |

真实 `syscall` 指令：`0x500243/0x500256/0x500269/0x50027c/0x50028f/0x5002b5/0x5002e2`。
`0x5001d0`（getpid/gettid stub）有 99 个 `call` 交叉引用，是通用入口，非自杀特异点。

### 4. 自杀决策函数（guest syscall 分发器）位于 `0x324e80`

`0x324e80` 起（push r14/r15/r12/rbx，栈帧 0x90）：
- `0x324e9c mov edi,1; call 0x57e2f0` 取状态
- `0x324ee3 cmp ebp,6; je` / `0x324ee9 cmp ebp,9; jne 0x324f2f` 按 `ebp`=guest syscall 分类
- `0x324f04 lea rsi,[0x69f060]="SIGKILL"`，`0x324f0b lea rdi,[0x69f068]="[%s] kill:"`
- `0x324f38 cmp ebp,0x40; jg 0x325068` syscall 号上限过滤
- 反复 `mov edi,39(getpid)/186(gettid) → call 0x5001d0` 取 pid/tid 填日志，走 `0x325068` 公共出口。

即：分发器先取 pid/tid → 发 `[%s] kill:` 日志 → host `syscall` 执行 guest `svc`，对应 logcat 现象。

### 5. guest 侧 `.so` 静态代码零 `svc`

对 `lib/arm64-v8a` 全部 ~80 个 `.so` 扫 `svc`（`d4xxxx01` 掩码）→ 0 命中（含 tersafe/TPCore/ckguard/xgVipSecurity/MSDKSystem）；`armeabi-v7a` 同扫 → 0。
→ 自 kill 的 `svc` 指令是运行时解密/JIT 生成，不在静态 `.text`。与 tersafe 加密自修改 + E3 一致：**guest `.so` 静态 patch 面为零**。

## 结论与边界

- 自杀路径：guest 加密代码（tersafe/TP，运行时解密）发 `svc kill/tgkill(9)` → houdini `0x324e80` 分发器取 pid/tid → 发 `[%s] kill:` 日志 → host `syscall` 真正 kill。调用点运行时生成，guest 静态 patch 不可达（与 R3 一致）。
- host `libhoudini.so` 在只读 `/system`（`touch` 实测 Read-only），不能直接改文件；PLT 无 kill/tgkill，syscall 由 trampoline 直发。
- `libhoudini.so` 全 strip（无 dynsym 命中），字符串部分加密。

## 推荐下一步（按可行性，证据充分）

1. **首选 — Zygisk/LSPosed host 侧拦截（不动 system，最小动态实验）**
   在 syscall 跳板 `0x5001d0`–`0x500230` 入口插桩：`edi`(guest sysno→host `kill=62`/`tgkill=234`/`tkill=200`) 为 kill 家族且 `signo==9` 且 `pid==getpid()` 时返回 0。
   - 设备已有 KernelSU + Zygisk Next + LSPosed（`zygisk_lsposed` 活跃）。
   - 用 `dlopen("libhoudini.so")` 取基址 + `0x5001d0` 偏移，`shadowhook`/`dobby` 挂 hook。干净、可回滚、可归因。
   - 注意：houdini 也可能内联 `syscall` 直接翻译（非全走 stub），需先实测 kill(9) 是否都过 `0x5001d0` 系；覆盖率未证前不宣称万能。

2. **次选 — bind-mount patched `libhoudini.so`（需 root，`/system` 只读）**
   `mount --bind patched.so /system/lib64/libhoudini.so`，在 `0x324e80` 的 kill 分支把 `signo` 改写或让日志后的 host `syscall` 返回 0。改动小但需重打整个库且影响全系统翻译进程，风险高于方案 1。

3. **不推荐 — guest `.so` patch**：证据已证静态 `.text` 无 `svc`，打不到运行时解密代码。

## 产物

- 拉取库：`workspace/analysis/security/houdini101/` 下 6 个。
- 关键地址（`libhoudini.so` x86_64）：
  - 自杀决策函数 `0x324e80`（`[%s] kill:` 日志在 `0x324f0b`）
  - syscall stub 表 `0x5001d0`–`0x5002e6`，真实 `syscall` 于 `0x500243`…`0x5002e2`
  - 通用入口 `0x5001d0`（getpid/gettid，99 xrefs）

> 状态：归因完成。**静态 patch 证据不足，不产出 native patch manifest。** 建议进入方案 1 的 LSPosed/Zygisk host 侧 hook 原型验证（最小动态实验），或方案 2 的 bind-mount patch。
