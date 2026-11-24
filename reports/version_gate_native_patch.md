# Version gate — `libapollo.so` native patch evidence — 2026-11-24

任务：`/root/version_gate_reverse_analyst`。范围只出静态证据与 patch 建议，不改设备、不构建 APK。

## 判定

版本门禁（"年度版本 云梦有灵"强制更新）由 `libapollo.so` 的 `cu::` GCloud 版本管理器驱动：

- 版本服务：`download.2.1212338883.wz.gcloudgbs.com`（HTTPS）+ 备用 `101.91.33.83:8085`/`119.147.15.155:8085`，**不在** method0 的 `127.0.0.1:19620` 控制面重写内。
- `on_get_new_version` 的 `m_custom_str` 是线上真实响应：`downloadAppVersion=9.2.1.7`、`IncompatibleResourceVersion=3.81.1.67` → `isNeedUpdating=1`。
- `libil2cpp.so` 加固，`CodeRegistration`/`MetadataRegistration` 不可恢复 → IL2CPP `CVersionUpdateSystem` 无法静态 patch。
- `libapollo.so` 是**未加固 C++ ELF**，带完整符号，是版本判定真正的落点。

## `_tagVersionInfo` / 回调对象布局（logcat + ctor 归零证据）

`CAppCallbackVersionInfo::ctor`（`0x4e2a1c`）把 `this+8/+9/+10/+11` 全部 `strb w31`(=0) 初始化，
`DoEvent` 再从 `_tagVersionInfo` 拷入。回调对象字段偏移：

| 偏移 | 字段 | logcat 对应 |
| --- | --- | --- |
| `+8` | `isNeedUpdating` | `Handle Version: isNeedUpdating[%d]` |
| `+9` | `isForcedUpdating` | `isForcedUpdating[%d]` |
| `+10` | `isAppUpdating` | `IsAppUpdating[%d]` |
| `+40`/`+48` | `needDownloadSize`/`totalDownloadSize` | `needDownloadSize[%llu]`/`totalDownloadSize` |

## 精确 patch 点 — `CAppCallbackVersionInfo::DoEvent`（`0x4f3654`）

DoEvent 把 `_tagVersionInfo` 的更新标志拷入回调对象后 `blr x3` 进 `OnGetNewVersionInfo`。
三条 `ldrb` 连续读 `this+8/+9/+10`；全部改成 `mov wN, wzr` 即让 `isNeedUpdating`/`isForcedUpdating`/`isAppUpdating` 恒为 0 → 走"无需更新"分支，公告不出现，`m_custom_str`/`fileinfo` 不受影响。

| VA | 原字节 | 原指令 | 替换字节 | 替换指令 | 作用 |
| --- | --- | --- | --- | --- | --- |
| `0x4f368c` | `65224039` | `ldrb w5,[x19,#8]` | `52800005` | `movz w5,#0` (=`mov w5,wzr`) | `isNeedUpdating := 0` |
| `0x4f3690` | `66264039` | `ldrb w6,[x19,#9]` | `52800006` | `mov w6, wzr` | `isForcedUpdating := 0` |
| `0x4f3698` | `672a4039` | `ldrb w7,[x19,#10]` | `52800007` | `mov w7, wzr` | `isAppUpdating := 0` |

> `movz wN,#0` = `mov wN,wzr`，编码 `0x52800000|N`。三处均为等长 4 字节，`lib/*` Store，符合 `native_patch_plan.md`。

## 备选（更保守，仅压强制更新）

只 patch `+9`(isForcedUpdating)与 `+8`(isNeedUpdating)，保留 `isAppUpdating`：

| VA | 原字节 | 替换字节 |
| --- | --- | --- |
| `0x4f368c` | `65224039` | `52800005` |
| `0x4f3690` | `66264039` | `52800006` |

## 服务端能否返回兼容版本字段（评估）

**不能直接解决。** 版本判定数据源是 `download.2.1212338883.wz.gcloudgbs.com`（GCloud 版本服务，HTTPS，不在本地重写内）。`getConfig`/`padx` 404 后 `on_get_new_version` 仍返回 9.2.1.7 → 本地服务端无法注入 `isNeedUpdating=0`。唯一可控路径是**客户端 patch**（本报告）或把版本服务域名加入等长控制面重写并把 `127.0.0.1:19620` 伪造成版本服务（需先证明 schema+签名，证据不足，不推荐作首选）。

## Patch manifest 草案（供 `Build-WzryNativePatch.ps1`，暂不执行）

