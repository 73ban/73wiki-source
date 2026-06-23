#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const FACT_PATH = "data/facts/tdx_hotlist.jsonl"
const REPORT_ROOT = ".llm-wiki/tdx-hotlist"
const DEFAULT_QUESTION = "最近最热的股票前100只"

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["write", "help", "allow-deprecated"].includes(key)) {
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

function ensureTdxEnabled(args) {
  if (args["allow-deprecated"] || process.env.ALLOW_TDX_CHAIN === "1") return
  console.error(JSON.stringify({
    ok: false,
    skipped: true,
    reason: "disabled_by_policy",
    message: "TDX hotlist is deprecated. Use THS hotlist and the public-source chain instead.",
  }, null, 2))
  process.exit(2)
}

function printHelp() {
  console.log(`Usage:
  node scripts/tdx-hotlist.mjs --project C:\\wiki\\73神话 --write
  node scripts/tdx-hotlist.mjs --project C:\\wiki\\73神话 --question "最近最热的股票前100只" --write

This command queries TongDaXin MCP for the hot-stock ranking and writes a structured hotlist report.
`)
}

function nowLocalTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function idTimestamp(date = new Date()) {
  return nowLocalTimestamp(date).replace(/[-: ]/g, "")
}

function shortHash(value) {
  let hash = 0
  const text = String(value ?? "")
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  return Math.abs(hash).toString(16).slice(0, 12)
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function resolveProjectPath(projectPath) {
  return path.resolve(projectPath ?? DEFAULT_PROJECT_PATH)
}

function projectRelative(projectPath, targetPath) {
  return path.relative(path.resolve(projectPath), path.resolve(targetPath)).replace(/\\/g, "/")
}

function runTdxAsk({ question, page = 1, size = 100 }) {
  const result = spawnSync(process.execPath, [path.join(process.cwd(), "scripts", "tdx-mcp.mjs"), "ask", "--question", question, "--range", "AG", "--page", String(page), "--size", String(size)], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error([result.stdout, result.stderr].filter(Boolean).join("\n") || "tdx ask failed")
  }
  const text = String(result.stdout ?? "").trim()
  if (!text) return null
  return JSON.parse(text)
}

function tableRows(structuredContent) {
  const headers = (structuredContent?.headers ?? []).map((header) => String(header).replace(/<br>/g, " ").replace(/[#@]/g, "").trim())
  const data = structuredContent?.data ?? []
  return data.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]])))
}

function findKey(row, patterns, fallback = "") {
  const keys = Object.keys(row ?? {})
  for (const key of keys) {
    if (patterns.some((pattern) => pattern.test(key))) return key
  }
  return fallback && keys.includes(fallback) ? fallback : ""
}

function normalizeRow(row, rank) {
  const codeKey = findKey(row, [/sec_code/i, /代码/, /代码/i], "sec_code")
  const nameKey = findKey(row, [/sec_name/i, /简称/, /名称/], "sec_name")
  const marketKey = findKey(row, [/market/i], "market")
  const industryKey = findKey(row, [/所属行业/, /行业/], "所属行业")
  const priceKey = findKey(row, [/now_price/i, /最新价/, /现价/], "now_price")
  const chgKey = findKey(row, [/^chg$/i, /涨跌幅?/, /涨跌$/], "chg")
  const heatKey = findKey(row, [/热搜度/, /热度/, /热股/])
  const volumeKey = findKey(row, [/成交量/, /量/], "")
  return {
    rank,
    code: String(row[codeKey] ?? "").trim(),
    name: String(row[nameKey] ?? "").trim(),
    market: String(row[marketKey] ?? "").trim(),
    industry: String(row[industryKey] ?? "").trim(),
    price: String(row[priceKey] ?? "").trim(),
    changePercent: String(row[chgKey] ?? "").trim(),
    heatScore: String(row[heatKey] ?? "").trim(),
    volume: String(row[volumeKey] ?? "").trim(),
    raw: row,
  }
}

function buildRecord({ projectPath, question, payload }) {
  const generatedAt = nowLocalTimestamp()
  const rows = tableRows(payload)
  const items = rows.map((row, index) => normalizeRow(row, index + 1)).filter((item) => /^\d{6}$/.test(item.code))
  const summary = [
    `通达信热股榜：${items.length} 只，原始行数 ${rows.length}。`,
    items.slice(0, 12).map((item) => `${item.name || item.code}(${item.code}) 热搜度${item.heatScore || "-"} 涨跌${item.changePercent || "-"}`).join("；"),
    `查询问题：${question}`,
  ].filter(Boolean).join("\n")

  return {
    schema: "73wiki-tdx-hotlist-v1",
    id: `tdx_hotlist_${idTimestamp()}_${shortHash(JSON.stringify({ generatedAt, question, items }))}`,
    status: "active",
    title: `${generatedAt.slice(0, 10)} 通达信热股榜`,
    generatedAt,
    source: "tongdaxin-mcp",
    sourceTool: "tdx_wenda_quotes",
    sourceTier: "paid_mcp",
    projectPath: projectRelative(projectPath, projectPath) || ".",
    question,
    counts: {
      requested: rows.length,
      succeeded: items.length,
      failed: Math.max(0, rows.length - items.length),
    },
    headers: payload?.headers ?? [],
    rows,
    items,
    summary,
    claim: summary,
    tags: ["tongdaxin", "mcp", "hotlist", "hot-stock", "watchlist"],
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  ensureTdxEnabled(args)
  if (args.help) {
    printHelp()
    return
  }

  const projectPath = resolveProjectPath(args.project ?? args._[0])
  const question = args.question ?? DEFAULT_QUESTION
  const page = Number(args.page ?? 1)
  const size = Number(args.size ?? 100)
  const payload = runTdxAsk({
    question,
    page: Number.isFinite(page) && page > 0 ? page : 1,
    size: Number.isFinite(size) && size > 0 ? size : 100,
  })
  const record = buildRecord({ projectPath, question, payload })
  const reportRoot = path.join(projectPath, REPORT_ROOT)
  const factPath = path.join(projectPath, FACT_PATH)
  const reportPath = path.join(reportRoot, `${idTimestamp()}-tdx-hotlist.json`)
  const latestPath = path.join(reportRoot, "latest-tdx-hotlist.json")

  const output = {
    dryRun: !args.write,
    record,
    writePaths: {
      facts: FACT_PATH,
      reportRoot: REPORT_ROOT,
    },
  }

  if (args.write) {
    appendJsonl(factPath, record)
    writeJson(reportPath, record)
    writeJson(latestPath, record)
    output.written = {
      facts: FACT_PATH,
      report: projectRelative(projectPath, reportPath),
      latest: projectRelative(projectPath, latestPath),
    }
  }

  console.log(JSON.stringify(output, null, 2))
}

main()
