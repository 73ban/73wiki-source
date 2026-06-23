#!/usr/bin/env node
import fs from "node:fs"
import { createHash } from "node:crypto"
import https from "node:https"
import os from "node:os"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const BASE_URL = "https://api-mcp.51ifind.com:8643/ds-mcp-servers"
const MARKET_SNAPSHOTS_PATH = "data/facts/market_snapshots.jsonl"
const IFIND_REPORT_ROOT = ".llm-wiki/ifind-mcp"
const SERVERS = {
  stock: `${BASE_URL}/hexin-ifind-ds-stock-mcp`,
  fund: `${BASE_URL}/hexin-ifind-ds-fund-mcp`,
  edb: `${BASE_URL}/hexin-ifind-ds-edb-mcp`,
  news: `${BASE_URL}/hexin-ifind-ds-news-mcp`,
  bond: `${BASE_URL}/hexin-ifind-ds-bond-mcp`,
  global_stock: `${BASE_URL}/hexin-ifind-ds-global-stock-mcp`,
  index: `${BASE_URL}/hexin-ifind-ds-index-mcp`,
}

const DEFAULT_QUOTE_INDICATORS = [
  "最新价",
  "涨跌幅",
  "成交额",
  "成交量",
  "开盘价",
  "最高价",
  "最低价",
]

const DEFAULT_INDEX_INDICATORS = [
  "最新价",
  "涨跌幅",
  "成交额",
  "成交量",
  "上涨家数",
  "下跌家数",
  "涨停家数",
  "跌停家数",
]

const WATCHLIST_ROOTS = [
  "wiki/07-作战室",
  "wiki/03-L3个股档案/作战室个股雷达卡",
]

const DEFAULT_INDEX_SYMBOLS = "上证指数,创业板指"

function printHelp() {
  console.log(`Usage:
  npm run ifind:mcp -- status
  npm run ifind:mcp -- list --server stock|index|news|fund|edb|bond|global_stock
  npm run ifind:mcp -- call --server <type> --tool <tool> --args-json <json>
  npm run ifind:mcp -- quote --symbols 600519,300750 [--mode real_time|highfreq] [--interval 1]
  npm run ifind:mcp -- index-quote --symbols 上证指数,创业板指 [--mode real_time|highfreq] [--interval 1]
  npm run ifind:mcp -- watchlist [--project <wiki-root>] [--max-symbols 30]
  npm run ifind:mcp -- snapshot [--project <wiki-root>] [--symbols 600519,300750] [--write]

Auth lookup order:
  1. IFIND_MCP_AUTH_TOKEN
  2. IFIND_MCP_CONFIG_PATH pointing to an MCP config/json/txt file
  3. Desktop text file containing api-mcp.51ifind.com and mcpServers

This CLI only queries iFinD MCP. It does not write raw/** or wiki/**.
snapshot --write only writes data/facts/market_snapshots.jsonl and .llm-wiki/ifind-mcp reports.
`)
}

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

function readTokenFromText(text) {
  const direct = text.match(/KEY:\s*(\S+)/)?.[1]
  if (direct) return direct

  try {
    const parsed = JSON.parse(text)
    const firstServer = Object.values(parsed.mcpServers ?? {})[0]
    const token = firstServer?.headers?.Authorization ?? parsed.auth_token
    if (token) return token
  } catch {
    // Fall through to regex extraction for txt files containing JSON plus notes.
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
    if (text.includes("api-mcp.51ifind.com") && text.includes("mcpServers")) {
      return { fullPath, text }
    }
  }
  return null
}

function loadAuthToken() {
  if (process.env.IFIND_MCP_AUTH_TOKEN) return process.env.IFIND_MCP_AUTH_TOKEN.trim()

  if (process.env.IFIND_MCP_CONFIG_PATH) {
    const text = fs.readFileSync(process.env.IFIND_MCP_CONFIG_PATH, "utf8")
    const token = readTokenFromText(text)
    if (token) return token
    throw new Error(`No iFinD MCP token found in IFIND_MCP_CONFIG_PATH=${process.env.IFIND_MCP_CONFIG_PATH}`)
  }

  const desktopConfig = findDesktopMcpConfig()
  if (desktopConfig) {
    const token = readTokenFromText(desktopConfig.text)
    if (token) return token
  }

  throw new Error("No iFinD MCP token found. Set IFIND_MCP_AUTH_TOKEN or IFIND_MCP_CONFIG_PATH.")
}

