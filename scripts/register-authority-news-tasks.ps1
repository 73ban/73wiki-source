param(
  [string]$ProjectPath = "C:\wiki\73神话",
  [string]$SourcePath = "C:\Users\Administrator\Desktop\73WIKI-1.0-source",
  [int]$MaxItems = 24
)

$ErrorActionPreference = "Stop"

$taskPrefix = "73WIKI-Authority-"
$existing = Get-ScheduledTask -TaskName "$taskPrefix*" -ErrorAction SilentlyContinue
foreach ($task in $existing) {
  Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false
}

$slots = @(
  @{ Time = "20:10"; Label = "2010-XWLB"; Source = "cctv-xwlb" },
  @{ Time = "21:40"; Label = "2140-XWLB"; Source = "cctv-xwlb" },
  @{ Time = "06:10"; Label = "0610-RMRB"; Source = "people-daily" },
  @{ Time = "07:20"; Label = "0720-ALL"; Source = "all" },
  @{ Time = "08:05"; Label = "0805-ALL"; Source = "all" }
)

foreach ($slot in $slots) {
  $taskName = "$taskPrefix$($slot.Label)"
  $command = "Set-Location -LiteralPath '$SourcePath'; node scripts/authority-news.mjs '$ProjectPath' '$($slot.Source)' $MaxItems write; npm run db:import-facts -- '$ProjectPath'"
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
    -Description "73WIKI authority policy news collector $($slot.Label) $($slot.Source)" `
    -Force | Out-Null
}

Get-ScheduledTask -TaskName "$taskPrefix*" |
  Sort-Object TaskName |
  Select-Object TaskName, State
