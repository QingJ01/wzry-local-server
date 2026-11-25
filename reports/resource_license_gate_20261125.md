# Resource-license 启动阻断静态逆向报告 — 2026-11-25

任务：`/root/resource_license_swe2`。范围：只读静态分析，不触碰设备、不改构建、不猜 schema。
证据输入：`artifacts/smoke-v3/REPORT.md`、`artifacts/smoke-v3/logcat-launch.txt`、
`workspace/analysis/sgamx_v3/`（v3 APK 提取的 dex/arsc/manifest/native libs）。

## 结论速览（TL;DR）

1. **"Resource license" 不是 license 表，也不是包名绑定逻辑。** 它是 `Resources.getIdentifier()` 找不到
   **名为 `license` 的 layout 资源**时打印的格式化错误（`Resource %s(type=%s, pkg=%s) is not found`，
   第一个 `%s` = 资源名 `license`）。APK 里不存在任何 license 注册表 / license 文件 / 包名-license 映射。
2. **阻断机制是 AOSP 框架语义，不是 MSDK 主动校验包名**：`getIdentifier("license","layout","com.tencent.tmgp.sgamx")`
   按**包名严格匹配**资源表 package group 名。v3 的 `resources.arsc` package group 名仍是
   `com.tencent.tmgp.sgame`（与原版**字节级一致**，v3 构建从未修改 arsc）→ 用 `sgamx` 查表必返 0
   → MSDK 的 `ResID.loadIdentifierResource` 对 0 值 `System.exit(-1)`。
3. **原始 `sgame` 包同版本同资源表完全通过此检查**（`webviewres LicenseDialogLayout=2131230737`
   = `0x7f080011` = `layout/license`），证明资源条目本身健康、查询代码正确——唯一变量就是包名不匹配。
4. **最小修复是单字节资源层补丁**：把 arsc package group 名 `sgame`→`sgamx`（22 字符等长，UTF-16 原位覆写，
   arsc 无校验和无签名，ZIP 内 STORED）。native patch 无必要（门禁纯 dalvik/框架层，native 库无相关逻辑）。
5. **"给 sgamx 补 license entry" 不可行也文不对题**：license 条目**已经存在**于表里，
   缺的不是条目而是包名匹配；且 arsc 无法等长新增 entry。

## 调用链与日志字符串定位（证据精确到文件偏移）

logcat 关键行（`artifacts/smoke-v3/logcat-launch.txt:177-201`）：

```
I/SGameActivity: webviewres com.tencent.tmgp.sgamx
W/System.err: java.lang.Exception: Resource license(type=layout, pkg=com.tencent.tmgp.sgamx) is not found
W/System.err:   at com.tencent.msdk.tools.ResID.loadIdentifierResource(ResID.java:11)
W/System.err:   at com.tencent.tmgp.Common.WebViewResID.init(WebViewResID.java:77)
W/System.err:   at com.tencent.tmgp.Common.SmobaEx.onCreate(SmobaEx.java:799)
W/System.err:   at com.tencent.tmgp.sgame.SGameActivity.onCreate(SGameActivity.java:29)
I/cent.tmgp.sgamx: System.exit called, status: -1
```

注意 sgamx 缺了第二行日志 `webviewres LicenseDialogLayout=<id>`——对照原版
（`workspace/experiments/20261124-203151-B0-tencent-sig-original.logcat.txt:1191-1192`）：

```
I/SGameActivity: webviewres com.tencent.tmgp.sgame
I/SGameActivity: webviewres LicenseDialogLayout=2131230737
```

原版在**第一条** `loadIdentifierResource("license","layout",pkg)` 就拿到 `2131230737 = 0x7f080011`。
sgamx 在**同一条**查询返 0，立即 printStackTrace + exit。失败点 = `init` 的第一个查询。

### dex 侧（日志字符串与 exit 分支的精确位置）

用自研解析器 `tools/analyze_resid_gate.mjs`（输出 `workspace/analysis/resid_gate/resid_gate_analysis.json`）：

