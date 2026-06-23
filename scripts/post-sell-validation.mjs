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
const FACT_PATH = "data/facts/post_sell_validations.jsonl"
const REPORT_ROOT = ".llm-wiki/post-sell-validation"
const WIKI_ROOT = "wiki/09-统计与进化/卖出后验证"
const RAW_DIR_CANDIDATES = ["raw/01-交割单", "raw/交割单"]

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
  node scripts/post-sell-validation.mjs --project C:\\wiki\\73神话 --trade-date 2026-06-15 --write

This script reviews sell execution by looking at:
1. same-day pre-sell and post-sell snapshots
2. D+1 / D+3 / D+5 post-sell performance
3. limit-up continuation after the sell

It writes review facts and wiki pages only. It does not create buy advice.
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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(cleanJsonValue(record))}\n`, "utf8")
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(cleanJsonValue(value), null, 2)}\n`, "utf8")
}

function writeText(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, value, "utf8")
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/")
}

function projectRelative(projectPath, targetPath) {
  return toPosixPath(path.relative(path.resolve(projectPath), path.resolve(targetPath)))
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))]
}

function numberOrNull(value) {
  if (value == null || value === "") return null
  const text = String(value).replace(/[,%￥¥]/g, "").replace(/,/g, "").trim()
  if (!text) return null
  const num = Number(text)
  return Number.isFinite(num) ? num : null
}

function pct(base, value) {
  if (!Number.isFinite(base) || base === 0 || !Number.isFinite(value)) return null
  return ((value - base) / base) * 100
}

function normalizeTradeDate(value) {
  const raw = String(value ?? "").trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  const match = raw.match(/\d{4}-\d{2}-\d{2}/)
  return match?.[0] ?? ""
}

function normalizeTime(value) {
  const raw = String(value ?? "").trim()
  const match = raw.match(/(\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!match) return ""
  return `${match[1]}:${match[2]}:${match[3] ?? "00"}`
}

function minuteText(value) {
  return normalizeTime(value).slice(0, 5)
}

function codeBase(value) {
  return String(value ?? "").replace(/\.(SH|SZ|BJ)$/i, "").trim()
}

function sqlLit(value) {
  if (value == null || value === "") return "null"
  return `'${String(value).replace(/'/g, "''")}'`
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

function walkMarkdownFiles(rootDir) {
  const result = []
  if (!fs.existsSync(rootDir)) return result
  const stack = [rootDir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (entry.isFile() && /\.md$/i.test(entry.name)) result.push(fullPath)
    }
  }
  return result.sort()
}

function splitTableLine(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
}

function isSeparatorRow(line) {
  return /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line)
}

function parseMarkdownTables(content) {
  const lines = String(content ?? "").split(/\r?\n/)
  const tables = []
  let i = 0
  while (i < lines.length - 1) {
    if (!/^\s*\|/.test(lines[i]) || !isSeparatorRow(lines[i + 1])) {
      i += 1
      continue
    }
    const header = splitTableLine(lines[i])
    i += 2
    const rows = []
    while (i < lines.length && /^\s*\|/.test(lines[i])) {
      if (!isSeparatorRow(lines[i])) rows.push(splitTableLine(lines[i]))
      i += 1
    }
    tables.push({ header, rows })
  }
  return tables
}

function normHeader(value) {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase()
}

function detectHeaderMap(header) {
  const map = {}
  header.forEach((raw, index) => {
    const key = normHeader(raw)
    if (map.time == null && /(时间|成交时间|时刻)/.test(key)) map.time = index
    if (map.direction == null && /(方向|买卖|操作|业务)/.test(key)) map.direction = index
    if (map.target == null && /(标的|证券|股票|名称代码|证券名称证券代码|名称\/代码)/.test(key)) map.target = index
    if (map.code == null && /(代码|证券代码)/.test(key)) map.code = index
    if (map.name == null && /(名称|证券名称)/.test(key)) map.name = index
    if (map.price == null && /(成交价|均价|价格|成交均价)/.test(key)) map.price = index
    if (map.quantity == null && /(数量|成交量|成交数量|股数)/.test(key)) map.quantity = index
    if (map.amount == null && /(金额|成交金额|发生金额)/.test(key)) map.amount = index
  })
  return map
}

