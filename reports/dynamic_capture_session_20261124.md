# Dynamic capture session — 2026-11-24

## Scope

This session only used device `192.168.5.102:5555` and package `com.tencent.tmgp.sgame`. No `su`/root command, Frida injection, device configuration change, purchase, login mutation, or battle action was performed.

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

- The target process can start and stay alive for at least 29.44 seconds, but an unrelated `com.tencent.xfight` activity became the foreground window. The target remained a background process during the snapshot.
- The current global snapshot contains established HTTPS connections to `101.71.7.63`, `113.201.9.14`, `101.71.7.71`, and `42.186.47.187`. These are not attributed to the target because no root-based `/proc/<pid>/fd` inode mapping was permitted in this session.
- No target-owned socket endpoint is proven. No frame, boundary, direction, command ID, encryption, account, battle, or shop protocol conclusion may be drawn from this evidence.
- The 60-second launch before the lifecycle run ended with a native `SIGKILL` through the Houdini bridge. Earlier launches also exited without a Java crash. This is negative evidence, not a stable reproducible lifecycle result.
- `monkey -p com.tencent.tmgp.sgame` is not reliable on this device: the later lifecycle log shows monkey resolving and launching `com.tencent.xfight`. Use the explicit `com.tencent.tmgp.sgame/.SGameActivity` intent and verify the foreground component before each socket sample.

## Next safe step

Have the operator manually close the unrelated policy dialog, bring the target activity to the foreground, and hold the target screen visible. Then run a single read-only PID/UID/inode socket capture with root explicitly permitted by the main thread. Only if that proves socket ownership should protocol hooking or payload correlation be considered.
