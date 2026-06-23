#!/usr/bin/env node
import fs from "node:fs"
import https from "node:https"
import path from "node:path"

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
  const match = text.match(/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
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

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function httpGetText(url) {
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
          chunks.push(Buffer.from(chunk))
        })
        res.on("end", () => {
          const buffer = Buffer.concat(chunks)
          try {
            resolve(new TextDecoder("gb18030").decode(buffer))
          } catch {
            resolve(buffer.toString("utf8"))
          }
        })
      })
      .on("error", reject)
  })
}

function httpGetJson(url) {
  return httpGetText(url).then((text) => {
    const trimmed = String(text ?? "").trim()
    return trimmed ? JSON.parse(trimmed) : null
  })
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

function collectSeeds(projectPath, explicitSymbols = "") {
  const seeds = []
  for (const code of String(explicitSymbols ?? "").split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)) seeds.push(normalizeCode(code))

  const preopen = readJsonMaybe(path.join(projectPath, ".llm-wiki/preopen/latest-preopen-intel.json"))
  const watchlist = readJsonMaybe(path.join(projectPath, ".llm-wiki/market-watchlist/latest-warroom-watchlist.json"))
  const predictions = readJsonMaybe(path.join(projectPath, ".llm-wiki/prediction-candidates/latest-prediction-candidates.json"))
  const latestTencent = readJsonMaybe(path.join(projectPath, ".llm-wiki/tencent-market/latest-tencent-market.json"))

  for (const item of preopen?.core ?? []) seeds.push(normalizeCode(item.code))
  for (const item of preopen?.symbols ?? []) seeds.push(normalizeCode(item))
  for (const item of watchlist?.tiers?.focus ?? []) seeds.push(normalizeCode(item.code))
  for (const item of watchlist?.tiers?.warroom ?? []) seeds.push(normalizeCode(item.code))
  for (const code of predictions?.symbols ?? []) seeds.push(normalizeCode(code))
  for (const code of latestTencent?.symbolsRequested ?? []) seeds.push(normalizeCode(code))

  return unique(seeds).slice(0, 8)
}

