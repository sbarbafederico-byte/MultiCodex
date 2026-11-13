$ErrorActionPreference = 'Stop'
$taskErrors = $null
$taskTokens = $null
$taskAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'windows.ps1'), [ref]$taskTokens, [ref]$taskErrors)
if ($taskErrors.Count) { throw ($taskErrors | Out-String) }
Add-Type -Path (Join-Path $PSScriptRoot 'ProcessSnapshot.cs') -ErrorAction Stop
$taskSnapshot = @([MultiCodex.ProcessSnapshot]::Read())
if (-not ($taskSnapshot | Where-Object { $_.ProcessId -eq $PID })) { throw 'Il processo di prova non viene rilevato.' }
if (-not [MultiCodex.ProcessSnapshot]::ImagePath([uint32]$PID)) { throw 'Il percorso del processo di prova non viene rilevato.' }
$taskDefinitions = @($taskAst.FindAll({
    param($taskNode)
    $taskNode -is [Management.Automation.Language.CommandAst] -and $taskNode.GetCommandName() -eq 'Add-Type' -and
        @($taskNode.CommandElements | Where-Object { $_ -is [Management.Automation.Language.CommandParameterAst] -and $_.ParameterName -eq 'TypeDefinition' }).Count -gt 0
}, $true))
if ($taskDefinitions.Count -ne 2) { throw 'Attesi entrambi i blocchi C# di chiusura e avvio.' }
foreach ($taskDefinition in $taskDefinitions) {
    $taskLiteral = @($taskDefinition.CommandElements | Where-Object {
        $_ -is [Management.Automation.Language.StringConstantExpressionAst] -and $_.StringConstantType -eq 'SingleQuotedHereString'
    })
    if ($taskLiteral.Count -ne 1) { throw 'Definizione C# non riconosciuta.' }
    # Compile the exact production text without activating or closing any app.
    Add-Type -TypeDefinition $taskLiteral[0].Value -ErrorAction Stop
}
Write-Output 'Entrambi i blocchi C# compilati correttamente.'
