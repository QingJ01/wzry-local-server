# APK 安装失败修复报告

## 现象

原 APK `3.81.1.8.apk` 可在目标设备安装并启动。对 `AndroidManifest.xml` 与 `resources.arsc` 做等长二进制替换、清除旧签名、`zipalign -p 4` 并重签后，安装失败：

```text
INSTALL_FAILED_CONTAINER_ERROR: Failed to extract native libraries, res=-18
NativeLibraryHelper: Failed uncompressing lib/arm64-v8a/libPxExtJava.so
```

## 根因分析

新增 `tools/Compare-ApkZipLayout.ps1` 后，对原 APK 与失败 APK 做逐 entry 对比：

- 两者均为 687 个 entry。
- 所有 `lib/*` entry 的内容 SHA-256、原始大小和压缩大小完全一致；未发现 `libPxExtJava.so` 数据损坏。
- 真实差异仅包括补丁后的 `AndroidManifest.xml`、`resources.arsc`、签名文件。
- 失败 APK 中 `resources.arsc` 从原始 Store（`263812` 字节）变为 Deflate（`41452` 字节）。

结论：`libPxExtJava.so` 是安装器报错位置，不是根因。根因是 .NET `ZipArchive` 在替换 entry 时未保留原始 ZIP 压缩策略；`resources.arsc` 被重压缩，触发目标 Android 15 / NativeBridge 环境的安装器兼容性路径失败。

## 修复

`client/Build-WzryApk.ps1` 新增 `Get-EntryCompressionLevel`：

- `resources.arsc`、`lib/*`、`assets/*` 使用 `CompressionLevel.NoCompression`。
- 其他 entry 维持 `Optimal`。

`Write-EntryBytes` 在重建 entry 时显式传入该策略，避免 .NET 默认重压缩敏感资源。

修复后构建的 APK 中：

- `resources.arsc` 内容 SHA-256 与预期补丁内容一致。
- `resources.arsc` 保持接近原始大小的 Store 形式（对齐后 `263857` 字节）。
- `libPxExtJava.so` 等 native entry 与原 APK 完全一致。
- `zipalign -c -p 4` 与 `apksigner verify --verbose` 通过。

## 验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\client\Test-Pipeline.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\client\Build-WzryApk.ps1 `
  -SourceApk .\workspace\apk\3.81.1.8.apk `
  -OutputApk .\workspace\apk\wzry-control-plane-debug-store.apk `
  -PatchManifest .\client\patches\control-plane.json
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\Verify-ControlPlanePatch.ps1 `
  -Apk .\workspace\apk\wzry-control-plane-debug-store.apk
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\Compare-ApkZipLayout.ps1 `
  -ReferenceApk .\workspace\apk\3.81.1.8.apk `
  -CandidateApk .\workspace\apk\wzry-control-plane-debug-store.apk
```

本地已通过上述脚本测试和构建验证。由于本任务约束不操作 ADB，最终仍需主线程将 `wzry-control-plane-debug-store.apk` 安装到 `192.168.5.102:5555` 做设备端验收。
