function Initialize-MultiCodexProcessSnapshot {
    if (-not ('MultiCodex.ProcessSnapshot' -as [type])) {
        [Console]::Error.WriteLine('MULTICODEX_STAGE=compile-process-reader')
        Add-Type -Path (Join-Path $PSScriptRoot 'ProcessSnapshot.cs')
    }
}
function Get-MultiCodexProcessSnapshot {
    Initialize-MultiCodexProcessSnapshot
    [Console]::Error.WriteLine('MULTICODEX_STAGE=process-snapshot')
    [MultiCodex.ProcessSnapshot]::Read()
}
function Get-MultiCodexDesktopRoots {
    param([object[]]$Processes, [string]$ExpectedPath)
    $taskById = @{}
    foreach ($taskRow in $Processes) { $taskById[[uint32]$taskRow.ProcessId] = $taskRow }
    @($Processes | Where-Object {
        $taskParent = $taskById[[uint32]$_.ParentProcessId]
        $_.ExecutablePath -and
        $(if ($ExpectedPath) { $_.ExecutablePath -eq $ExpectedPath } else { $_.ExecutablePath -match '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(ChatGPT|Codex)\.exe$' }) -and
        (-not $taskParent -or $taskParent.ExecutablePath -ne $_.ExecutablePath)
    })
}