function redactToken(token) {
  if (!token) return ""
  if (token.length <= 16) return "<redacted>"
  return `${token.slice(0, 8)}...${token.slice(-8)}`
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

  async post(serverType, payload, timeoutMs = 60_000) {
    const endpoint = SERVERS[serverType]
    if (!endpoint) throw new Error(`Unknown server type: ${serverType}`)
    const url = new URL(endpoint)
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
            // Keep non-JSON response body as text.
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
        clientInfo: { name: "73wiki-ifind-mcp", version: "1.0.0" },
      },
    }, 30_000)

    const sessionId = response.headers["mcp-session-id"]
    if (!sessionId) {
      throw new Error(`iFinD MCP initialize failed for ${serverType}: ${JSON.stringify(response.data)}`)
    }
    this.sessions.set(serverType, sessionId)
    await this.post(serverType, { jsonrpc: "2.0", method: "notifications/initialized" }, 10_000)
  }

  async listTools(serverType) {
    await this.initialize(serverType)
    return this.post(serverType, {
      jsonrpc: "2.0",
      id: this.nextId(serverType),
      method: "tools/list",
      params: {},
    }, 30_000)
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

function parseJsonArg(value) {
  try {
    return JSON.parse(value)
  } catch (err) {
    throw new Error(`Invalid --args-json: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2))
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

function resolveProjectPath(projectPath) {
  return path.resolve(projectPath ?? DEFAULT_PROJECT_PATH)
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

function walkFiles(rootDir, { maxFiles = 2000 } = {}) {
  const files = []
  function walk(dir) {
    if (files.length >= maxFiles || !fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= maxFiles) return
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".obsidian") continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(fullPath)
      else if (entry.isFile() && /\.(md|txt|json)$/i.test(entry.name)) files.push(fullPath)
    }
  }
  walk(rootDir)
  return files
}

function splitSymbols(value) {
  return String(value ?? "")
    .split(/[,\s，、]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))]
}

function extractStockSymbols(content) {
  const symbols = []
  const codeRegex = /\b(?:00|30|60|68|83|87|92)\d{4}\b/g
  for (const match of content.matchAll(codeRegex)) symbols.push(match[0])
  return symbols
}

function collectWatchlist({ projectPath, maxSymbols = 30, sourceLimit = 16 } = {}) {
  const root = resolveProjectPath(projectPath)
  const files = []
  for (const [rootIndex, relativeRoot] of WATCHLIST_ROOTS.entries()) {
    const fullRoot = path.join(root, relativeRoot)
    files.push(...walkFiles(fullRoot).map((file) => ({ file, rootIndex })))
  }
  const relevant = files
    .filter((item) => /作战室|候选|明日|交易计划|雷达卡|观察池/.test(item.file))
    .map((item) => ({ ...item, mtimeMs: fs.statSync(item.file).mtimeMs }))
    .sort((a, b) => a.rootIndex - b.rootIndex || b.mtimeMs - a.mtimeMs)
    .slice(0, Number(sourceLimit))

  const found = []
  const sourceFiles = []
  for (const item of relevant) {
    const content = fs.readFileSync(item.file, "utf8")
    const symbols = extractStockSymbols(content)
    if (symbols.length === 0) continue
    sourceFiles.push(projectRelative(root, item.file))
    found.push(...symbols)
  }

  return {
    projectPath: root,
    symbols: uniqueValues(found).slice(0, Number(maxSymbols)),
    sourceFiles,
    scannedFiles: relevant.length,
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

function decodeIfindToolData(response) {
  return parseNestedIfindData(decodeToolContent(response))
}

function extractQuoteRows(decoded) {
  const parsed = parseNestedIfindData(decoded)
  const tables = parsed?.data?.tables
  if (!Array.isArray(tables)) return []
  if (Array.isArray(tables[0]) && typeof tables[0][0] === "string") return tableRows(tables)
  return tables.flatMap((table) => tableRows(table))
}

function batchValues(values, size) {
  const batches = []
  for (let i = 0; i < values.length; i += size) batches.push(values.slice(i, i + size))
  return batches
}

async function queryStockQuotes(client, symbols, { mode = "real_time", interval } = {}) {
  const rows = []
  const errors = []
  for (const batch of batchValues(symbols, 10)) {
    const response = await client.callTool("stock", "stock_highfreq_quotes", {
      symbols: batch.join(","),
      indicators: DEFAULT_QUOTE_INDICATORS.join(","),
      data_mode: mode,
      interval,
    })
    const decoded = decodeIfindToolData(response)
    rows.push(...extractQuoteRows(decoded))
    if (response.statusCode >= 400 || decoded?.code !== 1) {
      errors.push({ batch, statusCode: response.statusCode, response: decoded })
    }
  }
  return { rows, errors }
}

async function queryIndexQuotes(client, symbols = DEFAULT_INDEX_SYMBOLS) {
  const response = await client.callTool("index", "index_highfreq_quotes", {
    symbols,
    indicators: DEFAULT_INDEX_INDICATORS.join(","),
    data_mode: "real_time",
  })
  const decoded = decodeIfindToolData(response)
  return { rows: extractQuoteRows(decoded), decoded, statusCode: response.statusCode }
}

function latestQuoteTime(rows) {
  return rows
    .map((row) => String(row.time ?? "").trim())
    .filter(Boolean)
    .sort()
    .at(-1) ?? null
}

function buildMarketSummary({ generatedAt, stockRows, indexRows, watchlist }) {
  const latestTime = latestQuoteTime([...stockRows, ...indexRows])
  const latestDate = latestTime?.slice(0, 10) ?? null
  const today = generatedAt.slice(0, 10)
  const sh = indexRows.find((row) => String(row["证券简称"] ?? "").includes("上证"))
  const riseCount = Number(sh?.["上涨家数"] ?? NaN)
  const fallCount = Number(sh?.["下跌家数"] ?? NaN)
  const upLimitCount = Number(sh?.["涨停家数"] ?? NaN)
  const downLimitCount = Number(sh?.["跌停家数"] ?? NaN)
  const breadth = Number.isFinite(riseCount) && Number.isFinite(fallCount)
    ? riseCount > fallCount ? "positive" : riseCount < fallCount ? "negative" : "neutral"
    : "unknown"
  const topStocks = [...stockRows]
    .sort((a, b) => Number(b["涨跌幅"] ?? -999) - Number(a["涨跌幅"] ?? -999))
    .slice(0, 8)
    .map((row) => `${row["证券简称"]}(${row["证券代码"]}) ${Number(row["涨跌幅"] ?? 0).toFixed(2)}%`)

  const stale = Boolean(latestDate && latestDate !== today)
  const summary = [
    `iFinD MCP 市场快照：关注池 ${watchlist.symbols.length} 只，返回股票行情 ${stockRows.length} 条，指数行情 ${indexRows.length} 条。`,
    latestTime ? `最新行情时间：${latestTime}${stale ? "（非今日，视为非交易日/盘后缓存）" : ""}。` : "未取得行情时间。",
    Number.isFinite(riseCount) ? `上证广度：上涨 ${riseCount} 家，下跌 ${fallCount} 家，涨停 ${upLimitCount} 家，跌停 ${downLimitCount} 家。` : "上证广度缺失。",
    topStocks.length ? `关注池涨幅前列：${topStocks.join("；")}。` : "关注池无可排序股票行情。",
  ]

  return { summary: summary.join("\n"), latestTime, latestDate, stale, breadth, riseCount, fallCount, upLimitCount, downLimitCount, topStocks }
}

async function runSnapshot(client, options = {}) {
  const projectPath = resolveProjectPath(options.projectPath)
  const generatedAt = nowLocalTimestamp()
  const explicitSymbols = splitSymbols(options.symbols)
  const watchlist = explicitSymbols.length > 0
    ? { projectPath, symbols: explicitSymbols.slice(0, Number(options.maxSymbols ?? 30)), sourceFiles: ["cli:--symbols"], scannedFiles: 0 }
    : collectWatchlist({
      projectPath,
      maxSymbols: Number(options.maxSymbols ?? 30),
      sourceLimit: Number(options["source-limit"] ?? 16),
    })
  if (watchlist.symbols.length === 0) throw new Error("No watchlist symbols found. Use --symbols or add stock codes to 作战室 files.")

  const stockQuotes = await queryStockQuotes(client, watchlist.symbols, { mode: "real_time" })
  const indexQuotes = await queryIndexQuotes(client, options.indices ?? DEFAULT_INDEX_SYMBOLS)
  const summary = buildMarketSummary({
    generatedAt,
    stockRows: stockQuotes.rows,
    indexRows: indexQuotes.rows,
    watchlist,
  })

  const record = {
    schema: "73wiki-ifind-market-snapshot-v1",
    id: `ifind_${idTimestamp()}_${shortHash(watchlist.symbols.join(","))}`,
    status: "active",
    title: `${generatedAt.slice(0, 10)} iFinD MCP 市场快照`,
    generatedAt,
    source: "ifind-mcp",
    sourceTier: "licensed_mcp",
    projectPath,
    symbols: watchlist.symbols,
    sourceFiles: watchlist.sourceFiles,
    quoteMode: "real_time",
    latestTime: summary.latestTime,
    latestDate: summary.latestDate,
    stale: summary.stale,
    breadth: {
      direction: summary.breadth,
      riseCount: summary.riseCount,
      fallCount: summary.fallCount,
      upLimitCount: summary.upLimitCount,
      downLimitCount: summary.downLimitCount,
    },
    stockQuotes: stockQuotes.rows,
    indexQuotes: indexQuotes.rows,
    errors: [...stockQuotes.errors, ...(indexQuotes.statusCode >= 400 ? [{ server: "index", response: indexQuotes.decoded }] : [])],
    summary: summary.summary,
    claim: summary.summary,
    tags: ["ifind-mcp", "market-snapshot", "watchlist", "作战室"],
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }

  const out = {
    dryRun: !options.write,
    record,
    writePaths: {
      facts: MARKET_SNAPSHOTS_PATH,
      reportRoot: IFIND_REPORT_ROOT,
    },
  }

  if (options.write) {
    const factsPath = path.join(projectPath, MARKET_SNAPSHOTS_PATH)
    const reportDir = path.join(projectPath, IFIND_REPORT_ROOT)
    const reportPath = path.join(reportDir, `${idTimestamp()}-market-snapshot.json`)
    const latestPath = path.join(reportDir, "latest-market-snapshot.json")
    appendJsonl(factsPath, record)
    writeJson(reportPath, record)
    writeJson(latestPath, record)
    out.written = {
      facts: projectRelative(projectPath, factsPath),
      report: projectRelative(projectPath, reportPath),
      latest: projectRelative(projectPath, latestPath),
    }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  if (!command || command === "help" || args.help) {
    printHelp()
    return
  }

  const token = loadAuthToken()
  const client = new IfindMcpClient({ token })

  if (command === "status") {
    printJson({
      ok: true,
      token: redactToken(token),
      servers: Object.keys(SERVERS),
      source: process.env.IFIND_MCP_AUTH_TOKEN
        ? "IFIND_MCP_AUTH_TOKEN"
        : process.env.IFIND_MCP_CONFIG_PATH
          ? "IFIND_MCP_CONFIG_PATH"
          : "Desktop MCP config",
    })
    return
  }

  if (command === "list") {
    const server = args.server ?? args._[1] ?? "stock"
    const result = await client.listTools(server)
    printJson({ statusCode: result.statusCode, data: result.data })
    return
  }

  if (command === "call") {
    const server = args.server ?? args._[1]
    const tool = args.tool ?? args._[2]
    if (!server || !tool) throw new Error("call requires --server and --tool")
    const callArgs = parseJsonArg(args["args-json"] ?? args._[3] ?? "{}")
    const result = await client.callTool(server, tool, callArgs)
    printJson({ statusCode: result.statusCode, data: decodeToolContent(result) })
    return
  }

  if (command === "quote") {
    const symbols = args.symbols ?? args._.slice(1).join(",")
    if (!symbols) throw new Error("quote requires --symbols")
    const result = await client.callTool("stock", "stock_highfreq_quotes", {
      symbols,
      indicators: args.indicators ?? DEFAULT_QUOTE_INDICATORS.join(","),
      data_mode: args.mode ?? "real_time",
      interval: args.interval ? Number(args.interval) : undefined,
    })
    printJson({ statusCode: result.statusCode, data: decodeToolContent(result) })
    return
  }

  if (command === "index-quote") {
    const symbols = args.symbols ?? args._.slice(1).join(",")
    if (!symbols) throw new Error("index-quote requires --symbols")
    const result = await client.callTool("index", "index_highfreq_quotes", {
      symbols,
      indicators: args.indicators ?? DEFAULT_INDEX_INDICATORS.join(","),
      data_mode: args.mode ?? "real_time",
      interval: args.interval ? Number(args.interval) : undefined,
    })
    printJson({ statusCode: result.statusCode, data: decodeToolContent(result) })
    return
  }

  if (command === "watchlist") {
    const result = collectWatchlist({
      projectPath: args.project ?? args._[1],
      maxSymbols: Number(args["max-symbols"] ?? args._[2] ?? 30),
      sourceLimit: Number(args["source-limit"] ?? 16),
    })
    printJson(result)
    return
  }

  if (command === "snapshot") {
    const result = await runSnapshot(client, {
      projectPath: args.project ?? args._[1],
      symbols: args.symbols,
      indices: args.indices,
      "max-symbols": args["max-symbols"] ?? args._[2],
      "source-limit": args["source-limit"],
      write: Boolean(args.write) || args._.includes("write"),
    })
    printJson(result)
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
