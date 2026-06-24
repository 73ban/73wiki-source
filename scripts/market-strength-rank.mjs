#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import https from "node:https"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73wiki"
const REPORT_ROOT = ".llm-wiki/market-strength-rank"
const FACT_PATH = "data/facts/market_strength_ranks.jsonl"
const EASTMONEY_UT = "bd1d9ddb04089700cf9c27f6f7426281"
const EASTMONEY_FIELDS = "f12,f14,f2,f3,f4,f5,f6,f8,f9,f10,f15,f16,f17,f18,f20,f21"
const EASTMONEY_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23"

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

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function latestWeekday(date = new Date()) {
  const candidate = new Date(date)
  while ([0, 6].includes(candidate.getDay())) candidate.setDate(candidate.getDate() - 1)
  return candidate
}

function projectRelative(projectPath, targetPath) {
  return path.relative(path.resolve(projectPath), path.resolve(targetPath)).replace(/\\/g, "/")
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

function httpGetJson(url) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json,text/plain,*/*" } }, (res) => {
        const chunks = []
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
          } catch {
            resolve(null)
          }
        })
      })
      .on("error", () => resolve(null))
  })
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function round(value, digits = 2) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const factor = 10 ** digits
  return Math.round(n * factor) / factor
}

function normalizeCode(value) {
  return String(value ?? "").replace(/\D/g, "").padStart(6, "0").slice(-6)
}

function isAStockCode(code) {
  return /^(00|30|60|68|8|92|43)/.test(normalizeCode(code))
}

function normalizeRow(row) {
  const code = normalizeCode(row?.f12)
  return {
    code,
    name: String(row?.f14 ?? "").trim(),
    latestPrice: num(row?.f2),
    changePercent: num(row?.f3),
    changeAmount: num(row?.f4),
    volume: num(row?.f5),
    amount: num(row?.f6),
    turnoverRate: num(row?.f8),
    peTtm: num(row?.f9),
    volumeRatio: num(row?.f10),
    highPrice: num(row?.f15),
    lowPrice: num(row?.f16),
    openPrice: num(row?.f17),
    prevClose: num(row?.f18),
    totalMarketValue: num(row?.f20),
    floatMarketValue: num(row?.f21),
  }
}

async function fetchEastmoneyPage({ page = 1, pageSize = 100 } = {}) {
  const url = new URL("https://push2.eastmoney.com/api/qt/clist/get")
  const params = {
    pn: String(page),
    pz: String(pageSize),
    po: "1",
    np: "1",
    ut: EASTMONEY_UT,
    fltt: "2",
    invt: "2",
    fid: "f3",
    fs: EASTMONEY_FS,
    fields: EASTMONEY_FIELDS,
  }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const payload = await httpGetJson(url)
  const rows = Array.isArray(payload?.data?.diff) ? payload.data.diff : []
  return {
    total: Number(payload?.data?.total ?? rows.length),
    rows: rows.map(normalizeRow).filter((row) => isAStockCode(row.code) && row.changePercent != null),
  }
}

async function fetchEastmoneyAllA({ pageSize = 100, maxPages = 80 } = {}) {
  const all = []
  let total = 0
  for (let page = 1; page <= Number(maxPages); page += 1) {
    const result = await fetchEastmoneyPage({ page, pageSize })
    total = result.total || total
    all.push(...result.rows)
    if (result.rows.length === 0) break
    if (total > 0 && all.length >= total) break
  }
  const byCode = new Map()
  for (const row of all) {
    if (!byCode.has(row.code)) byCode.set(row.code, row)
  }
  return {
    total: total || byCode.size,
    rows: [...byCode.values()],
  }
}

function addRanks(rows) {
  const byChange = [...rows].sort((a, b) => Number(b.changePercent ?? -Infinity) - Number(a.changePercent ?? -Infinity) || Number(b.amount ?? 0) - Number(a.amount ?? 0) || a.code.localeCompare(b.code))
  byChange.forEach((row, index) => {
    row.fullMarketDailyRank = index + 1
    row.fullMarketDailyPercentile = round((index + 1) / Math.max(1, byChange.length), 4)
  })
  const byAmount = [...rows].sort((a, b) => Number(b.amount ?? -Infinity) - Number(a.amount ?? -Infinity) || a.code.localeCompare(b.code))
  byAmount.forEach((row, index) => {
    row.amountRank = index + 1
  })
  return byChange
}

function buildSummary(record) {
  const top = record.topDailyStrength.slice(0, 10).map((item) => `${item.name || item.code}(${item.code}) ${item.changePercent}%`).join(", ")
  const limitLike = record.rows.filter((item) => Number(item.changePercent ?? 0) >= 9.5).length
  const bigUp = record.rows.filter((item) => Number(item.changePercent ?? 0) >= 5).length
  const bigDown = record.rows.filter((item) => Number(item.changePercent ?? 0) <= -5).length
  return `Full-market daily strength: stocks=${record.counts.stocks}, limitLike=${limitLike}, up>=5=${bigUp}, down<=-5=${bigDown}. Top: ${top}`
}

function markdown(record) {
  const lines = [
    "# Market Strength Rank",
    "",
    `Generated: ${record.generatedAt}`,
    `Evidence trade date: ${record.evidenceTradeDate}`,
    `Stocks ranked: ${record.counts.stocks}`,
    `Ranking scope: ${record.rankingScope.type}`,
    "",
    "## Top Daily Strength",
    "",
  ]
  for (const item of record.topDailyStrength) {
    lines.push(`- ${item.fullMarketDailyRank}. ${item.name || item.code}(${item.code}) change=${item.changePercent}% amountRank=${item.amountRank ?? "-"} turnover=${item.turnoverRate ?? "-"}%`)
  }
  lines.push("", "This is a full-market daily ranking snapshot. Multi-day full-market interval ranks are not generated here yet.")
  return `${lines.join("\n").trim()}\n`
}

async function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const evidenceTradeDate = normalizeTradeDate(options.tradeDate) ?? dateOnly(latestWeekday())
  const fetched = await fetchEastmoneyAllA({
    pageSize: Number(options.pageSize ?? 100),
    maxPages: Number(options.maxPages ?? 80),
  })
  const ranked = addRanks(fetched.rows)
  const topDailyStrength = ranked.slice(0, Number(options.topLimit ?? 100))
  const generatedAt = nowLocalTimestamp()
  const record = {
    schema: "73wiki-market-strength-rank-v1",
    id: `market_strength_${evidenceTradeDate.replace(/-/g, "")}_${idTimestamp()}_${shortHash(topDailyStrength.map((item) => `${item.code}:${item.changePercent}`).join("|"))}`,
    status: ranked.length > 0 ? "active" : "warning",
    generatedAt,
    projectPath,
    evidenceTradeDate,
    sourceTradeDates: {
      eastmoneyFullMarket: evidenceTradeDate,
    },
    source: "eastmoney-push2-clist",
    sourceTier: "public_api_wrapper",
    counts: {
      totalFromSource: fetched.total,
      stocks: ranked.length,
      limitLike: ranked.filter((item) => Number(item.changePercent ?? 0) >= 9.5).length,
      up5: ranked.filter((item) => Number(item.changePercent ?? 0) >= 5).length,
      down5: ranked.filter((item) => Number(item.changePercent ?? 0) <= -5).length,
    },
    rankingScope: {
      type: "full_market_daily",
      universe: "A-share public Eastmoney clist snapshot",
      dailyRankAvailable: true,
      intervalRankAvailable: false,
      note: "D1 full-market rank is available. D3/D5 full-market interval rank requires historical all-market bars and is intentionally not faked.",
    },
    topDailyStrength,
    rows: ranked,
    summary: "",
    claim: "",
    tags: ["eastmoney", "full-market", "daily-strength-rank"],
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }
  record.summary = buildSummary(record)
  record.claim = record.summary

  if (options.write) {
    const stamp = idTimestamp()
    const reportDir = path.join(projectPath, REPORT_ROOT)
    const latestJson = path.join(reportDir, "latest-market-strength-rank.json")
    const latestMd = path.join(reportDir, "latest-market-strength-rank.md")
    writeJson(path.join(reportDir, `${stamp}-market-strength-rank.json`), record)
    writeJson(latestJson, record)
    writeText(path.join(reportDir, `${stamp}-market-strength-rank.md`), markdown(record))
    writeText(latestMd, markdown(record))
    appendJsonl(path.join(projectPath, FACT_PATH), record)
    return {
      dryRun: false,
      record,
      written: {
        facts: FACT_PATH,
        latest: projectRelative(projectPath, latestJson),
        markdown: projectRelative(projectPath, latestMd),
      },
    }
  }
  return { dryRun: true, record }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/market-strength-rank.mjs --project <wiki-root> --top-limit 100 --write")
    return
  }
  const result = await run({
    projectPath: args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH,
    tradeDate: args["trade-date"],
    pageSize: Number(args["page-size"] ?? 100),
    maxPages: Number(args["max-pages"] ?? 80),
    topLimit: Number(args["top-limit"] ?? 100),
    write: Boolean(args.write || args._.includes("write")),
  })
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(JSON.stringify({
      dryRun: result.dryRun,
      id: result.record.id,
      status: result.record.status,
      evidenceTradeDate: result.record.evidenceTradeDate,
      stocks: result.record.counts.stocks,
      limitLike: result.record.counts.limitLike,
      up5: result.record.counts.up5,
      down5: result.record.counts.down5,
      top: result.record.topDailyStrength.slice(0, 10).map((item) => ({
        rank: item.fullMarketDailyRank,
        code: item.code,
        name: item.name,
        changePercent: item.changePercent,
      })),
      written: result.written ?? null,
    }, null, 2))
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
