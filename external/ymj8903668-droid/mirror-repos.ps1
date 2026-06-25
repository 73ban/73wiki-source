param(
  [string]$TargetRoot = (Join-Path $PSScriptRoot "snapshots")
)

$ErrorActionPreference = "Stop"

$repos = @(
  @{ Name = "trading-review-wiki"; Url = "https://github.com/ymj8903668-droid/trading-review-wiki.git" },
  @{ Name = "QUEST"; Url = "https://github.com/ymj8903668-droid/QUEST.git" },
  @{ Name = "WeKnora"; Url = "https://github.com/ymj8903668-droid/WeKnora.git" },
  @{ Name = "wechat-radar"; Url = "https://github.com/ymj8903668-droid/wechat-radar.git" },
  @{ Name = "wx-cli"; Url = "https://github.com/ymj8903668-droid/wx-cli.git" },
  @{ Name = "wiki"; Url = "https://github.com/ymj8903668-droid/wiki.git" }
)

New-Item -ItemType Directory -Force -Path $TargetRoot | Out-Null

foreach ($repo in $repos) {
  $dest = Join-Path $TargetRoot $repo.Name
  if (Test-Path $dest) {
    Write-Host "Updating $($repo.Name)..."
    git -C $dest fetch --all --tags --prune | Out-Null
  } else {
    Write-Host "Cloning $($repo.Name)..."
    git clone --mirror $repo.Url $dest | Out-Null
  }
}

Write-Host "Done. Mirrors stored in $TargetRoot"