| 项 | 位置 | 证据 |
| --- | --- | --- |
| 日志格式串 `"Resource %s(type=%s, pkg=%s) is not found"` | `classes2.dex` string #25776, dataOff `0x23b102` | 同时存在于 `classes.dex` #28960 `0x252253`（smoba webview 死代码路径的另一份拷贝） |
| `com.tencent.msdk.tools.ResID.loadIdentifierResource` | `classes2.dex` code item `0x42f8a4`，insns @ `0x42f8b4` | 方法体与 `com.tencent.tmgp.Common.ResID`（`0x6a0ec0` 区域）**逐字节同构** |
| `System.exit` invoke | `classes2.dex` file **`0x42f8f6`**（msdk tools 版）/ **`0x6a0f0e`**（tmgp Common 版） | `invoke-static {v5}, Ljava/lang/System;->exit`；前一 insn `12f5` = `const/4 v5, #-1`（operand 半字节 `f` = −1，与 logcat `status: -1` 精确吻合） |
| 查表调用 | 方法首条 `invoke-virtual … Resources;->getIdentifier` @ `0x42f8b4` | `if-nez v4, +32` 跳过 exit 块直走 `return v4` |
| `com.tencent.tmgp.Common.WebViewResID.init` | `classes2.dex` code item `0x6a5ac8` | `getPackageName` → pkg 字符串进寄存器 → 逐条 `loadIdentifierResource(resources, name, type, pkg)`；首条查 `license`/`layout` @ `0x6a5b16` |
| pkg 字符串来源 | `Context.getPackageName()` 运行时返回值 | **dex 中无硬编码 sgamx 参与此查询**——pkg 就是安装包名 `sgamx` 本身 |

jadx 对照源码（`workspace/analysis/jadx/sources/com/tencent/tmgp/Common/WebViewResID.java`，
loaded from `classes2.dex`）确认 `init` 共 39 条查询，第一条即：

```java
LicenseDialogLayout = loadIdentifierResource(resources, "license", "layout", packageName);
```

### 资源表侧（arsc 结构化解析证据）

`tools/analyze_resid_gate.mjs` 直接解析 `workspace/analysis/sgamx_v3/resources.arsc`。该文件与 v3 APK 内
`resources.arsc`、原版 `workspace/apk/3.81.1.8.apk` 内 arsc **三者 SHA-256 完全相同**
（`76407A3E…24A46D`）——v3 构建链从未碰过 arsc：

- package group：`id=0x7f name=com.tencent.tmgp.sgame`（arsc package chunk 头 `+0xC` UTF-16，文件偏移 `52124`）。
- `layout/license` 条目**存在**：resId `0x7f080011`（与原版 logcat `2131230737` 十进制一致）。
- `init` 全部 **39 项查询在 arsc 中全部存在**（`layout/license`、`id/no|yes|title|privacy|childText|sdkText|license`、
  `layout/permissions`、7 个 `drawable/permission_*`、`raw/videosplash`、10 个 `string/Permmsion_*` 等——
  完整矩阵见分析 JSON 的 `tmgpQueryMatrix`，全 OK，零缺失）。
- type 表清单：`anim(17) array(4) attr(76) color(65) dimen(138) drawable(218) id(197) layout(40) menu(1) raw(3) string(241) style(34) xml(4)`。

**结论：数据完好，唯一不匹配项是查询用的包名。**

### 框架语义（AOSP 源码证据）

`android.content.res.Resources.getIdentifier(name,type,pkg)`（aosp `core/java/android/content/res/Resources.java`）
直接 JNI 进 native `ResTable::identifierForName`。`libs/androidfw/ResourceTypes.cpp`（android13-release，
本地存档 `workspace/analysis/ResourceTypes.cpp.txt` 行 4965+）核心逻辑：

```cpp
for (size_t ig=0; ig<NG; ig++) {
    const PackageGroup* group = mPackageGroups[ig];
    if (strzcmp16(package, packageLen,
                  group->name.string(), group->name.size())) {
        continue;   // 包名与 package group 名不符 → 跳过
    }
    …findEntry(group, *ti, name, nameLen, …)
}
return 0;
```

