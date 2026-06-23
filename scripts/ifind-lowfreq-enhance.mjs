#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const BASE_URL = "https://api-mcp.51ifind.com:8643/ds-mcp-servers"
const STOCK_SERVER = `${BASE_URL}/hexin-ifind-ds-stock-mcp`
const NEWS_SERVER = `${BASE_URL}/hexin-ifind-ds-news-mcp`
const FACT_PATH = "data/facts/ifind_lowfreq_enhancements.jsonl"
const REPORT_ROOT = ".llm-wiki/ifind-enhance"
const DEFAULT_QUOTE_INDICATORS = ["最新价", "涨跌幅", "成交额", "成交量", "开盘价", "最高价", "最低价"]

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["write", "help"].includes(key)) {
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

function printHelp() {
  console.log(`Usage:
  npm run ifind:enhance -- --project C:\\wiki\\73神话 --write
  npm run ifind:enhance -- --project C:\\wiki\\73神话 --symbols 600519,300750 --write

This is a low-frequency licensed enhancer.
It only targets core/watchlist symbols and writes to data/facts + .llm-wiki.
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
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12)
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/")
}

function projectRelative(projectPath, targetPath) {
  return toPosixPath(path.relative(path.resolve(projectPath), path.resolve(targetPath)))
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

function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function splitSymbols(value) {
  return String(value ?? "")
    .split(/[,\s，、]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean))]
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function firstTradeDate(...values) {
  for (const value of values) {
    const normalized = normalizeTradeDate(value)
    if (normalized) return normalized
  }
  return null
}

function latestTradeDate(values = []) {
  return values
    .map((value) => normalizeTradeDate(value))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .at(-1) ?? null
}

function resolveIfindTradeDateContext(projectPath, generatedAt, items = []) {
  const today = generatedAt.slice(0, 10)
  const preopen = readJsonMaybe(path.join(projectPath, ".llm-wiki/preopen/latest-preopen-intel.json"))
  const watchlist = readJsonMaybe(path.join(projectPath, ".llm-wiki/market-watchlist/latest-warroom-watchlist.json"))
  const itemEvidenceDates = items.flatMap((item) => [
    item?.quote?.time,
    ...(item?.newsItems ?? []).map((news) => news?.date),
  ])
  const planTradeDate = firstTradeDate(
    preopen?.tradeDate,
    watchlist?.planTradeDate,
    watchlist?.tradeDate,
    today,
  ) ?? today
  const evidenceTradeDate = latestTradeDate([
    watchlist?.evidenceTradeDate,
    ...itemEvidenceDates,
  ]) ?? today
  const sourceTradeDates = {
    preopen: normalizeTradeDate(preopen?.tradeDate),
    marketWatchlistPlan: normalizeTradeDate(watchlist?.planTradeDate ?? watchlist?.tradeDate),
    marketWatchlistEvidence: normalizeTradeDate(watchlist?.evidenceTradeDate),
    itemEvidence: latestTradeDate(itemEvidenceDates),
    generatedBatch: normalizeTradeDate(generatedAt),
  }
  const distinct = [...new Set(Object.values(sourceTradeDates).filter(Boolean))]
  return {
    tradeDate: evidenceTradeDate,
    planTradeDate,
    evidenceTradeDate,
    sourceTradeDates,
    hasDateMismatch: distinct.length > 1,
  }
}

function readTokenFromText(text) {
  const direct = text.match(/KEY:\s*(\S+)/)?.[1]
  if (direct) return direct
  try {
    const parsed = JSON.parse(text)
    const firstServer = Object.values(parsed.mcpServers ?? {})[0]
    const token = firstServer?.headers?.Authorization ?? parsed.auth_token
    if (token) return token
  } catch {
    // fall through
  }
  return text.match(/"Authorization"\s*:\s*"([^"]+)"/)?.[1] ?? null
}

function findDesktopMcpConfig() {
  const desktop = path.join(os.homedir(), "Desktop")
  if (!fs.existsSync(desktop)) return null
  for (const entry of fs.readdirSync(desktop, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".txt")) continue
    const fullPath = path.join(desktop, entry.name)
    const text = fs.readFileSync(fullPath, "utf8")
    if (text.includes("api-mcp.51ifind.com") && text.includes("mcpServers")) return { fullPath, text }
  }
  return null
}

function loadAuthToken() {
  if (process.env.IFIND_MCP_AUTH_TOKEN) return process.env.IFIND_MCP_AUTH_TOKEN.trim()
  if (process.env.IFIND_MCP_CONFIG_PATH) {
    const text = fs.readFileSync(process.env.IFIND_MCP_CONFIG_PATH, "utf8")
    const token = readTokenFromText(text)
    if (token) return token
  }
  const desktopConfig = findDesktopMcpConfig()
  if (desktopConfig) {
    const token = readTokenFromText(desktopConfig.text)
    if (token) return token
  }
  throw new Error("No iFinD MCP token found. Set IFIND_MCP_AUTH_TOKEN or IFIND_MCP_CONFIG_PATH.")
}

class IfindMcpClient {
  constructor({ token }) {
    this.token = token
    this.sessions = new Map()
    this.requestIds = new Map()
  }

  nextId(serverType) {
    const next = (this.requestIds.get(serverType) ?? 0) + 1
    this.requestIds.set(serverType, next)
    return next
  }

  endpoint(serverType) {
    return serverType === "news" ? NEWS_SERVER : STOCK_SERVER
  }

  async post(serverType, payload, timeoutMs = 60_000) {
    const url = new URL(this.endpoint(serverType))
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json, text/event-stream",
      Authorization: this.token,
    }
    const sessionId = this.sessions.get(serverType)
    if (sessionId) headers["Mcp-Session-Id"] = sessionId

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers,
        timeout: timeoutMs,
      }, (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => {
          body += chunk
        })
        res.on("end", () => {
          let data = body
          try {
            data = body.trim() ? JSON.parse(body) : null
          } catch {
            // keep text
          }
          resolve({ statusCode: res.statusCode, headers: res.headers, data })
        })
      })
      req.on("error", reject)
      req.on("timeout", () => req.destroy(new Error(`iFinD MCP request timeout after ${timeoutMs}ms`)))
      req.write(JSON.stringify(payload))
      req.end()
    })
  }

  async initialize(serverType) {
    if (this.sessions.has(serverType)) return
    const response = await this.post(serverType, {
      jsonrpc: "2.0",
      id: this.nextId(serverType),
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "73wiki-ifind-lowfreq-enhance", version: "1.0.0" },
      },
    }, 30_000)
    const sessionId = response.headers["mcp-session-id"]
    if (!sessionId) throw new Error(`iFinD MCP initialize failed for ${serverType}: ${JSON.stringify(response.data)}`)
    this.sessions.set(serverType, sessionId)
    await this.post(serverType, { jsonrpc: "2.0", method: "notifications/initialized" }, 10_000)
  }

  async callTool(serverType, toolName, args) {
    await this.initialize(serverType)
    return this.post(serverType, {
      jsonrpc: "2.0",
      id: this.nextId(serverType),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    })
  }
}

function decodeToolContent(response) {
  const content = response.data?.result?.content
  if (!Array.isArray(content)) return response.data
  const text = content.map((item) => item.text ?? "").join("\n")
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function parseNestedIfindData(value) {
  if (!value || typeof value !== "object") return value
  if (typeof value.data === "string") {
    try {
      return { ...value, data: JSON.parse(value.data) }
    } catch {
      return value
    }
  }
  return value
}

function tableRows(table) {
  if (!Array.isArray(table) || table.length === 0) return []
  const [headers, ...rows] = table
  if (!Array.isArray(headers)) return []
  return rows
    .filter((row) => Array.isArray(row))
    .map((row) => Object.fromEntries(headers.map((header, index) => [String(header), row[index] ?? ""])))
}

function extractQuoteRows(decoded) {
  const parsed = parseNestedIfindData(decoded)
  const tables = parsed?.data?.tables
  if (!Array.isArray(tables)) return []
  if (Array.isArray(tables[0]) && typeof tables[0][0] === "string") return tableRows(tables)
  return tables.flatMap((table) => tableRows(table))
}

function parseNewsItems(decoded) {
  const parsed = parseNestedIfindData(decoded)
  const nested = parsed?.data?.data
  const items = Array.isArray(parsed)
    ? parsed
    : typeof nested === "string"
      ? JSON.parse(nested)
      : Array.isArray(nested)
        ? nested
        : []
  return items
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      title: item.title || item["资讯标题"] || "",
      date: item.date || item["日期"] || "",
      url: item.url || item["URL"] || "",
      snippet: String(item.content || item["资讯内容"] || "").replace(/\s+/g, " ").trim().slice(0, 200),
    }))
    .filter((item) => item.title || item.snippet)
}

function normalizeCode(value) {
  return String(value ?? "").replace(/\D/g, "").padStart(6, "0").slice(-6)
}

function parseNumberLoose(value) {
  const text = String(value ?? "").replace(/,/g, "").trim()
  if (!text || text === "--") return null
  const match = text.match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : null
}

function collectEnhanceTargets(projectPath, explicitSymbols, maxSymbols) {
  if (explicitSymbols.length > 0) {
    return explicitSymbols.slice(0, Number(maxSymbols)).map((symbol) => ({
      code: normalizeCode(symbol),
      name: "",
      role: "manual",
      themes: [],
      source: "cli:--symbols",
    }))
  }

  const targets = []
  const seen = new Set()
  const add = (item, source) => {
    const code = normalizeCode(item?.code)
    if (!/^\d{6}$/.test(code) || seen.has(code)) return
    seen.add(code)
    targets.push({
      code,
      name: String(item?.name ?? "").trim(),
      role: String(item?.role ?? "").trim(),
      themes: Array.isArray(item?.themes) ? item.themes.slice(0, 8) : [],
      source,
    })
  }

  const preopen = readJsonMaybe(path.join(projectPath, ".llm-wiki/preopen/latest-preopen-intel.json"))
  for (const item of preopen?.core ?? []) add(item, "preopen")

  const watchlist = readJsonMaybe(path.join(projectPath, ".llm-wiki/market-watchlist/latest-warroom-watchlist.json"))
  for (const item of watchlist?.tiers?.focus ?? []) add(item, "watchlist:focus")

  return targets.slice(0, Number(maxSymbols))
}

async function queryQuotes(client, symbols) {
  const response = await client.callTool("stock", "stock_highfreq_quotes", {
    symbols: symbols.join(","),
    indicators: DEFAULT_QUOTE_INDICATORS.join(","),
    data_mode: "real_time",
  })
  const decoded = parseNestedIfindData(decodeToolContent(response))
  return {
    statusCode: response.statusCode,
    rows: extractQuoteRows(decoded),
    decoded,
  }
}

function todayRange(daysBack) {
  const end = nowLocalTimestamp().slice(0, 10)
  const date = new Date(`${end}T00:00:00`)
  date.setDate(date.getDate() - Number(daysBack))
  const pad = (n) => String(n).padStart(2, "0")
  const start = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return { start, end }
}

async function queryNews(client, target, { daysBack, size }) {
  const { start, end } = todayRange(daysBack)
  const query = target.name ? `${target.name} ${target.code}` : target.code
  const response = await client.callTool("news", "search_news", {
    query,
    time_start: start,
    time_end: end,
    size: Number(size),
  })
  const decoded = parseNestedIfindData(decodeToolContent(response))
  return {
    statusCode: response.statusCode,
    query,
    items: parseNewsItems(decoded).slice(0, Number(size)),
    decoded,
  }
}

function buildItem(target, quoteRow, newsResult) {
  const name = String(quoteRow?.["证券简称"] ?? quoteRow?.name ?? target.name ?? "").trim()
  const changePercent = parseNumberLoose(quoteRow?.["涨跌幅"] ?? quoteRow?.changePercent)
  const latestPrice = parseNumberLoose(quoteRow?.["最新价"] ?? quoteRow?.latestPrice)
  const newsCount = newsResult.items.length
  const confidence = Math.min(0.92, 0.25 + (quoteRow ? 0.18 : 0) + Math.min(0.36, newsCount * 0.12))
  const summaryBits = [
    name || target.code,
    Number.isFinite(changePercent) ? `涨跌幅 ${changePercent}%` : "",
    Number.isFinite(latestPrice) ? `最新价 ${latestPrice}` : "",
    newsCount > 0 ? `iFinD近端新闻 ${newsCount} 条` : "iFinD未命中新新闻",
  ].filter(Boolean)

  return {
    code: target.code,
    name: name || target.name || target.code,
    role: target.role || "",
    source: target.source,
    themes: target.themes ?? [],
    latestPrice,
    changePercent,
    quote: quoteRow
      ? {
        latestPrice,
        changePercent,
        amount: parseNumberLoose(quoteRow?.["成交额"]),
        volume: parseNumberLoose(quoteRow?.["成交量"]),
        openPrice: parseNumberLoose(quoteRow?.["开盘价"]),
        highPrice: parseNumberLoose(quoteRow?.["最高价"]),
        lowPrice: parseNumberLoose(quoteRow?.["最低价"]),
        time: String(quoteRow?.time ?? "").trim(),
        raw: quoteRow,
      }
      : null,
    newsQuery: newsResult.query,
    newsItems: newsResult.items,
    newsCount,
    confidence: Number(confidence.toFixed(2)),
    summary: summaryBits.join("；"),
  }
}

async function runEnhancer(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const explicitSymbols = splitSymbols(options.symbols).map(normalizeCode).filter((item) => /^\d{6}$/.test(item))
  const targets = collectEnhanceTargets(projectPath, explicitSymbols, Number(options["max-symbols"] ?? 8))
  if (targets.length === 0) throw new Error("No iFinD enhance targets found. Provide --symbols or ensure preopen/watchlist exists.")

  const client = new IfindMcpClient({ token: loadAuthToken() })
  const quoteResult = await queryQuotes(client, targets.map((item) => item.code))
  const quoteByCode = new Map(
    quoteResult.rows
      .map((row) => [normalizeCode(row?.["证券代码"] ?? row?.code), row])
      .filter(([code]) => /^\d{6}$/.test(code)),
  )

  const items = []
  const errors = []
  for (const target of targets) {
    let newsResult = { query: target.code, items: [] }
    try {
      newsResult = await queryNews(client, target, {
        daysBack: Number(options["days-back"] ?? 5),
        size: Number(options["news-limit"] ?? 3),
      })
      if (newsResult.statusCode >= 400) errors.push({ code: target.code, scope: "news", statusCode: newsResult.statusCode })
    } catch (error) {
      errors.push({ code: target.code, scope: "news", error: error?.message ?? String(error) })
    }
    items.push(buildItem(target, quoteByCode.get(target.code), newsResult))
  }

  if (quoteResult.statusCode >= 400) errors.push({ scope: "quote", statusCode: quoteResult.statusCode })

  const generatedAt = nowLocalTimestamp()
  const dateContext = resolveIfindTradeDateContext(projectPath, generatedAt, items)
  const highlighted = items
    .filter((item) => item.newsCount > 0 || Number.isFinite(item.changePercent))
    .sort((left, right) => (right.newsCount - left.newsCount) || ((right.changePercent ?? -999) - (left.changePercent ?? -999)))
    .slice(0, 8)
    .map((item) => `${item.name}(${item.code})`)

  const record = {
    schema: "73wiki-ifind-lowfreq-enhance-v1",
    id: `ifind_enhance_${idTimestamp()}_${shortHash(items.map((item) => item.code).join(","))}`,
    status: "active",
    title: `${dateContext.evidenceTradeDate} iFinD low-frequency enhancer`,
    generatedAt,
    tradeDate: dateContext.evidenceTradeDate,
    planTradeDate: dateContext.planTradeDate,
    evidenceTradeDate: dateContext.evidenceTradeDate,
    sourceTradeDates: dateContext.sourceTradeDates,
    hasDateMismatch: dateContext.hasDateMismatch,
    source: "ifind-mcp",
    sourceTier: "licensed_low_frequency_enhancer",
    projectPath,
    targetCount: targets.length,
    items,
    errors,
    summary: highlighted.length
      ? `iFinD low-frequency enhancer covered ${targets.length} symbols; highlighted ${highlighted.join(", ")}.`
      : `iFinD low-frequency enhancer covered ${targets.length} symbols with no highlighted items.`,
    claim: "This layer is a low-frequency licensed enhancer for core symbols only. It is evidence support, not a primary ingestion source or buy advice.",
    tags: ["ifind", "licensed", "low-frequency", "enhancer"],
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }

  const output = {
    dryRun: !options.write,
    record,
    writePaths: {
      facts: FACT_PATH,
      reportRoot: REPORT_ROOT,
    },
  }

  if (options.write) {
    const factPath = path.join(projectPath, FACT_PATH)
    const reportDir = path.join(projectPath, REPORT_ROOT)
    const reportPath = path.join(reportDir, `${idTimestamp()}-ifind-enhance.json`)
    const latestPath = path.join(reportDir, "latest-ifind-enhance.json")
    appendJsonl(factPath, record)
    writeJson(reportPath, record)
    writeJson(latestPath, record)
    output.written = {
      facts: projectRelative(projectPath, factPath),
      report: projectRelative(projectPath, reportPath),
      latest: projectRelative(projectPath, latestPath),
    }
  }

  return output
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  const result = await runEnhancer({
    projectPath: args.project ?? args._[0],
    symbols: args.symbols,
    "max-symbols": args["max-symbols"] ?? args._[1],
    "news-limit": args["news-limit"],
    "days-back": args["days-back"],
    write: Boolean(args.write) || args._.includes("write"),
  })
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error(err?.stack ?? err?.message ?? String(err))
  process.exit(1)
})
