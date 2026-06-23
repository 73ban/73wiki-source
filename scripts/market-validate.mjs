#!/usr/bin/env node
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const DEFAULT_PSQL = "C:/Program Files/PostgreSQL/16/bin/psql.exe"
const PSQL = process.env.WIKI73_PSQL_PATH || DEFAULT_PSQL
const HOST = process.env.WIKI73_PGHOST || "127.0.0.1"
const PORT = process.env.WIKI73_PGPORT || "55432"
const USER = process.env.WIKI73_PGUSER || "wiki73"
const DATABASE = process.env.WIKI73_PGDATABASE || "wiki73_trading"
const FACT_PATH = "data/facts/intraday_validations.jsonl"
const REPORT_ROOT = ".llm-wiki/market-validate"
const DEFAULT_TIMES = ["09:15", "09:20", "09:25", "09:31", "09:35", "09:40", "09:45", "09:50", "10:00", "10:20", "10:50", "11:30", "13:03", "13:10", "13:30", "14:00", "14:30", "14:50", "15:05"]
const SOURCE_PRIORITY = new Map([
  ["tencent-minute-bars", 1],
  ["tencent-open-price", 2],
  ["tencent-market", 3],
  ["ifind-mcp", 4],
  ["akshare-compatible-eastmoney", 5],
])

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

function printHelp() {
  console.log(`Usage:
  npm run market:validate -- --project C:\\wiki\\73神话 --trade-date 2026-06-15 --write
  npm run market:validate -- --project C:\\wiki\\73神话 --trade-date 2026-06-15 --symbols 605589,601991,603993 --write

This script validates pre-open hypotheses against intraday quote snapshots.
It writes facts/reports only. It does not create buy advice.
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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function cleanText(value) {
  return String(value ?? "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
}

function cleanJsonValue(value) {
  if (typeof value === "string") return cleanText(value)
  if (Array.isArray(value)) return value.map(cleanJsonValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [cleanText(key), cleanJsonValue(item)]))
  }
  return value
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(cleanJsonValue(value), null, 2)}\n`, "utf8")
}

function writeText(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, value, "utf8")
}

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(cleanJsonValue(record))}\n`, "utf8")
}

function sqlLit(value) {
  if (value == null || value === "") return "null"
  return `'${String(value).replace(/'/g, "''")}'`
}

function codeBase(value) {
  return String(value ?? "").replace(/\.(SH|SZ|BJ)$/i, "").trim()
}

function normalizeTradeDate(value) {
  const raw = String(value ?? "").trim()
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  const match = raw.match(/\d{4}-\d{2}-\d{2}/)
  return match?.[0] ?? nowLocalTimestamp().slice(0, 10)
}

function resolveValidationTradeDateContext(projectPath, tradeDate) {
  const preopen = readJsonMaybe(path.join(projectPath, ".llm-wiki/preopen/latest-preopen-intel.json"))
  const watchlist = readJsonMaybe(path.join(projectPath, ".llm-wiki/market-watchlist/latest-warroom-watchlist.json"))
  const cards = readJsonMaybe(path.join(projectPath, ".llm-wiki/stock-reason-cards/latest-stock-reason-cards.json"))
  const sourceTradeDates = {
    validationTradeDate: normalizeTradeDate(tradeDate),
    preopen: normalizeTradeDate(preopen?.tradeDate),
    marketWatchlistPlan: normalizeTradeDate(watchlist?.planTradeDate ?? watchlist?.tradeDate),
    marketWatchlistEvidence: normalizeTradeDate(watchlist?.evidenceTradeDate),
    stockReasonCardsPlan: normalizeTradeDate(cards?.planTradeDate ?? cards?.tradeDate),
    stockReasonCardsEvidence: normalizeTradeDate(cards?.evidenceTradeDate),
  }
  const distinct = [...new Set(Object.values(sourceTradeDates).filter(Boolean))]
  return {
    tradeDate: normalizeTradeDate(tradeDate),
    planTradeDate: normalizeTradeDate(
      cards?.planTradeDate
      ?? watchlist?.planTradeDate
      ?? watchlist?.tradeDate
      ?? preopen?.tradeDate
      ?? tradeDate,
    ),
    evidenceTradeDate: normalizeTradeDate(tradeDate),
    sourceTradeDates,
    hasDateMismatch: distinct.length > 1,
  }
}

