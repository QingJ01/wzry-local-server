# Non-patch stabilization audit — Houdini self-SIGKILL (device 192.168.5.101:5555)

**Date:** 2026-11-24
**Task:** `/root/emulator_detection_auditor` — enumerate every *non-patch* lever that could let `com.tencent.tmgp.sgame` survive the ~60 s in-process `SIGKILL`, ranked by confidence and reversibility. **No device or APK was modified** — this is a read-only audit.

## What is actually killing the game (recap, evidence-locked)

- Mechanism: a worker thread **inside the game pid** issues `kill(<self-pid>, 9)`; logcat shows `houdini [<tid>] [SIGKILL] kill: pid = <game>, tid = <worker>, signo = 9`. `xg_vip_service` child dies ~1 s earlier — the checker kills the whole process group.
- It is **not** signature/repack (B0 Tencent-signed, zero-change APK dies identically), **not** frida (E1: killed with frida fully dead), **not** an external `am force-stop` (AccServiceManager is passive, `hasAccSuccess=false`), **not** Zygisk root-mount visibility (E2: `denylist_enforce=2`/just_umount already max, `sgame` has no root grant, `/proc/<pid>/mounts` shows 0 root/module traces).
- What remains, and cannot be hidden by any denylist/umount: **the Houdini ARM→x86 translation surface itself**, in-process and unmaskable.

## Detection surface visible to the game (live read on .101)

| Surface | Value | Reachable by non-patch hide? |
| --- | --- | --- |
| `/system/lib64/libhoudini.so` (+`libnb.so`, `libnbaio.so`, `libnblog.so`, `libtcb.so`, `houdini/` dir) | present, mapped into every arm64 process | **No** — required for the game to execute at all |
| `ro.dalvik.vm.isa.arm64` | `x86_64` (arm64 is emulated) | partial — see E-prop |
| `ro.dalvik.vm.native.bridge` | `libnb.so` | partial — see E-prop |
| `ro.build.hv.platform` | `vbox` | partial — see E-prop |
| `qemu.hw.mainkeys` | `1` | partial — see E-prop |
| `ro.product.cpu.abilist` / `abilist64` | `x86_64,arm64-v8a,x86` / `x86_64,arm64-v8a` | **No** — changing it breaks arm64 loading entirely |
| `init.svc.nemu*` daemons | `nemu_sys_opt`, `nemufreepfn`, `nemuhotd`, `nemuinit`, `nemuinput` all `running` | risky — killing them destabilizes the emulator |
| `ro.product.model/device` | `24031PN0DC` / `manet` (Xiaomi spoof already applied) | already spoofed — not the trigger |
| `ro.product.brand/manufacturer` | `Xiaomi` | already spoofed |
| `ro.build.fingerprint` | `Xiaomi/manet/manet:15/.../release-keys` | already spoofed |
| `ro.zygote` | `zygote64_32` | fixed |
| `ro.debuggable` / `ro.secure` | `0` / `1` | already correct |

Net: the fingerprint layer (model/brand/fingerprint) is *already* convincingly spoofed to a Xiaomi `manet`. What remains detectable is the **translation/runtime layer** — which is intrinsic, not a configurable property.

## Reversible experiment matrix (ranked)

Ordered by expected value. Every entry is independently reversible. Measure = cold-start `sgame`, poll pid + `houdini [SIGKILL]` line, target foreground survival **> 180 s**.

### E-prop — property masking for the game process only (medium confidence, fully reversible)

The game's check likely reads `ro.dalvik.vm.isa.arm64`, `ro.dalvik.vm.native.bridge`, `ro.build.hv.platform`, `qemu.hw.mainkeys` via `__system_property_get`. These are read from `libc`'s property area — spoofable **per-process** by an LSPosed/Zygisk module that intercepts `SystemProperties.native_get` / `__system_property_get` for the `sgame` process only.

- Lever: LSPosed module (already installed, `lspd` active) scoped to `sgame`, returning `arm64`/`arm` for `isa.arm64`, empty for `native.bridge`, `""`/goldfish-free for `hv.platform`/`qemu.hw.mainkeys`.
- Revert: disable the module scope; props only spoofed in-process, nothing persists.
- Confidence: **medium** — covers the property-read path but NOT the in-process `libhoudini.so`/`libnb.so` maps presence, which the checker can also read directly from `/proc/self/maps`.
- Effort: write + install one LSPosed module; no APK/system change.