function extractTarget(codeCell, nameCell, targetCell) {
  const blob = [targetCell, nameCell, codeCell].filter(Boolean).join(" ")
  const code = codeBase(blob.match(/\d{6}(?:\.(?:SH|SZ|BJ))?/)?.[0] ?? "")
  const nameSource = targetCell || nameCell || blob
  const name = cleanText(
    String(nameSource ?? "")
      .replace(/\d{6}(?:\.(?:SH|SZ|BJ))?/g, "")
      .replace(/[()（）]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
  return { code, name }
}

export function parseSellRecordsFromMarkdown(content, sourcePath = "") {
  const tables = parseMarkdownTables(content)
  const records = []
  for (const table of tables) {
    const headerMap = detectHeaderMap(table.header)
    if (headerMap.direction == null || (headerMap.target == null && headerMap.code == null && headerMap.name == null)) continue
    for (const row of table.rows) {
      const directionText = cleanText(row[headerMap.direction] ?? "")
      if (!/卖|减仓|平仓|退出/.test(directionText) || /买/.test(directionText)) continue
      const price = numberOrNull(row[headerMap.price])
      const quantity = numberOrNull(row[headerMap.quantity])
      if (!Number.isFinite(price) || !Number.isFinite(quantity) || quantity <= 0) continue
      const time = normalizeTime(row[headerMap.time] ?? "")
      if (!time) continue
      const amount = numberOrNull(row[headerMap.amount]) ?? price * quantity
      const { code, name } = extractTarget(row[headerMap.code], row[headerMap.name], row[headerMap.target])
      if (!/^\d{6}$/.test(code)) continue
      records.push({
        time,
        code,
        name,
        side: "sell",
        price,
        quantity,
        amount,
        directionText,
        sourcePath,
      })
    }
  }
  return records
}

function inferTradeDate(filePath, content) {
  const fileMatch = toPosixPath(filePath).match(/(\d{4}-\d{2}-\d{2})/)
  if (fileMatch) return fileMatch[1]
  const contentMatch = String(content ?? "").match(/\d{4}-\d{2}-\d{2}/)
  return contentMatch?.[0] ?? ""
}

function collectSellRecords(projectPath, tradeDate) {
  const items = []
  for (const relativeDir of RAW_DIR_CANDIDATES) {
    const rootDir = path.join(projectPath, relativeDir)
    for (const filePath of walkMarkdownFiles(rootDir)) {
      const content = fs.readFileSync(filePath, "utf8")
      const fileTradeDate = inferTradeDate(filePath, content)
      if (tradeDate && fileTradeDate !== tradeDate) continue
      for (const record of parseSellRecordsFromMarkdown(content, projectRelative(projectPath, filePath))) {
        items.push({
          ...record,
          tradeDate: fileTradeDate,
        })
      }
    }
  }
  const dedup = new Map()
  for (const item of items) {
    const key = [item.tradeDate, item.time, item.code, item.price, item.quantity, item.sourcePath].join("|")
    if (!dedup.has(key)) dedup.set(key, item)
  }
  return [...dedup.values()].sort((a, b) =>
    `${a.tradeDate}T${a.time}`.localeCompare(`${b.tradeDate}T${b.time}`),
  )
}

function loadQuotesAroundSell(code, tradeDate, lookaheadDays) {
  const sql = `
select coalesce(jsonb_agg(to_jsonb(q) order by q.snapshot_at asc), '[]'::jsonb)::text
from (
  select
    code,
    coalesce(name, '') as name,
    source,
    to_char(snapshot_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as snapshot_at,
    to_char(snapshot_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD') as trade_date,
    to_char(snapshot_at at time zone 'Asia/Shanghai', 'HH24:MI') as minute,
    price::float8 as price,
    change_percent::float8 as change_percent
  from trading.quote_snapshots
  where code = ${sqlLit(code)}
    and (snapshot_at at time zone 'Asia/Shanghai')::date between date ${sqlLit(tradeDate)} and date ${sqlLit(tradeDate)} + interval '${Number(lookaheadDays)} day'
  union all
  select
    code,
    coalesce(name, '') as name,
    source,
    to_char(snapshot_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as snapshot_at,
    to_char(snapshot_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD') as trade_date,
    minute,
    close_price::float8 as price,
    null::float8 as change_percent
  from trading.minute_bars
  where code = ${sqlLit(code)}
    and trade_date between date ${sqlLit(tradeDate)} and date ${sqlLit(tradeDate)} + interval '${Number(lookaheadDays)} day'
  order by snapshot_at asc, source asc
) q;`
  return runPsqlJson(sql)
}

function loadLimitUpsAfterSell(code, tradeDate, lookaheadDays) {
  const sql = `
select coalesce(jsonb_agg(to_jsonb(q) order by q.trade_date asc, q.snapshot_at asc), '[]'::jsonb)::text
from (
  select
    code,
    coalesce(name, '') as name,
    source,
    to_char(trade_date, 'YYYY-MM-DD') as trade_date,
    to_char(snapshot_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as snapshot_at,
    to_char(snapshot_at at time zone 'Asia/Shanghai', 'HH24:MI') as minute,
    change_percent::float8 as change_percent,
    limit_up_height,
    first_limit_time::text as first_limit_time,
    last_limit_time::text as last_limit_time,
    burst_count,
    industry
  from trading.limit_up_pool
  where code = ${sqlLit(code)}
    and trade_date between date ${sqlLit(tradeDate)} and date ${sqlLit(tradeDate)} + interval '${Number(lookaheadDays)} day'
  order by trade_date asc, snapshot_at asc
) q;`
  return runPsqlJson(sql)
}

function latestByMinute(rows) {
  const byMinute = new Map()
  for (const row of rows) {
    const key = `${row.trade_date} ${row.minute}`
    const old = byMinute.get(key)
    if (!old || String(old.source).localeCompare(String(row.source)) > 0) byMinute.set(key, row)
  }
  return [...byMinute.values()].sort((a, b) => `${a.trade_date} ${a.minute}`.localeCompare(`${b.trade_date} ${b.minute}`))
}

function daySummaryFromQuotes(rows, sellPrice) {
  if (rows.length === 0) return null
  const prices = rows.map((item) => Number(item.price)).filter(Number.isFinite)
  if (prices.length === 0) return null
  const high = Math.max(...prices)
  const low = Math.min(...prices)
  const close = prices[prices.length - 1]
  return {
    tradeDate: rows[0].trade_date,
    close,
    high,
    low,
    highGainPct: pct(sellPrice, high),
    lowGainPct: pct(sellPrice, low),
    closeGainPct: pct(sellPrice, close),
    closeMinute: rows[rows.length - 1].minute,
    highMinute: rows.find((item) => Number(item.price) === high)?.minute ?? "",
    lowMinute: rows.find((item) => Number(item.price) === low)?.minute ?? "",
  }
}

export function classifySellValidation(metrics) {
  const hasEvidence = [
    metrics.preSellMissPct,
    metrics.sameDayAfterHighGainPct,
    metrics.sameDayAfterCloseGainPct,
    metrics.d1CloseGainPct,
    metrics.d5MaxGainPct,
  ].some((value) => value != null) || (metrics.futureLimitUpCount ?? 0) > 0

  if (!hasEvidence) {
    return {
      verdictType: "needs_backfill",
      score: null,
      verdict: "缺少卖出后的行情快照，当前只能记账，不能下卖点结论。",
      rewatch: false,
      reasons: ["当前数据库没有覆盖该卖出后的分时/收盘快照，需要补行情回放后再判。"],
    }
  }

  const futureLimitUp = metrics.futureLimitUpCount > 0
  const d5Max = metrics.d5MaxGainPct ?? -Infinity
  const d1Close = metrics.d1CloseGainPct ?? null
  const sameDayAfterHigh = metrics.sameDayAfterHighGainPct ?? null
  const sameDayAfterClose = metrics.sameDayAfterCloseGainPct ?? null
  const preSellMiss = metrics.preSellMissPct ?? null
  const sameDayAfterLow = metrics.sameDayAfterLowGainPct ?? null

  const rewatch = futureLimitUp || d5Max >= 12 || (sameDayAfterHigh != null && sameDayAfterHigh >= 7 && (d1Close ?? -999) >= 3)
  if (rewatch) {
    return {
      verdictType: "sold_rewatch",
      score: 28,
      verdict: "卖出后继续超预期走强，必须进入重点回看和龙头跟踪。",
      rewatch: true,
      reasons: unique([
        futureLimitUp ? "卖出后出现涨停/连板延续" : "",
        d5Max >= 12 ? `卖出后5日最高涨幅仍达 ${d5Max.toFixed(2)}%` : "",
        sameDayAfterHigh != null && sameDayAfterHigh >= 7 ? `卖出后当日仍冲高 ${sameDayAfterHigh.toFixed(2)}%` : "",
      ]),
    }
  }

  if ((sameDayAfterHigh != null && sameDayAfterHigh >= 4) || (d1Close != null && d1Close >= 4)) {
    return {
      verdictType: "sold_too_early",
      score: 42,
      verdict: "卖点偏早，卖出后仍有明显延续空间。",
      rewatch: false,
      reasons: unique([
        sameDayAfterHigh != null && sameDayAfterHigh >= 4 ? `卖出后当日最高继续走出 ${sameDayAfterHigh.toFixed(2)}%` : "",
        d1Close != null && d1Close >= 4 ? `D+1 收盘仍高于卖价 ${d1Close.toFixed(2)}%` : "",
      ]),
    }
  }

  if ((preSellMiss != null && preSellMiss >= 4) && ((sameDayAfterClose != null && sameDayAfterClose <= -2) || (sameDayAfterLow != null && sameDayAfterLow <= -4))) {
    return {
      verdictType: "sold_too_late",
      score: 55,
      verdict: "卖点偏慢，卖出前已有更好兑现窗口，卖后并未再走强。",
      rewatch: false,
      reasons: unique([
        preSellMiss != null && preSellMiss >= 4 ? `卖出前当日更高位置多出 ${preSellMiss.toFixed(2)}%` : "",
        sameDayAfterClose != null && sameDayAfterClose <= -2 ? `卖后当日收盘低于卖价 ${Math.abs(sameDayAfterClose).toFixed(2)}%` : "",
      ]),
    }
  }

  return {
    verdictType: "sold_reasonable",
    score: 82,
    verdict: "卖点基本合理，卖出后没有出现足以推翻卖点的超预期强化。",
    rewatch: false,
    reasons: ["卖出后延续幅度有限，未形成明显卖飞或龙头超预期特征。"],
  }
}

function buildValidationItem(sell, quoteRows, limitUps, lookaheadDays) {
  const rows = latestByMinute(quoteRows)
  const sellMinute = minuteText(sell.time)
  const sameDayRows = rows.filter((row) => row.trade_date === sell.tradeDate)
  const preSellRows = sameDayRows.filter((row) => row.minute <= sellMinute)
  const postSellRows = sameDayRows.filter((row) => row.minute >= sellMinute)
  const futureRows = rows.filter((row) => row.trade_date > sell.tradeDate)
  const futureDates = unique(futureRows.map((row) => row.trade_date)).slice(0, lookaheadDays)
  const preSellHigh = preSellRows.reduce((max, row) => Math.max(max, Number(row.price) || -Infinity), -Infinity)
  const preSellLow = preSellRows.reduce((min, row) => Math.min(min, Number(row.price) || Infinity), Infinity)
  const sameDayAfter = daySummaryFromQuotes(postSellRows, sell.price)

  const futureDaily = futureDates.map((date) => daySummaryFromQuotes(futureRows.filter((row) => row.trade_date === date), sell.price)).filter(Boolean)
  const futureLimitUpDates = unique(limitUps.map((item) => item.trade_date).filter((date) => date >= sell.tradeDate))

  const d1 = futureDaily[0] ?? null
  const d3Slice = futureDaily.slice(0, 3)
  const d5Slice = futureDaily.slice(0, 5)
  const d3Max = d3Slice.length ? Math.max(...d3Slice.map((item) => item.highGainPct ?? -Infinity)) : null
  const d5Max = d5Slice.length ? Math.max(...d5Slice.map((item) => item.highGainPct ?? -Infinity)) : null
  const metrics = {
    preSellMissPct: Number.isFinite(preSellHigh) ? pct(sell.price, preSellHigh) : null,
    preSellLowPct: Number.isFinite(preSellLow) ? pct(sell.price, preSellLow) : null,
    sameDayAfterHighGainPct: sameDayAfter?.highGainPct ?? null,
    sameDayAfterLowGainPct: sameDayAfter?.lowGainPct ?? null,
    sameDayAfterCloseGainPct: sameDayAfter?.closeGainPct ?? null,
    d1CloseGainPct: d1?.closeGainPct ?? null,
    d1HighGainPct: d1?.highGainPct ?? null,
    d3MaxGainPct: Number.isFinite(d3Max) ? d3Max : null,
    d5MaxGainPct: Number.isFinite(d5Max) ? d5Max : null,
    futureLimitUpCount: futureLimitUpDates.filter((date) => date > sell.tradeDate).length,
  }

  const classified = classifySellValidation(metrics)
  const evidence = {
    preSellHigh: Number.isFinite(preSellHigh) ? preSellHigh : null,
    preSellRows: preSellRows.slice(-4),
    postSellRows: postSellRows.slice(0, 8),
    sameDayAfter,
    futureDaily,
    futureLimitUpDates,
  }

  return {
    id: `post_sell_${sell.tradeDate.replace(/-/g, "")}_${sell.code}_${sellMinute.replace(":", "")}_${shortHash(`${sell.sourcePath}|${sell.price}|${sell.quantity}`)}`,
    tradeDate: sell.tradeDate,
    code: sell.code,
    name: sell.name || sell.code,
    sellTime: sell.time,
    sellMinute,
    sellPrice: sell.price,
    sellQuantity: sell.quantity,
    sellAmount: sell.amount,
    sourcePath: sell.sourcePath,
    verdictType: classified.verdictType,
    verdict: classified.verdict,
    score: classified.score,
    rewatch: classified.rewatch,
    reasons: classified.reasons,
    metrics,
    evidence,
    summary: [
      `卖出价 ${sell.price}`,
      metrics.sameDayAfterHighGainPct != null ? `卖后当日最高 ${metrics.sameDayAfterHighGainPct.toFixed(2)}%` : "",
      metrics.d1CloseGainPct != null ? `D+1 收盘 ${metrics.d1CloseGainPct.toFixed(2)}%` : "",
      metrics.d5MaxGainPct != null ? `5日最高 ${metrics.d5MaxGainPct.toFixed(2)}%` : "",
    ].filter(Boolean).join(" | "),
  }
}

function buildMarkdown(record) {
  const lines = [
    `# ${record.tradeDate} 卖出后验证`,
    "",
    `- 生成时间：${record.generatedAt}`,
    `- 卖出样本：${record.items.length}`,
    `- 重点回看：${record.counts.rewatch}`,
    `- 卖早：${record.counts.tooEarly}`,
    `- 卖晚：${record.counts.tooLate}`,
    `- 基本合理：${record.counts.reasonable}`,
    `- 待补行情：${record.counts.needsBackfill}`,
    "",
  ]

  const sections = [
    ["重点回看 / 超预期继续走强", record.items.filter((item) => item.verdictType === "sold_rewatch")],
    ["卖点偏早", record.items.filter((item) => item.verdictType === "sold_too_early")],
    ["卖点偏慢", record.items.filter((item) => item.verdictType === "sold_too_late")],
    ["卖点基本合理", record.items.filter((item) => item.verdictType === "sold_reasonable")],
    ["待补行情回放", record.items.filter((item) => item.verdictType === "needs_backfill")],
  ]

  for (const [title, items] of sections) {
    lines.push(`## ${title}`, "")
    if (items.length === 0) {
      lines.push("- 无", "")
      continue
    }
    for (const item of items) {
      lines.push(`### ${item.name} ${item.code}`)
      lines.push(`- 卖出时间：${item.tradeDate} ${item.sellTime}`)
      lines.push(`- 卖出价格：${item.sellPrice}`)
      lines.push(`- 结论：${item.verdict}`)
      lines.push(`- 摘要：${item.summary}`)
      lines.push(`- 关键原因：${item.reasons.join("；") || "待补充"}`)
      lines.push(`- 原始来源：${item.sourcePath}`)
      lines.push("")
    }
  }

  return `${lines.join("\n").trim()}\n`
}

function summarizeCounts(items) {
  return {
    rewatch: items.filter((item) => item.verdictType === "sold_rewatch").length,
    tooEarly: items.filter((item) => item.verdictType === "sold_too_early").length,
    tooLate: items.filter((item) => item.verdictType === "sold_too_late").length,
    reasonable: items.filter((item) => item.verdictType === "sold_reasonable").length,
    needsBackfill: items.filter((item) => item.verdictType === "needs_backfill").length,
  }
}

function resolvePostSellTradeDateContext(tradeDate, sells) {
  const evidenceTradeDate = normalizeTradeDate(tradeDate)
  const sellTradeDates = unique((sells ?? []).map((item) => normalizeTradeDate(item.tradeDate)).filter(Boolean))
  const sourceTradeDates = {
    validationTradeDate: evidenceTradeDate,
    sellRecords: sellTradeDates.length <= 1 ? (sellTradeDates[0] ?? null) : sellTradeDates,
  }
  const distinctTradeDates = [...new Set([evidenceTradeDate, ...sellTradeDates].filter(Boolean))]
  return {
    planTradeDate: evidenceTradeDate,
    evidenceTradeDate,
    sourceTradeDates,
    hasDateMismatch: distinctTradeDates.length > 1,
  }
}

function buildRecord({ projectPath, tradeDate, lookaheadDays }) {
  const sells = collectSellRecords(projectPath, tradeDate)
  const items = sells.map((sell) => {
    const quotes = loadQuotesAroundSell(sell.code, sell.tradeDate, lookaheadDays)
    const limitUps = loadLimitUpsAfterSell(sell.code, sell.tradeDate, lookaheadDays)
    return buildValidationItem(sell, quotes, limitUps, lookaheadDays)
  })

  const counts = summarizeCounts(items)
  const tradeDateContext = resolvePostSellTradeDateContext(tradeDate, sells)
  const summary = items.length === 0
    ? `${tradeDate} 无可验证卖出记录。`
    : `${tradeDate} 卖出后验证：重点回看 ${counts.rewatch}，卖早 ${counts.tooEarly}，卖晚 ${counts.tooLate}，合理 ${counts.reasonable}，待补行情 ${counts.needsBackfill}。`

  return {
    schema: "73wiki-post-sell-validation-v1",
    id: `post_sell_validation_${tradeDate.replace(/-/g, "")}_${idTimestamp()}_${shortHash(items.map((item) => item.id).join(","))}`,
    status: "active",
    generatedAt: nowLocalTimestamp(),
    tradeDate,
    planTradeDate: tradeDateContext.planTradeDate,
    evidenceTradeDate: tradeDateContext.evidenceTradeDate,
    sourceTradeDates: tradeDateContext.sourceTradeDates,
    hasDateMismatch: tradeDateContext.hasDateMismatch,
    source: "73wiki-post-sell-validation",
    sourceTier: "db_derived",
    projectPath: ".",
    summary,
    counts,
    symbols: unique(items.map((item) => item.code)),
    items,
    writePolicy: {
      rawWrite: false,
      wikiWrite: true,
      buyAdvice: false,
    },
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const projectPath = path.resolve(args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH)
  const tradeDate = normalizeTradeDate(args["trade-date"] ?? args._[1] ?? nowLocalTimestamp().slice(0, 10))
  const lookaheadDays = Number(args["lookahead-days"] ?? 5)
  const record = buildRecord({ projectPath, tradeDate, lookaheadDays })
  const reportDir = path.join(projectPath, REPORT_ROOT)
  const reportPath = path.join(reportDir, `${tradeDate}-post-sell-validation.json`)
  const latestPath = path.join(reportDir, "latest-post-sell-validation.json")
  const wikiPath = path.join(projectPath, WIKI_ROOT, `${tradeDate}-卖出后验证.md`)
  const output = {
    dryRun: !args.write,
    record,
    writePaths: {
      facts: FACT_PATH,
      report: projectRelative(projectPath, reportPath),
      latest: projectRelative(projectPath, latestPath),
      wiki: projectRelative(projectPath, wikiPath),
    },
  }

  if (args.write) {
    appendJsonl(path.join(projectPath, FACT_PATH), record)
    writeJson(reportPath, record)
    writeJson(latestPath, record)
    writeText(wikiPath, buildMarkdown(record))
    output.written = output.writePaths
  }

  console.log(JSON.stringify(cleanJsonValue(output), null, 2))
}

main()
