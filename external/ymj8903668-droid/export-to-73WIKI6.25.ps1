param(
  [Parameter(Mandatory = $true)]
  [string]$TargetRepoRoot
)

$ErrorActionPreference = "Stop"

$sourceRoot = Join-Path $PSScriptRoot "snapshots"
$targetExternal = Join-Path $TargetRepoRoot "external\ymj8903668-droid\snapshots"

if (-not (Test-Path $sourceRoot)) {
  throw "Snapshot source folder not found: $sourceRoot"
}

New-Item -ItemType Directory -Force -Path $targetExternal | Out-Null

Get-ChildItem -LiteralPath $sourceRoot -Directory | ForEach-Object {
  $dest = Join-Path $targetExternal $_.Name
  if (Test-Path $dest) {
    Remove-Item -LiteralPath $dest -Recurse -Force
  }
  Copy-Item -LiteralPath $_.FullName -Destination $dest -Recurse -Force
}

Copy-Item -LiteralPath (Join-Path $PSScriptRoot "backup-manifest.json") -Destination (Join-Path $TargetRepoRoot "external\ymj8903668-droid\backup-manifest.json") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "README.md") -Destination (Join-Path $TargetRepoRoot "external\ymj8903668-droid\README.md") -Force

Write-Host "Exported snapshots to $targetExternal"