### E-maps — hide `libhoudini`/`libnb` from `/proc/self/maps` (medium-high, reversible)

If the checker scans its own maps for `houdini`/`libnb`, an LSPosed/Zygisk module can intercept the read path (`fopen("/proc/self/maps")`, `read`, or `dl_iterate_phdr`/`getline`) and filter those lines. This is standard HMA-style maps-hide, applied to `sgame` only.

- Revert: disable module.
- Confidence: **medium-high** — attacks the strongest in-process tell; but if the check also reads the loaded-ELF list via `dl_iterate_phdr`/`link_map` (not the maps file), text-filtering maps is insufficient.
- Combined E-prop + E-maps is the realistic non-patch ceiling.

### E-kernel — Zygisk/kernel intercept of the self-`kill` syscall (high reliability if it fires, reversible)

Since E3 proved userspace `Interceptor` can't see the JIT-emitted syscall, the robust non-patch fix is a **Zygisk module or kernel-level hook** that, for the `sgame` uid only, swallows `kill/tgkill(pid==self|sig==9)` and `exit_group`. KernelSU is present (`ksud`), so a kpm/LKM hook is an option; a Zygisk interceptor on the raw `syscall`/`tgkill` gate is the lighter path.

- Revert: disable module / unload kpm.
- Confidence: **high** that it can block the signal, **medium** that it doesn't just convert the death into an `abort`/`exit` path — the checker may try several teardown syscalls. Must intercept the syscall gate, not libc.
- Risk: touching the syscall gate for self-kill could also block legitimate exits; scope strictly to `sgame` + signo 9.

### E-nemudaemon — stop the `nemu*` system daemons (low confidence, risky)

`init.svc.nemu_sys_opt/nemufreepfn/nemuhotd/nemuinit/nemuinput` are always `running`. Stopping them reduces detection surface but also removes emulator services the game may need (input, GPS, sysopt). Reversible via `setprop ctl.start`, but can crash the session.

- Confidence: **low** — the kill is in-process guest code, not a nemu daemon action; these are unlikely to be the trigger the checker reads.
- Not recommended before E-prop/E-maps/E-kernel.

### E-x86-only — force the game onto the native x86 path (rejected)

The APK only has `arm64-v8a`/`armeabi-v7a` libs (confirmed); there is **no x86 native lib to load**. Not viable without injecting x86 stubs. Listed for completeness.

## Recommended order (non-patch)

1. **E-prop + E-maps together** as one LSPosed module scoped to `sgame` — the realistic ceiling of hiding. Reversible, zero APK change.
2. **E-kernel** self-syscall swallow if (1) fails — highest reliability, slightly more invasive.
3. E-nemudaemon only as a diagnostic datapoint, last.

## Validation method (> 180 s)

For each experiment: revert to clean state → `am start -W com.tencent.tmgp.sgame/.SGameActivity` → poll `pidof`/logcat every 5 s for ≥ 200 s → assert (a) no `houdini [SIGKILL] kill: pid=<self>`, (b) no `Process ... has died: fg TOP`, (c) process stays foreground. Record `workspace/experiments/<tag>-<ts>.jsonl` + logcat. One variable per run; never stack two changes.

## Honest assessment

All non-patch levers operate on *detection surfaces* (props, maps, the self-kill syscall). They can likely get the client past the ~60 s window, but none of them proves the check is fully neutralized — the checker may escalate to a different teardown syscall or a later re-check. The **durable** fix remains client-side (neutralize the check), but the E-prop+E-maps Zygisk module is the cheapest reversible path to buy the > 180 s window needed to reach login/lobby for protocol capture.

## Evidence pointers

- Props/maps/daemon reads: this audit, `.101`, 2026-11-24 ~21:39.
- Kill signature: `workspace/experiments/r1-method0-20261124.jsonl` + logcat (`houdini [6029] [SIGKILL] kill: pid=5983, signo=9` at ~63 s).
- Prior elimination of frida/root/sig/external: `reports/kill_tracer_e3_20261124.md`, `reports/signature_integrity_verdict.md`, `reports/runtime_stability_20261124.md`.
