# wzry-local-server

A workspace for developing a local game server, reverse-engineering client protocols, and producing a reproducible APK pipeline.

## Current artifacts

- `reports/device_baseline.md` — ADB baseline for `192.168.5.102:5555`.
- `reports/protocol_plan.md` — staged protocol reverse-engineering plan.
- `reports/apk_pipeline.md` — APK extraction, patching, signing, and installation workflow.
- `reports/server_architecture.md` — proposed local server architecture and milestones.
- `workspace/tools/extract_wzry_apk.mjs` — ZIP64-aware APK extractor.

Large game archives and extracted APK files are intentionally excluded by `.gitignore`.

## Getting started

```powershell
node .\workspace\tools\extract_wzry_apk.mjs .\3.81.1.67.zip .\workspace\apk\3.81.1.8.apk
```

The extractor verifies the expected APK SHA-256 value:

```text
A016D941A3D7BA0A8FC976DAE6FE744EFEC85835A16DD10928B65A9C7E19EE5D
```

Use the tools under `D:\project\poxxiao\tools` for ADB, AAPT, ZipAlign, APKSigner, Java, Node, and static analysis.
