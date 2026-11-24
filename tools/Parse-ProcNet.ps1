param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [string]$Package = 'com.tencent.tmgp.sgame'
)

$ErrorActionPreference = 'Stop'
$lines = Get-Content -LiteralPath $Path
$rows = @()
foreach ($line in $lines | Select-Object -Skip 1) {
    $columns = ($line -split '\s+') | Where-Object { $_ -ne '' }
    if ($columns.Count -lt 4) { continue }
    $localParts = [regex]::Match($columns[1], '^([^:]+):([0-9A-Fa-f]+)$').Groups
    $remoteParts = [regex]::Match($columns[2], '^([^:]+):([0-9A-Fa-f]+)$').Groups
    if ($localParts.Count -lt 3 -or $remoteParts.Count -lt 3) {
        continue
    }
    $rows += [pscustomobject]@{
        State = switch ($columns[3]) {
            '01' { 'ESTABLISHED' }
            '02' { 'SYN_SENT' }
            '03' { 'SYN_RECV' }
            '04' { 'FIN_WAIT1' }
            '05' { 'FIN_WAIT2' }
            '06' { 'TIME_WAIT' }
            '07' { 'CLOSE' }
            '08' { 'CLOSE_WAIT' }
            default { $columns[3] }
        }
        LocalAddress = '{0}:{1}' -f ($localParts[1].Value -replace '^(.{2})(?=.)', '$0:'), [Convert]::ToUInt64($localParts[2].Value, 16)
        RemoteAddress = '{0}:{1}' -f ($remoteParts[1].Value -replace '^(.{2})(?=.)', '$0:'), [Convert]::ToUInt64($remoteParts[2].Value, 16)
        UID = [Convert]::ToInt64($columns[7], 16)
        Inode = $columns[9]
    }
}

$rows | Sort-Object State, RemoteAddress | Format-Table -AutoSize
Write-Host "Rows: $($rows.Count)"
Write-Host "Correlate Inode values with /proc/<PID>/fd in a root shell to isolate $Package sockets."