function parseSymbols(value) {
  return String(value ?? "")
    .split(/[,\s，]+/)
    .map(codeBase)
    .map((code) => String(code).trim())
    .map((code) => (/^\d{1,6}$/.test(code) ? code.padStart(6, "0") : code))
    .filter((code) => /^\d{6}$/.test(code))
}

function runPsqlJson(sql) {
  const result = spawnSync(PSQL, ["-h", HOST, "-p", PORT, "-U", USER, "-d", DATABASE, "-X", "-q", "-t", "-A", "-c", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.status !== 0) {
    throw new Error([result.stdout, result.stderr].filter(Boolean).join("\n"))
  }
  const text = String(result.stdout ?? "").trim()
  if (!text) return []
  return JSON.parse(text)
}

function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function latestJsonlRecord(filePath, predicate = () => true) {
  if (!fs.existsSync(filePath)) return null
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const record = JSON.parse(lines[i])
      if (predicate(record)) return record
    } catch {
      // ignore malformed legacy lines
    }
  }
  return null
}

function loadFallbackSymbols(projectPath, tradeDate, maxSymbols) {
  const watchlist = readJsonMaybe(path.join(projectPath, ".llm-wiki/market-watchlist/latest-warroom-watchlist.json"))
  const preopen = readJsonMaybe(path.join(projectPath, ".llm-wiki/preopen/latest-preopen-intel.json"))
  const reasonCards = readJsonMaybe(path.join(projectPath, ".llm-wiki/stock-reason-cards/latest-stock-reason-cards.json"))
  const rows = []
  for (const item of watchlist?.tiers?.focus ?? []) rows.push({ ...item, source: "latest-watchlist" })
  for (const item of preopen?.core ?? []) rows.push({ ...item, source: "latest-preopen" })
  for (const item of reasonCards?.cards ?? []) rows.push({ ...item, source: "latest-reason-card" })

  const byCode = new Map()
  for (const item of rows) {
    const code = codeBase(item.code)
    if (!/^\d{6}$/.test(code) || byCode.has(code)) continue
    byCode.set(code, {
      code,
      name: item.name ?? "",
      rank: item.rank ?? item.priorityRank ?? byCode.size + 1,
      role: item.role ?? "watch",
      source: item.source,
      score: Number(item.score ?? 0),
      themes: item.themes ?? [],
      reasons: item.reasons ?? item.reason ?? [],
    })
  }

  const factRecord = latestJsonlRecord(path.join(projectPath, FACT_PATH), (record) => normalizeTradeDate(record.tradeDate) === tradeDate)
  for (const item of factRecord?.items ?? []) {
    const code = codeBase(item.code)
    if (!/^\d{6}$/.test(code) || byCode.has(code)) continue
    byCode.set(code, { code, name: item.name ?? "", rank: byCode.size + 1, role: item.role ?? "watch", source: "previous-validation" })
  }

  return [...byCode.values()].slice(0, maxSymbols)
}

function loadDbSymbolPool(tradeDate, maxSymbols) {
  const sql = `
with latest_watchlist as (
  select id
  from trading.warroom_watchlists
  where (generated_at at time zone 'Asia/Shanghai')::date <= date ${sqlLit(tradeDate)}
  order by generated_at desc
  limit 1
),
latest_preopen as (
  select id
  from trading.preopen_intel
  where trade_date = date ${sqlLit(tradeDate)}
  order by generated_at desc
  limit 1
),
ranked as (
  select code, name, role, priority_rank as rank, score, tier, 'warroom_watchlist' as source
  from trading.warroom_watchlist_items
  where watchlist_id in (select id from latest_watchlist)
  union all
  select code, name, role, rank, score, null as tier, 'preopen_intel' as source
  from trading.preopen_intel_items
  where intel_id in (select id from latest_preopen)
),
dedup as (
  select distinct on (code) code, name, role, rank, score, tier, source
  from ranked
  where code is not null
  order by code, case source when 'preopen_intel' then 0 else 1 end, rank nulls last, score desc nulls last
)
select coalesce(jsonb_agg(to_jsonb(d) order by d.rank nulls last, d.score desc nulls last), '[]'::jsonb)::text
from (select * from dedup limit ${Number(maxSymbols)}) d;`
  return runPsqlJson(sql).map((item, index) => ({
    code: codeBase(item.code),
    name: item.name ?? "",
    rank: Number(item.rank ?? index + 1),
    role: item.role ?? item.tier ?? "watch",
    source: item.source,
    score: Number(item.score ?? 0),
  }))
}

