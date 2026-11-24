<#
.SYNOPSIS
  Static verification for the kill-path tracer tooling (no device required).
.DESCRIPTION
  Confirms that tools/frida/wzry-kill-trace.js exists, loads as valid JavaScript,
  registers the expected termination + Houdini-kill-log hooks, and that
  run-kill-trace.mjs uses the attach (not spawn) path and targets the correct
  package/serial. Pure static checks; produces no device traffic.
#>
[CmdletBinding()] param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath | Split-Path -Parent
$script = Join-Path $root 'tools\frida\wzry-kill-trace.js'
$runner = Join-Path $root 'tools\frida\run-kill-trace.mjs'

$results = [ordered]@{}
$js = Get-Content -LiteralPath $script -Raw
$runnerSrc = Get-Content -LiteralPath $runner -Raw

$results['tracer-exists'] = (Test-Path -LiteralPath $script) -and $js.Length -gt 1000

# termination hooks
foreach ($sym in 'kill','raise','pthread_kill','tgkill','abort','exit','_exit','_Exit','quick_exit','sigqueue') {
    $results["hook-$sym"] = $js -match "'$sym'"
}
# write-family + android-log detection of the houdini kill log
foreach ($sym in 'write','writev','pwrite64','send','fputs','fwrite','__android_log_print','__android_log_vprint','__android_log_write','__android_log_buf_write') {
    $results["hook-$sym"] = $js -match "'$sym'"
}
$results['kill-format-regex'] = $js -match 'kill: pid|signo = 9|SIGKILL'
# thread tracking (to correlate the houdini [tid] kill worker to its creator)
$results['hook-pthread_create'] = $js -match 'pthread_create'
$results['hook-clone'] = $js -match 'clone'
# syscall-number filter for kill/tkill/tgkill/exit/exit_group
$results['syscall-filter'] = $js -match '62' -and $js -match '200' -and $js -match '234' -and $js -match '231'
# backtrace + caller resolution
$results['backtrace'] = $js -match 'Thread\.backtrace' -and $js -match 'DebugSymbol\.fromAddress' -and $js -match 'findModuleByAddress'
# must NOT use Stalker (it froze the target in run e3)
$jsCodeOnly = ($js -split "`n" | Where-Object { $_ -notmatch 'Stalker' -or $_ -match 'hookExport|Stalker\.follow' }) -join "`n"
$results['no-stalker'] = -not ($jsCodeOnly -match 'Stalker\.follow\(')

# runner: attach-mode only, correct package/serial
$results['runner-attach'] = $runnerSrc -match 'device\.attach\(' -and $runnerSrc -match 'attachMode: true'
$results['runner-nospawn'] = -not ($runnerSrc -match 'device\.spawn\(')
$results['runner-package'] = $runnerSrc -match 'com\.tencent\.tmgp\.sgame'
$results['runner-serial']  = $runnerSrc -match '192\.168\.5\.102:5555'
$results['runner-activity'] = $runnerSrc -match 'SGameActivity'
$results['runner-detached-event'] = $runnerSrc -match 'session-detached'

$failed = $results.GetEnumerator() | Where-Object { -not $_.Value }
foreach ($k in $results.Keys) { Write-Output ("{0,-26} {1}" -f $k, $(if($results[$k]){'PASS'}else{'FAIL'})) }
if ($failed) { Write-Error ("{0} check(s) failed: {1}" -f $failed.Count, ($failed | ForEach-Object Name) -join ', '); exit 1 }
Write-Output "All $($results.Count) kill-trace checks passed."

