# 包名共存改造审计报告

## 目标
在已装 `com.tencent.tmgp.sgame` 12.1.1.1 的 vivo 真机（arm64, Android 16）上，
让 3.81.1.8 method0 调试包以**独立包名**共存安装，避免覆盖正式版本。

## 源 APK
- 路径：`client/builds/wzry-version-gate-method0.apk`
- SHA-256：`9C1D9CD61A359025A01D7003CA0129A4A5150A74D4907D185777574A05EB441F`
- 基础：3.81.1.8 method0（已含 libapollo.so version-gate 3 处 patch）
- ZIP：687 entries，UTF-8 flag，无 data descriptor，central/local extra 全一致

## 输出 APK
- 路径：`client/builds/wzry-localdebug-sgamx.apk`
- SHA-256：`5AA7CBB84AB2C7963861AE07BECEE116A3D139A45B13D00B1983120DED073BBB`
- 包名：`com.tencent.tmgp.sgame` → `com.tencent.tmgp.sgamx`（22 字符等长替换）
- 签名：WZRY-DEB 调试 keystore，v2+v3 scheme，minSdk 24
- 验证：`aapt2 dump packagename` → `com.tencent.tmgp.sgamx`；`aapt dump badging` 正常

## 包名修改点（最小化）
只改 AXML root `manifest package` 属性：
- AXML string pool index **231**
- UTF-16 text offset **15640**
- 原值 `com.tencent.tmgp.sgame`（44 字节 UTF-16），新值 `com.tencent.tmgp.sgamx`（44 字节等长原位覆写）

manifest 中其它包名引用（permission name、provider authorities、activity
taskAffinity、deep-link host、metadata `com.tencent.tmgp.sgame.*`）**保持原值**。
这样所有组件仍能定位，不会因为 authorities 错乱崩溃；但会与正式包共享
`android:authorities` 命名空间——vivo/Android 16 对重复 authorities 只在
安装时告警或拒绝，**需要真机安装验证**。

## 关键坑与修复
### 1. `AndroidManifest.xml` local header nameLen=19 混淆
源 entry central/local 都写 `nameLen=19`，但 `AndroidManifest.xml` 实际 18
字符。第 19 字节是 deflate 数据首字节 `BD`。dataOffset = lho+30+19+0 =
lho+49，恰好指向真实 deflate 流起点。

**结论**：不是 bug 是技巧——ZIP 规范允许任意 nameLen，工具按 nameLen 跳过
仍能读到正确数据。修复：写 staging 时用真实 `AndroidManifest.xml`(18)
nameLen，dataOffset=lho+48 即数据起点，与源语义一致。

### 2. apksigner 对 stored manifest 的二次破坏
若把 manifest 写为 stored，apksigner sign 会插 9 字节 extra + 把 nameLen
改 19，导致数据偏移错乱（读到下个 entry 的 `PK\x03\x04`）。修复：
manifest 保持 **deflate**（method=8），apksigner 不动它。

### 3. ZIP 写入时 central 多写 uint32
原脚本 central header 在 `internalAttrs` 后多写一个 `uint32` 占位，把
`externalAttrs`/`localHeaderOffset` 后移 4 字节，central 全部损坏。已修。

## ZIP 布局对比
`tools/Compare-ApkZipLayout.ps1` 结果：
- 687 → 687 entries
- `AndroidManifest.xml` changed（deflate 9659→9693）
- `META-INF/SGAME.{SF,RSA}` removed（原签名剥除）
- `META-INF/WZRY-DEB.{SF,RSA}` added（调试签名）
- `META-INF/MANIFEST.MF` regenerated（v1 manifest 条目）
- 其它 681 entries **字节级一致**（含所有 lib/arm64-v8a .so、resources.arsc、assets）

## 共存性评估
| 维度 | 评估 |
|---|---|
| package name | ✅ 唯一 `sgamx`，不冲突 |
| 签名 | ✅ 自签，Android 不做开发者校验 |
| provider authorities | ⚠️ 未改，与正式包重复——Android 16 可能报警告但仍可装 |
| permission name | ⚠️ 未改，自定义权限与正式包重名，通常允许 |
| deep link scheme | ✅ 与正式包同 host，点击会弹选择器 |
| native lib 包名硬编码 | ⚠️ 已扫 `libil2cpp.so`/`libGameCore.so` 对 `com.tencent.tmgp.sgame` 字符串引用，未发现用于文件路径/IPC 的硬编码 |
| 多开/分身框架 | ✅ 这是正规共存安装，比多开稳定 |

## 真机安装前置条件
1. 设备已开 USB 调试 + `adb connect 192.168.5.101:5555`
2. 已装 `com.tencent.tmgp.sgame`（不必卸载，共存安装）
3. 推荐先备份正式包数据：`adb shell pm list packages | grep sgame`
4. 安装：`adb install -r client/builds/wzry-localdebug-sgamx.apk`
5. 启动：`adb shell monkey -p com.tencent.tmgp.sgamx -c android.intent.category.LAUNCHER 1`