function loadReasonCards(tradeDate, codes) {
  if (codes.length === 0) return new Map()
  const list = codes.map(sqlLit).join(",")
  const sql = `
select coalesce(jsonb_agg(to_jsonb(r) order by r.code, r.generated_at desc), '[]'::jsonb)::text
from (
  select distinct on (code)
    code, name, role, confidence, inferred_reason, themes, catalysts, risks, evidence_files, generated_at
  from trading.stock_reason_cards
  where code in (${list})
    and trade_date <= date ${sqlLit(tradeDate)} + interval '1 day'
  order by code, trade_date desc, generated_at desc, confidence desc nulls last
) r;`
  return new Map(runPsqlJson(sql).map((item) => [codeBase(item.code), item]))
}

function loadQuotes(tradeDate, codes) {
  if (codes.length === 0) return []
  const list = codes.map(sqlLit).join(",")
  const sql = `
select coalesce(jsonb_agg(to_jsonb(q) order by q.code, q.snapshot_at, q.source), '[]'::jsonb)::text
from (
  select
    code,
    coalesce(name, '') as name,
    source,
    to_char(snapshot_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as snapshot_at,
    to_char(snapshot_at at time zone 'Asia/Shanghai', 'HH24:MI') as minute,
    price::float8 as price,
    change_percent::float8 as change_percent,
    amount::float8 as amount,
    volume::float8 as volume,
    raw
  from trading.quote_snapshots
  where code in (${list})
    and (snapshot_at at time zone 'Asia/Shanghai')::date = date ${sqlLit(tradeDate)}
) q;`
  return runPsqlJson(sql)
}

function normalizeMinuteToken(value) {
  const text = String(value ?? "").trim()
  if (/^\d{2}:\d{2}$/.test(text)) return text
  if (/^\d{4}$/.test(text)) return `${text.slice(0, 2)}:${text.slice(2, 4)}`
  return ""
}