`group->name` 就是 arsc 里编译期固化的 `com.tencent.tmgp.sgame`。运行时传入 `com.tencent.tmgp.sgamx`
→ `strzcmp16` 不等 → skip → **必然返回 0**。资源存在与否完全不影响结果。

> 即："license 表"就是 arsc 本身，"包名绑定逻辑"就是这一行 `strzcmp16`。**两个问题其实是同一个问题。**

### native 侧排查（否定证据）

`libMSDKSystem.so`、`libtprt.so`（及启动期加载的其余库）中均无 `license`/`getIdentifier`/`is not found`
字符串；该门禁**纯 dalvik + 框架层**，native 无需也不应参与修复。

## 三个候选修复评估

### 方案 A：补 sgamx license entry —— 不可行（且文不对题）

- license entry 已存在（`0x7f080011`）；缺的不是 entry。
- arsc 是稠密二进制表：新增 entry 需扩 key string pool、扩 TYPE_SPEC 标志位图、扩 TYPE 偏移数组与 entry 区，
  全部 chunk size/offset 连锁变化，**无等长方案**，重写风险远高于收益。

### 方案 B：让 license 查询在 sgamx 包名下命中 —— 推荐

**首选 B2：arsc package group 名单字节补丁**

| 项 | 值 |
| --- | --- |
| 文件 | `resources.arsc`（ZIP 内 STORED、无压缩、无校验和、无签名） |
| 文件偏移 | **`0xCBC6`**（十进制 52166）= package chunk 起 `52112` + 头内 name 字段 `+0xC` + 第 21 字符×2 字节 |
| 原字节 | `65 00`（`e` UTF-16LE，`com.tencent.tmgp.sgame` 最后一字符） |
| 替换字节 | `78 00`（`x` UTF-16LE） |
| 效果 | package group 名 `com.tencent.tmgp.sgame` → `com.tencent.tmgp.sgamx`，22 字符等长原位覆写，arsc 结构与对齐零变化 |

机制：`getIdentifier(..., pkg="sgamx")` 与 arsc 组名精确匹配 → 39 项查询全部命中（已全部静态验证存在）。
这不是 hack 而是**补完构建**：MSDK 模板资源体系设计上就按宿主包名动态查询（`getPackageName()`），
arsc 组名本应跟随宿主包名；v3 改了 manifest package 却没改 arsc 组名，属于构建不完整。

**备选 B3：dex 指令级 pkg 回退**（仅当 B2 上机暴露反例时启用）：
把 `WebViewResID.init`（`classes2.dex` code item `0x6a5ac8`）的 pkg 参数从 `getPackageName()` 动态值
改为常量串 `com.tencent.tmgp.sgame`（该串在 `classes2.dex` 中唯一存在，string index 37332，
dataOff `0x27AC54`）。指令改写面较大，且改后须重算 dex SHA-1 signature（`0x0C..0x1F`）与
Adler-32 checksum（`0x08..0x0B`）——纯函数但审计面大于 B2。**当前不建议，仅作互斥 fallback。**

**明确排除的错误方向**：把 `classes2.dex` 里 `sgame` 常量串原位改成 `sgamx`（`0x27AC5F` `e→x`）
看似等价，实则**有害**——它会消灭 dex 中唯一一份正确的 sgame 字面量，若任何 MSDK 路径靠它做显式包名查询，
反而全部失配。不要这样做。

### 方案 C：patch System.exit 分支 —— 最后手段（不推荐）

精确位置已定位（如坚持需要）：

| dex | 类 | file offset | 原指令 | 最小改法 |
| --- | --- | --- | --- | --- |
| `classes2.dex` | `com.tencent.msdk.tools.ResID` | `0x42F8BC` | `if-nez v4, +0x20`（字节 `39 04 20 00`） | 改 `if-nez`→`goto` 或 `nop` 跳过 exit 块 |
| `classes2.dex` | `com.tencent.tmgp.Common.ResID` | `0x6A0ED0` 区域同 pc | 同上 | 同上 |
| `classes.dex` | `com.smoba.webview.ResID` | `0x5C2DC0` | 同上 | 同上（该类当前无调用方，属死代码，可不改） |

**为什么强烈不推荐**：

