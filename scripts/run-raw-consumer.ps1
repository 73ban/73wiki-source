param(
  [string]$ProjectPath = "",
  [int]$BatchSize = 80
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
  $ProjectPath = "C:\wiki\73$([char]0x795e)$([char]0x8bdd)"
}

$SourcePath = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ConsumerScript = Join-Path $SourcePath "scripts\raw-queue-consumer.mjs"
$LogDir = Join-Path $ProjectPath ".system\logs"
$LogPath = Join-Path $LogDir "raw-queue-consumer.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location -LiteralPath $SourcePath

$startedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "[$startedAt] start raw consumer batchSize=$BatchSize project=$ProjectPath"

try {
  node $ConsumerScript --project $ProjectPath --once --batch-size $BatchSize *>&1 |
    ForEach-Object { Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value $_ }
  $exitCode = $LASTEXITCODE
} catch {
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ($_ | Out-String)
  $exitCode = 1
}

$finishedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "[$finishedAt] finish raw consumer exit=$exitCode"
exit $exitCode
