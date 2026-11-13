$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'desktop-process.ps1')

# A replacement process must be discovered and stopped as well as the old PID.
$script:taskFakePid = 101
$script:taskKilled = @()
Stop-MultiCodexDesktop -ExpectedPath 'test-path' -GraceSeconds 0 -QuietMilliseconds 0 -ForceSeconds 1 -Pause {} -RequestClose {} -FindProcesses {
    param($p)
    if ($script:taskFakePid) { [PSCustomObject]@{ProcessId=$script:taskFakePid} }
} -Terminate {
    param($p, $expected)
    $script:taskKilled += $p.ProcessId
    if ($p.ProcessId -eq 101) { $script:taskFakePid = 102 } else { $script:taskFakePid = 0 }
}
if (($script:taskKilled -join ',') -ne '101,102') { throw 'Il processo sostitutivo non viene chiuso.' }

# A short empty interval is not enough: activation may start another PID.
$script:taskGapPhase = 0
$script:taskGapKills = @()
Stop-MultiCodexDesktop -ExpectedPath 'test-path' -GraceSeconds 0 -QuietMilliseconds 20 -ForceSeconds 2 -Pause { Start-Sleep -Milliseconds 5 } -RequestClose {} -FindProcesses {
    param($p)
    switch ($script:taskGapPhase) {
        0 { [PSCustomObject]@{ProcessId=201} }
        1 { $script:taskGapPhase = 2 }
        2 { [PSCustomObject]@{ProcessId=202} }
    }
} -Terminate {
    param($p, $expected)
    $script:taskGapKills += $p.ProcessId
    if ($p.ProcessId -eq 201) { $script:taskGapPhase = 1 } else { $script:taskGapPhase = 3 }
}
if (($script:taskGapKills -join ',') -ne '201,202') { throw 'La pausa fra i processi causa un falso successo.' }

# A process that survives termination must cause an error, never false success.
$taskRejected = $false
try {
    Stop-MultiCodexDesktop -ExpectedPath 'test-path' -GraceSeconds 0 -QuietMilliseconds 0 -ForceSeconds 0.05 -Pause {} -RequestClose {} -FindProcesses { [PSCustomObject]@{ProcessId=103} } -Terminate {}
} catch {
    if ($_.Exception.Message -notmatch 'processi: 103') { throw }
    $taskRejected = $true
}
if (-not $taskRejected) { throw 'Un processo ancora vivo viene dichiarato chiuso.' }

# Exercise the real Windows termination and wait against only our own helper.
$taskPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script:taskHelper = Start-Process -FilePath $taskPowerShell -ArgumentList '-NoProfile -NonInteractive -Command "[Threading.Thread]::Sleep(60000)"' -WindowStyle Hidden -PassThru
try {
    Stop-MultiCodexDesktop -ExpectedPath $taskPowerShell -GraceSeconds 0 -QuietMilliseconds 0 -ForceSeconds 10 -RequestClose {} -FindProcesses {
        param($expected)
        if (-not $script:taskHelper.HasExited) { [PSCustomObject]@{ProcessId=$script:taskHelper.Id} }
    }
    if (-not $script:taskHelper.WaitForExit(1000)) { throw 'Il processo di prova non termina.' }
} finally {
    if (-not $script:taskHelper.HasExited) { $script:taskHelper.Kill(); $null = $script:taskHelper.WaitForExit(3000) }
    $script:taskHelper.Dispose()
}
Write-Output 'Chiusura verificata: PID sostitutivo, errore persistente e processo Windows reale.'
