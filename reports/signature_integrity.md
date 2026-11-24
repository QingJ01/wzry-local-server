# Signature / package-integrity vs environment — 2026-11-24 (specialist report)

Device `192.168.5.102:5555` (NetEase MuMu x86_64, Houdini ARM64 translation, KernelSU root). Package `com.tencent.tmgp.sgame`, `versionCode=381010801`, `versionName=3.81.1.8`. Purpose: determine whether the recurring ~60 s foreground self-SIGKILL is triggered by the debug re-signature / repack (user hypothesis) or by the emulator/Houdini environment.

## TL;DR — answer to the user

- **Signature change alone is NOT proven to be the trigger; package-content change is the leading suspect.** The original Tencent-signed, byte-original APK survived a full **130 s** foreground window (pid 42568) with zero self-SIGKILL — far past the ~60 s point at which every patched/debug-signed build reliably dies. We do not yet have a clean `orig-content + debug-cert` datapoint (see Experiment A caveat), so the signature vs content split is not fully resolved, but the strongest surviving hypothesis is **TenProtect APK file-integrity CRC** tripping on the `AndroidManifest.xml`/`resources.arsc` patch — not a PM signature check and not the environment.
- The kill mechanism is unchanged: in-process `kill(9)` from a Houdini worker thread (`houdini [tid] [SIGKILL] kill: pid=<self>`). The environment supplies the messenger; the verdict most plausibly comes from the integrity engine.

## APK comparison matrix

| Build | Content | Signer | v1/v2/v3 | Entry diff vs orig |
| --- | --- | --- | --- | --- |
| `workspace/apk/3.81.1.8.apk` (SHA-256 `a016d941…`) | original | `C=86,ST=Sichuan,O=Tencent,OU=IEG Timi L1,CN=S Game` cert SHA-256 `e8685274…` | v1+v2+v3 | — (reference) |
| `workspace/apk/orig-zipalign-force-sign.apk` (`00905b4f…`) | original bytes | `CN=WZRY Local Debug` cert `4d224626…` | v1+v2+v3 | only signature block/.SF/.RSA |
| `workspace/apk/wzry-patched-working-sign.apk` (`88205f4c…`) | manifest+arsc patched | `CN=WZRY Local Debug` `4d224626…` | v1+v2+v3 | manifest, arsc, sig files |
| `client/builds/wzry-control-plane-store-method0.apk` (`136fca81…`, 977 MB) | manifest+arsc patched, resources.arsc Store | `CN=WZRY Local Debug` `4d224626…` | v1+v2+v3 | manifest, arsc (true method 0), sig files |

- Package name `com.tencent.tmgp.sgame` and `versionCode 381010801` are **identical across all builds** — package-name/version triggers ruled out.
- `store_layout_diff.json`: the only content differences vs original are `AndroidManifest.xml` (same length, different bytes — control-plane URL rewrite) and `resources.arsc` (same length, different bytes — `ap6.ssl.msdk.qq.com` → `127.0.0.1`), plus `META-INF` signature files. No `lib/*` or `classes*.dex` changed.
- Patch surface (`client/patches/control-plane.json`): only rewrites `hc2.tdm.qq.com`, `cloudctrl.gcloud.qq.com`, `ap6.ssl.msdk.qq.com` → `127.0.0.1:19620`. Byte-length preserved.

## Integrity / signature-check surface in the client (static evidence)

- Protection suite present in `lib/arm64`: `libtersafe.so`, `libtprt.so`, `libTPCore-master.so`, `libxgVipSecurity.so`, `libpandoragamecore.so` — Tencent TP (TenProtect) anti-tamper. `libGameCore.so` carries `ELF_HOOK_BRIDGE_*`, `g_tprt_*`, `stub_send/stub_recv`, `libunpacker_otheralign.so` → packed/hooked.
- `libtersafe.so` strings: `[Shell]apk_path`, `apk_path=%s`, `ApkAbort_CS_%d`, `ApkAbort_CS_Cnt`, `mtcj_apk.txt`, `mtcj_inner_apk_file_info.txt`, `mtcj_mem_page_crc.txt`, `%s, size:%d, crc:%08x`, `dl %s, len:%d, crc:%08x`, `TssSDKOnRecvSignature`, `%sDigital Signature`, plus `abort`, `_exit`. → It reads the on-disk `base.apk` (`/proc/self/mounts`,`/proc/self/status`,`ptrace`,`debugger` also present) and CRCs **inner apk file info + memory pages**. `ApkAbort` is the kill path.
- `libTPCore-master.so`: `client signature does not match!` — an explicit signature-mismatch message exists in the TP audio/RTC lib.
- `libxgVipSecurity.so`: `getEncryptAPKSignatureNative`, `toCharsString` — pulls signing certificate via JNI `Signature.toCharsString()` (PackageManager-visible signature path). Spoofable via an LSPosed/`IPackageManager` hook; **but** this is the xg-vip/push security lib, a secondary check.
- Conclusion of static pass: there are **two distinct check surfaces** —
  1. **TenProtect file integrity** (`libtersafe` `apk_path` + `mtcj_*_crc`): detects ANY repack/resign that alters entry bytes or layout. Not fixable by a PM-signature spoof.
  2. **PM/JNI signature read** (`libxgVipSecurity` `getEncryptAPKSignatureNative`, TP `client signature does not match`): fixable by returning the original cert via hook.

