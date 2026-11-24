# libtersafe.so kill/abort 调用点静态分析（R3 前置）

任务 `/root/r3_tersafe_analyst`。目标库 `workspace/analysis/jadx/resources/lib/arm64-v8a/libtersafe.so`（sha256 `c11dfa6a…`，4,931,800 B，ELF64 AArch64 shared object）。输出目录 `workspace/analysis/security/libtersafe-arm64/call-analysis/`。

## 可复现命令

```powershell
node tools/analyze_tersafe_calls.mjs workspace/analysis/jadx/resources/lib/arm64-v8a/libtersafe.so workspace/analysis/security/libtersafe-arm64/call-analysis
powershell -NoProfile -ExecutionPolicy Bypass -File tools/Test-TersafeAnalyzer.ps1
```

## 目标符号与 PLT 解析

`.rela.plt` 共 296 项；`kill`/`abort`/`_exit`/`exit`/`signal`/`syscall`/`ptrace` 均为 `R_AARCH64_JUMP_SLOT`（type 1026）。PLT 地址按 `.plt + 32 + index*16` 推导，GOT 槽在重定位前均指向 `0x24d70`（PLT resolver stub），惰性绑定。

| 符号 | .rela.plt index | GOT 槽 | PLT stub |
| --- | --- | --- | --- |
| kill | 31 | `0x4a5530` | `0x24f80` |
| _exit | 50 | `0x4a55c8` | `0x250b0` |
| exit | 128 | `0x4a5838` | `0x25590` |
| abort | 197 | `0x4a5a60` | `0x259e0` |
| signal | 249 | `0x4a5c00` | `0x25d20` |
| syscall | 264 | `0x4a5c78` | `0x25e10` |

## 关键结构发现：调用全部经跳板间接化

`.text` 内 `BL`（`0x94`）出现 **0 次**、`SVC` 0 次、`ADRP`/`BLR`/`BR` 均 0 次。库内函数调用被重编码为 `B <thunk>`（跳板在 `.plt` 与 `.text` 间隙 `0x239xxx`）再由跳板 `B <plt>`。因此常规 `BL` 交叉引用扫描必然落空，必须做两级解析：

1. 扫 `.plt` 起至 `.text` 末的整个可执行区，收集所有 `B` 目标；
2. 直接把 `B <plt>` 记为跳板；再反向收集 `B <thunk>` 作为真实调用点。

`ApkAbort_CS_*`、`mtcj_*`、`apk_path`、`Digital Signature` 字符串在 `.rodata`/`.data.rel.ro` 中均**无任何代码或数据指针引用**（ADRP 0 次、无 8-byte 指针指向字符串 VA）——它们由运行时表/blob 解密使用，静态无法定位触发点，符合 TP/TerSafe 自保护设计，与 E3 "userspace hook 不可见"结论一致。

## kill 调用点（3 个站点 = 1 跳板 + 2 调用者）

| 站点 | file off | 指令 | 性质 |
| --- | --- | --- | --- |
| `0x2396d0` | `0x2396d0` | `17f7ae2c` (`B kill@plt`) | 跳板 |
| `0x26309c` | `0x26309c` | `17ff598d` (`B 0x2396d0`) | 尾调用，函数 A |
| `0x2792f4` | `0x2792f4` | `17ff00f7` (`B 0x2396d0`) | 尾调用，函数 B |

上下文（`context.insns`）显示两处均为函数末尾 `kill(pid, sig)` 尾调用：参数经 `x19`/`x20`/`x21` 传入，非硬编码 `SIGKILL` 自杀。它们是**通用 kill 辅助函数**，静态上无法判定其中一条就是 Houdini 自检路径 —— E3 已证致命 kill 发自 JIT 翻译的 Houdini worker（`libhoudini.so`/`libnb.so`），不是 `libtersafe` 的这条静态路径。

## abort/_exit/exit/syscall：零调用点

`abort`、`exit`、`_exit`、`syscall` 的 PLT 在 `.text` 中**无任何 `B`/`BL` 交叉引用**。它们的 GOT 槽保留 resolver stub（`0x24d70`），说明这些导入仅在**首次经 PLT 惰性绑定**或经 GOT 内存驻留指针（`LDR + BLR`）被调用 —— 而 `BLR`/`LDR literal` 在 `.text` 中分别为 0/31 次且无任何指向 `.got` 的。结论：`libtersafe` 的自杀路径不经静态代码直接调用这些符号。

## 推荐等长 patch 策略与 manifest 草案

`reports/native_patch_plan.md` 规定：仅接受已证实的精确文件偏移 + 原始/替换字节完全匹配 + 等长替换。**当前证据不足以给出可直接使用的生产 manifest**，理由：

- 致命 `SIGKILL` 的发起者是 Houdini JIT worker（`libhoudini`/`libnb`），不是 `libtersafe.so` 的静态代码路径；改 `libtersafe` 的 `kill` 调用点打不中真正的自杀点。
- `libtersafe` 的两处 `kill` 尾调用是通用辅助，NOP 它们只能阻止"该 .so 主动 kill 别的进程"，与自检自杀无关；且会破坏 `kill` 的正常用途（清理 helper 进程）。
- `abort`/`_exit`/`syscall` 无静态调用点，无从 NOP。

**若后续动态归因证明** `0x26309c`/`0x2792f4` 中某条就是自检路径（例如 hook `libhoudini` 的 `translate` 回调确认返址），对应的最小等长 patch manifest 形如：

```json
{
  "nativePatches": [
    {
      "entryPath": "lib/arm64-v8a/libtersafe.so",
      "offset": 2502812,
      "originalBytesHex": "17ff598d",
      "replacementBytesHex": "1f2003d5",
      "evidence": "reports/tersafe_call_analysis.md#kill-caller-0x26309c"
    }
  ]
}
```

（`offset` 为文件偏移，`17ff598d` → `NOP`；替换后函数照常返回，相当于吞掉这次 kill。）但**必须先**用 `tools/frida/run-kill-trace.mjs` 或等效手段证明该返址在死亡时间线内被命中，再产出 manifest —— 现阶段不建议构建/安装此 patch。

## 与 E3 结论的一致性

E3 证明 `kill(9)` 与 abort 均由 Houdini 翻译的 guest-ARM 代码直接发 `syscall`/`write`，绕过 `libtersafe` 的导入表。本分析独立证实：`libtersafe` 静态代码里没有 `SVC`、没有 `abort` 调用、`kill` 只剩两条通用辅助路径 —— 自杀点不在 `libtersafe.so` 内。R3 的下一步不是 patch `libtersafe`，而是：

1. 在 `libhoudini.so`/`libnb.so` 中定位 `kill`/`tgkill`/`exit_group` 的发射点（它们同样是 ARM 库，可复用本分析器）；
2. 或用 `run-kill-trace.mjs` 抓 Houdini worker 的精确返址，归因到具体翻译代码段。

## 测试

`tools/Test-TersafeAnalyzer.ps1` 校验：sha256、ELF machine=183、`kill` PLT `0x24f80`、3 个 kill 站点（1 thunk + 2 caller）、`abort`/`exit`/`_exit`/`syscall` 各 0 站点、保护字符串零引用。全部通过。