1. 返 0 后 `init` 继续把 0 写进 39 个静态字段——后续 `setContentView(0)`/`findViewById(0)` 全是未定义行为。
   该 license/permissions dialog 是启动流程的隐私合规弹窗，**一定会被 inflate**；
   崩溃只是从干净的 exit 变成难调试的随机 NPE，系统性后续失败概率接近 100%。
2. 该方法是 MSDK 全局共享工具方法，39+ 个调用点依赖"返 0 = 致命"语义。patch exit 等于放开全部资源缺失的
   静默失败，审计面远超一个分支。
3. 属于用更大的错掩盖小问题，违背最小修复原则。

## 推荐行动（不执行，仅建议）

**v4 构建建议 = v3 + arsc 包组名单字节补丁（方案 B2）**。集成点：
`tools/build_native_patch_apk.mjs` 的 patch 流水线已支持任意 entry+offset 等长覆写
（`originalBytesHex` 前置校验）。patch manifest 草案：

```json
{
  "nativePatches": [
    {
      "entryPath": "resources.arsc",
      "offset": 52166,
      "originalBytesHex": "6500",
      "replacementBytesHex": "7800",
      "evidence": "reports/resource_license_gate_20261125.md"
    }
  ]
}
```

验证闭环（构建后、装机前全部静态可做）：

1. 解出 patched arsc 重跑 `node tools/analyze_resid_gate.mjs`：package group 名应为 `sgamx`，
   39 项查询矩阵仍全 OK。
2. `aapt2 dump packagename` 仍 `sgamx`（manifest 未动）；`zipalign -c`、`apksigner verify` 全过。
3. 装机后 logcat 期望 `webviewres LicenseDialogLayout=2131230737`——与原版完全一致的 id，
   即证明 gate 通过且查到的就是同一个 license layout。

**必须如实声明的未验证风险**：

- 若游戏其它代码路径用**显式** `"com.tencent.tmgp.sgame"` 字面量做 cross-package 资源查询，
  B2 后这些查询会 miss。`classes2.dex` 确有唯一一份 `sgame` 常量串（index 37332），其用途未完全定性——
  这是本报告唯一的残余不确定点。缓解：B2 上机后若出现新的 `Resource xxx is not found` 且
  `pkg=` 显示 `com.tencent.tmgp.sgame`，互斥切换到 B3，成本极低（两者均已精确定位）。
- version-gate patch（libapollo 三处）依然**未被验证**——license gate 解除后流程才能走到版本检查点。

## 可复现工具

- **`tools/analyze_resid_gate.mjs`**（本次新增，纯 Node 零依赖）：
  - 结构化解析 3 个 dex（header/string/type/proto/method/class data/code item），dump 全部 `*ResID` 类的
    `loadIdentifierResource`/`init` 指令流（含 file offset）；
  - 结构化解析 `resources.arsc`（string pool/TYPE_SPEC/TYPE/entry），输出全部 type 条目清单、
    smoba 资源存在性、`tmgp Common WebViewResID.init` 39 项查询命中矩阵；
  - 输出 `workspace/analysis/resid_gate/resid_gate_analysis.json`（机器可复核）。
- `workspace/analysis/ResourceTypes.cpp.txt`：AOSP android13-release `libs/androidfw/ResourceTypes.cpp`
  存档（`identifierForName` 包名匹配证据）。

## 证据文件索引

- `artifacts/smoke-v3/logcat-launch.txt:177-201` — sgamx 失败轨迹。
- `workspace/experiments/20261124-203151-B0-tencent-sig-original.logcat.txt:1191-1192` — sgame 原版通过轨迹。
- `workspace/analysis/resid_gate/resid_gate_analysis.json` — dex/arsc 结构化解析全量输出。
- `workspace/analysis/sgamx_v3/` — v3 提取文件（manifest sha256 `E10016D2…` 与构建记录一致；
  arsc sha256 `76407A3E…` 与原版一致）。
- `workspace/analysis/jadx/sources/com/tencent/tmgp/Common/WebViewResID.java` — jadx 反编译对照。
- `docs/package-rename-audit.md` — v3 构建链（证明 arsc 从未被 patch）。
