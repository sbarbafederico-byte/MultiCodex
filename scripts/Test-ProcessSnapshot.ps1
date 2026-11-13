$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'process-snapshot.ps1')
$taskRows = @(Get-MultiCodexProcessSnapshot)
$taskSelf = $taskRows | Where-Object { $_.ProcessId -eq $PID }
if (-not $taskSelf -or $taskSelf.Name -notmatch 'powershell|pwsh') { throw 'Snapshot dei processi non valido.' }
$taskSelfPath = [MultiCodex.ProcessSnapshot]::ImagePath([uint32]$PID)
if (-not $taskSelfPath -or -not (Test-Path -LiteralPath $taskSelfPath)) { throw 'Percorso eseguibile non valido.' }
$taskPath = 'C:\Program Files\WindowsApps\OpenAI.Codex_test_x64__test\app\ChatGPT.exe'
$taskFakeRows = @(
    [PSCustomObject]@{ProcessId=10;ParentProcessId=1;Name='ChatGPT.exe';ExecutablePath=$taskPath},
    [PSCustomObject]@{ProcessId=11;ParentProcessId=10;Name='ChatGPT.exe';ExecutablePath=$taskPath},
    [PSCustomObject]@{ProcessId=12;ParentProcessId=11;Name='ChatGPT.exe';ExecutablePath=$taskPath},
    [PSCustomObject]@{ProcessId=20;ParentProcessId=1;Name='ChatGPT.exe';ExecutablePath='C:\other\ChatGPT.exe'}
)
$taskRoots = @(Get-MultiCodexDesktopRoots -Processes $taskFakeRows)
if ($taskRoots.Count -ne 1 -or $taskRoots[0].ProcessId -ne 10) { throw 'Il rilevamento include renderer o app estranee.' }
if (@(Get-MultiCodexDesktopRoots -Processes $taskFakeRows -ExpectedPath 'C:\missing\app.exe').Count -ne 0) { throw 'Il filtro per percorso non viene rispettato.' }
Write-Output 'Snapshot nativo verificato: PID, percorso, parentela e processi desktop.'
