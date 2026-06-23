#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const DEFAULT_MCP_URL = process.env.TDX_MCP_URL ?? "https://mcp.tdx.com.cn:3001/mcp"
const FACT_PATH = "data/facts/limit_up_reasons.jsonl"
const REPORT_ROOT = ".llm-wiki/limit-up-reasons"
const TDX_TOOL_NAME = "tdx_wenda_quotes"

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["write", "help", "no-tdx"].includes(key)) {
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
  npm run limitup:reasons -- C:\\wiki\\73神话 80 write
  npm run limitup:reasons -- --project C:\\wiki\\73神话 --max-items 80 --write

This creates a conservative limit-up reason skeleton from current emotion data.
The default workflow does not call TongDaXin MCP.
`)
}

function nowLocalTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
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

function loadTdxApiKey() {
  if (process.env.TDX_MCP_API_KEY) return process.env.TDX_MCP_API_KEY.trim()
  if (process.env.TDX_MCP_CONFIG_PATH) {
    const key = extractTdxKey(fs.readFileSync(process.env.TDX_MCP_CONFIG_PATH, "utf8"))
    if (key) return key
  }
  const desktopKeyFile = findDesktopKeyFile()
  if (desktopKeyFile) return extractTdxKey(fs.readFileSync(desktopKeyFile, "utf8"))
  return null
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
  return (headers ?? []).map((header) => String(header).replace(/<br>/g, " ").replace(/[#@]/g, "").trim())
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

class TdxWendaClient {
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
        clientInfo: { name: "73wiki-limit-up-reasons", version: "1.0.0" },
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

  async ask({ question, range = "AG", page = 1, size = 100 }) {
    await this.initialize()
    const response = await this.post({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "tools/call",
      params: {
        name: TDX_TOOL_NAME,
        arguments: { question, range, page, size },
      },
    }, 90_000)
    if (response.data?.result?.isError || response.data?.error) {
      const message = response.data?.result?.content?.map((item) => item.text).join("\n") ?? JSON.stringify(response.data)
      throw new Error(message)
    }
    return extractResultPayload(response.data)
  }
}

function compactDate(value) {
  const raw = String(value ?? "")
  if (/^\d{8}$/.test(raw)) return raw
  const match = raw.match(/(\d{4})-(\d{2})-(\d{2})/)
  return match ? `${match[1]}${match[2]}${match[3]}` : nowLocalTimestamp().slice(0, 10).replace(/-/g, "")
}

function codeBase(value) {
  return String(value ?? "").replace(/\.(SH|SZ|BJ)$/i, "")
}

function splitConcepts(value) {
  return [...new Set(String(value ?? "")
    .replace(/[@#]/g, "")
    .split(/[.、，,；;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean))]
}

function normalizeTdxLimitUpRow(row) {
  const code = codeBase(row.sec_code ?? row.code ?? row["代码"])
  const themeText = row["短线主题名称"] ?? row["涨停原因"] ?? row["涨停分析"] ?? row["所属行业"] ?? ""
  const reasonText = row["原因揭秘"] ?? row["涨停原因"] ?? row["涨停分析"] ?? ""
  if (!code || !reasonText) return null
  return {
    code,
    name: row.sec_name ?? row.name ?? row["名称"] ?? "",
    reasonText,
    themeText,
    concepts: splitConcepts(themeText),
    happenedAt: row["发生日期"] ?? "",
    firstLimitTime: row["首次涨停时间"] ?? row["首次封板时间"] ?? "",
    lastLimitTime: row["最近涨停时间"] ?? row["最后封板时间"] ?? "",
    openCount: row["涨停打开次数"] ?? "",
    height: row["连续涨停天数"] ?? row["几板"] ?? "",
    boardType: row["板型"] ?? "",
    raw: row,
  }
}

async function loadTdxLimitUpReasons({ maxItems, disabled }) {
  if (disabled) return { ok: false, skipped: true, rows: [], byCode: new Map(), error: null }
  const apiKey = loadTdxApiKey()
  if (!apiKey) return { ok: false, skipped: true, rows: [], byCode: new Map(), error: "missing TDX key" }
  const client = new TdxWendaClient({ apiKey })
  const questions = [
    "今日A股涨停股票列表 涨停原因 连板",
    "今日A股涨停股票列表 涨停原因 原因揭秘 连板 首次涨停时间 最近涨停时间",
    "今日A股涨停原因 连板天梯",
  ]
  const rows = []
  const errors = []
  for (const question of questions) {
    try {
      const payload = await client.ask({ question, range: "AG", page: 1, size: Math.max(20, Number(maxItems)) })
      for (const row of tableRows(payload)) {
        const normalized = normalizeTdxLimitUpRow(row)
        if (normalized) rows.push(normalized)
      }
      if (rows.length > 0) break
    } catch (err) {
      errors.push(err?.message ?? String(err))
    }
  }
  const byCode = new Map()
  for (const row of rows) if (!byCode.has(row.code)) byCode.set(row.code, row)
  return {
    ok: byCode.size > 0,
    skipped: false,
    rows: [...byCode.values()],
    byCode,
    error: errors.join(" | ") || null,
  }
}

function sourceLevel(row, isWarroom) {
  const height = Number(row["连板数"] ?? 0)
  const burst = Number(row["炸板次数"] ?? 0)
  if (isWarroom && height >= 2 && burst === 0) return "B"
  if (height >= 3 && burst <= 1) return "B"
  return "C"
}

function confidence(row, isWarroom) {
  let score = 0.3
  const height = Number(row["连板数"] ?? 0)
  const burst = Number(row["炸板次数"] ?? 0)
  if (height >= 2) score += 0.08
  if (height >= 3) score += 0.08
  if (String(row["首次封板时间"] ?? "").startsWith("09:25")) score += 0.08
  if (burst === 0) score += 0.06
  if (isWarroom) score += 0.08
  return Math.min(0.62, Number(score.toFixed(2)))
}

function nameQuality(value) {
  const name = String(value ?? "").trim()
  if (!name) return -Infinity
  let score = 0
  const hasCjk = /[\u4e00-\u9fff]/.test(name)
  const hasAscii = /[A-Za-z]/.test(name)
  const asciiOnly = /^[A-Za-z0-9.]+$/.test(name)
  if (hasCjk) score += 50
  if (hasAscii && hasCjk) score += 8
  if (asciiOnly) score -= 30
  if (name.length <= 2 && !hasCjk) score -= 40
  if (name.length >= 4) score += 4
  return score
}

function preferBetterName(...values) {
  const names = values.map((value) => String(value ?? "").trim()).filter(Boolean)
  if (names.length === 0) return ""
  return names.sort((a, b) => nameQuality(b) - nameQuality(a))[0]
}

function buildReason(row, isWarroom) {
  const parts = [
    `${row["所属行业"] || "未知行业"}涨停`,
    `${row["连板数"] || 1}板`,
    row["首次封板时间"] ? `首次封板${row["首次封板时间"]}` : "",
    row["最后封板时间"] ? `最后封板${row["最后封板时间"]}` : "",
    row["炸板次数"] != null ? `炸板${row["炸板次数"]}次` : "",
    row["封板资金"] != null ? `封板资金${row["封板资金"]}` : "",
    isWarroom ? "作战室池内票" : "",
  ].filter(Boolean)
  return parts.join("；")
}

function loadWarroomCodes(projectPath) {
  const latestPath = path.join(projectPath, ".llm-wiki/market-watchlist/latest-warroom-watchlist.json")
  if (!fs.existsSync(latestPath)) return new Set()
  const latest = readJson(latestPath)
  return new Set((latest.symbols ?? []).map((code) => String(code)))
}

function mergeTdxReason({ item, tdxReason }) {
  if (!tdxReason) return item
  const timingParts = [
    tdxReason.boardType,
    tdxReason.height ? `${tdxReason.height}板` : "",
    tdxReason.firstLimitTime ? `首次涨停${tdxReason.firstLimitTime}` : "",
    tdxReason.lastLimitTime ? `最近涨停${tdxReason.lastLimitTime}` : "",
    tdxReason.openCount !== "" ? `打开${tdxReason.openCount}次` : "",
  ].filter(Boolean)
  return {
    ...item,
    name: preferBetterName(item.name, tdxReason.name),
    reason: [tdxReason.reasonText, timingParts.join("；")].filter(Boolean).join("；"),
    theme: tdxReason.themeText || item.theme,
    concepts: tdxReason.concepts.length > 0 ? tdxReason.concepts : item.concepts,
    source: "tongdaxin-wenda-limit-up-reason",
    sourceLevel: "A",
    confidence: Math.max(item.confidence ?? 0, item.raw?.isWarroom ? 0.9 : 0.84),
    evidenceRefs: [...new Set([...(item.evidenceRefs ?? []), "F:tdx_wenda_limit_up_reason"])],
    status: "tdx_confirmed",
    raw: {
      ...item.raw,
      tdxReason,
    },
  }
}

async function buildRecord({ projectPath, maxItems, disableTdx }) {
  const emotionPath = path.join(projectPath, ".llm-wiki/akshare-emotion/latest-shortline-emotion.json")
  if (!fs.existsSync(emotionPath)) throw new Error(`Missing emotion snapshot: ${emotionPath}`)
  const emotion = readJson(emotionPath)
  const generatedAt = nowLocalTimestamp()
  const tradeDate = compactDate(emotion.tradeDate ?? emotion.generatedAt)
  const tdx = {
    ok: false,
    skipped: true,
    rows: [],
    byCode: new Map(),
    error: "disabled_by_policy",
  }
  const warroomCodes = loadWarroomCodes(projectPath)
  const ladderCodes = new Set((emotion.limitUpLadder ?? []).map((row) => String(row["代码"] ?? "")))
  const rows = [...(emotion.pools?.limit_up ?? emotion.limitUpLadder ?? [])]
    .sort((a, b) => Number(b["连板数"] ?? 0) - Number(a["连板数"] ?? 0)
      || Number(ladderCodes.has(String(b["代码"] ?? ""))) - Number(ladderCodes.has(String(a["代码"] ?? "")))
      || String(a["首次封板时间"] ?? "").localeCompare(String(b["首次封板时间"] ?? ""))
      || String(a["代码"]).localeCompare(String(b["代码"])))
    .slice(0, Number(maxItems))

  const reasons = rows.map((row) => {
    const code = codeBase(row["代码"] ?? "")
    const isWarroom = warroomCodes.has(code)
    const base = {
      id: `lur_${tradeDate}_${code}_${shortHash(JSON.stringify(row))}`,
      tradeDate,
      observedAt: generatedAt,
      code,
      name: row["名称"] ?? "",
      reason: buildReason(row, isWarroom),
      theme: row["所属行业"] ?? "",
      concepts: [row["所属行业"]].filter(Boolean),
      source: "eastmoney-limit-up-pool-skeleton",
      sourceLevel: sourceLevel(row, isWarroom),
      confidence: confidence(row, isWarroom),
      evidenceRefs: ["F:shortline_emotion_latest"],
      status: "skeleton",
      raw: {
        isWarroom,
        row,
      },
    }
    return mergeTdxReason({ item: base, tdxReason: tdx.byCode.get(code) })
  })

  const knownCodes = new Set(reasons.map((item) => item.code))
  for (const tdxReason of tdx.rows) {
    if (knownCodes.has(tdxReason.code) || reasons.length >= Number(maxItems)) continue
    const isWarroom = warroomCodes.has(tdxReason.code)
    reasons.push({
      id: `lur_${tradeDate}_${tdxReason.code}_${shortHash(JSON.stringify(tdxReason.raw))}`,
      tradeDate,
      observedAt: generatedAt,
      code: tdxReason.code,
      name: preferBetterName(tdxReason.name, tdxReason.code),
      reason: [tdxReason.reasonText, tdxReason.boardType, tdxReason.height ? `${tdxReason.height}板` : ""].filter(Boolean).join("；"),
      theme: tdxReason.themeText,
      concepts: tdxReason.concepts,
      source: "tongdaxin-wenda-limit-up-reason",
      sourceLevel: "A",
      confidence: isWarroom ? 0.9 : 0.84,
      evidenceRefs: ["F:tdx_wenda_limit_up_reason"],
      status: "tdx_confirmed",
      raw: {
        isWarroom,
        tdxReason,
      },
    })
  }

  const byTheme = new Map()
  for (const item of reasons) byTheme.set(item.theme || "未知", (byTheme.get(item.theme || "未知") ?? 0) + 1)
  const topThemes = [...byTheme.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  const evidenceTradeDate = normalizeTradeDate(tradeDate) ?? tradeDate
  return {
    schema: "73wiki-limit-up-reasons-v1",
    id: `limit_up_reasons_${tradeDate}_${idTimestamp()}_${shortHash(reasons.map((item) => item.id).join(","))}`,
    status: "active",
    title: `${tradeDate} public limit-up reason skeleton`,
    generatedAt,
    tradeDate,
    planTradeDate: evidenceTradeDate,
    evidenceTradeDate,
    sourceTradeDates: {
      limitUpReasons: evidenceTradeDate,
    },
    hasDateMismatch: false,
    source: "73wiki-limit-up-reasons",
    sourceTier: "derived_skeleton",
    reasons,
    counts: {
      reasons: reasons.length,
      warroomMatches: reasons.filter((item) => item.raw.isWarroom).length,
      tdxConfirmed: reasons.filter((item) => item.status === "tdx_confirmed").length,
    },
    tdxStatus: {
      ok: tdx.ok,
      skipped: tdx.skipped,
      rows: tdx.rows.length,
      error: tdx.error,
      policyDisabled: true,
    },
    topThemes,
    summary: `public limit-up skeleton ${reasons.length}; warroom matches ${reasons.filter((item) => item.raw.isWarroom).length}; top themes ${topThemes.map(([theme, count]) => `${theme}:${count}`).join(", ")}`,
    claim: "This record uses AKShare and public market fields to build a limit-up reason skeleton. Final theme logic still needs text confirmation from THS, Taoguba, WeChat posts, and announcements.",
    tags: ["limit-up-reason", "public-skeleton", "涨停原因", "连板天梯"],
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (args._.includes("write")) args.write = true
  const projectPath = resolveProjectPath(args.project ?? args._[0])
  const maxItems = Number(args["max-items"] ?? args._[1] ?? 100)
  const record = await buildRecord({ projectPath, maxItems, disableTdx: args["no-tdx"] })
  const reportDir = path.join(projectPath, REPORT_ROOT)
  const reportPath = path.join(reportDir, `${idTimestamp()}-limit-up-reasons.json`)
  const latestPath = path.join(reportDir, "latest-limit-up-reasons.json")
  const factPath = path.join(projectPath, FACT_PATH)
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
      facts: projectRelative(projectPath, factPath),
      report: projectRelative(projectPath, reportPath),
      latest: projectRelative(projectPath, latestPath),
    }
  }
  console.log(JSON.stringify(output, null, 2))
}

main().catch((err) => {
  console.error(err?.stack ?? err?.message ?? String(err))
  process.exit(1)
})
