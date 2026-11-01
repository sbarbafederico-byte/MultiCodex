$ErrorActionPreference = 'Stop'
$taskLauncher = Join-Path $PSScriptRoot 'Avvia-MultiCodex.ps1'
$taskIcon = Join-Path $PSScriptRoot 'public\multicodex.ico'
Add-Type -AssemblyName System.Drawing
$taskBitmap = New-Object Drawing.Bitmap(64,64)
$taskGraphics = [Drawing.Graphics]::FromImage($taskBitmap)
$taskGraphics.Clear([Drawing.Color]::FromArgb(83,71,214))
$taskFont = New-Object Drawing.Font('Segoe UI',32,[Drawing.FontStyle]::Bold)
$taskGraphics.DrawString('M', $taskFont, [Drawing.Brushes]::White, 6, 4)
$taskIconHandle = $taskBitmap.GetHicon()
$taskIconObject = [Drawing.Icon]::FromHandle($taskIconHandle)
$taskStream = [IO.File]::Create($taskIcon)
$taskIconObject.Save($taskStream)
$taskStream.Dispose(); $taskIconObject.Dispose(); $taskGraphics.Dispose(); $taskFont.Dispose(); $taskBitmap.Dispose()
$taskShell = New-Object -ComObject WScript.Shell
$taskLink = $taskShell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'MultiCodex.lnk'))
$taskLink.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$taskLink.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $taskLauncher + '"'
$taskLink.WorkingDirectory = $PSScriptRoot
$taskLink.IconLocation = $taskIcon
$taskLink.Description = 'Gestisci account, disponibilità e cambio account Codex'
$taskLink.WindowStyle = 7
$taskLink.Save()
Write-Output 'Collegamento MultiCodex creato sul desktop.'
