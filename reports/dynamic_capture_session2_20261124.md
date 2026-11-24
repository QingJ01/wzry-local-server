# Dynamic capture session 2 — 2026-11-24 (post-session-bind)

## Scope

Read-only UI progression on device `192.168.5.102:5555` for package `com.tencent.tmgp.sgame` after `runtime_and_stability` brought the Rust service up and bound `POST /local/session`. No login input, purchase, battle, or Frida change was performed. Stopped as soon as the client process died, per the task boundary.

## Runtime precondition evidence

- Rust service listened on `127.0.0.1:19620` and `127.0.0.1:19621` (PID 34740) before launch.
- `POST /accounts/register {"username":"local_debug"}` returned `accountId=3`; `POST /local/session {"accountId":3}` returned `localToken=local-3-4` and set the default loopback account.
- With that binding, `GET /game/events?after=0&epoch=1` from loopback returns HTTP 200 (`{"epoch":1,"events":[],"messages":[],"resetRequired":false,"room":null}`) without a client token.

## Timeline (all times Asia/Shanghai)

| Time | Phase | Evidence |
| --- | --- | --- |
| 19:51:18 | Cold start via explicit intent `am start -W -n com.tencent.tmgp.sgame/.SGameActivity` (COLD, 564 ms). PID 20314, foreground. | `workspace/observations/ui/session2-01-coldstart.png`, `session2-01-coldstart-ui.xml` |
| 19:51:18 | First screen again shows “腾讯游戏用户协议和隐私政策” with “同意” at `[990,685][1148,738]` — prior consent did not persist across last run's force-stop. | same as above |
| 19:51:1x | PID 20314 / UID 10061 fd snapshot: 13 socket fds; one process-owned tcp6 ESTABLISHED socket inode `1196769` to `116.77.172.88:443`. | `process-sockets/s2-01-pid20314-fd.txt`, `s2-01-endpoints.txt` |
| ~19:51:2x | Tapped 同意 (1069,711); UI advanced to 权限列表 (permissions: 定位/存储/日历/麦克风/相机), “确定” at `[888,715][1030,768]`. | `ui/session2-02-postconsent.png`, `session2-02-postconsent-ui.xml` |
| ~19:51:30 | Tapped 确定 (959,741). | logcat `s2-02-postconfirm-logcat.txt` |
| 19:51:31.577 | Shell-side `Shutdown thread` PID 20568 (UID 2000, not the app) crashes SIGSEGV → `tombstone_17`. | logcat lines 252-282 |
| 19:51:39.518 | `houdini [20342] [SIGKILL] kill: pid = 20314` — game killed in foreground (`has died: fg TOP`), focus falls back to `app.lawnchair` launcher. No `Force stopping` line this run; no Java FATAL exception. | logcat lines 289-303 |
| 19:51:40.062 | `AccServiceManager.onAppClose: com.tencent.tmgp.sgame` (emulator accelerator hook notices the death). | logcat line 443 |

## Findings

- The 同意 → 权限列表 → 确定 click chain is repeatable on the method0 APK. Progress reached the same permissions screen as session 1.
- Death is now better characterized: this run shows `houdini` issuing `SIGKILL` to the game ~9 s after the permission confirm (~21 s after cold start), not the external `Force stopping ... from pid 4076` path seen previously. The 20568 `Shutdown thread` SIGSEGV is a shell/UID-2000 artifact, separate from the game death.
- `/debug/observations` recorded 179 HTTP observations in the session window: 147 `401` `GET /game/events` polls (continuing through 19:52:03, so the poll loop persists independently of the patched consent path), and a burst of `501` frame-channel observations at 19:52:00-19:52:01 including `methodId=4375`, `methodId=184357`, `methodId=184355`, `methodId=186201`. These 501s are server-side "not implemented" responses, not recovered protocol semantics — do not treat them as command IDs.
- No `200` event-poll response was attributed to the client APK during this run; all observed 200s belong to this operator's own loopback checks.

## Evidence files

- `workspace/observations/ui/session2-01-coldstart.png`, `ui/session2-02-postconsent.png`, `ui/session2-03-after-death.png`
- `workspace/observations/session2-01-coldstart-ui.xml`, `session2-02-postconsent-ui.xml`
- `workspace/observations/process-sockets/s2-01-pid20314-fd.txt`, `s2-01-inodes.txt`, `s2-01-endpoints.txt`, `s2-01-tcp6.txt`
- `workspace/observations/s2-02-postconfirm-logcat.txt`
- `workspace/observations/s2-http-observations.json`

## Next safe step

Before further UI progression, stabilize cold start: identify what triggers the Houdini `SIGKILL` ~9-20 s after the permissions confirm (it fired before any login prompt). Consider whether the kernel-level `su` presence, the frida-server process on loopback:27042, or the emulator's `AccServiceManager` hook correlates with the kill window. Only after a post-permissions screen survives >60 s should the login/lobby progression resume.
