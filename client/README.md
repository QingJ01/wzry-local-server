# WZRY client debug pipeline

`Build-WzryApk.ps1` performs a deterministic, manifest-driven APK rebuild:

1. Verifies the source APK SHA-256.
2. Applies add/replace entries from a JSON patch manifest.
3. Removes V1 signing metadata.
4. Runs ZipAlign 4-byte alignment.
5. Creates and reuses a local debug PKCS12 keystore.
6. Signs and verifies with APKSigner.
7. Writes a JSON build manifest next to the output APK.

Example:

```powershell
.\Build-WzryApk.ps1 `
  -SourceApk D:\project\wzry\workspace\apk\3.81.1.8.apk `
  -OutputApk D:\project\wzry\client\builds\wzry-debug.apk `
  -PatchManifest D:\project\wzry\client\patches\empty.json
```

Patch manifest format:

```json
{
  "entries": [
    {
      "entryPath": "assets/local-server.ini",
      "sourcePath": "D:/project/wzry/client/patches/local-server.ini"
    }
  ]
}
```

`Install-WzryDbg.ps1` explicitly targets `192.168.5.102:5555`, creates ADB reverse mappings for local HTTP `19620` and frame TCP `19621`, installs with `adb install -r -d`, and records commands and results in `install-logs`.

```powershell
.\Install-WzryDbg.ps1 `
  -Apk D:\project\wzry\client\builds\wzry-debug.apk `
  -Serial 192.168.5.102:5555
```

Validate the scripts without touching the device:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\project\wzry\client\Test-Pipeline.ps1
```

The debug keystore is excluded from Git. Never use it for distribution.
