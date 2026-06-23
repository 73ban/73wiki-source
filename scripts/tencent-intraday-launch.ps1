param(
  [string]$ProjectPath = "C:\wiki\73神话",
  [string]$SourcePath = "C:\Users\Administrator\Desktop\73WIKI-1.0-source",
  [string]$Symbols = "",
  [switch]$Write
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $SourcePath "scripts\tencent-intraday.mjs"
$scriptText = Get-Content -LiteralPath $scriptPath -Raw
$scriptUrl = ($scriptPath -replace "\\", "/")
$projectArg = (($ProjectPath -replace "\\", "/") -replace "'", "''")
$symbolsArg = ($Symbols -replace "'", "''")
$writeLine = if ($Write.IsPresent) { "process.argv.push('--write')" } else { "" }
$js = @"
import fs from 'node:fs'
const code = fs.readFileSync('$scriptUrl', 'utf8')
process.argv = ['node', 'tencent-intraday', '--project', '$projectArg']
if ('$symbolsArg') {
  process.argv.push('--symbols', '$symbolsArg')
}
$writeLine
await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(code))
"@

node --input-type=module -e $js
