#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73wiki"
const REPORT_ROOT = ".llm-wiki/hotlist-health"
const FACT_PATH = "data/facts/hotlist_health.jsonl"

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["write", "json", "help"].includes(key)) {
      args[key] = true
      continue
    }
    const value = argv[i + 1]
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${key}`)
    args[key] = value
    i += 1
  }
  return args
}

function nowLocalTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function idTimestamp(date = new Date()) {
  return nowLocalTimestamp(date).replace(/[-: ]/g, "")
}

function shortHash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 12)
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function statInfo(filePath) {
  try {
    const stat = fs.statSync(filePath)
    return { exists: true, path: filePath, mtime: nowLocalTimestamp(stat.mtime), ageHours: Math.round(((Date.now() - stat.mtimeMs) / 3600000) * 10) / 10, size: stat.size }
  } catch {
    return { exists: false, path: filePath, mtime: null, ageHours: null, size: null }
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function writeText(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, value, "utf8")
}

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
}

function projectRelative(projectPath, targetPath) {
  return path.relative(path.resolve(projectPath), path.resolve(targetPath)).replace(/\\/g, "/")
}

function evaluateSource(name, record, stat, minRows, maxAgeHours) {
  const rows = record?.rows ?? record?.items ?? []
  const issues = []
  const warnings = []
  if (!stat.exists) issues.push(`${name} report missing`)
  if (stat.ageHours != null && stat.ageHours > maxAgeHours) warnings.push(`${name} report stale: ${stat.ageHours}h`)
  if (rows.length < minRows) warnings.push(`${name} rows ${rows.length}/${minRows}`)
  const duplicateCodes = rows.length - new Set(rows.map((row) => row.code ?? row.sec_code).filter(Boolean)).size
  if (duplicateCodes > 0) warnings.push(`${name} duplicate codes: ${duplicateCodes}`)
  return {
    name,
    ok: issues.length === 0,
    rows: rows.length,
    minRows,
    ageHours: stat.ageHours,
    maxAgeHours,
    issues,
    warnings,
    sourceId: record?.id ?? null,
    evidenceTradeDate: record?.evidenceTradeDate ?? record?.tradeDate ?? null,
  }
}

function buildRecord(projectPath, options = {}) {
  const llm = path.join(projectPath, ".llm-wiki")
  const thsPath = path.join(llm, "ths-hotlist", "latest-ths-hotlist.json")
  const tdxPath = path.join(llm, "tdx-hotlist", "latest-tdx-hotlist.json")
  const ths = evaluateSource("ths-hotlist", readJsonMaybe(thsPath), statInfo(thsPath), Number(options.minThsRows ?? 80), Number(options.maxAgeHours ?? 24))
  const tdx = evaluateSource("tdx-hotlist", readJsonMaybe(tdxPath), statInfo(tdxPath), Number(options.minTdxRows ?? 80), Number(options.maxAgeHours ?? 48))
  const issues = [...ths.issues, ...tdx.issues]
  const warnings = [...ths.warnings, ...tdx.warnings]
  const generatedAt = nowLocalTimestamp()
  return {
    schema: "73wiki-hotlist-health-v1",
    id: `hotlist_health_${idTimestamp()}_${shortHash([...issues, ...warnings].join("|"))}`,
    status: issues.length === 0 ? "active" : "needs_attention",
    ok: issues.length === 0,
    generatedAt,
    projectPath,
    sources: { ths, tdx },
    issues,
    warnings,
    summary: issues.length ? issues.join("; ") : warnings.length ? warnings.join("; ") : "hotlist health passed",
    writePolicy: { rawWrite: false, wikiWrite: false, buyAdvice: false },
  }
}

function markdown(record) {
  return `# Hotlist Health

Generated: ${record.generatedAt}
Status: ${record.ok ? "ok" : "needs-attention"}

## Sources

- THS: rows=${record.sources.ths.rows}, age=${record.sources.ths.ageHours ?? "-"}h, warnings=${record.sources.ths.warnings.length}
- TDX: rows=${record.sources.tdx.rows}, age=${record.sources.tdx.ageHours ?? "-"}h, warnings=${record.sources.tdx.warnings.length}

## Issues

${record.issues.length ? record.issues.map((item) => `- ${item}`).join("\n") : "- none"}

## Warnings

${record.warnings.length ? record.warnings.map((item) => `- ${item}`).join("\n") : "- none"}
`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const record = buildRecord(projectPath, options)
  if (options.write) {
    const stamp = idTimestamp()
    const outDir = path.join(projectPath, REPORT_ROOT)
    const latestJson = path.join(outDir, "latest-hotlist-health.json")
    const latestMd = path.join(outDir, "latest-hotlist-health.md")
    writeJson(path.join(outDir, `${stamp}-hotlist-health.json`), record)
    writeJson(latestJson, record)
    writeText(path.join(outDir, `${stamp}-hotlist-health.md`), markdown(record))
    writeText(latestMd, markdown(record))
    appendJsonl(path.join(projectPath, FACT_PATH), record)
    return { dryRun: false, record, written: { facts: FACT_PATH, latest: projectRelative(projectPath, latestJson), markdown: projectRelative(projectPath, latestMd) } }
  }
  return { dryRun: true, record }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/hotlist-health.mjs --project <wiki-root> --write")
    return
  }
  const result = run({
    projectPath: args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH,
    minThsRows: Number(args["min-ths-rows"] ?? 80),
    minTdxRows: Number(args["min-tdx-rows"] ?? 80),
    maxAgeHours: Number(args["max-age-hours"] ?? 48),
    write: Boolean(args.write || args._.includes("write")),
  })
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else console.log(JSON.stringify({ dryRun: result.dryRun, id: result.record.id, ok: result.record.ok, issues: result.record.issues, warnings: result.record.warnings, written: result.written ?? null }, null, 2))
}

main()
