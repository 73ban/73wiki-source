#!/usr/bin/env node
import { createHash } from "node:crypto"
import https from "node:https"
import fs from "node:fs"
import path from "node:path"
import { sanitizeList } from "./signal-quality.mjs"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73wiki"
const REPORT_ROOT = ".llm-wiki/focus-trend-validation"
const FACT_PATH = "data/facts/focus_trend_validations.jsonl"
const FOCUS_PATH = ".llm-wiki/market-focus-universe/latest-market-focus-universe.json"
const CHECKPOINTS = [1, 3, 5]

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

function dateOnly(date = new Date()) {
  return nowLocalTimestamp(date).slice(0, 10)
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

function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function projectRelative(projectPath, targetPath) {
  return path.relative(path.resolve(projectPath), path.resolve(targetPath)).replace(/\\/g, "/")
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00`)
  date.setDate(date.getDate() + Number(days))
  return dateOnly(date)
}

function previousTradingDate(isoDate) {
  let current = addDays(isoDate, -1)
  while ([0, 6].includes(new Date(`${current}T00:00:00`).getDay())) current = addDays(current, -1)
  return current
}

function codeBase(value) {
  return String(value ?? "").replace(/\.(SH|SZ|BJ)$/i, "").replace(/\D/g, "").padStart(6, "0").slice(-6)
}

function marketPrefix(code) {
  const text = codeBase(code)
  if (/^(60|68|90)/.test(text)) return "sh"
  if (/^(00|20|30)/.test(text)) return "sz"
  if (/^(4|8|92)/.test(text)) return "bj"
  return "sz"
}

function round(value, digits = 2) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  const factor = 10 ** digits
  return Math.round(number * factor) / factor
}

function pct(base, value) {
  const a = Number(base)
  const b = Number(value)
  if (!Number.isFinite(a) || a === 0 || !Number.isFinite(b)) return null
  return round(((b - a) / a) * 100)
}

function maxNum(values) {
  const nums = values.map(Number).filter(Number.isFinite)
  return nums.length ? Math.max(...nums) : null
}

function httpGetJson(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" } }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
        } catch {
          resolve(null)
        }
      })
    }).on("error", () => resolve(null))
  })
}

async function fetchTencentDailyHistory(code, startDate, endDate) {
  const symbol = `${marketPrefix(code)}${codeBase(code)}`
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,${startDate},${endDate},80,qfq`
  const payload = await httpGetJson(url)
  const rows = payload?.data?.[symbol]?.qfqday ?? payload?.data?.[symbol]?.day ?? []
  return rows.map((row) => ({
    tradeDate: normalizeTradeDate(row[0]),
    open: Number(row[1]),
    close: Number(row[2]),
    high: Number(row[3]),
    low: Number(row[4]),
    volume: Number(row[5]),
  })).filter((row) => row.tradeDate && Number.isFinite(row.open) && Number.isFinite(row.close))
}

async function mapLimit(rows, limit, mapper) {
  const out = []
  let index = 0
  async function worker() {
    while (index < rows.length) {
      const current = rows[index]
      index += 1
      out.push(await mapper(current))
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Number(limit)) }, worker))
  return out
}

function checkpointSlice(rows, startDate, days) {
  return rows.filter((row) => row.tradeDate >= startDate).slice(0, Number(days))
}

function buildMetrics(rows, tradeDate) {
  const entryDay = rows.find((row) => row.tradeDate >= tradeDate) ?? null
  if (!entryDay) return { available: false, reason: "no_entry_day_quote" }
  const entryPrice = entryDay.open || entryDay.close
  const checkpoints = {}
  for (const days of CHECKPOINTS) {
    const slice = checkpointSlice(rows, entryDay.tradeDate, days)
    const endDay = slice.at(-1) ?? null
    checkpoints[`D${days}`] = {
      available: slice.length >= days,
      daysCovered: slice.length,
      entryTradeDate: entryDay.tradeDate,
      asOfTradeDate: endDay?.tradeDate ?? null,
      closeGainPct: endDay ? pct(entryPrice, endDay.close) : null,
      maxGainPct: maxNum(slice.map((row) => pct(entryPrice, row.high))),
      minGainPct: maxNum(slice.map((row) => {
        const value = pct(entryPrice, row.low)
        return value == null ? null : -value
      })),
    }
  }
  return { available: true, entryTradeDate: entryDay.tradeDate, entryPrice, checkpoints }
}

