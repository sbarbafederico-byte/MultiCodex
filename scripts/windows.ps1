param([Parameter(Mandatory=$true)][ValidateSet('Protect','Unprotect','Discover','HostStatus','OpenLogin','StopApp','LaunchApp','Restrict')][string]$Action)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $taskInput = [Console]::In.ReadToEnd() | ConvertFrom-Json
    switch ($Action) {
        'Protect' {
            Add-Type -AssemblyName System.Security
            $taskBytes = [Convert]::FromBase64String($taskInput.data)
            $taskCipher = [Security.Cryptography.ProtectedData]::Protect($taskBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
            [Convert]::ToBase64String($taskCipher)
        }
        'Unprotect' {
            Add-Type -AssemblyName System.Security
            $taskBytes = [Convert]::FromBase64String($taskInput.data)
            $taskPlain = [Security.Cryptography.ProtectedData]::Unprotect($taskBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
            [Convert]::ToBase64String($taskPlain)
        }
        'Restrict' {
            $taskDir = [IO.Path]::GetFullPath($taskInput.path)
            $taskInfo = New-Object IO.DirectoryInfo($taskDir)
            $taskAcl = $taskInfo.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
            $taskAcl.SetAccessRuleProtection($true, $false)
            $taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
            $taskRule = New-Object Security.AccessControl.FileSystemAccessRule($taskSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            $taskAcl.AddAccessRule($taskRule)
            $taskInfo.SetAccessControl($taskAcl)
            '{"ok":true}'
        }
        'Discover' {
            $taskApp = Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' OR Name='Codex.exe'" | Where-Object {
                $_.ExecutablePath -match '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(ChatGPT|Codex)\.exe$' -and $_.CommandLine -notmatch ' --type='
            } | Select-Object -First 1
            $taskAppPath = if ($taskApp) { $taskApp.ExecutablePath } else { $null }
            if (-not $taskAppPath) {
                $taskPackages = @(Get-ChildItem -LiteralPath "$env:ProgramFiles\WindowsApps" -Directory -Filter 'OpenAI.Codex_*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
                foreach ($taskPackage in $taskPackages) {
                    foreach ($taskName in @('ChatGPT.exe','Codex.exe')) {
                        $taskCandidate = Join-Path $taskPackage.FullName "app\$taskName"
                        if (Test-Path -LiteralPath $taskCandidate) { $taskAppPath = $taskCandidate; break }
                    }
                    if ($taskAppPath) { break }
                }
            }
            $taskCli = Get-CimInstance Win32_Process -Filter "Name='codex.exe'" | Where-Object { $_.CommandLine -match '\bapp-server\b' -and $_.ExecutablePath -match '\\OpenAI\\Codex\\bin\\' } | Select-Object -First 1
            $taskCliPath = if ($taskCli) { $taskCli.ExecutablePath } elseif ($taskAppPath) { Join-Path (Split-Path $taskAppPath) 'resources\codex.exe' } else { $null }
            $taskAppAgent = if ($taskApp) { Get-CimInstance Win32_Process -Filter "Name='codex.exe'" | Where-Object { $_.ParentProcessId -eq $taskApp.ProcessId -and $_.CommandLine -match '\bapp-server\b' } | Select-Object -First 1 } else { $null }
            $taskWindowReady = if ($taskApp) { [bool](Get-Process -Id $taskApp.ProcessId -ErrorAction SilentlyContinue).MainWindowHandle } else { $false }
            @{ appPath=$taskAppPath; cliPath=$taskCliPath; pid=$(if ($taskApp) { $taskApp.ProcessId } else { $null }); appRunning=[bool]$taskApp; agentReady=[bool]$taskAppAgent; windowReady=$taskWindowReady } | ConvertTo-Json -Compress
        }
        'HostStatus' {
            $taskProcesses = @(Get-CimInstance Win32_Process)
            $taskCurrentPid = [int]$taskInput.pid
            $taskChain = @()
            $taskSeen = @{}
            for ($taskIndex = 0; $taskIndex -lt 24 -and $taskCurrentPid -gt 0; $taskIndex++) {
                if ($taskSeen.ContainsKey($taskCurrentPid)) { break }
                $taskSeen[$taskCurrentPid] = $true
                $taskProcess = $taskProcesses | Where-Object { $_.ProcessId -eq $taskCurrentPid } | Select-Object -First 1
                if (-not $taskProcess) { break }
                $taskChain += @{name=$taskProcess.Name;pid=$taskProcess.ProcessId;parentPid=$taskProcess.ParentProcessId}
                $taskCurrentPid = $taskProcess.ParentProcessId
            }
            $taskCodexAncestor = @($taskChain | Where-Object { $_.name -in @('ChatGPT.exe','codex.exe') }).Count -gt 0
            $taskSchedulerAncestor = @($taskChain | Where-Object { $_.name -in @('svchost.exe','taskeng.exe','taskhostw.exe') }).Count -gt 0
            @{codexAncestor=$taskCodexAncestor;taskSchedulerAncestor=$taskSchedulerAncestor;chain=$taskChain} | ConvertTo-Json -Compress -Depth 4
        }
        'OpenLogin' {
            $taskUri = [Uri]$taskInput.url
            if ($taskUri.Scheme -ne 'https' -or $taskUri.Host -notin @('auth.openai.com','chatgpt.com','auth0.openai.com')) { throw 'URL accesso non consentito.' }
            $taskBrowser = $null
            foreach ($taskCandidate in @(
                "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
                "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
                "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
                "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
            )) { if (Test-Path -LiteralPath $taskCandidate) { $taskBrowser=$taskCandidate; break } }
            if (-not $taskBrowser) { throw 'Installa Edge o Chrome per usare gli accessi separati.' }
            $taskProfile = [IO.Path]::GetFullPath($taskInput.profile)
            $taskAllowed = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'MultiCodex\browser')) + '\'
            if (-not $taskProfile.StartsWith($taskAllowed, [StringComparison]::OrdinalIgnoreCase) -or $taskProfile.Contains('"')) { throw 'Profilo browser non valido.' }
            # Interactive login window: the user must see and complete it.
            Start-Process -FilePath $taskBrowser -ArgumentList ('--user-data-dir="' + $taskProfile + '" --no-first-run --new-window "' + $taskUri.AbsoluteUri + '"')
            '{"ok":true}'
        }
        'StopApp' {
            $taskExpected = [IO.Path]::GetFullPath($taskInput.path)
            if ($taskExpected -notmatch '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(ChatGPT|Codex)\.exe$') { throw 'Percorso app non valido.' }
            $taskApps = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $taskExpected -and $_.CommandLine -notmatch ' --type=' })
            foreach ($taskApp in $taskApps) {
                $taskProcess = Get-Process -Id $taskApp.ProcessId -ErrorAction SilentlyContinue
                if ($taskProcess) { $null = $taskProcess.CloseMainWindow() }
            }
            $taskDeadline = [DateTime]::UtcNow.AddSeconds(6)
            do {
                $taskRemaining = @($taskApps | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
                if ($taskRemaining.Count -eq 0) { break }
                Start-Sleep -Milliseconds 250
            } while ([DateTime]::UtcNow -lt $taskDeadline)
            foreach ($taskApp in $taskRemaining) {
                $taskCheck = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskApp.ProcessId)"
                if ($taskCheck -and $taskCheck.ExecutablePath -eq $taskExpected) {
                    # Stop only the verified desktop process. Never terminate its whole tree:
                    # it can include the caller that must reopen the application.
                    Stop-Process -Id $taskApp.ProcessId -ErrorAction Stop
                }
            }
            Start-Sleep -Milliseconds 700
            if (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $taskExpected -and $_.CommandLine -notmatch ' --type=' }) { throw 'Codex risulta ancora aperto.' }
            '{"ok":true}'
        }
        'LaunchApp' {
            $taskPath = [IO.Path]::GetFullPath($taskInput.path)
            if ($taskPath -notmatch '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(ChatGPT|Codex)\.exe$' -or -not (Test-Path -LiteralPath $taskPath)) { throw 'Installazione Codex non trovata.' }
            # Microsoft Store packages must be activated by their registered app identity.
            # Starting the executable directly can return ERROR_ACCESS_DENIED.
            $taskPackage = Split-Path (Split-Path $taskPath)
            if ((Split-Path $taskPackage -Leaf) -notmatch '^(OpenAI\.Codex)_[^\\]+__([a-z0-9]+)$') { throw 'Identita pacchetto non riconosciuta.' }
            $taskFamily = $Matches[1] + '_' + $Matches[2]
            [xml]$taskManifest = Get-Content -LiteralPath (Join-Path $taskPackage 'AppxManifest.xml')
            $taskRelative = 'app/' + (Split-Path $taskPath -Leaf)
            $taskApplication = @($taskManifest.Package.Applications.Application | Where-Object { $_.Executable.Replace('\','/') -eq $taskRelative })
            if ($taskApplication.Count -ne 1) { throw 'App non individuata nel manifesto Windows.' }
            $taskAumid = $taskFamily + '!' + $taskApplication[0].Id
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace MultiCodex {
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IApplicationActivationManager {
        [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
        [PreserveSig] int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string appId, IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint processId);
        [PreserveSig] int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string appId, IntPtr items, out uint processId);
    }
    public static class StoreLauncher {
        [DllImport("ole32.dll", ExactSpelling=true, PreserveSig=true)]
        private static extern int CoCreateInstance(ref Guid classId, IntPtr outer, uint context, ref Guid interfaceId, [MarshalAs(UnmanagedType.Interface)] out IApplicationActivationManager manager);
        public static uint Activate(string appId) {
            Guid clsid = new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C");
            Guid iid = typeof(IApplicationActivationManager).GUID;
            IApplicationActivationManager manager;
            // Local server lifetime is independent of this short-lived PowerShell process.
            Marshal.ThrowExceptionForHR(CoCreateInstance(ref clsid, IntPtr.Zero, 4, ref iid, out manager));
            try {
                uint pid;
                Marshal.ThrowExceptionForHR(manager.ActivateApplication(appId, "", 2, out pid));
                return pid;
            } finally { Marshal.ReleaseComObject(manager); }
        }
    }
}
'@
            $taskActivatedPid = [MultiCodex.StoreLauncher]::Activate($taskAumid)
            @{ok=$true;pid=$taskActivatedPid;method='windows-package-activation';appId=$taskAumid} | ConvertTo-Json -Compress
        }
    }
} catch {
    [Console]::Error.WriteLine('Operazione Windows non riuscita: ' + $_.Exception.Message)
    exit 1
}
