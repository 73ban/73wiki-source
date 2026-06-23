#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const DEFAULT_MCP_URL = process.env.TDX_MCP_URL ?? "https://mcp.tdx.com.cn:3001/mcp"
const TDX_SNAPSHOTS_PATH = "data/facts/tdx_mcp_snapshots.jsonl"
const REPORT_ROOT = ".llm-wiki/tdx-mcp"
const TOOL_NAME = "tdx_wenda_quotes"
const WATCHLIST_ROOTS = [
  "wiki/07-作战室",
  "wiki/03-L3个股档案/作战室个股雷达卡",
]

function printHelp() {
  console.log(`Usage:
  npm run tdx:mcp -- status
  npm run tdx:mcp -- list
  npm run tdx:mcp -- ask --question "贵州茅台600519最新行情" [--range AG] [--page 1] [--size 10]
  npm run tdx:mcp -- quote --symbols 600519,300750
  npm run tdx:mcp -- snapshot [--project <wiki-root>] [--symbols 600519,300750] [--max-symbols 20] [--write]
  npm run tdx:mcp -- snapshot C:\\wiki\\73神话 20 write

Auth lookup order:
  1. TDX_MCP_API_KEY
  2. TDX_MCP_CONFIG_PATH pointing to a txt/json file containing a TDX-* key
  3. Desktop\\MCP.txt containing a TDX-* key

This CLI only queries TongDaXin MCP. It does not write raw/** or wiki/**.
snapshot --write only writes data/facts/tdx_mcp_snapshots.jsonl and .llm-wiki/tdx-mcp reports.
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
    message: "TDX chain is deprecated. Use AKShare, Tencent, iWenCai, THS hotlist, Ashare, mootdx, and iFinD instead.",
  }, null, 2))
  process.exit(2)
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

function loadTextMaybe(filePath) {
  return fs.readFileSync(filePath, "utf8")
}

function extractTdxKey(text) {
  return String(text ?? "").match(/TDX-[a-f0-9]{16,}/i)?.[0] ?? null
}

function findDesktopKeyFile() {
  const desktop = path.join(os.homedir(), "Desktop")
  const candidates = ["MCP.txt", "通达信.txt", "tdx.txt", "TDX.txt"]
  for (const name of candidates) {
    const fullPath = path.join(desktop, name)
    if (fs.existsSync(fullPath)) return fullPath
  }
  return null
}

function loadApiKey() {
  if (process.env.TDX_MCP_API_KEY) return process.env.TDX_MCP_API_KEY.trim()

  if (process.env.TDX_MCP_CONFIG_PATH) {
    const text = loadTextMaybe(process.env.TDX_MCP_CONFIG_PATH)
    const key = extractTdxKey(text)
    if (key) return key
    throw new Error(`No TDX MCP key found in TDX_MCP_CONFIG_PATH=${process.env.TDX_MCP_CONFIG_PATH}`)
  }

  const desktopKeyFile = findDesktopKeyFile()
  if (desktopKeyFile) {
    const key = extractTdxKey(loadTextMaybe(desktopKeyFile))
    if (key) return key
  }

  throw new Error("No TongDaXin MCP key found. Set TDX_MCP_API_KEY or TDX_MCP_CONFIG_PATH.")
}

function parseSseOrJson(text) {
  const chunks = []
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith("data:")) chunks.push(trimmed.slice(5).trim())
  }
  const payload = chunks.length > 0 ? chunks.join("\n") : text
  return payload?.trim() ? JSON.parse(payload) : null
}

function sanitizeHeaders(headers) {
  return headers.map((header) => String(header).replace(/<br>/g, " ").replace(/[#@]/g, "").trim())
}

function tableRows(structuredContent) {
  const headers = sanitizeHeaders(structuredContent?.headers ?? [])
  const data = structuredContent?.data ?? []
  return data.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]])))
}

function extractResultPayload(response) {
  if (response?.result?.structuredContent) return response.result.structuredContent
  const textContent = response?.result?.content?.find((item) => item.type === "text")?.text
  if (!textContent) return null
  try {
    return JSON.parse(textContent)
  } catch {
    return { text: textContent }
  }
}

function pickQuoteSummary(row) {
  if (!row) return null
  const latestKey = Object.keys(row).find((key) => key.includes("现价")) ?? "now_price"
  return {
    code: row.sec_code ?? row.code ?? row.代码 ?? "",
    name: row.sec_name ?? row.name ?? row.名称 ?? "",
    price: row.now_price ?? row[latestKey] ?? row.现价 ?? "",
    changePercent: row.chg ?? row.涨跌幅 ?? "",
    industry: row["所属行业"] ?? "",
  }
}

class TdxMcpClient {
  constructor({ apiKey, endpoint = DEFAULT_MCP_URL }) {
    this.apiKey = apiKey
    this.endpoint = endpoint
    this.sessionId = null
    this.requestId = 0
  }

  nextId() {
    this.requestId += 1
    return this.requestId
  }

  async post(payload, timeoutMs = 60_000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers = {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      }
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const body = await response.text()
      return {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        data: body ? parseSseOrJson(body) : null,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async initialize() {
    if (this.sessionId) return
    const response = await this.post({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "73wiki-tdx-mcp", version: "1.0.0" },
      },
    }, 30_000)
    const sessionId = response.headers["mcp-session-id"]
    if (!sessionId) throw new Error(`TongDaXin MCP initialize failed: ${JSON.stringify(response.data)}`)
    this.sessionId = sessionId
    await this.post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }, 30_000)
  }

  async listTools() {
    await this.initialize()
    const response = await this.post({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "tools/list",
      params: {},
    }, 30_000)
    return response.data?.result?.tools ?? []
  }

  async ask({ question, range = "AG", page = 1, size = 10 }) {
    await this.initialize()
    const response = await this.post({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "tools/call",
      params: {
        name: TOOL_NAME,
        arguments: { question, range, page, size },
      },
    }, 60_000)
    if (response.data?.result?.isError) {
      const message = response.data.result.content?.map((item) => item.text).join("\n") ?? JSON.stringify(response.data)
      throw new Error(message)
    }
    return extractResultPayload(response.data)
  }

  async callTool(name, argumentsPayload, timeoutMs = 60_000) {
    await this.initialize()
    const response = await this.post({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "tools/call",
      params: {
        name,
        arguments: argumentsPayload,
      },
    }, timeoutMs)
    if (response.data?.result?.isError || response.data?.error) {
      const message = response.data?.result?.content?.map((item) => item.text).join("\n") ?? JSON.stringify(response.data)
      throw new Error(message)
    }
    return extractResultPayload(response.data) ?? response.data
  }
}

function isTextFile(filePath) {
  return [".md", ".txt"].includes(path.extname(filePath).toLowerCase())
}

function listTextFiles(rootDir, limit = 2000) {
  const out = []
  function walk(dir) {
    if (out.length >= limit || !fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= limit) return
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile() && isTextFile(fullPath)) {
        out.push(fullPath)
      }
    }
  }
  walk(rootDir)
  return out
}

function extractWatchlistSymbols(projectPath, maxSymbols = 20) {
  const symbols = new Map()
  for (const root of WATCHLIST_ROOTS) {
    const fullRoot = path.join(projectPath, root)
    for (const filePath of listTextFiles(fullRoot)) {
      const content = fs.readFileSync(filePath, "utf8")
      for (const match of content.matchAll(/(?<!\d)(?:SH|SZ)?([036]\d{5})(?:\.(?:SH|SZ))?(?!\d)/gi)) {
        const code = match[1]
        if (!symbols.has(code)) symbols.set(code, { code, source: projectRelative(projectPath, filePath) })
        if (symbols.size >= maxSymbols) return [...symbols.values()]
      }
    }
  }
  return [...symbols.values()]
}

async function quoteSymbols(client, symbols) {
  const rows = []
  for (const symbol of symbols) {
    const code = typeof symbol === "string" ? symbol : symbol.code
    const source = typeof symbol === "string" ? "" : symbol.source
    const question = `${code}最新行情`
    try {
      const payload = await client.ask({ question, range: "AG", page: 1, size: 10 })
      const firstRow = tableRows(payload)[0] ?? null
      rows.push({
        code,
        source,
        question,
        ok: true,
        meta: payload?.meta ?? null,
        headers: payload?.headers ?? [],
        rows: tableRows(payload),
        summary: pickQuoteSummary(firstRow),
      })
    } catch (err) {
      rows.push({ code, source, question, ok: false, error: err?.message ?? String(err) })
    }
  }
  return rows
}

function buildSnapshot({ projectPath, quoteResults }) {
  const generatedAt = nowLocalTimestamp()
  const okRows = quoteResults.filter((item) => item.ok)
  const summaries = okRows.map((item) => item.summary).filter(Boolean)
  const topText = summaries
    .slice(0, 12)
    .map((item) => `${item.name || item.code}(${item.code}) ${item.changePercent || ""}% 现价${item.price || ""}`)
    .join("；")
  const title = `${generatedAt.slice(0, 10)} 通达信 MCP 实时行情快照`
  const summary = [
    `通达信 MCP 实时行情快照：请求关注池 ${quoteResults.length} 只，成功 ${okRows.length} 只，失败 ${quoteResults.length - okRows.length} 只。`,
    topText ? `关注池行情：${topText}。` : "",
    "数据来自通达信问小达 MCP；单次查询仅支持单个品种，脚本按关注池逐只查询后合并。",
  ].filter(Boolean).join("\n")

  return {
    schema: "73wiki-tdx-mcp-snapshot-v1",
    id: `tdx_${idTimestamp()}_${shortHash(JSON.stringify({ generatedAt, quoteResults }))}`,
    status: "active",
    title,
    generatedAt,
    source: "tongdaxin-mcp",
    sourceTool: TOOL_NAME,
    sourceTier: "paid_mcp",
    counts: {
      requested: quoteResults.length,
      succeeded: okRows.length,
      failed: quoteResults.length - okRows.length,
    },
    quotes: quoteResults,
    summary,
    claim: summary,
    tags: ["tongdaxin", "mcp", "real-time", "行情", "作战室"],
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
    projectPath: projectPath ? projectRelative(projectPath, projectPath) || "." : undefined,
  }
}

function resolveSnapshotArgs(args) {
  let projectPath = args.project
  let maxSymbols = Number(args["max-symbols"] ?? 20)
  const explicitSymbols = args.symbols
    ? String(args.symbols).split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean)
    : []
  let positional = args._[0] === "snapshot" ? args._.slice(1) : [...args._]

  if (positional[0] && /^[a-z]:\\/i.test(positional[0])) {
    projectPath = positional.shift()
  }
  if (positional[0] && /^\d+$/.test(positional[0])) {
    maxSymbols = Number(positional.shift())
  }
  if (positional.includes("write")) args.write = true

  return {
    projectPath: resolveProjectPath(projectPath),
    maxSymbols,
    explicitSymbols,
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2))
  ensureTdxEnabled(args)
  const command = args._[0] ?? "help"
  if (args.help || command === "help") {
    printHelp()
    return
  }

  const client = new TdxMcpClient({ apiKey: loadApiKey() })

  if (command === "status") {
    await client.initialize()
    console.log(JSON.stringify({
      ok: true,
      endpoint: DEFAULT_MCP_URL,
      session: client.sessionId ? "ok" : "missing",
      tool: TOOL_NAME,
    }, null, 2))
    return
  }

  if (command === "list") {
    const tools = await client.listTools()
    console.log(JSON.stringify(tools, null, 2))
    return
  }

  if (command === "ask") {
    const question = args.question ?? args._.slice(1).join(" ")
    if (!question) throw new Error("Missing --question")
    const payload = await client.ask({
      question,
      range: args.range ?? "AG",
      page: args.page ?? 1,
      size: args.size ?? 10,
    })
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  if (command === "api-data") {
    const payload = {}
    for (const key of ["entry", "fixedTag", "code", "extra", "pageNo", "pageSize", "industryCode", "branch"]) {
      if (args[key] != null) payload[key] = args[key]
    }
    if (!payload.entry) throw new Error("Missing --entry")
    const result = await client.callTool("tdx_api_data", payload, 90_000)
    console.log(JSON.stringify({ tool: "tdx_api_data", arguments: payload, result }, null, 2))
    return
  }

  if (command === "quote") {
    const symbolsText = args.symbols ?? args._.slice(1).join(",")
    const symbols = symbolsText.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean)
    if (symbols.length === 0) throw new Error("Missing --symbols")
    const quoteResults = await quoteSymbols(client, symbols)
    console.log(JSON.stringify({ generatedAt: nowLocalTimestamp(), quotes: quoteResults }, null, 2))
    return
  }

  if (command === "snapshot") {
    const { projectPath, maxSymbols, explicitSymbols } = resolveSnapshotArgs(args)
    const symbols = explicitSymbols.length > 0
      ? explicitSymbols.slice(0, maxSymbols).map((code) => ({ code, source: "cli:--symbols" }))
      : extractWatchlistSymbols(projectPath, maxSymbols)
    if (symbols.length === 0) throw new Error(`No watchlist symbols found under ${projectPath}`)
    const quoteResults = await quoteSymbols(client, symbols)
    const record = buildSnapshot({ projectPath, quoteResults })
    const reportRoot = path.join(projectPath, REPORT_ROOT)
    const factPath = path.join(projectPath, TDX_SNAPSHOTS_PATH)
    const reportPath = path.join(reportRoot, `${idTimestamp()}-tdx-mcp-snapshot.json`)
    const latestPath = path.join(reportRoot, "latest-tdx-mcp-snapshot.json")

    const output = {
      dryRun: !args.write,
      record,
      writePaths: {
        facts: TDX_SNAPSHOTS_PATH,
        reportRoot: REPORT_ROOT,
      },
    }

    if (args.write) {
      appendJsonl(factPath, record)
      writeJson(reportPath, record)
      writeJson(latestPath, record)
      output.written = {
        facts: TDX_SNAPSHOTS_PATH,
        report: projectRelative(projectPath, reportPath),
        latest: projectRelative(projectPath, latestPath),
      }
    }

    console.log(JSON.stringify(output, null, 2))
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

run().catch((err) => {
  console.error(err?.stack ?? err?.message ?? String(err))
  process.exit(1)
})