function classify(metrics) {
  if (!metrics.available) return "data_gap"
  const d1 = metrics.checkpoints.D1
  const d3 = metrics.checkpoints.D3
  const d5 = metrics.checkpoints.D5
  if ((d3?.maxGainPct ?? -Infinity) >= 15 || (d5?.maxGainPct ?? -Infinity) >= 20) return "trend_big_win"
  if ((d3?.maxGainPct ?? -Infinity) >= 10 || (d5?.maxGainPct ?? -Infinity) >= 15) return "trend_win"
  if ((d1?.maxGainPct ?? -Infinity) >= 9.5) return "limit_or_near_limit"
  if ((d3?.maxGainPct ?? -Infinity) >= 6 || (d5?.maxGainPct ?? -Infinity) >= 8) return "tradable_swing"
  if ((d3?.closeGainPct ?? 0) <= -3 && (d3?.maxGainPct ?? 0) < 3) return "failed"
  return "observe"
}

function addRanks(items, field, rankField) {
  const ranked = items
    .filter((item) => item[field] != null)
    .sort((a, b) => Number(b[field]) - Number(a[field]) || Number(a.focusRank ?? 999999) - Number(b.focusRank ?? 999999))
  ranked.forEach((item, index) => {
    item[rankField] = index + 1
  })
}

async function buildRecord(projectPath, options = {}) {
  const focus = readJsonMaybe(path.join(projectPath, FOCUS_PATH))
  if (!focus?.items?.length) throw new Error("market focus universe is missing or empty")
  const evidenceTradeDate = normalizeTradeDate(options.tradeDate ?? focus.evidenceTradeDate) ?? dateOnly()
  const asOfDate = normalizeTradeDate(options.asOfDate) ?? dateOnly()
  const limit = Number(options.limit ?? 500)
  const sourceItems = focus.items.slice(0, limit)
  const startDate = previousTradingDate(evidenceTradeDate)
  const items = await mapLimit(sourceItems, Number(options.concurrency ?? 8), async (item) => {
    const rows = await fetchTencentDailyHistory(item.code, startDate, asOfDate)
    const metrics = buildMetrics(rows, evidenceTradeDate)
    const d1 = metrics.checkpoints?.D1 ?? {}
    const d3 = metrics.checkpoints?.D3 ?? {}
    const d5 = metrics.checkpoints?.D5 ?? {}
    const bestMaxGainPct = maxNum([d1.maxGainPct, d3.maxGainPct, d5.maxGainPct])
    const bestCloseGainPct = maxNum([d1.closeGainPct, d3.closeGainPct, d5.closeGainPct])
    return {
      code: codeBase(item.code),
      name: item.name ?? "",
      focusRank: item.focusRank ?? null,
      focusScore: item.score ?? null,
      focusRole: item.role ?? null,
      sources: item.sources ?? [],
      themes: item.themes ?? [],
      reasons: sanitizeList(item.reasons ?? [], 8),
      metrics,
      bestMaxGainPct,
      bestCloseGainPct,
      label: classify(metrics),
    }
  })
  addRanks(items, "bestMaxGainPct", "intervalStrengthRank")
  addRanks(items, "bestCloseGainPct", "intervalCloseRank")
  addRanks(items, "focusScore", "focusScoreRank")
  const leaders = [...items]
    .filter((item) => item.bestMaxGainPct != null)
    .sort((a, b) => Number(b.bestMaxGainPct) - Number(a.bestMaxGainPct) || Number(a.focusRank ?? 999999) - Number(b.focusRank ?? 999999))
    .slice(0, 30)
  const generatedAt = nowLocalTimestamp()
  return {
    schema: "73wiki-focus-trend-validation-v1",
    id: `focus_trend_${evidenceTradeDate.replace(/-/g, "")}_${idTimestamp()}_${shortHash(items.map((item) => `${item.code}:${item.bestMaxGainPct}`).join("|"))}`,
    status: "active",
    generatedAt,
    projectPath,
    evidenceTradeDate,
    asOfDate,
    sourceFocusUniverseId: focus.id ?? null,
    marketRegime: focus.marketRegime ?? null,
    counts: {
      items: items.length,
      evaluable: items.filter((item) => item.metrics.available).length,
      trendBigWin: items.filter((item) => item.label === "trend_big_win").length,
      trendWin: items.filter((item) => item.label === "trend_win").length,
      tradable: items.filter((item) => ["trend_big_win", "trend_win", "limit_or_near_limit", "tradable_swing"].includes(item.label)).length,
      dataGap: items.filter((item) => item.label === "data_gap").length,
    },
    leaders,
    items,
    claim: "Ranks D1/D3/D5 profit outcomes inside the focus universe, so trend markets are validated by interval strength rather than only next-day limit-up.",
    writePolicy: { rawWrite: false, wikiWrite: false, buyAdvice: false, trainingSampleWrite: true },
  }
}