## 已知风险
- **资源/authority 冲突**：若 Android 16 严格拒绝重复 provider
  authorities，需要追加 patch authorities（同长度改 `sgame`→`sgamx`）。
  字符串扫描显示 manifest 中 `com.tencent.tmgp.sgame` 共出现 4+ 次，
  后续可做等长全替换版本。
- **IL2CPP 包名校验**：游戏运行时可能比对 `context.getPackageName()` 与
  硬编码常量。若 crash 在启动早期，需 il2cpp 逆向定位 package 校验。
- **server 校验**：包名改变后 server 端签名校验（若有）会失败；
  本地服务端可配置忽略。

## 工具链
- 构建：`tools/Build-PackageRenameApk.ps1`（自研，保持 Store/Deflate 策略 + entry 顺序）
- 对比：`tools/Compare-ApkZipLayout.ps1`
- 验证：`aapt2 dump packagename`、`apksigner verify --min-sdk-version 24`、`zipalign -c -p 4`

## 构建清单
`wzry-localdebug-sgamx.apk.manifest.json`：
- sourceSha256：`9C1D9CD6...EB441F`
- outputSha256：`5AA7CBB8...073BBB`
- patchedManifestSha256：`9383CACC...D0594D16`
- builtAt：`2026-11-24T16:42:29Z`

---

## 合并构建（version-gate + package-rename）

`client/builds/wzry-version-gate-localdebug-sgamx.apk`
- 源：`wzry-version-gate-signed.apk`（已含 libapollo.so 三处 version-gate patch + WZRY-DEB 签名）
- 输出 SHA-256：`DD8BE26780BDD11F3F6506D5EA0364D16D9C24DE8B695B6A43A08B5E8FD3E3B2`
- 大小：976,967,359 B
- `aapt2 dump packagename` → `com.tencent.tmgp.sgamx`
- `aapt dump badging` → `versionCode=381010801 versionName=3.81.1.8`
- `lib/arm64-v8a/libapollo.so` SHA-256：`8B6F4BB3...88FB65`（与源字节一致，patch 完整保留）
- `lib/arm64-v8a/{libGameCore,libil2cpp,libapollo}.so` / `resources.arsc` 全 Stored
- `AndroidManifest.xml` 保持 deflate（9693 B），AXML magic `03 00 08 00` 完整
- ZIP layout diff：仅 manifest + META-INF 签名条目变化，683 entries 字节一致
- 验证：`zipalign -c -p 4` ✓ `apksigner verify --min-sdk-version 24` v2+v3 ✓
- 构建时间：`2026-11-24T16:45:39Z`

## 推荐安装顺序
此 APK = version-gate patch + package-rename，是**最终建议装机版本**。
```
adb connect 192.168.5.101:5555
adb install -r client/builds/wzry-version-gate-localdebug-sgamx.apk
adb shell monkey -p com.tencent.tmgp.sgamx -c android.intent.category.LAUNCHER 1
```

---

## v2 构建：修复 INSTALL_FAILED_DUPLICATE_PERMISSION

`client/builds/wzry-version-gate-localdebug-sgamx-v2.apk`
- 源：`wzry-version-gate-signed.apk`（version-gate + WZRY-DEB 签名）
- 输出 SHA-256：`F891A8A3696993D2C6518107285DE789F7E4BCD9EC7A4BD6012BEA8F1E418A8D`
- 替换策略：**所有 `com.tencent.tmgp.sgame` 子串等长替换为 `com.tencent.tmgp.sgamx`**
- **15 处 editPoints**（AXML UTF-16 原位覆写，等长不改 AXML 结构）

### 替换明细
| AXML idx | 原字符串 | byteOffset |
|---|---|---|
| 172 | `com.subao.permission.USE_SDK.com.tencent.tmgp.sgame.KingsGlory` | 10122 |
| 231 | `com.tencent.tmgp.sgame`（root package） | 15640 |
| 232 | `...AUTH_XGPUSH_KEEPALIVE` | 15688 |
| 233 | `...ApolloFileprovider` | 15780 |
| 234 | `...CAMP_OPEN_SDK_PROVIDER` | 15866 |
| 235 | `...OPEN_TPNS_ACTIVITY_V2` | 15960 |
| 236 | `...SGameActivity` | 16052 |
| 237 | `...TPUSH_PROVIDER` | 16128 |
| 238 | `...XGVIP_PUSH_ACTION` | 16206 |
| 239 | `...XGVIP_PUSH_AUTH` | 16290 |
| 240 | `...XG_SETTINGS_PROVIDER` | 16370 |
| 241 | `...diff` | 16460 |
| 242 | `...fileProvider` | 16518 |
| 243 | `...permission.XGPUSH_RECEIVE` | 16592 |
| 244 | `...wxapi.WXEntryActivity` | 16692 |

### 关键修复点
- **idx 243** `...permission.XGPUSH_RECEIVE` 是 `INSTALL_FAILED_DUPLICATE_PERMISSION` 元凶：正式包已声明 `com.tencent.tmgp.sgame.permission.XGPUSH_RECEIVE`，v1 不改导致权限命名空间冲突。v2 改为 `sgamx` 命名空间。
- **idx 172** subao 权限引用：原引用正式包权限，v2 改为引用 sgamx 声明的同名权限（sgamx 也声明了该 permission），行为一致。
- **idx 232-242, 244**：provider authorities / action / activity name 全部去 sgame 前缀，避免 authority 重复冲突。

