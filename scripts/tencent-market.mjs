#!/usr/bin/env node
import fs from "node:fs"
import https from "node:https"
import path from "node:path"
import { TextDecoder } from "node:util"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const FACT_PATH = "data/facts/tencent_market_snapshots.jsonl"
const REPORT_ROOT = ".llm-wiki/tencent-market"

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

function nowLocalTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function compactDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function latestWeekday(date = new Date()) {
  const candidate = new Date(date)
  while (candidate.getDay() === 0 || candidate.getDay() === 6) {
    candidate.setDate(candidate.getDate() - 1)
  }
  return candidate
}

function latestMarketCompactDate(date = new Date()) {
  return compactDate(latestWeekday(date))
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

function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function normalizeCode(value) {
  return String(value ?? "").replace(/^\s*0+/, "").padStart(6, "0").slice(-6)
}

function symbolPrefix(code) {
  const normalized = normalizeCode(code)
  if (/^(6|5|9)/.test(normalized)) return "sh"
  if (/^[03]/.test(normalized)) return "sz"
  if (/^8/.test(normalized)) return "bj"
  return "sh"
}

function quoteSymbol(code) {
  return `${symbolPrefix(code)}${normalizeCode(code)}`
}

function decodeResponse(buffer, encoding = "utf-8") {
  return new TextDecoder(encoding).decode(buffer)
}

function httpGetText(url, { encoding = "utf-8" } = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "*/*",
        },
      }, (res) => {
        const chunks = []
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        res.on("end", () => resolve(decodeResponse(Buffer.concat(chunks), encoding)))
      })
      .on("error", reject)
  })
}

function httpGetJson(url, { encoding = "utf-8" } = {}) {
  return httpGetText(url, { encoding }).then((text) => {
    const trimmed = String(text ?? "").trim()
    return trimmed ? JSON.parse(trimmed) : null
  })
}