async function fetchTencentIntraday(projectPath, tradeDate, symbols, { write = false } = {}) {
  const requested = unique(symbols).slice(0, 8)
  if (requested.length === 0) {
    return { skipped: true, reason: "no-symbols" }
  }

  const generatedAt = nowLocalTimestamp()
  const stockSymbols = requested.map(quoteSymbol)
  const indexSymbols = ["s_sh000001", "s_sz399001"]

  const stockQuotes = await Promise.all(stockSymbols.map(async (symbol) => {
    try {
      const text = await httpGetText(`https://qt.gtimg.cn/q=${symbol}`)
      const parsed = parseQtQuote(text, symbol)
      if (!parsed) return null
      return {
        code: normalizeCode(parsed.code),
        name: parsed.name ?? "",
        market: parsed.market ?? "",
        latestPrice: parsed.latestPrice,
        prevClose: parsed.prevClose,
        openPrice: parsed.openPrice,
        highPrice: parsed.highPrice,
        lowPrice: parsed.lowPrice,
        volume: parsed.volume,
        amount: parsed.amount,
        changeAmount: parsed.changeAmount,
        changePercent: parsed.changePercent,
        time: parsed.time ?? generatedAt,
        raw: parsed.raw,
      }
    } catch (error) {
      return {
        code: normalizeCode(symbol.slice(-6)),
        name: "",
        time: generatedAt,
        error: error?.message ?? String(error),
      }
    }
  })).then((rows) => rows.filter(Boolean))

  const indexQuotes = await Promise.all(indexSymbols.map(async (symbol) => {
    try {
      const text = await httpGetText(`https://qt.gtimg.cn/q=${symbol}`)
      const parsed = parseQtQuote(text, symbol)
      if (!parsed) return null
      return {
        code: parsed.symbol,
        name: parsed.name ?? "",
        market: parsed.market ?? "",
        latestPrice: parsed.latestPrice,
        prevClose: parsed.prevClose,
        openPrice: parsed.openPrice,
        highPrice: parsed.highPrice,
        lowPrice: parsed.lowPrice,
        volume: parsed.volume,
        amount: parsed.amount,
        changeAmount: parsed.changeAmount,
        changePercent: parsed.changePercent,
        time: parsed.time ?? generatedAt,
        raw: parsed.raw,
      }
    } catch (error) {
      return {
        code: symbol,
        name: "",
        time: generatedAt,
        error: error?.message ?? String(error),
      }
    }
  })).then((rows) => rows.filter(Boolean))

  const minuteBars = await Promise.all(stockSymbols.map(async (symbol) => {
    try {
      const minutePayload = await httpGetJson(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}&day=${tradeDate}`)
      return {
        symbol,
        code: normalizeCode(symbol.slice(-6)),
        bars: parseMinuteBars(symbol, minutePayload),
      }
    } catch {
      return {
        symbol,
        code: normalizeCode(symbol.slice(-6)),
        bars: [],
      }
    }
  }))

  const summary = [
    `Tencent intraday snapshot: stocks=${stockQuotes.length}, indices=${indexQuotes.length}, minute=${minuteBars.length}`,
    stockQuotes.length
      ? `leaders=${stockQuotes.slice(0, 6).map((item) => `${item.name || item.code}(${item.code}) ${item.changePercent ?? 0}%`).join(", ")}`
      : "leaders=none",
  ].join("\n")
  const evidenceTradeDate = normalizeTradeDate(tradeDate) ?? tradeDate

  const record = {
    schema: "73wiki-tencent-market-snapshot-v1",
    id: `tencent_market_${tradeDate}_${idTimestamp()}_${shortHash(summary)}`,
    status: "active",
    title: `${tradeDate} Tencent intraday snapshot`,
    generatedAt,
    tradeDate,
    planTradeDate: evidenceTradeDate,
    evidenceTradeDate,
    sourceTradeDates: {
      tencentMarket: evidenceTradeDate,
    },
    hasDateMismatch: false,
    source: "tencent-open-api-intraday",
    sourceTier: "public_api_wrapper",
    symbolsRequested: requested,
    stockQuotes,
    indexQuotes,
    minuteBars,
    klineBars: [],
    summary,
    claim: summary,
    tags: ["tencent", "quote", "minute", "intraday"],
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }

  if (write) {
    const factsPath = path.join(projectPath, FACT_PATH)
    const reportDir = path.join(projectPath, REPORT_ROOT)
    const reportPath = path.join(reportDir, `${idTimestamp()}-${tradeDate}-tencent-intraday.json`)
    const latestPath = path.join(reportDir, "latest-tencent-market.json")
    ensureDir(path.dirname(factsPath))
    fs.appendFileSync(factsPath, `${JSON.stringify(record)}\n`, "utf8")
    ensureDir(reportDir)
    fs.writeFileSync(reportPath, `${JSON.stringify(record, null, 2)}\n`, "utf8")
    fs.writeFileSync(latestPath, `${JSON.stringify(record, null, 2)}\n`, "utf8")
  }

  return { record }
}

function printHelp() {
  console.log(`Usage:
  node scripts/tencent-intraday.mjs --project C:\\wiki\\73神话 --write
  node scripts/tencent-intraday.mjs --project C:\\wiki\\73神话 --symbols 601991,000636 --write
`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const projectPath = resolveProjectPath(args.project ?? args._[0])
  const tradeDate = String(args.date ?? compactDate()).replace(/-/g, "").slice(0, 8)
  const symbols = collectSeeds(projectPath, args.symbols ?? args._[1] ?? "")
  const result = await fetchTencentIntraday(projectPath, tradeDate, symbols, { write: Boolean(args.write) || args._.includes("write") })
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
