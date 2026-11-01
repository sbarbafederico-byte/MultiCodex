param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$taskWorkspace = Split-Path $PSScriptRoot
$taskWorker = Join-Path $PSScriptRoot 'Run-HubWorker.ps1'
$taskService = New-Object -ComObject 'Schedule.Service'
$taskService.Connect()
$taskRoot = $taskService.GetFolder('\')
$taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskName = 'MultiCodexHub-' + $taskSid
$taskDefinition = $taskService.NewTask(0)
$taskDefinition.RegistrationInfo.Description = 'Hub MultiCodex avviato su richiesta, indipendente dal processo Codex.'
$taskDefinition.Principal.UserId = $taskSid
$taskDefinition.Principal.LogonType = 3 # Interactive user token; no password stored.
$taskDefinition.Principal.RunLevel = 0 # Normal user privileges.
$taskDefinition.Settings.Enabled = $true
$taskDefinition.Settings.AllowDemandStart = $true
$taskDefinition.Settings.DisallowStartIfOnBatteries = $false
$taskDefinition.Settings.StopIfGoingOnBatteries = $false
$taskDefinition.Settings.ExecutionTimeLimit = 'PT0S'
$taskDefinition.Settings.MultipleInstances = 2 # Ignore a duplicate start.
$taskDefinition.Settings.Hidden = $true
# No time or logon triggers: the desktop launcher starts it on demand only.
$taskAction = $taskDefinition.Actions.Create(0)
$taskAction.Path = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$taskAction.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $taskWorker + '" -NodePath "' + $NodePath + '"'
$taskAction.WorkingDirectory = $taskWorkspace
$taskRegistered = $taskRoot.RegisterTaskDefinition($taskName, $taskDefinition, 6, $taskSid, $null, 3)
$null = $taskRegistered.Run($null)
Write-Output 'Avvio indipendente MultiCodex richiesto a Windows.'