## Experiment A — runtime matrix (only run completed before device went offline)

- Target: `orig-zipalign-force-sign.apk` (orig bytes + debug cert), `pm install -r` via `/data/local/tmp` push (full 460 355 263 B pushed, remote SHA-256 verified `00905b4f…`).
- **Install was REJECTED**: `INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package … signatures do not match newer version`. The device still had the Tencent-signed build installed, so the debug-signed variant could not replace it.
- `installed-verified` reported `deviceSha256 = a016d941…` = the **original Tencent-signed `3.81.1.8.apk`** (NOT method0 `136fca…`). At some earlier point the original-signed build had been (re)installed over method0.
- Cold-start of that **original signed build**: `pid 42568` stayed foreground-alive for the full **130 s** watch, `type:survived`, no `died`, no `houdini [SIGKILL]` line in the captured logcat. Process confirmed still present at `pidof` after the window.

### Interpretation of Experiment A

- Because the install was rejected, the surviving process is the **original-signed, original-content** build — not the `orig-content + debug-cert` isolate I intended. So the signature-vs-content variable was **not** cleanly separated by this run.
- What IS proven: a Tencent-signed, byte-original APK does **not** self-SIGKILL in this exact emulator/root environment for at least 130 s. That pushes attribution strongly toward **package modification** (signature and/or manifest/arsc content) as the trigger, and **away** from a pure environment detection — because the same vbox/qemu/native-bridge/`su` surface was present during the surviving run.
- Caveat that must be stated: `A` does not prove signature alone is safe. It proves the *original signed package* is stable here. To isolate signature alone we still need `orig-content + debug-cert` to actually install (requires uninstall of the Tencent-signed package first → needs user approval, since it clears app data).

## Signature vs content — what each hypothesis predicts

| Hypothesis | `orig+debug-cert` result | `patched+orig-cert` (if it could exist) |
| --- | --- | --- |
| Signature check (PM/`getEncryptAPKSignatureNative`) | dies ~60 s | survives |
| APK file integrity (`libtersafe` `apk_path`/`mtcj_crc`) | survives | dies ~60 s |
| Environment only | dies ~60 s | dies ~60 s |

Experiment A (as actually installed = orig+orig-cert) survived → consistent with both "signature-check" being absent on the original AND "file-integrity" being satisfied on the original. The discriminating test is still the `orig+debug-cert` build, which we could not install without a signature-mismatch uninstall.

## Remaining ambiguities / next experiments (need user approval + online device)

- **E-A′ (clean signature isolate)**: uninstall `com.tencent.tmgp.sgame` (loses app data — approval required) → install `orig-zipalign-force-sign.apk` (orig bytes + debug cert) → cold-start 130 s. If it dies ~60 s → signature check confirmed. If it survives → repack/file-integrity confirmed.
- **E-B (patch-only, orig-cert impossible)**: cannot re-sign with Tencent's private key, so a "patched + orig-cert" build cannot be produced. The only way to keep the original cert is to not modify content — meaning signature and content are coupled: any repack forces resign. Therefore the practical question becomes "is the integrity check on the *signature block* (spoofable) or on *entry bytes* (not spoofable without exact-byte patching)".
- **Native patch candidates (ONLY if file-integrity confirmed)**: locate `ApkAbort`/mtcj-crc verifier in `libtersafe.so`, find the abort branch, produce exact entry/offset/original-bytes patch via `tools/Build-WzryNativePatch.ps1`. Requires first capturing the call site — currently impossible because the SIGKILL is emitted by JIT-translated ARM code bypassing libc `kill`/`tgkill` and the process dies before the write-hook pattern fires (kill-trace a–d only reached `hook-attached`, 14–27 lines).
- **PM-signature spoof path (if signature confirmed)**: write a minimal LSPosed/Zygisk module hooking `PackageManagerService`/`getPackageInfo`→`signingInfo`/`signatures` for `sgame` to return the original Tencent cert `e8685274…`. Cheaper than native patching but only covers the JNI/`getEncryptAPKSignatureNative` surface, not `libtersafe` file CRC.

## Recommendation

- Treat **repack/file-integrity (`libtersafe` `apk_path`+`mtcj_*_crc`)** as the primary suspect and the debug signature as secondary. The cleanest single next step is `E-A′` (uninstall → install orig+debug-cert) which definitively splits signature from content — but it requires wiping the app's data and an online device.
- The device went `offline` (adbd hung) after ~291 MB of a 977 MB method0 push; no further experiments were run. All `.100`/`.101`/`192.168.5.3`/`192.168.5.6` devices belong to other projects and were not touched.

## Evidence pointers

- `workspace/observations/lifetime/A-orig-resign-20261124-204240.jsonl` — full run log (install-failed → launched → survived 130 s).
- `workspace/observations/lifetime/A-orig-resign-20261124-204240-logcat.txt` — logcat around the window.
- `tools/Run-ApkLifetimeMatrix.ps1` — reusable push+pm-install+watch+kill-evidence runner (now uses device-side `pm install`, avoids the adb-streaming stall).
- apksigner digests recorded inline above; entry diff in `workspace/apk/store_layout_diff.json`.
