function Get-MultiCodexDesktopProcesses {
    param([string]$ExpectedPath)
    @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' OR Name='Codex.exe'" -OperationTimeoutSec 8 | Where-Object {
        $_.ExecutablePath -eq $ExpectedPath -and $_.CommandLine -notmatch ' --type=' -and
        (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue)
    })
}

function Stop-MultiCodexDesktop {
    param(
        [string]$ExpectedPath,
        [double]$GraceSeconds = 6,
        [double]$ForceSeconds = 18,
        [int]$QuietMilliseconds = 1000,
        [scriptblock]$FindProcesses = { param($p) Get-MultiCodexDesktopProcesses $p },
        [scriptblock]$RequestClose = {
            param($p)
            $taskWindowProcess = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
            if ($taskWindowProcess -and $taskWindowProcess.MainWindowHandle -ne [IntPtr]::Zero) {
                $null = [MultiCodex.WindowCloser]::PostMessage($taskWindowProcess.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
            }
        },
        [scriptblock]$Terminate = {
            param($p, $expected)
            # Revalidate immediately before termination. Never kill a process tree.
            $taskVerified = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ProcessId)" -OperationTimeoutSec 8
            if ($taskVerified -and $taskVerified.ExecutablePath -eq $expected -and $taskVerified.CommandLine -notmatch ' --type=') {
                $taskLiveProcess = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
                if ($taskLiveProcess -and -not $taskLiveProcess.HasExited) {
                    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
                    $null = $taskLiveProcess.WaitForExit(3000)
                }
            }
        },
        [scriptblock]$Pause = { Start-Sleep -Milliseconds 200 }
    )
    $taskInitial = @(& $FindProcesses $ExpectedPath)
    foreach ($taskItem in $taskInitial) { & $RequestClose $taskItem }
    $taskGrace = [Diagnostics.Stopwatch]::StartNew()
    while ($taskGrace.Elapsed.TotalSeconds -lt $GraceSeconds) {
        if (@(& $FindProcesses $ExpectedPath).Count -eq 0) { break }
        & $Pause
    }
    $taskForce = [Diagnostics.Stopwatch]::StartNew()
    $taskEmptySince = $null
    $taskRemaining = @()
    while ($taskForce.Elapsed.TotalSeconds -lt $ForceSeconds) {
        # Refresh the list: Windows activation can replace the original PID.
        $taskRemaining = @(& $FindProcesses $ExpectedPath)
        if ($taskRemaining.Count -eq 0) {
            if ($null -eq $taskEmptySince) { $taskEmptySince = $taskForce.Elapsed.TotalMilliseconds }
            if ($taskForce.Elapsed.TotalMilliseconds - $taskEmptySince -ge $QuietMilliseconds) { return }
        } else {
            $taskEmptySince = $null
            foreach ($taskItem in $taskRemaining) { & $Terminate $taskItem $ExpectedPath }
        }
        & $Pause
    }
    $taskIds = ($taskRemaining | ForEach-Object { $_.ProcessId }) -join ', '
    throw "Codex non ha terminato la chiusura entro il tempo previsto (processi: $taskIds)."
}
