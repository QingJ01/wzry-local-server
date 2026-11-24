# Dynamic capture session — 2026-11-24

## Scope

This session only used device `192.168.5.102:5555` and package `com.tencent.tmgp.sgame`. The socket observer used the existing rooted-device `/proc` read path. No Frida injection, device configuration change, purchase, login mutation, or battle action was performed.

## Evidence

Raw evidence is intentionally excluded from Git by `.gitignore` and remains under `workspace/observations/`:

- `workspace/observations/manifest-20261124-152421.json` and its eight companion files record a 60-second cold-start observation.
- `workspace/observations/process-sockets/00-cold-start-lifecycle.json` shows PID `53389` alive from the first sample at 0.76 seconds through the final sample at 29.44 seconds.
- `workspace/observations/process-sockets/00-cold-start-logcat.txt` records a monkey launch for `com.tencent.xfight`, not the target package, and the target activity being moved to the background.
- `workspace/observations/process-sockets/current-manifest-20261124-154213.json` records a non-root short snapshot while PID `53389` was alive.
- `workspace/observations/process-sockets/current-proc-net-tcp-20261124-154213.txt` and `current-proc-net-tcp6-20261124-154213.txt` record global socket tables.
- `workspace/observations/process-sockets/current-ss-20261124-154213.txt` records established HTTPS sockets but lacks per-process inode ownership.
- `workspace/observations/ui/current-20261124-154213.png` shows the foreground `com.tencent.xfight` privacy-policy dialog, not the target game UI.
- `workspace/observations/ui/01-cold-start.png` is a valid PNG captured during an earlier target cold start.
- `workspace/observations/ui/02-post-failed-launch.png` is zero bytes because its `adb exec-out screencap` invocation was interrupted; the shell created/truncated the redirect target before output arrived.

## Findings

- A live UI dump located the first-screen “同意” button at bounds `[990,685][1148,738]`. Tapping `(1069,711)` advanced the same PID to the “权限列表” screen without a crash, login, purchase, or battle action.
- PID 17193 / UID 10061 stayed in the foreground from cold start at 19:34:32.199 until an external process (PID 4076) issued a force-stop at 19:35:13.044. This is a 40.85-second stable window, after which the game was relaunched and immediately hit a Houdini-backed native `SIGSEGV` in PID 17458.
- During the stable window, the patched client sent 36 `GET /game/events?after=0&epoch=1` requests (0.881 requests/second, median interval 1125 ms). The newly added local-session route can authorize a default account, but this installed APK does not carry the token, so all 36 requests returned 401. No post-consent protocol change can be inferred from this evidence.
- The 19:35:04 root-backed snapshot attributed 13 socket fds to PID 17193. One target-owned established connection matched UID 10061 and socket inode 1160014 to 113.201.9.14:443 (`tcp6`). This is control-plane HTTPS ownership only, not a game gateway or frame protocol result.
- Logcat records `Force stopping com.tencent.tmgp.sgame ... from pid 4076`, followed by `SIGKILL` for PID 17193, an automatic relaunch, and native `SIGSEGV` in replacement PID 17458. A separate `uiautomator` process also crashed; that crash belongs to the test tool, not the game.
- The failed lifecycle sampler wrote `post-consent-20261124-lifecycle.json` after the target was dead and therefore contains only launcher/null-PID samples. Use the logcat timestamps above as the authoritative lifecycle evidence. Do not reuse PowerShell's reserved `$PID` variable for the target process ID.

## Evidence for this update

- `workspace/observations/first-screen-live-20261124-ui.xml` and `workspace/observations/ui/first-screen-live-20261124.png`: first-screen policy dialog and button bounds.
- `workspace/observations/post-consent-20261124-ui.xml` and `workspace/observations/ui/post-consent-20261124.png`: permissions screen reached after the consent click.
- `workspace/observations/process-sockets/post-consent-20261124.json`: PID 17193 / UID 10061 fd and inode snapshot.
- `workspace/observations/post-consent-20261124-http-observations.json`: 218 recorded event requests in the service session; 36 fall within the stable foreground window.
- `workspace/observations/post-consent-20261124-logcat.txt` and `workspace/observations/post-consent-20261124-logcat-epoch.txt`: launch, consent transition, force-stop, `SIGKILL`, relaunch, and native crash timeline.

- The target process can start and stay alive for at least 29.44 seconds, but an unrelated `com.tencent.xfight` activity became the foreground window. The target remained a background process during the snapshot.
- The current global snapshot contains established HTTPS connections to `101.71.7.63`, `113.201.9.14`, `101.71.7.71`, and `42.186.47.187`. These are not attributed to the target because no root-based `/proc/<pid>/fd` inode mapping was permitted in this session.
- No target-owned socket endpoint is proven. No frame, boundary, direction, command ID, encryption, account, battle, or shop protocol conclusion may be drawn from this evidence.
- The 60-second launch before the lifecycle run ended with a native `SIGKILL` through the Houdini bridge. Earlier launches also exited without a Java crash. This is negative evidence, not a stable reproducible lifecycle result.
- `monkey -p com.tencent.tmgp.sgame` is not reliable on this device: the later lifecycle log shows monkey resolving and launching `com.tencent.xfight`. Use the explicit `com.tencent.tmgp.sgame/.SGameActivity` intent and verify the foreground component before each socket sample.

## Next safe step

Have the operator manually close the unrelated policy dialog, bring the target activity to the foreground, and hold the target screen visible. Then run a single read-only PID/UID/inode socket capture with root explicitly permitted by the main thread. Only if that proves socket ownership should protocol hooking or payload correlation be considered.
