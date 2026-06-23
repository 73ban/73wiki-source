param(
  [string]$ProjectPath = "C:\wiki\73神话",
  [string]$SourcePath = "C:\Users\Administrator\Desktop\73WIKI-1.0-source",
  [string]$FeishuManagerPath = "C:\Users\Administrator\Desktop\workspace\feishu-73-manager",
  [int]$MaxSymbols = 20
)

$ErrorActionPreference = "Stop"

$taskPrefix = "73WIKI-Market-"
$existing = Get-ScheduledTask -TaskName "$taskPrefix*" -ErrorAction SilentlyContinue
foreach ($task in $existing) {
  Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false
}

$slots = @(
  @{ Time = "09:15"; Label = "0915"; Profile = "intraday" },
  @{ Time = "09:20"; Label = "0920"; Profile = "intraday" },
  @{ Time = "09:25"; Label = "0925"; Profile = "intraday" },
  @{ Time = "09:30"; Label = "0930"; Profile = "report" },
  @{ Time = "09:31"; Label = "0931"; Profile = "watchlist" },
  @{ Time = "09:32"; Label = "0932"; Profile = "watchlist" },
  @{ Time = "09:33"; Label = "0933"; Profile = "watchlist" },
  @{ Time = "09:34"; Label = "0934"; Profile = "watchlist" },
  @{ Time = "09:35"; Label = "0935"; Profile = "full" },
  @{ Time = "09:36"; Label = "0936"; Profile = "watchlist" },
  @{ Time = "09:37"; Label = "0937"; Profile = "watchlist" },
  @{ Time = "09:38"; Label = "0938"; Profile = "watchlist" },
  @{ Time = "09:39"; Label = "0939"; Profile = "watchlist" },
  @{ Time = "09:40"; Label = "0940"; Profile = "watchlist" },
  @{ Time = "09:41"; Label = "0941"; Profile = "watchlist" },
  @{ Time = "09:42"; Label = "0942"; Profile = "watchlist" },
  @{ Time = "09:43"; Label = "0943"; Profile = "watchlist" },
  @{ Time = "09:44"; Label = "0944"; Profile = "watchlist" },
  @{ Time = "09:45"; Label = "0945"; Profile = "full" },
  @{ Time = "09:46"; Label = "0946"; Profile = "watchlist" },
  @{ Time = "09:47"; Label = "0947"; Profile = "watchlist" },
  @{ Time = "09:48"; Label = "0948"; Profile = "watchlist" },
  @{ Time = "09:49"; Label = "0949"; Profile = "watchlist" },
  @{ Time = "09:50"; Label = "0950"; Profile = "full" },
  @{ Time = "10:00"; Label = "1000"; Profile = "full" },
  @{ Time = "10:20"; Label = "1020"; Profile = "full" },
  @{ Time = "10:50"; Label = "1050"; Profile = "full" },
  @{ Time = "11:30"; Label = "1130"; Profile = "full" },
  @{ Time = "13:03"; Label = "1303"; Profile = "watchlist" },
  @{ Time = "13:10"; Label = "1310"; Profile = "full" },
  @{ Time = "13:30"; Label = "1330"; Profile = "full" },
  @{ Time = "14:00"; Label = "1400"; Profile = "full" },
  @{ Time = "14:30"; Label = "1430"; Profile = "full" },
  @{ Time = "14:50"; Label = "1450"; Profile = "full" },
  @{ Time = "15:05"; Label = "1505"; Profile = "full" }
)

foreach ($slot in $slots) {
  $taskName = "$taskPrefix$($slot.Label)"
  if ($slot.Profile -eq "report") {
    $command = "Set-Location -LiteralPath '$FeishuManagerPath'; npm run send:intraday-report"
  } elseif ($slot.Profile -eq "intraday") {
    $command = "Set-Location -LiteralPath '$SourcePath'; powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\tencent-intraday-launch.ps1' -ProjectPath '$ProjectPath' -SourcePath '$SourcePath' -Write"
  } else {
    $command = @"
Set-Location -LiteralPath '$SourcePath'
npm run market:collect -- --project '$ProjectPath' --label '$($slot.Label)' --profile '$($slot.Profile)' --max-symbols $MaxSymbols
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
npm run audit:dates -- --project '$ProjectPath'
`$auditExit = `$LASTEXITCODE
npm run execution:audit -- --project '$ProjectPath' --write
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
npm run execution:brief -- --project '$ProjectPath' --write
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
npm run audit:encoding -- --project '$ProjectPath'
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
npm run hypothesis:validate -- --project '$ProjectPath'
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
npm run brain:health -- --project '$ProjectPath'
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
npm run learning:layers -- --project '$ProjectPath'
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
npm run warroom:skeleton -- --project '$ProjectPath'
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
npm run correction:push -- --project '$ProjectPath' --manager-path '$FeishuManagerPath'
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
npm run brain:push -- --project '$ProjectPath' --manager-path '$FeishuManagerPath'
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
npm run system:health -- --project '$ProjectPath' --manager-path '$FeishuManagerPath' --write
if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }
if (`$auditExit -ne 0) { exit `$auditExit }
"@
  }
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
    -Description "73WIKI market collector $($slot.Label) $($slot.Profile)" `
    -Force | Out-Null
}

Get-ScheduledTask -TaskName "$taskPrefix*" |
  Sort-Object TaskName |
  Select-Object TaskName, State