function cleanName(value) {
  const name = String(value ?? "").trim()
  if (!name) return ""
  if (/^(image|图片|截图)\s*\d+$/i.test(name)) return ""
  if (/^[*+=_#@!~`^|\\/-]+$/.test(name)) return ""
  return name
}

function nameQuality(value) {
  const name = cleanName(value)
  if (!name) return -Infinity
  let score = 0
  const hasCjk = /[\u4e00-\u9fff]/.test(name)
  const hasAscii = /[A-Za-z]/.test(name)
  const asciiOnly = /^[A-Za-z0-9.]+$/.test(name)
  const garbled = /[�]|锟|閿|鎴|璇佸埜|娑ㄨ穼/.test(name)
  if (hasCjk) score += 50
  if (hasAscii && hasCjk) score += 8
  if (asciiOnly) score -= 30
  if (name.length <= 2 && !hasCjk) score -= 40
  if (name.length >= 4) score += 4
  if (garbled) score -= 80
  return score
}

function preferBetterName(...values) {
  const names = values.map((value) => cleanName(value)).filter(Boolean)
  if (names.length === 0) return ""
  return names.sort((a, b) => nameQuality(b) - nameQuality(a))[0]
}

function buildNameHints(projectPath, codes = []) {
  const targetCodes = new Set((codes ?? []).map((code) => normalizeCode(code)).filter(Boolean))
  const hints = new Map()
  const add = (code, name) => {
    const normalized = normalizeCode(code)
    if (!normalized || (targetCodes.size > 0 && !targetCodes.has(normalized))) return
    const current = hints.get(normalized) ?? ""
    hints.set(normalized, preferBetterName(current, name))
  }

  const watchlist = readJsonMaybe(path.join(projectPath, ".llm-wiki/market-watchlist/latest-warroom-watchlist.json"))
  for (const section of ["focus", "warroom", "normal"]) {
    for (const item of watchlist?.tiers?.[section] ?? []) add(item.code, item.name)
  }

  const preopen = readJsonMaybe(path.join(projectPath, ".llm-wiki/preopen/latest-preopen-intel.json"))
  for (const item of preopen?.core ?? []) add(item.code, item.name)

  const reasonCards = readJsonMaybe(path.join(projectPath, ".llm-wiki/stock-reason-cards/latest-stock-reason-cards.json"))
  for (const item of reasonCards?.cards ?? []) add(item.code, item.name)

  const limitReasons = readJsonMaybe(path.join(projectPath, ".llm-wiki/limit-up-reasons/latest-limit-up-reasons.json"))
  for (const item of [...(limitReasons?.items ?? []), ...(limitReasons?.reasons ?? [])]) add(item.code, item.name)

  return hints
}

function parseQtQuote(raw, symbol) {
  const match = String(raw ?? "").match(/="([^"]*)"/)
  if (!match) return null
  const fields = match[1].split("~")
  const name = fields[1] ?? ""
  const code = normalizeCode(fields[2] ?? symbol.slice(-6))
  const price = Number(fields[3] ?? NaN)
  const prevClose = Number(fields[4] ?? NaN)
  const open = Number(fields[5] ?? NaN)
  const volume = Number(fields[6] ?? NaN)
  const amount = Number(fields[7] ?? NaN)
  const high = Number(fields[33] ?? NaN)
  const low = Number(fields[34] ?? NaN)
  const time = fields[30] ?? ""
  const changeAmount = Number.isFinite(price) && Number.isFinite(prevClose) ? price - prevClose : NaN
  const changePercent = Number.isFinite(price) && Number.isFinite(prevClose) && prevClose !== 0
    ? ((price - prevClose) / prevClose) * 100
    : NaN
  return {
    symbol,
    code,
    name,
    market: symbol.startsWith("sh") ? "SH" : symbol.startsWith("sz") ? "SZ" : symbol.startsWith("bj") ? "BJ" : "",
    latestPrice: Number.isFinite(price) ? Number(price.toFixed(2)) : null,
    prevClose: Number.isFinite(prevClose) ? Number(prevClose.toFixed(2)) : null,
    openPrice: Number.isFinite(open) ? Number(open.toFixed(2)) : null,
    highPrice: Number.isFinite(high) ? Number(high.toFixed(2)) : null,
    lowPrice: Number.isFinite(low) ? Number(low.toFixed(2)) : null,
    volume: Number.isFinite(volume) ? volume : null,
    amount: Number.isFinite(amount) ? amount : null,
    changeAmount: Number.isFinite(changeAmount) ? Number(changeAmount.toFixed(2)) : null,
    changePercent: Number.isFinite(changePercent) ? Number(changePercent.toFixed(2)) : null,
    time,
    raw: fields,
  }
}

function parseMinuteBars(code, payload) {
  const rows = payload?.data?.[code]?.data?.data ?? []
  return rows.map((row) => {
    const [time, price, cumulativeVolume, cumulativeAmount] = String(row).split(/\s+/)
    return {
      time,
      price: Number(price),
      cumulativeVolume: Number(cumulativeVolume),
      cumulativeAmount: Number(cumulativeAmount),
      raw: row,
    }
  }).filter((row) => row.time)
}

function parseKlineBars(code, payload) {
  const rows = payload?.data?.[code]?.qfqday ?? payload?.data?.[code]?.day ?? []
  return rows.map((row) => {
    const [date, open, close, high, low, volume] = row
    return {
      date,
      open: Number(open),
      close: Number(close),
      high: Number(high),
      low: Number(low),
      volume: Number(volume),
      raw: row,
    }
  }).filter((row) => row.date)
}

function normalizeSymbolList(value) {
  return String(value ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^(?:SH|SZ|BJ)?/i, "").replace(/[.\s](?:SH|SZ|BJ)$/i, ""))
    .map(normalizeCode)
    .filter((item) => /^\d{6}$/.test(item))
}

function buildSummary({ stockQuotes, indexQuotes, minuteBars, klineBars }) {
  const topMoves = [...stockQuotes]
    .filter((item) => Number.isFinite(item.changePercent))
    .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
    .slice(0, 8)
    .map((item) => `${item.name || item.code}(${item.code}) ${item.changePercent}%`)
  return [
    `Tencent行情快照：股票 ${stockQuotes.length} 只，指数 ${indexQuotes.length} 只，分时 ${minuteBars.length} 只，K线 ${klineBars.length} 只。`,
    topMoves.length ? `波动前列：${topMoves.join("，")}` : "波动前列：无",
  ].join("\n")
}

async function fetchQuoteBatch(symbols, nameHints = new Map()) {
  const entries = []
  for (const symbol of symbols) {
    const code = normalizeCode(symbol.slice(-6))
    try {
      const text = await httpGetText(`https://qt.gtimg.cn/q=${symbol}`, { encoding: "gb18030" })
      const parsed = parseQtQuote(text, symbol)
      if (parsed) {
        entries.push({
          ...parsed,
          code,
          name: preferBetterName(nameHints.get(code), parsed.name),
        })
      }
    } catch (error) {
      entries.push({
        symbol,
        code,
        name: nameHints.get(code) ?? "",
        market: symbol.startsWith("sh") ? "SH" : symbol.startsWith("sz") ? "SZ" : symbol.startsWith("bj") ? "BJ" : "",
        error: error?.message ?? String(error),
      })
    }
  }
  return entries
}