```json
{
  "nativePatches": [
    {
      "entryPath": "lib/arm64-v8a/libapollo.so",
      "offset": 5191308,
      "originalBytesHex": "65224039",
      "replacementBytesHex": "52800005",
      "evidence": "reports/version_gate_native_patch.md#0x4f368c-isNeedUpdating"
    },
    {
      "entryPath": "lib/arm64-v8a/libapollo.so",
      "offset": 5191312,
      "originalBytesHex": "66264039",
      "replacementBytesHex": "52800006",
      "evidence": "reports/version_gate_native_patch.md#0x4f3690-isForcedUpdating"
    },
    {
      "entryPath": "lib/arm64-v8a/libapollo.so",
      "offset": 5191320,
      "originalBytesHex": "672a4039",
      "replacementBytesHex": "52800007",
      "evidence": "reports/version_gate_native_patch.md#0x4f3698-isAppUpdating"
    }
  ]
}
```

`offset` = VA `0x4f368c/0x4f3690/0x4f3698`（`.text` `ad==of`，file offset == vaddr）。

## 证据强度与未证明点

- `DoEvent`/`ctor`/symbol/field offsets：**高置信**（符号 + ctor 归零 + ldrb 序列 + logcat 字段一一对应）。
- `this+8/+9/+10` 与 `isNeed/isForced/isApp` 的对应：**高**（ctor `strb w31` 顺序 = `VERSIONINFO` 字段顺序 = `isNeedUpdating`/`isForcedUpdating`/`isAppUpdating`）。
- patch 后是否完全跳过公告 UI：未验证——`_tagVersionInfo` 里 `newAppVersion`/`AnnouncementUrl` 仍会下发，但 `isNeedUpdating=0` 应让 `CVersionUpdateSystem` 跳过公告窗。需 `.101` 实测确认。
- 若仍弹公告：下一 patch 点是 `PluginVersionMgrCallback::OnGetNewVersionInfo`（`0x44ba58`）里 `ldrb w5,[x19,#1/#2]` 的写回（序列化侧 `isNeedUpdating`/`isForcedUpdating`）。

## 工具

- `tools/analyze_apollo_version.mjs` — ELF/dynsym/section/ADRP 扫描器，输出 `workspace/analysis/security/libapollo-version/apollo-version-analysis.json`。

---

## 构建结果（2026-11-25，`/root/version_patch_builder`）

**已构建签名 APK**：`client/builds/wzry-version-gate-signed.apk`
- SHA-256：`33F1374863BC5975474781F3A5282DABDAAB38FAA9EB68DC0E34B9978F8417F2`
- Manifest：`client/patches/version-gate.json`（3 处 `lib/arm64-v8a/libapollo.so` 等长 patch）

**关键工程发现 — .NET `ZipArchive` 无法写真 Store。**
`tools/Build-WzryNativePatch.ps1` 的 `CreateEntry(NoCompression)` + 反射 `CompressionMethod='Stored'` 只改 method 标志，写入管道仍是 deflate → 每个 entry 数据被插入 5 字节无压缩块头 + 块边界 padding（8.5MB apollo 解压出 8514396B 而非 8513096B，ELF 头被推到 offset 5）。`CompressionLevel` 三档全部如此（.NET Core/Framework 均复现，见 `workspace/minizip-test.ps1`）。`Compare-ApkZipLayout` 因此报全部敏感 entry "changed"。

**修复**：新增 `tools/build_native_patch_apk.mjs`（纯 Node zlib）——解析源 APK central directory，逐 entry 流式解压，`lib/*`/`assets/*`/`resources.arsc` 用 `method=0`（真 STORED），其余用 raw `deflateRawSync`（method=8），按源顺序重写 local+central headers，应用 patch 字节。输出后 `libapollo.so` `CompressedLength=8513096=Length`（真 Store）、解压 ELF 头在 offset 0、patch 字节 `52800005/06/07` 精确落位。

**构建链**：`build_native_patch_apk.mjs` → `zipalign -f -p 4` → `apksigner sign` → `apksigner verify --verbose`。

**验证矩阵（全过）**
- patch 字节校验：`-WhatIf` 3/3 patch 通过（`originalBytesHex` 精确匹配）。
- Store：所有 `lib/*`/`assets/*`/`resources.arsc` `CompressedLength==Length`，无块头。
- 签名：`v2`/`v3` scheme 均 `Verified using ... : true`，`Number of signers: 1`。
- 解压纯净：`libapollo.so` 解压字节序 ELF 头 `7F 45 4C 46` @offset 0，patch 区 `52 80 00 05`。

**待办**：`.101` 设备安装 + 冷启动验证"年度版本"公告消失，再进登录/大厅/商城/对战闭环。

> 注：`tools/Build-WzryNativePatch.ps1` 的 `Write-EntryBytes`/`Write-EntryStream` 已按同样 Store 策略改写为流式（避免 460MB `byte[]` OOM），但 `.NET CreateEntry(NoCompression)` 仍会写 deflate 块头——**`build_native_patch_apk.mjs` 才是产生真 Store 的正确路径**。