function markdown(record) {
  const lines = [
    "# Focus Trend Validation",
    "",
    `Generated: ${record.generatedAt}`,
    `Evidence trade date: ${record.evidenceTradeDate}`,
    `As of: ${record.asOfDate}`,
    `Items: ${record.counts.items}, evaluable: ${record.counts.evaluable}`,
    `Trend big win: ${record.counts.trendBigWin}, trend win: ${record.counts.trendWin}, tradable: ${record.counts.tradable}`,
    "",
    "## Interval Leaders",
    "",
  ]
  for (const item of record.leaders.slice(0, 30)) {
    lines.push(`- ${item.intervalStrengthRank}. ${item.name || item.code}(${item.code}) focusRank=${item.focusRank ?? "-"} role=${item.focusRole ?? "-"} D3max=${item.metrics.checkpoints?.D3?.maxGainPct ?? "-"}% D5max=${item.metrics.checkpoints?.D5?.maxGainPct ?? "-"}% best=${item.bestMaxGainPct ?? "-"}% label=${item.label}`)
  }
  lines.push("", "This validates the tracking universe only. It is not buy advice.")
  return `${lines.join("\n").trim()}\n`
}

async function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const record = await buildRecord(projectPath, options)
  if (options.write) {
    const stamp = idTimestamp()
    const outDir = path.join(projectPath, REPORT_ROOT)
    const latestJson = path.join(outDir, "latest-focus-trend-validation.json")
    const latestMd = path.join(outDir, "latest-focus-trend-validation.md")
    writeJson(path.join(outDir, `${stamp}-focus-trend-validation.json`), record)
    writeJson(latestJson, record)
    writeText(path.join(outDir, `${stamp}-focus-trend-validation.md`), markdown(record))
    writeText(latestMd, markdown(record))
    appendJsonl(path.join(projectPath, FACT_PATH), record)
    return { dryRun: false, record, written: { facts: FACT_PATH, latest: projectRelative(projectPath, latestJson), markdown: projectRelative(projectPath, latestMd) } }
  }
  return { dryRun: true, record }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/focus-trend-validation.mjs --project <wiki-root> --limit 500 --write")
    return
  }
  const result = await run({
    projectPath: args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH,
    tradeDate: args["trade-date"],
    asOfDate: args["as-of"],
    limit: Number(args.limit ?? 500),
    concurrency: Number(args.concurrency ?? 8),
    write: Boolean(args.write || args._.includes("write")),
  })
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else console.log(JSON.stringify({
    dryRun: result.dryRun,
    id: result.record.id,
    evidenceTradeDate: result.record.evidenceTradeDate,
    asOfDate: result.record.asOfDate,
    counts: result.record.counts,
    leaders: result.record.leaders.slice(0, 10).map((item) => ({
      rank: item.intervalStrengthRank,
      code: item.code,
      name: item.name,
      focusRank: item.focusRank,
      bestMaxGainPct: item.bestMaxGainPct,
      label: item.label,
    })),
    written: result.written ?? null,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
