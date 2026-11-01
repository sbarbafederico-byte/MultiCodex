param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$taskData = Join-Path $env:LOCALAPPDATA 'MultiCodex'
$taskWorkspace = Split-Path $PSScriptRoot
try {
    $taskServer = Join-Path $taskWorkspace 'src\server.mjs'
    if (-not (Test-Path -LiteralPath $NodePath) -or -not (Test-Path -LiteralPath $taskServer)) { throw 'File di avvio MultiCodex non trovati.' }
    New-Item -ItemType Directory -Path $taskData -Force | Out-Null
    $env:MULTICODEX_HOST = 'windows-task'
    # These belong to the Codex tool invocation and must not leak into the independent host.
    foreach ($taskName in @('CODEX_HOME','CODEX_SQLITE_HOME','ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_EXTRA_CA_CERTS','OPENAI_API_KEY','CODEX_ACCESS_TOKEN','PSModulePath')) {
        Remove-Item -LiteralPath ('Env:' + $taskName) -ErrorAction SilentlyContinue
    }
    $taskOutput = Join-Path $taskData 'hub-output.log'
    $taskErrors = Join-Path $taskData 'hub-errors.log'
    $taskProcess = Start-Process -FilePath $NodePath -ArgumentList ('"' + $taskServer + '"') -WorkingDirectory $taskWorkspace -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput $taskOutput -RedirectStandardError $taskErrors
    exit $taskProcess.ExitCode
} catch {
    [IO.File]::WriteAllText((Join-Path $taskData 'startup-error.txt'), $_.Exception.Message)
    exit 1
}