async function fetchMinuteAndKline(symbols, day) {
  const limited = symbols.slice(0, 10)
  const minuteBars = []
  const klineBars = []
  for (const symbol of limited) {
    try {
      const minutePayload = await httpGetJson(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}&day=${day}`)
      minuteBars.push({
        symbol,
        code: normalizeCode(symbol.slice(-6)),
        bars: parseMinuteBars(symbol, minutePayload),
      })
    } catch {
      minuteBars.push({
        symbol,
        code: normalizeCode(symbol.slice(-6)),
        bars: [],
      })
    }
    try {
      const klinePayload = await httpGetJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,5,qfq`)
      klineBars.push({
        symbol,
        code: normalizeCode(symbol.slice(-6)),
        bars: parseKlineBars(symbol, klinePayload),
      })
    } catch {
      klineBars.push({
        symbol,
        code: normalizeCode(symbol.slice(-6)),
        bars: [],
      })
    }
  }
  return { minuteBars, klineBars }
}

async function runSnapshot(options = {}) {
  const projectPath = resolveProjectPath(options.projectPath)
  const generatedAt = nowLocalTimestamp()
  const tradeDate = options.date ? String(options.date).replace(/-/g, "").slice(0, 8) : latestMarketCompactDate()
  const requestedSymbols = normalizeSymbolList(options.symbols ?? "")
  const nameHints = buildNameHints(projectPath, requestedSymbols)
  const indexSymbols = ["s_sh000001", "s_sz399001"]
  const stockSymbols = [...new Set(requestedSymbols.map(quoteSymbol))]

  const stockQuotes = await fetchQuoteBatch(stockSymbols, nameHints)
  const indexQuotes = await fetchQuoteBatch(indexSymbols)
  const { minuteBars, klineBars } = await fetchMinuteAndKline(stockSymbols, tradeDate)
  const summary = buildSummary({ stockQuotes, indexQuotes, minuteBars, klineBars })
  const evidenceTradeDate = normalizeTradeDate(tradeDate) ?? tradeDate

  const record = {
    schema: "73wiki-tencent-market-snapshot-v1",
    id: `tencent_market_${tradeDate}_${idTimestamp()}_${shortHash(summary)}`,
    status: "active",
    title: `${tradeDate} Tencent行情快照`,
    generatedAt,
    tradeDate,
    planTradeDate: evidenceTradeDate,
    evidenceTradeDate,
    sourceTradeDates: {
      tencentMarket: evidenceTradeDate,
    },
    hasDateMismatch: false,
    source: "tencent-open-api",
    sourceTier: "public_api_wrapper",
    symbolsRequested: requestedSymbols,
    stockQuotes,
    indexQuotes,
    minuteBars,
    klineBars,
    summary,
    claim: summary,
    tags: ["tencent", "quote", "minute", "kline", "market-snapshot"],
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
      facts: FACT_PATH,
      reportRoot: REPORT_ROOT,
    },
  }

  if (options.write) {
    const factsPath = path.join(projectPath, FACT_PATH)
    const reportDir = path.join(projectPath, REPORT_ROOT)
    const reportPath = path.join(reportDir, `${idTimestamp()}-${tradeDate}-tencent-market.json`)
    const latestPath = path.join(reportDir, "latest-tencent-market.json")
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

function printHelp() {
  console.log(`Usage:
  node scripts/tencent-market.mjs snapshot --project C:\\wiki\\73神话 --symbols 601991,000636 --write
  node scripts/tencent-market.mjs snapshot --project C:\\wiki\\73神话 --symbols 601991,000636

Fetch Tencent public quote/minute/K-line endpoints and write a snapshot report.
`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  if (!command || command === "help" || args.help) {
    printHelp()
    return
  }
  if (command === "snapshot") {
    const result = await runSnapshot({
      projectPath: args.project ?? args._[1],
      symbols: args.symbols ?? args._[2] ?? "",
      date: args.date ?? args._[3],
      write: Boolean(args.write) || args._.includes("write"),
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }
  throw new Error(`Unknown command: ${command}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
