param([switch]$NoWindow)
$ErrorActionPreference = 'Stop'
try {
    $taskRoot = $PSScriptRoot
    $taskData = Join-Path $env:LOCALAPPDATA 'MultiCodex'
    $taskRuntimeFile = Join-Path $taskData 'runtime.json'
    function Get-HubRuntime {
        if (-not (Test-Path -LiteralPath $taskRuntimeFile)) { return $null }
        try {
            $taskRuntime = Get-Content -LiteralPath $taskRuntimeFile -Raw | ConvertFrom-Json
            if ($taskRuntime.port -lt 1 -or $taskRuntime.port -gt 65535 -or $taskRuntime.token -notmatch '^[a-f0-9]{64}$') { return $null }
            $taskHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$($taskRuntime.port)/api/health" -Headers @{Authorization="Bearer $($taskRuntime.token)"} -TimeoutSec 2
            if ($taskHealth.app -eq 'MultiCodex' -and $taskHealth.pid -eq $taskRuntime.pid) { return $taskRuntime }
        } catch { return $null }
        return $null
    }
    $taskRuntime = Get-HubRuntime
    if (-not $taskRuntime) {
        $taskNode = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        if (-not $taskNode) {
            foreach ($taskCandidate in @(
                (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'),
                (Join-Path $env:ProgramFiles 'nodejs\node.exe')
            )) { if (Test-Path -LiteralPath $taskCandidate) { $taskNode=$taskCandidate; break } }
        }
        if (-not $taskNode) { throw 'Node.js non trovato. Installa Node.js 22 o successivo, poi riapri MultiCodex.' }
        # Launch through the Windows scheduler, not as a child of Codex or its job object.
        & (Join-Path $taskRoot 'scripts\Start-HubTask.ps1') -NodePath $taskNode
        $taskDeadline = [DateTime]::UtcNow.AddSeconds(45)
        do {
            Start-Sleep -Milliseconds 400
            $taskRuntime = Get-HubRuntime
        } while (-not $taskRuntime -and [DateTime]::UtcNow -lt $taskDeadline)
        if (-not $taskRuntime) {
            $taskErrorFile = Join-Path $taskData 'startup-error.txt'
            if (Test-Path -LiteralPath $taskErrorFile) { throw (Get-Content -LiteralPath $taskErrorFile -Raw) }
            throw 'Avvio non riuscito. Apri un terminale nella cartella MultiCodex ed esegui: node src/server.mjs'
        }
    }
    if ($NoWindow) { Write-Output 'MultiCodex avviato.'; exit 0 }
    $taskUrl = "http://127.0.0.1:$($taskRuntime.port)/#token=$($taskRuntime.token)"
    $taskBrowser = $null
    foreach ($taskCandidate in @(
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )) { if (Test-Path -LiteralPath $taskCandidate) { $taskBrowser=$taskCandidate; break } }
    if (-not $taskBrowser) { throw 'Edge o Chrome non trovato. Installa uno dei due browser e riprova.' }
    $taskProfile = Join-Path $taskData 'hub-browser'
    # Visible interactive application window, with a dedicated profile.
    Start-Process -FilePath $taskBrowser -ArgumentList ('--user-data-dir="' + $taskProfile + '" --no-first-run --app="' + $taskUrl + '" --window-size=1420,960')
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'MultiCodex', 'OK', 'Error') | Out-Null
    exit 1
}
