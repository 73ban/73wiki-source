param(
  [string]$ProjectPath = "C:\wiki\73神话",
  [string]$SourcePath = "C:\Users\Administrator\Desktop\73WIKI-1.0-source"
)

$ErrorActionPreference = "Stop"

$taskPrefix = "73WIKI-Training-Flywheel-"
$existing = Get-ScheduledTask -TaskName "$taskPrefix*" -ErrorAction SilentlyContinue
foreach ($task in $existing) {
  Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false
}

$slots = @(
  @{ Time = "15:20"; Label = "1520-CLOSE" },
  @{ Time = "21:50"; Label = "2150-NIGHT" }
)

foreach ($slot in $slots) {
  $taskName = "$taskPrefix$($slot.Label)"
  $command = @"
Set-Location -LiteralPath '$SourcePath'
node scripts/training-flywheel.mjs --project '$ProjectPath' --write
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
node scripts/pipeline-audit.mjs --project '$ProjectPath' --write
"@
  $action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"$command`""
  $trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($slot.Time, "HH:mm", $null))
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew
  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "73WIKI self-learning training flywheel $($slot.Label)" `
    -Force | Out-Null
}

Get-ScheduledTask -TaskName "$taskPrefix*" |
  Sort-Object TaskName |
  Select-Object TaskName, State