### 验证
- `aapt2 dump packagename` → `com.tencent.tmgp.sgamx` ✓
- `aapt dump badging` → `versionCode=381010801 versionName=3.81.1.8` ✓
- `aapt dump permissions`：`permission: com.tencent.tmgp.sgamx.permission.XGPUSH_RECEIVE` + `com.subao.permission.USE_SDK.com.tencent.tmgp.sgamx.KingsGlory` ✓
- `zipalign -c -p 4` ✓ `apksigner verify --min-sdk-version 24` v2+v3 ✓
- `lib/arm64-v8a/libapollo.so` SHA-256 `8B6F4BB3…88FB65`（version-gate 三处 patch 完整保留）✓
- `Compare-ApkZipLayout`：仅 manifest + META-INF 签名条目变化，683 entries 字节一致 ✓
- manifest deflate 9693B，AXML magic `03 00 08 00` 完整 ✓
- 构建时间：`2026-11-24T17:52:09+08:00`

### 推荐（v2 优先）
```
adb install -r client/builds/wzry-version-gate-localdebug-sgamx-v2.apk
```

---

## v3 构建：修复 vivo 启动崩溃（组件类名回退 sgame）

**v2 引入的 bug**：launchable-activity 被改成 `com.tencent.tmgp.sgamx.SGameActivity`，
但 dex 中类仍是 `com.tencent.tmgp.sgame.SGameActivity` → `ClassNotFoundException`。

**v3 策略**：
- root `manifest package` = `sgamx`（共存安装必须）
- `android:name` 组件类（activity/service/receiver/provider）**保持 `sgame` 前缀**，
  与 dex 类全名一致
- intent-filter `action android:name` **保持 `sgame` 前缀**（XGPush SDK 内部可能
  硬编码 action 字符串）
- provider `authorities` / `permission` / `taskAffinity` / root package 改为 `sgamx`

`client/builds/wzry-version-gate-localdebug-sgamx-v3.apk`
- 输出 SHA-256：`7DEA7EE8E32ACF7FD3ED48C9FD6E67D6C690E7010576C9A18460B5E56D062AD7`
- **11 处 editPoints**（精准 index 控制，等长覆写）

### 替换集合（11 处）
| idx | 字符串 | 用途 |
|---|---|---|
| 172 | `subao.USE_SDK.sgame.KingsGlory` | permission + uses-permission |
| 231 | `sgame` | root manifest package |
| 232 | `sgame.AUTH_XGPUSH_KEEPALIVE` | provider authorities |
| 233 | `sgame.ApolloFileprovider` | provider authorities |
| 234 | `sgame.CAMP_OPEN_SDK_PROVIDER` | provider authorities |
| 237 | `sgame.TPUSH_PROVIDER` | provider authorities |
| 239 | `sgame.XGVIP_PUSH_AUTH` | provider authorities |
| 240 | `sgame.XG_SETTINGS_PROVIDER` | provider authorities |
| 241 | `sgame.diff` | taskAffinity |
| 242 | `sgame.fileProvider` | provider authorities |
| 243 | `sgame.permission.XGPUSH_RECEIVE` | permission + uses-permission |

### 保留 sgame 的字符串（不改）
| idx | 字符串 | 原因 |
|---|---|---|
| 235 | `sgame.OPEN_TPNS_ACTIVITY_V2` | intent-filter action，SDK 可能 hardcode |
| 236 | `sgame.SGameActivity` | **launchable activity dex 类名** |
| 238 | `sgame.XGVIP_PUSH_ACTION` | intent-filter action，SDK 可能 hardcode |
| 244 | `sgame.wxapi.WXEntryActivity` | activity dex 类名 |

### 关键验证（v3）
- `aapt2 dump packagename` → `com.tencent.tmgp.sgamx` ✓
- `aapt dump badging`：
  - `package: name='com.tencent.tmgp.sgamx'` ✓
  - **`launchable-activity: name='com.tencent.tmgp.sgame.SGameActivity'`** ✓
  - `leanback-launchable-activity` 同 ✓
- `aapt dump permissions`：`sgamx.permission.XGPUSH_RECEIVE` + `subao...sgamx.KingsGlory` ✓
- `zipalign -c -p 4` ✓ `apksigner verify --min-sdk-version 24` v2+v3 ✓
- `lib/arm64-v8a/libapollo.so` SHA-256 `8B6F4BB3…88FB65`（version-gate patch 保留）✓
- `Compare-ApkZipLayout`：仅 manifest + META-INF 签名条目，683 entries 字节一致 ✓
- manifest deflate 9697B ✓
- 构建时间：`2026-11-24T18:17:38+08:00`

### 工具更新
`tools/Build-PackageRenameApk.ps1` 新增 `-EditIndexes @(int[])` 参数，
按 AXML string pool index 精准控制替换集合。

### 推荐（v3 优先）
```
adb install -r client/builds/wzry-version-gate-localdebug-sgamx-v3.apk
```
