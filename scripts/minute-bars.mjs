#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const TENCENT_FACT_PATH = "data/facts/tencent_market_snapshots.jsonl"
const FACT_PATH = "data/facts/minute_bar_snapshots.jsonl"
const REPORT_ROOT = ".llm-wiki/minute-bars"

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["write", "help", "json"].includes(key)) {
      args[key] = true
      continue
    }
    const value = argv[index + 1]
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${key}`)
    args[key] = value
    index += 1
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

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function normalizeCode(value) {
  const digits = String(value ?? "").replace(/\D/g, "")
  if (!digits) return ""
  return digits.padStart(6, "0").slice(-6)
}

function normalizeMinuteToken(value) {
  const text = String(value ?? "").trim()
  if (/^\d{2}:\d{2}$/.test(text)) return text
  if (/^\d{4}$/.test(text)) return `${text.slice(0, 2)}:${text.slice(2, 4)}`
  return ""
}

function isSessionMinute(minute) {
  if (!/^\d{2}:\d{2}$/.test(minute)) return false
  const numeric = Number(minute.replace(":", ""))
  if (numeric >= 930 && numeric <= 1130) return true
  return numeric >= 1300 && numeric <= 1500
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

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function writeText(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, value, "utf8")
}

function projectRelative(projectPath, targetPath) {
  return path.relative(path.resolve(projectPath), path.resolve(targetPath)).replace(/\\/g, "/")
}

function cleanName(value) {
  return String(value ?? "").trim()
}

function nameQuality(value) {
  const name = cleanName(value)
  if (!name) return -Infinity
  let score = 0
  const hasCjk = /[\u4e00-\u9fff]/.test(name)
  const hasAscii = /[A-Za-z]/.test(name)
  const asciiOnly = /^[A-Za-z0-9.]+$/.test(name)
  const garbled = /[锟�鎴浘鍥剧墖]/.test(name)
  if (hasCjk) score += 50
  if (hasAscii && hasCjk) score += 8
  if (asciiOnly) score -= 30
  if (name.length >= 4) score += 4
  if (garbled) score -= 80
  return score
}

function preferBetterName(...values) {
  const names = values.map((value) => cleanName(value)).filter(Boolean)
  if (names.length === 0) return ""
  return names.sort((a, b) => nameQuality(b) - nameQuality(a))[0]
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
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

function uniquePush(list, value) {
  if (value && !list.includes(value)) list.push(value)
}

function loadTencentRecords(projectPath) {
  const filePath = path.join(projectPath, TENCENT_FACT_PATH)
  const rows = readJsonl(filePath).filter((row) => row?.schema === "73wiki-tencent-market-snapshot-v1")
  const latest = readJsonMaybe(path.join(projectPath, ".llm-wiki/tencent-market/latest-tencent-market.json"))
  if (latest?.schema === "73wiki-tencent-market-snapshot-v1" && !rows.some((row) => row.id === latest.id)) rows.push(latest)
  return rows
}

function totalMinutePoints(record) {
  return (record?.minuteBars ?? []).reduce((sum, item) => sum + ((item?.bars ?? []).length || 0), 0)
}

function chooseBestSourceRecords(records, tradeDateFilter = null) {
  const grouped = new Map()
  for (const record of records) {
    const tradeDate = normalizeTradeDate(record.tradeDate ?? record.evidenceTradeDate ?? record.planTradeDate)
    if (!tradeDate) continue
    if (tradeDateFilter && tradeDate !== tradeDateFilter) continue
    const list = grouped.get(tradeDate) ?? []
    list.push(record)
    grouped.set(tradeDate, list)
  }

  const selected = []
  for (const [tradeDate, list] of grouped.entries()) {
    const best = [...list].sort((a, b) => {
      const pointDiff = totalMinutePoints(b) - totalMinutePoints(a)
      if (pointDiff !== 0) return pointDiff
      return String(b.generatedAt ?? "").localeCompare(String(a.generatedAt ?? ""))
    })[0]
    if (best) selected.push({ tradeDate, record: best, alternatives: list.length })
  }
  return selected.sort((a, b) => String(a.tradeDate).localeCompare(String(b.tradeDate)))
}

function quoteFromRow(row, nameHints = new Map()) {
  const raw = Array.isArray(row?.raw) ? row.raw : Array.isArray(row?.["原始"]) ? row["原始"] : []
  const code = normalizeCode(row?.code ?? row?.["证券代码"] ?? raw[2] ?? "")
  if (!code) return null
  const name = preferBetterName(
    nameHints.get(code),
    row?.name,
    row?.["证券简称"],
    raw[1],
  )
  return {
    code,
    name,
    openPrice: finiteNumber(row?.openPrice ?? row?.["开盘价"] ?? raw[5]),
    prevClose: finiteNumber(row?.prevClose ?? row?.["昨收"] ?? raw[4]),
    latestPrice: finiteNumber(row?.latestPrice ?? row?.["最新价"] ?? raw[3]),
  }
}

function chooseReferenceQuote(record, code, nameHints = new Map()) {
  const matches = (record.stockQuotes ?? [])
    .map((row) => quoteFromRow(row, nameHints))
    .filter((row) => row?.code === code)
  if (matches.length === 0) {
    return {
      code,
      name: nameHints.get(code) ?? "",
      openPrice: null,
      prevClose: null,
      latestPrice: null,
    }
  }
  return matches.sort((a, b) => {
    const nameDiff = nameQuality(b.name) - nameQuality(a.name)
    if (nameDiff !== 0) return nameDiff
    return Number(finiteNumber(b.latestPrice) != null) - Number(finiteNumber(a.latestPrice) != null)
  })[0]
}

function normalizeBar(rawBar) {
  const minute = normalizeMinuteToken(rawBar?.time)
  const close = finiteNumber(rawBar?.price)
  const cumulativeVolume = finiteNumber(rawBar?.cumulativeVolume)
  const cumulativeAmount = finiteNumber(rawBar?.cumulativeAmount)
  if (!minute || !isSessionMinute(minute) || close == null) return null
  return {
    minute,
    close,
    cumulativeVolume,
    cumulativeAmount,
    raw: rawBar ?? null,
  }
}

function buildOneMinuteSeries(tradeDate, minuteRow, quote) {
  const code = normalizeCode(minuteRow?.code ?? minuteRow?.symbol)
  if (!code) return null
  const normalized = (minuteRow?.bars ?? [])
    .map((bar) => normalizeBar(bar))
    .filter(Boolean)
    .sort((a, b) => String(a.minute).localeCompare(String(b.minute)))
  if (normalized.length === 0) return null

  let previousVolume = 0
  let previousAmount = 0
  let previousClose = finiteNumber(quote?.openPrice) ?? normalized[0].close
  const bars = []

  for (const bar of normalized) {
    const open = bars.length === 0 ? (finiteNumber(quote?.openPrice) ?? bar.close) : previousClose
    const close = bar.close
    const high = Math.max(open, close)
    const low = Math.min(open, close)
    const volume = bar.cumulativeVolume == null ? null : Math.max(0, bar.cumulativeVolume - previousVolume)
    const amount = bar.cumulativeAmount == null ? null : Math.max(0, bar.cumulativeAmount - previousAmount)
    if (bar.cumulativeVolume != null) previousVolume = bar.cumulativeVolume
    if (bar.cumulativeAmount != null) previousAmount = bar.cumulativeAmount
    previousClose = close
    bars.push({
      minute: bar.minute,
      snapshotAt: `${tradeDate} ${bar.minute}:00`,
      open,
      high,
      low,
      close,
      volume,
      amount,
      cumulativeVolume: bar.cumulativeVolume,
      cumulativeAmount: bar.cumulativeAmount,
      syntheticOHLC: true,
      raw: bar.raw,
    })
  }

  return {
    code,
    symbol: minuteRow?.symbol ?? "",
    name: preferBetterName(quote?.name, ""),
    interval: "1m",
    source: "tencent-minute-query-normalized",
    sourceQuality: "synthetic_ohlc_from_last_price",
    tradeDate,
    openPrice: finiteNumber(quote?.openPrice),
    prevClose: finiteNumber(quote?.prevClose),
    latestPrice: finiteNumber(quote?.latestPrice),
    bars,
  }
}

function buildBatchRecord(projectPath, tradeDate, sourceRecord, nameHints, symbolFilter = new Set()) {
  const items = []
  for (const minuteRow of sourceRecord.minuteBars ?? []) {
    const code = normalizeCode(minuteRow?.code ?? minuteRow?.symbol)
    if (!code) continue
    if (symbolFilter.size > 0 && !symbolFilter.has(code)) continue
    const quote = chooseReferenceQuote(sourceRecord, code, nameHints)
    const item = buildOneMinuteSeries(tradeDate, minuteRow, quote)
    if (item) items.push(item)
  }
  if (items.length === 0) return null

  const barCount = items.reduce((sum, item) => sum + item.bars.length, 0)
  const symbols = items.map((item) => item.code)
  const summary = `tradeDate ${tradeDate}, symbols ${items.length}, bars ${barCount}, sourceBatch ${sourceRecord.id}`
  return {
    schema: "73wiki-minute-bars-batch-v1",
    id: `minute_bars_${tradeDate.replace(/-/g, "")}_${shortHash(`${sourceRecord.id}|${symbols.join(",")}|${barCount}`)}`,
    status: "active",
    title: `${tradeDate} minute bars`,
    generatedAt: nowLocalTimestamp(),
    tradeDate,
    planTradeDate: tradeDate,
    evidenceTradeDate: tradeDate,
    sourceTradeDates: {
      tencentMarket: tradeDate,
    },
    hasDateMismatch: false,
    source: "73wiki-minute-bars",
    sourceTier: "derived_public_api",
    interval: "1m",
    sourceBatchId: sourceRecord.id,
    symbols,
    counts: {
      symbols: items.length,
      bars: barCount,
    },
    items,
    summary,
    claim: "Minute bars are normalized from Tencent minute snapshots for replay and audit, not buy advice.",
    tags: ["minute-bars", "tencent", "history", "1m"],
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }
}

function buildMarkdown(report) {
  const lines = [
    `# ${report.title}`,
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- selectedDates: ${report.selectedDates}`,
    `- written: ${report.written}`,
    `- totalSymbols: ${report.totalSymbols}`,
    `- totalBars: ${report.totalBars}`,
    "",
  ]
  if (report.samples.length > 0) {
    lines.push("## Samples")
    lines.push("")
    for (const item of report.samples) {
      lines.push(`- ${item.tradeDate} ${item.code} ${item.name} | bars=${item.barCount} | first=${item.firstMinute} | last=${item.lastMinute}`)
    }
    lines.push("")
  }
  return `${lines.join("\n")}\n`
}

function runSync(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const tradeDateFilter = normalizeTradeDate(options.tradeDate)
  const symbolFilter = new Set(String(options.symbols ?? "")
    .split(",")
    .map((item) => normalizeCode(item))
    .filter(Boolean))
  const tencentRecords = loadTencentRecords(projectPath)
  const selected = chooseBestSourceRecords(tencentRecords, tradeDateFilter)
  const nameHints = buildNameHints(projectPath, [...symbolFilter])

  let written = 0
  let totalSymbols = 0
  let totalBars = 0
  const samples = []

  for (const item of selected) {
    const record = buildBatchRecord(projectPath, item.tradeDate, item.record, nameHints, symbolFilter)
    if (!record) continue
    totalSymbols += record.counts.symbols
    totalBars += record.counts.bars
    for (const series of record.items.slice(0, 3)) {
      samples.push({
        tradeDate: item.tradeDate,
        code: series.code,
        name: series.name,
        barCount: series.bars.length,
        firstMinute: series.bars[0]?.minute ?? "",
        lastMinute: series.bars[series.bars.length - 1]?.minute ?? "",
      })
    }
    if (options.write) {
      appendJsonl(path.join(projectPath, FACT_PATH), record)
      written += 1
    }
  }

  const report = {
    schema: "73wiki-minute-bars-report-v1",
    id: `minute_bars_report_${idTimestamp()}_${shortHash(`${tradeDateFilter ?? "all"}|${[...symbolFilter].join(",")}`)}`,
    title: "73交易大脑分钟K线同步",
    generatedAt: nowLocalTimestamp(),
    projectPath,
    tradeDateFilter,
    symbolFilter: [...symbolFilter],
    sourceRecords: tencentRecords.length,
    selectedDates: selected.length,
    written,
    totalSymbols,
    totalBars,
    samples: samples.slice(0, 20),
    summary: `selected dates ${selected.length}, written ${written}, symbols ${totalSymbols}, bars ${totalBars}`,
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }

  if (!options.write) return { dryRun: true, report }

  const reportDir = path.join(projectPath, REPORT_ROOT)
  const stamp = idTimestamp()
  const jsonPath = path.join(reportDir, `${stamp}-minute-bars.json`)
  const mdPath = path.join(reportDir, `${stamp}-minute-bars.md`)
  const latestJson = path.join(reportDir, "latest-minute-bars.json")
  const latestMd = path.join(reportDir, "latest-minute-bars.md")
  writeJson(jsonPath, report)
  writeJson(latestJson, report)
  writeText(mdPath, buildMarkdown(report))
  writeText(latestMd, buildMarkdown(report))
  return {
    dryRun: false,
    report,
    written: {
      report: projectRelative(projectPath, jsonPath),
      markdown: projectRelative(projectPath, mdPath),
      latest: projectRelative(projectPath, latestJson),
      facts: FACT_PATH,
    },
  }
}

function printHelp() {
  console.log(`Usage:
  npm run minute:bars -- sync --project C:\\wiki\\73神话 --write
  npm run minute:bars -- sync --project C:\\wiki\\73神话 --trade-date 2026-06-19 --symbols 000657,002167 --write
`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    process.exit(0)
  }
  const command = args._[0] ?? "sync"
  if (command !== "sync") throw new Error(`Unsupported command: ${command}`)
  const positional = args._.slice(1)
  const positionalProject = positional.find((value) => /[:\\/]/.test(String(value ?? ""))) ?? null
  const positionalWrite = positional.some((value) => String(value ?? "").toLowerCase() === "write")
  const result = runSync({
    projectPath: args.project ?? positionalProject,
    tradeDate: args["trade-date"],
    symbols: args.symbols,
    write: Boolean(args.write || positionalWrite),
  })
  console.log(JSON.stringify(result.dryRun ? result.report : {
    dryRun: false,
    summary: result.report.summary,
    written: result.written,
  }, null, 2))
}

main()