function pctFromPrices(price, prevClose) {
  const a = Number(price)
  const b = Number(prevClose)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null
  return Number((((a - b) / b) * 100).toFixed(4))
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

function buildNameHints(projectPath, codes = []) {
  const targetCodes = new Set((codes ?? []).map((code) => codeBase(code)).filter(Boolean))
  const hints = new Map()
  const add = (code, name) => {
    const normalized = codeBase(code)
    if (!/^\d{6}$/.test(normalized) || (targetCodes.size > 0 && !targetCodes.has(normalized))) return
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

function loadTencentFallbackQuotes(projectPath, tradeDate, codes) {
  if (codes.length === 0) return []
  const payload = readJsonMaybe(path.join(projectPath, ".llm-wiki/tencent-market/latest-tencent-market.json"))
  if (!payload || normalizeTradeDate(payload.tradeDate) !== tradeDate) return []
  const nameHints = buildNameHints(projectPath, codes)

  const stockQuoteByCode = new Map(
    (payload.stockQuotes ?? [])
      .filter((item) => item?.code)
      .map((item) => [codeBase(item.code), item]),
  )

  const rows = []
  for (const code of codes) {
    const stockQuote = stockQuoteByCode.get(code)
    const prevClose = Number(stockQuote?.prevClose)
    const openPrice = Number(stockQuote?.openPrice)
    const latestPrice = Number(stockQuote?.latestPrice)
    const latestAmount = Number(stockQuote?.amount)
    const latestVolume = Number(stockQuote?.volume)
    const quoteName = preferBetterName(nameHints.get(code), stockQuote?.name ?? "")

    if (Number.isFinite(openPrice) && Number.isFinite(prevClose) && prevClose !== 0) {
      rows.push({
        code,
        name: quoteName,
        source: "tencent-open-price",
        snapshot_at: `${tradeDate} 09:25:00`,
        minute: "09:25",
        price: openPrice,
        change_percent: pctFromPrices(openPrice, prevClose),
        amount: null,
        volume: null,
        raw: { source: "stockQuotes.openPrice" },
      })
    }

    const minuteRow = (payload.minuteBars ?? []).find((item) => codeBase(item?.code) === code)
    for (const bar of minuteRow?.bars ?? []) {
      const minute = normalizeMinuteToken(bar?.time)
      const price = Number(bar?.price)
      if (!minute || !Number.isFinite(price)) continue
      rows.push({
        code,
        name: quoteName,
        source: "tencent-minute-bars",
        snapshot_at: `${tradeDate} ${minute}:00`,
        minute,
        price,
        change_percent: pctFromPrices(price, prevClose),
        amount: Number.isFinite(Number(bar?.cumulativeAmount)) ? Number(bar.cumulativeAmount) : null,
        volume: Number.isFinite(Number(bar?.cumulativeVolume)) ? Number(bar.cumulativeVolume) : null,
        raw: bar ?? null,
      })
    }

    if (Number.isFinite(latestPrice) && Number.isFinite(prevClose) && prevClose !== 0) {
      rows.push({
        code,
        name: quoteName,
        source: "tencent-market",
        snapshot_at: `${tradeDate} 15:05:00`,
        minute: "15:05",
        price: latestPrice,
        change_percent: pctFromPrices(latestPrice, prevClose),
        amount: Number.isFinite(latestAmount) ? latestAmount : null,
        volume: Number.isFinite(latestVolume) ? latestVolume : null,
        raw: { source: "stockQuotes.latestPrice" },
      })
    }
  }
  return rows
}

function loadLimitPools(tradeDate, codes) {
  if (codes.length === 0) return { limitUps: [], bursts: [], limitDowns: [], reasons: [] }
  const list = codes.map(sqlLit).join(",")
  const limitUps = runPsqlJson(`
select coalesce(jsonb_agg(to_jsonb(x) order by x.minute desc), '[]'::jsonb)::text
from (
  select code, name, source, to_char(snapshot_at at time zone 'Asia/Shanghai', 'HH24:MI') as minute,
    change_percent::float8 as change_percent, limit_up_height, first_limit_time::text,
    last_limit_time::text, seal_amount::float8, burst_count, industry, raw
  from trading.limit_up_pool
  where trade_date = date ${sqlLit(tradeDate)} and code in (${list})
) x;`)
  const bursts = runPsqlJson(`
select coalesce(jsonb_agg(to_jsonb(x) order by x.minute desc), '[]'::jsonb)::text
from (
  select code, name, source, to_char(snapshot_at at time zone 'Asia/Shanghai', 'HH24:MI') as minute,
    change_percent::float8 as change_percent, first_limit_time::text, burst_count, amplitude::float8, speed::float8, industry, raw
  from trading.burst_pool
  where trade_date = date ${sqlLit(tradeDate)} and code in (${list})
) x;`)
  const limitDowns = runPsqlJson(`
select coalesce(jsonb_agg(to_jsonb(x) order by x.minute desc), '[]'::jsonb)::text
from (
  select code, name, source, to_char(snapshot_at at time zone 'Asia/Shanghai', 'HH24:MI') as minute,
    change_percent::float8 as change_percent, seal_amount::float8, last_limit_time::text,
    continuous_down_days, open_board_count, industry, raw
  from trading.limit_down_pool
  where trade_date = date ${sqlLit(tradeDate)} and code in (${list})
) x;`)
  const reasons = runPsqlJson(`
select coalesce(jsonb_agg(to_jsonb(x) order by x.minute desc), '[]'::jsonb)::text
from (
  select code, name, reason, theme, concepts, source, source_level, confidence::float8,
    to_char(observed_at at time zone 'Asia/Shanghai', 'HH24:MI') as minute, evidence_refs
  from trading.limit_up_reasons
  where trade_date = date ${sqlLit(tradeDate)} and code in (${list})
) x;`)
  return { limitUps, bursts, limitDowns, reasons }
}

function loadEmotion(tradeDate) {
  return runPsqlJson(`
select coalesce(jsonb_agg(to_jsonb(e) order by e.minute), '[]'::jsonb)::text
from (
  select
    id,
    to_char(snapshot_at at time zone 'Asia/Shanghai', 'HH24:MI') as minute,
    source,
    payload -> 'counts' as counts,
    payload -> 'limitUpIndustries' as limit_up_industries,
    payload ->> 'summary' as summary,
    payload ->> 'claim' as claim
  from trading.market_snapshot_batches
  where source = 'akshare-compatible-eastmoney'
    and (snapshot_at at time zone 'Asia/Shanghai')::date = date ${sqlLit(tradeDate)}
) e;`)
}

function bestQuoteForMinute(rows, minute) {
  const candidates = rows.filter((row) => row.minute === minute)
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => {
    const ap = SOURCE_PRIORITY.get(a.source) ?? 99
    const bp = SOURCE_PRIORITY.get(b.source) ?? 99
    if (ap !== bp) return ap - bp
    return String(b.snapshot_at).localeCompare(String(a.snapshot_at))
  })[0]
}

function latestQuoteBefore(rows, minute) {
  const candidates = rows.filter((row) => row.minute <= minute)
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => String(b.minute).localeCompare(String(a.minute)) || ((SOURCE_PRIORITY.get(a.source) ?? 99) - (SOURCE_PRIORITY.get(b.source) ?? 99)))[0]
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function fmtPct(value) {
  const n = num(value)
  return n == null ? "-" : `${n.toFixed(2)}%`
}

function pctDelta(next, prev) {
  const a = num(next)
  const b = num(prev)
  if (a == null || b == null) return null
  return a - b
}

function fmtAmount(value) {
  const n = num(value)
  if (n == null) return "-"
  if (n >= 100000000) return `${(n / 100000000).toFixed(2)}亿`
  if (n >= 10000) return `${(n / 10000).toFixed(2)}万`
  return `${Math.round(n)}`
}

function isWeakName(name) {
  return /^(换手龙一字板|观察票候选|核心票普通票|持仓处理)?$/i.test(String(name ?? "").trim())
}

function statusFromScore({ score, latestChange, maxChange, limitHit, dataPoints }) {
  if (dataPoints === 0) return "数据不足"
  if (latestChange != null && latestChange <= -8) return "验证失败"
  if (maxChange != null && maxChange >= 9.5 && latestChange != null && latestChange >= 7) return "验证成功"
  if (limitHit && latestChange != null && latestChange >= 5) return "验证成功"
  if (latestChange != null && latestChange <= -5) return "验证失败"
  if (score >= 85) return "验证成功"
  if (score >= 65) return "观察中"
  if (score >= 45) return "弱观察"
  return "验证失败"
}

function buildVerdict(stock, reason, timeline, limitUps, bursts, limitDowns, limitReasons) {
  const points = Object.fromEntries(timeline.filter((item) => item.quote).map((item) => [item.time, item.quote]))
  const scoredTimeline = timeline.filter((item) => item.time >= "09:25")
  const changes = scoredTimeline.map((item) => num(item.quote?.change_percent)).filter((value) => value != null)
  const change0915 = num(points["09:15"]?.change_percent)
  const change0920 = num(points["09:20"]?.change_percent)
  const change0925 = num(points["09:25"]?.change_percent)
  const change0931 = num(points["09:31"]?.change_percent)
  const change0950 = num(points["09:50"]?.change_percent)
  const latest = [...timeline].reverse().find((item) => item.quote)?.quote ?? null
  const quoteName = latest?.name ?? timeline.find((item) => item.quote?.name)?.quote?.name ?? ""
  const latestChange = num(latest?.change_percent)
  const delta0915to0920 = pctDelta(change0920, change0915)
  const delta0920to0925 = pctDelta(change0925, change0920)
  const delta0915to0925 = pctDelta(change0925, change0915)
  const maxChange = changes.length ? Math.max(...changes) : null
  const minChange = changes.length ? Math.min(...changes) : null
  const limitHit = limitUps.length > 0 || (maxChange != null && maxChange >= 9.5)
  const burstHit = bursts.length > 0
  let score = 50

  if (change0925 != null) {
    if (change0925 >= 8) score += 15
    else if (change0925 >= 3) score += 8
    else if (change0925 >= 0) score += 2
    else if (change0925 <= -8) score -= 20
    else if (change0925 <= -5) score -= 12
  }
  if (delta0915to0920 != null) {
    if (delta0915to0920 >= 2) score += 8
    else if (delta0915to0920 >= 1) score += 4
    else if (delta0915to0920 <= -2) score -= 10
    else if (delta0915to0920 <= -1) score -= 5
  }
  if (delta0920to0925 != null) {
    if (delta0920to0925 >= 2) score += 8
    else if (delta0920to0925 >= 1) score += 4
    else if (delta0920to0925 <= -2) score -= 10
    else if (delta0920to0925 <= -1) score -= 5
  }
  if (change0931 != null) {
    if (change0931 >= 5) score += 10
    else if (change0931 >= 0) score += 3
    else if (change0931 <= -5) score -= 12
  }
  if (change0950 != null) {
    if (change0950 >= 9.5) score += 18
    else if (change0950 >= 5) score += 10
    else if (change0950 >= 0) score += 3
    else if (change0950 <= -5) score -= 12
  }
  if (latestChange != null) {
    if (latestChange >= 9.5) score += 20
    else if (latestChange >= 5) score += 12
    else if (latestChange >= 0) score += 3
    else if (latestChange <= -8) score -= 25
    else if (latestChange <= -5) score -= 15
  }
  if (change0925 != null && latestChange != null) {
    if (latestChange - change0925 >= 5) score += 10
    if (latestChange - change0925 <= -5) score -= 10
  }
  if (limitHit) score += 18
  if (burstHit && !limitHit) score -= 6
  if (num(reason?.confidence) != null) score += Math.round(Number(reason.confidence) * 8)
  score = Math.max(0, Math.min(100, Math.round(score)))

  const status = statusFromScore({ score, latestChange, maxChange, limitHit, dataPoints: changes.length })
  const isHolding = /持仓|holding/i.test(String(stock.role ?? ""))
  const finalStatus = isHolding ? "持仓处理" : status
  const facts = []
  if (change0915 != null) facts.push(`09:15 ${fmtPct(change0915)}`)
  if (change0920 != null) facts.push(`09:20 ${fmtPct(change0920)}`)
  if (delta0915to0920 != null) facts.push(`09:15->09:20 ${delta0915to0920 >= 0 ? "+" : ""}${delta0915to0920.toFixed(2)}pct`)
  if (change0925 != null) facts.push(`09:25 ${fmtPct(change0925)}`)
  if (delta0920to0925 != null) facts.push(`09:20->09:25 ${delta0920to0925 >= 0 ? "+" : ""}${delta0920to0925.toFixed(2)}pct`)
  if (delta0915to0925 != null) facts.push(`09:15->09:25 ${delta0915to0925 >= 0 ? "+" : ""}${delta0915to0925.toFixed(2)}pct`)
  if (change0931 != null) facts.push(`09:31 ${fmtPct(change0931)}`)
  if (change0950 != null) facts.push(`09:50 ${fmtPct(change0950)}`)
  if (latest) facts.push(`latest ${latest.minute} ${fmtPct(latestChange)}`)
  if (limitUps[0]) facts.push(`limit-up ${limitUps[0].minute} ${limitUps[0].limit_up_height ?? "-"}板`)
  if (bursts[0]) facts.push(`burst-risk ${bursts[0].minute} 炸板${bursts[0].burst_count ?? "-"}次`)
  if (limitDowns[0]) facts.push(`limit-down ${limitDowns[0].minute} 封单${fmtAmount(limitDowns[0].seal_amount)}`)

  let verdict = "缺少足够盘中报价，暂不下结论。"
  if (finalStatus === "验证成功") verdict = "盘前逻辑得到盘中价格确认，可以保留为重点复盘样本。"
  if (finalStatus === "观察中") verdict = "盘中有承接，但强度尚未完全兑现，需要继续结合板块共振和尾盘位置观察。"
  if (finalStatus === "弱观察") verdict = "强度低于核心标准，除非题材再次加强，否则降级观察。"
  if (finalStatus === "验证失败") verdict = "盘中表现明显弱于盘前预期，作为失败样本记录，后续复盘错在题材、节奏还是个股。"
  if (finalStatus === "持仓处理") {
    verdict = status === "验证失败"
      ? "持仓优先风控：盘中弱于预期，应在复盘中核查卖点和持仓逻辑是否失效。"
      : "持仓优先跟踪：先验证持仓逻辑是否继续成立，再考虑是否扩展到同题材。"
  }

  return {
    code: stock.code,
    name: preferBetterName(stock.name, !isWeakName(reason?.name) ? reason?.name : "", quoteName),
    rank: stock.rank,
    role: stock.role,
    source: stock.source,
    status: finalStatus,
    underlyingStatus: status,
    verdict,
    score,
    latestChange,
    change0915,
    change0920,
    change0925,
    change0931,
    change0950,
    delta0915to0920,
    delta0920to0925,
    delta0915to0925,
    maxChange,
    minChange,
    limitHit,
    burstHit,
    limitDowns,
    keyFacts: facts,
    reason: {
      confidence: reason?.confidence ?? null,
      inferredReason: reason?.inferred_reason ?? reason?.inferredReason ?? null,
      themes: reason?.themes ?? [],
      catalysts: reason?.catalysts ?? [],
      risks: reason?.risks ?? [],
    },
    limitReasons,
    evidenceTimes: timeline,
  }
}

function makeMarkdown(record) {
  const lines = []
  lines.push(`# ${record.tradeDate} 盘中验证`)
  lines.push("")
  lines.push(record.summary)
  lines.push(`计划交易日: ${record.planTradeDate || record.tradeDate}`)
  lines.push(`证据交易日: ${record.evidenceTradeDate || record.tradeDate}`)
  lines.push(`日期状态: ${record.hasDateMismatch ? "计划与证据日期不一致" : "一致"}`)
  lines.push("")
  lines.push("| 排名 | 代码 | 名称 | 状态 | 分数 | 关键盘中事实 | 结论 |")
  lines.push("|---:|---|---|---|---:|---|---|")
  for (const item of record.items) {
    lines.push(`| ${item.rank ?? ""} | ${item.code} | ${item.name ?? ""} | ${item.status} | ${item.score} | ${item.keyFacts.join("; ")} | ${item.verdict} |`)
  }
  lines.push("")
  lines.push("## 市场情绪快照")
  for (const item of record.marketEmotion) {
    const counts = item.counts ?? {}
    lines.push(`- ${item.minute}: 涨停 ${counts.limit_up ?? "-"}，炸板 ${counts.burst ?? "-"}，跌停 ${counts.limit_down ?? "-"}，强势 ${counts.strong ?? "-"}`)
  }
  lines.push("")
  lines.push("声明：这是盘前假设和盘中事实的验证记录，不是自动买入建议。")
  lines.push("")
  return lines.join("\n")
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const projectPath = path.resolve(args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH)
  const tradeDate = normalizeTradeDate(args["trade-date"] ?? args.date ?? args._[1] ?? nowLocalTimestamp())
  const maxSymbols = Number(args["max-symbols"] ?? 10)
  const requestedTimes = String(args.times ?? DEFAULT_TIMES.join(",")).split(/[,，\s]+/).filter(Boolean)
  const currentStamp = nowLocalTimestamp()
  const currentDate = currentStamp.slice(0, 10)
  const currentMinute = currentStamp.slice(11, 16)
  const keyTimes = tradeDate === currentDate
    ? requestedTimes.filter((time) => time <= currentMinute)
    : requestedTimes

  let stocks = parseSymbols(args.symbols).map((code, index) => ({ code, rank: index + 1, role: "core", source: "manual-symbols" }))
  if (stocks.length === 0) {
    try {
      stocks = loadDbSymbolPool(tradeDate, maxSymbols)
    } catch {
      stocks = []
    }
  }
  if (stocks.length === 0) stocks = loadFallbackSymbols(projectPath, tradeDate, maxSymbols)
  stocks = stocks.slice(0, maxSymbols)
  const codes = stocks.map((item) => codeBase(item.code)).filter(Boolean)
  if (codes.length === 0) throw new Error("No symbols to validate")

  const reasonCards = loadReasonCards(tradeDate, codes)
  const quotes = [
    ...loadQuotes(tradeDate, codes),
    ...loadTencentFallbackQuotes(projectPath, tradeDate, codes),
  ]
  const pools = loadLimitPools(tradeDate, codes)
  const marketEmotion = loadEmotion(tradeDate)
  const quotesByCode = new Map()
  for (const row of quotes) {
    const code = codeBase(row.code)
    const rows = quotesByCode.get(code) ?? []
    rows.push(row)
    quotesByCode.set(code, rows)
  }

  const limitByCode = new Map()
  for (const item of pools.limitUps) {
    const rows = limitByCode.get(codeBase(item.code)) ?? []
    rows.push(item)
    limitByCode.set(codeBase(item.code), rows)
  }
  const burstByCode = new Map()
  for (const item of pools.bursts) {
    const rows = burstByCode.get(codeBase(item.code)) ?? []
    rows.push(item)
    burstByCode.set(codeBase(item.code), rows)
  }
  const limitDownByCode = new Map()
  for (const item of pools.limitDowns) {
    const rows = limitDownByCode.get(codeBase(item.code)) ?? []
    rows.push(item)
    limitDownByCode.set(codeBase(item.code), rows)
  }
  const limitReasonByCode = new Map()
  for (const item of pools.reasons) {
    const rows = limitReasonByCode.get(codeBase(item.code)) ?? []
    rows.push(item)
    limitReasonByCode.set(codeBase(item.code), rows)
  }

  const topLimitUps = [...pools.limitUps]
    .filter((item) => item && num(item.seal_amount) != null)
    .sort((a, b) => (num(b.seal_amount) ?? 0) - (num(a.seal_amount) ?? 0))
    .slice(0, 5)
    .map((item) => ({
      code: codeBase(item.code),
      name: item.name ?? "",
      minute: item.minute ?? "",
      sealAmount: num(item.seal_amount),
      changePercent: num(item.change_percent),
      limitUpHeight: item.limit_up_height ?? null,
      firstLimitTime: item.first_limit_time ?? null,
      lastLimitTime: item.last_limit_time ?? null,
      reasonText: (limitReasonByCode.get(codeBase(item.code)) ?? [])[0]?.reason ?? "",
      source: item.source ?? "",
    }))
  const topLimitDowns = [...pools.limitDowns]
    .filter((item) => item && num(item.seal_amount) != null)
    .sort((a, b) => (num(b.seal_amount) ?? 0) - (num(a.seal_amount) ?? 0))
    .slice(0, 5)
    .map((item) => ({
      code: codeBase(item.code),
      name: item.name ?? "",
      minute: item.minute ?? "",
      sealAmount: num(item.seal_amount),
      changePercent: num(item.change_percent),
      lastLimitTime: item.last_limit_time ?? null,
      continuousDownDays: item.continuous_down_days ?? null,
      openBoardCount: item.open_board_count ?? null,
      reasonText: "",
      source: item.source ?? "",
    }))

  const items = stocks.map((stock) => {
    const code = codeBase(stock.code)
    const rows = quotesByCode.get(code) ?? []
    const timeline = keyTimes.map((time) => {
      const quote = bestQuoteForMinute(rows, time) ?? latestQuoteBefore(rows, time)
      return {
        time,
        quote: quote ? {
          minute: quote.minute,
          name: quote.name,
          source: quote.source,
          price: num(quote.price),
          change_percent: num(quote.change_percent),
          amount: num(quote.amount),
        } : null,
      }
    })
    return buildVerdict(
      { ...stock, code },
      reasonCards.get(code),
      timeline,
      limitByCode.get(code) ?? [],
      burstByCode.get(code) ?? [],
      limitDownByCode.get(code) ?? [],
      limitReasonByCode.get(code) ?? [],
    )
  })

  const generatedAt = nowLocalTimestamp()
  const dateContext = resolveValidationTradeDateContext(projectPath, tradeDate)
  const id = `intraday_validation_${tradeDate.replace(/-/g, "")}_${idTimestamp()}_${shortHash(codes.join(","))}`
  const counts = {
    success: items.filter((item) => item.status === "验证成功").length,
    watch: items.filter((item) => item.status === "观察中").length,
    weak: items.filter((item) => item.status === "弱观察").length,
    failed: items.filter((item) => item.status === "验证失败").length,
    holding: items.filter((item) => item.status === "持仓处理").length,
    noData: items.filter((item) => item.status === "数据不足").length,
  }

  const record = {
    schema: "73wiki-intraday-validation-v1",
    id,
    status: "active",
    generatedAt,
    tradeDate: dateContext.evidenceTradeDate,
    planTradeDate: dateContext.planTradeDate,
    evidenceTradeDate: dateContext.evidenceTradeDate,
    sourceTradeDates: dateContext.sourceTradeDates,
    hasDateMismatch: dateContext.hasDateMismatch,
    source: "73wiki-market-validate",
    sourceTier: "db_derived",
    projectPath,
    keyTimes,
    symbols: codes,
    counts,
    summary: `${tradeDate} 核心票盘中验证：成功 ${counts.success}，观察 ${counts.watch}，弱观察 ${counts.weak}，失败 ${counts.failed}，持仓处理 ${counts.holding}，数据不足 ${counts.noData}。`,
    marketEmotion: marketEmotion.map((item) => ({
      minute: item.minute,
      source: item.source,
      counts: item.counts,
      industries: item.limit_up_industries,
    })),
    marketPressure: {
      topLimitUps,
      topLimitDowns,
      limitUpCount: pools.limitUps.length,
      burstCount: pools.bursts.length,
      limitDownCount: pools.limitDowns.length,
    },
    items,
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }

  const reportDir = path.join(projectPath, REPORT_ROOT)
  const reportPath = path.join(reportDir, `${id}.json`)
  const latestPath = path.join(reportDir, "latest-market-validate.json")
  const markdownPath = path.join(reportDir, "latest-market-validate.md")
  if (args.write) {
    appendJsonl(path.join(projectPath, FACT_PATH), record)
    writeJson(reportPath, record)
    writeJson(latestPath, record)
    writeText(markdownPath, makeMarkdown(record))
  }

  console.log(JSON.stringify({ ok: true, reportPath, latestPath, markdownPath, record }, null, 2))
}

main()
