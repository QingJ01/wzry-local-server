# LSPosed hook — .101 实测通过 — 2026-11-24

任务 `/root/lsposed_hook_engineer` 收尾。设备 `192.168.5.101:5555`
（MuMu x86_64 + Houdini，Android 15，KernelSU + Zygisk Next + LSPosed）。
**结论：LSPosed 注入路径打通，`com.tencent.tmgp.sgame` 越过 ~60 s
自 SIGKILL 窗口，3 字节运行时 patch 生效。**

## 结果

- `handleLoadPackage` 在主进程与 `:xg_vip_service` 都触发。
- JNI payload 加载成功（fallback `/data/local/tmp/libwzry_houdini_selfkill_hook.so`）。
- `install result=true state=1` → `libhoudini.so+0x324eef`
  `bf ba 00` → `e9 bf 01`（jmp 0x3250b3，仅 signo==9 到达处）。
- 主进程稳定存活 >90 s，`logcat | grep SIGKILL` 无新 `houdini [SIGKILL]` 行。

## 关键坑（已修）

1. **`xposed_init` 必须放 `assets/`**。早期构建放根目录 → LSPosed 不识别模块。
2. **包名不能含 `_`**。`com.wzry.houdini_hook` 让 JNI 符号变成
   `Java_com_wzry_houdini_1hook_...`（下划线转义），找不到实现。改名
   `com.wzry.houdinihook` 后 `Java_com_wzry_houdinihook_NativeInstall_install`
   正常匹配。
3. **dex 不能含 `de.robv.*`**。`provided/` 仅编译期使用，`classes.jar`
   只打 `com\wzry\**`；`classesDir` 每次构建前清空，防旧包名 class 残留。
4. **lspd 模块列表缓存在启动时**。安装后必须 `reboot`（或重启 lspd），
   只 force-stop sgame 不会重新扫描模块。
5. **DB 启用方式**（manager 枚举不到包时）：
   `modules`/`modules_state(enabled=1)`/`scope` 三表都要插行。
6. **native 侧 `/proc/self/cmdline` 包名过滤失败**。hook 执行时进程还是
   `<pre-initialized>`，zygote 尚未 setproctitle。已移除该过滤——LSPosed
   Java 侧的 packageName 过滤足够。
7. **ProtectionDomain 为 null**。LSPosed 注入的 classloader 下
   `getCodeSource()` NPE；`resolveSoPath` 改为反射 `pathList.dexElements[].path`
   推导模块 lib 目录，失败则回退 `/data/local/tmp`。

## 复现流程

```powershell
# build
powershell -File .\lsposed_hook\Build-LsposedHookApk.ps1
# install + enable + reboot + launch
adb -s 192.168.5.101:5555 install -r .\lsposed_hook\build\wzry-lsposed-hook.apk
adb -s 192.168.5.101:5555 push .\lsposed_hook\build\native\libwzry_houdini_selfkill_hook.so /data/local/tmp/
# (insert modules/modules_state/scope rows, then reboot)
adb -s 192.168.5.101:5555 reboot
# verify
adb -s 192.168.5.101:5555 shell 'monkey -p com.tencent.tmgp.sgame -c android.intent.category.LAUNCHER 1'
adb -s 192.168.5.101:5555 shell 'logcat -d | grep wzry_hook'
```

## 当前 .101 状态

- 模块 `com.wzry.houdinihook` 安装并启用，scope = `com.tencent.tmgp.sgame`。
- `libhoudini.so` 原始 md5 未动（in-memory patch），`/system` 干净。
- Rust 后端 `19620/19621` 未重启（本任务范围外）。

## 下一步（交接 `protocol_capture`）

sgame 现在能撑过自杀窗口，可继续做带标签的动态捕获：
cold-start / login / lobby / shop / battle（参考 `capture_matrix.md`）。
Frida read/recv hook 的 inbound 采集修复仍待办。
