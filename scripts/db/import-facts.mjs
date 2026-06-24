#!/usr/bin/env node
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

const FACT_FILES = [
  "data/facts/prediction_candidates.jsonl",
  "data/facts/preopen_intel.jsonl",
  "data/facts/catalyst_events.jsonl",
  "data/facts/stock_reason_cards.jsonl",
  "data/facts/authority_policy_events.jsonl",
  "data/facts/intraday_validations.jsonl",
  "data/facts/minute_bar_snapshots.jsonl",
  "data/facts/warroom_watchlists.jsonl",
  "data/facts/limit_up_reasons.jsonl",
  "data/facts/market_strength_ranks.jsonl",
  "data/facts/market_focus_universe.jsonl",
  "data/facts/focus_trend_validations.jsonl",
  "data/facts/prediction_outcome_reviews.jsonl",
  "data/facts/score_feedback.jsonl",
  "data/facts/hotlist_health.jsonl",
  "data/facts/market_snapshots.jsonl",
  "data/facts/shortline_emotion_snapshots.jsonl",
  "data/facts/tdx_mcp_snapshots.jsonl",
]

function lit(value) {
  if (value === null || value === undefined || value === "") return "null"
  return `'${cleanText(String(value)).replace(/'/g, "''")}'`
}

function jsonLit(value) {
  return `${lit(JSON.stringify(cleanJsonValue(value ?? {})))}::jsonb`
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

function arrayLit(values) {
  const items = [...new Set((values ?? []).filter(Boolean).map((item) => String(item)))]
  if (items.length === 0) return "'{}'::text[]"
  return `array[${items.map(lit).join(",")}]::text[]`
}

function num(value) {
  if (value === null || value === undefined || value === "") return "null"
  const n = Number(String(value).replace(/[,%]/g, "").trim())
  return Number.isFinite(n) ? String(n) : "null"
}

function intNum(value) {
  if (value === null || value === undefined || value === "") return "null"
  const n = Number(String(value).replace(/[,%]/g, "").trim())
  return Number.isFinite(n) ? String(Math.trunc(n)) : "null"
}

function dateLit(value) {
  if (!value) return "null"
  const raw = String(value)
  if (/^\d{8}$/.test(raw)) return lit(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`)
  const match = raw.match(/\d{4}-\d{2}-\d{2}/)
  return match ? lit(match[0]) : "null"
}

function tsLit(value) {
  if (!value) return "now()"
  const normalized = String(value).replace(" ", "T")
  return lit(normalized)
}

function timeLit(value) {
  if (!value) return "null"
  const raw = String(value).trim()
  if (/^\d{2}:\d{2}:\d{2}$/.test(raw)) return lit(raw)
  if (/^\d{6}$/.test(raw)) return lit(`${raw.slice(0, 2)}:${raw.slice(2, 4)}:${raw.slice(4, 6)}`)
  return "null"
}

function codeBase(value) {
  return String(value ?? "").replace(/\.(SH|SZ|BJ)$/i, "")
}

function parseCliArgs(argv) {
  const args = { _: [], all: false, recentRecords: Number(process.env.WIKI73_IMPORT_RECENT_RECORDS ?? 25) }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === "--all") {
      args.all = true
      continue
    }
    if (token === "--recent-records") {
      args.recentRecords = Number(argv[index + 1] ?? args.recentRecords)
      index += 1
      continue
    }
    if (!token.startsWith("--")) args._.push(token)
  }
  return args
}

function readJsonl(filePath, { all = false, recentRecords = 25 } = {}) {
  if (!fs.existsSync(filePath)) return []
  const raw = fs.readFileSync(filePath, "utf8")
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const selected = all ? lines : lines.slice(-Math.max(1, Number(recentRecords)))
  return selected.map((line) => JSON.parse(line))
}

function batchSql(record, { scope }) {
  return `
insert into trading.market_snapshot_batches
  (id, snapshot_at, trade_date, session_label, source, scope, status, summary, raw_fact_path, payload)
values
  (${lit(record.id)}, ${tsLit(record.generatedAt)}, ${dateLit(record.tradeDate ?? record.latestDate ?? record.generatedAt)}, null, ${lit(record.source ?? record.sourceTool ?? "unknown")}, ${lit(scope)}, ${lit(record.status ?? "active")}, ${lit(record.summary ?? record.claim ?? "")}, null, ${jsonLit(record)})
on conflict (id) do update set
  summary = excluded.summary,
  payload = excluded.payload;
`
}

function instrumentSql({ code, name, market, industry }) {
  if (!code) return ""
  return `
insert into trading.instruments (code, name, market, industry, updated_at)
values (${lit(code)}, ${lit(name)}, ${lit(market)}, ${lit(industry)}, now())
on conflict (code) do update set
  name = coalesce(excluded.name, trading.instruments.name),
  market = coalesce(excluded.market, trading.instruments.market),
  industry = coalesce(excluded.industry, trading.instruments.industry),
  updated_at = now();
`
}

function quoteSql(record, row, { source, scope }) {
  const code = codeBase(row["证券代码"] ?? row.sec_code ?? row.code ?? row.代码)
  const market = String(row["证券代码"] ?? "").split(".")[1] ?? row.market ?? null
  const name = row["证券简称"] ?? row.sec_name ?? row.name ?? row.名称 ?? ""
  const industry = row["所属行业"] ?? row.industry ?? ""
  return `
${instrumentSql({ code, name, market, industry })}
insert into trading.quote_snapshots
  (batch_id, snapshot_at, code, name, source, scope, price, change_percent, open_price, high_price, low_price, volume, amount, industry, raw)
values
  (${lit(record.id)}, ${tsLit(row.time ?? record.generatedAt)}, ${lit(code)}, ${lit(name)}, ${lit(source)}, ${lit(scope)}, ${num(row["最新价"] ?? row.now_price ?? row.price)}, ${num(row["涨跌幅"] ?? row.chg ?? row.changePercent)}, ${num(row["开盘价"] ?? row.open_price)}, ${num(row["最高价"] ?? row.high_price)}, ${num(row["最低价"] ?? row.low_price)}, ${num(row["成交量"] ?? row.volume)}, ${num(row["成交额"] ?? row.amount)}, ${lit(industry)}, ${jsonLit(row)})
on conflict (batch_id, code, source, scope) do update set
  price = excluded.price,
  change_percent = excluded.change_percent,
  raw = excluded.raw;
`
}

function indexSql(record, row) {
  return `
insert into trading.index_snapshots
  (batch_id, snapshot_at, index_code, index_name, source, price, change_percent, amount, volume, up_count, down_count, limit_up_count, limit_down_count, raw)
values
  (${lit(record.id)}, ${tsLit(row.time ?? record.generatedAt)}, ${lit(row["证券代码"] ?? row.code)}, ${lit(row["证券简称"] ?? row.name)}, ${lit(record.source ?? "ifind-mcp")}, ${num(row["最新价"])}, ${num(row["涨跌幅"])}, ${num(row["成交额"])}, ${num(row["成交量"])}, ${intNum(row["上涨家数"])}, ${intNum(row["下跌家数"])}, ${intNum(row["涨停家数"])}, ${intNum(row["跌停家数"])}, ${jsonLit(row)})
on conflict (batch_id, index_name, source) do update set raw = excluded.raw;
`
}

function poolSql(record, poolName, row) {
  const table = {
    limit_up: "limit_up_pool",
    burst: "burst_pool",
    limit_down: "limit_down_pool",
    strong: "strong_pool",
  }[poolName]
  if (!table) return ""
  const code = codeBase(row["代码"])
  const common = {
    tradeDate: dateLit(record.tradeDate ?? record.generatedAt),
    snapshotAt: tsLit(record.generatedAt),
    source: lit(record.source ?? "akshare-compatible-eastmoney"),
    code: lit(code),
    name: lit(row["名称"]),
    price: num(row["最新价"]),
    change: num(row["涨跌幅"]),
    amount: num(row["成交额"]),
    turnover: num(row["换手率"]),
    industry: lit(row["所属行业"]),
    raw: jsonLit(row),
  }
  if (poolName === "limit_up") {
    return `
${instrumentSql({ code, name: row["名称"], industry: row["所属行业"] })}
insert into trading.limit_up_pool
  (batch_id, trade_date, snapshot_at, code, name, source, price, change_percent, amount, turnover_rate, limit_up_height, first_limit_time, last_limit_time, seal_amount, burst_count, industry, limit_up_stat, raw)
values
  (${lit(record.id)}, ${common.tradeDate}, ${common.snapshotAt}, ${common.code}, ${common.name}, ${common.source}, ${common.price}, ${common.change}, ${common.amount}, ${common.turnover}, ${intNum(row["连板数"])}, ${timeLit(row["首次封板时间"])}, ${timeLit(row["最后封板时间"])}, ${num(row["封板资金"])}, ${intNum(row["炸板次数"])}, ${common.industry}, ${lit(row["涨停统计"])}, ${common.raw})
on conflict (batch_id, trade_date, code, source) do update set raw = excluded.raw;
`
  }
  if (poolName === "burst") {
    return `
${instrumentSql({ code, name: row["名称"], industry: row["所属行业"] })}
insert into trading.burst_pool
  (batch_id, trade_date, snapshot_at, code, name, source, price, change_percent, amount, turnover_rate, first_limit_time, burst_count, amplitude, speed, industry, raw)
values
  (${lit(record.id)}, ${common.tradeDate}, ${common.snapshotAt}, ${common.code}, ${common.name}, ${common.source}, ${common.price}, ${common.change}, ${common.amount}, ${common.turnover}, ${timeLit(row["首次封板时间"])}, ${intNum(row["炸板次数"])}, ${num(row["振幅"])}, ${num(row["涨速"])}, ${common.industry}, ${common.raw})
on conflict (batch_id, trade_date, code, source) do update set raw = excluded.raw;
`
  }
  if (poolName === "limit_down") {
    return `
${instrumentSql({ code, name: row["名称"], industry: row["所属行业"] })}
insert into trading.limit_down_pool
  (batch_id, trade_date, snapshot_at, code, name, source, price, change_percent, amount, turnover_rate, seal_amount, last_limit_time, continuous_down_days, open_board_count, industry, raw)
values
  (${lit(record.id)}, ${common.tradeDate}, ${common.snapshotAt}, ${common.code}, ${common.name}, ${common.source}, ${common.price}, ${common.change}, ${common.amount}, ${common.turnover}, ${num(row["封单资金"])}, ${timeLit(row["最后封板时间"])}, ${intNum(row["连续跌停"])}, ${intNum(row["开板次数"])}, ${common.industry}, ${common.raw})
on conflict (batch_id, trade_date, code, source) do update set raw = excluded.raw;
`
  }
  return `
${instrumentSql({ code, name: row["名称"], industry: row["所属行业"] })}
insert into trading.strong_pool
  (batch_id, trade_date, snapshot_at, code, name, source, price, change_percent, amount, turnover_rate, volume_ratio, reason, industry, raw)
values
  (${lit(record.id)}, ${common.tradeDate}, ${common.snapshotAt}, ${common.code}, ${common.name}, ${common.source}, ${common.price}, ${common.change}, ${common.amount}, ${common.turnover}, ${num(row["量比"])}, ${lit(row["入选理由"])}, ${common.industry}, ${common.raw})
on conflict (batch_id, trade_date, code, source) do update set raw = excluded.raw;
`
}

function watchlistSql(record) {
  const items = [
    ...(record.tiers?.focus ?? []),
    ...(record.tiers?.normal ?? []),
  ]
  const sql = [`
insert into trading.warroom_watchlists
  (id, generated_at, trade_date, title, source, status, summary, data_quality, source_files, raw)
values
  (${lit(record.id)}, ${tsLit(record.generatedAt)}, ${dateLit(record.tradeDate ?? record.generatedAt)}, ${lit(record.title)}, ${lit(record.source ?? "73wiki-market-watchlist")}, ${lit(record.status ?? "active")}, ${lit(record.summary ?? record.claim ?? "")}, ${jsonLit(record.dataQuality)}, ${arrayLit(record.sourceFiles)}, ${jsonLit(record)})
on conflict (id) do update set
  summary = excluded.summary,
  data_quality = excluded.data_quality,
  source_files = excluded.source_files,
  raw = excluded.raw;
`]

  for (const item of items) {
    const code = codeBase(item.code)
    if (!code) continue
    sql.push(`
${instrumentSql({ code, name: item.name })}
insert into trading.warroom_watchlist_items
  (id, watchlist_id, generated_at, trade_date, code, name, tier, role, priority_rank, score, occurrences, reasons, source_files, raw)
values
  (${lit(`${record.id}_${item.tier}_${code}`)}, ${lit(record.id)}, ${tsLit(record.generatedAt)}, ${dateLit(record.tradeDate ?? record.generatedAt)}, ${lit(code)}, ${lit(item.name)}, ${lit(item.tier)}, ${lit(item.role)}, ${intNum(item.priorityRank)}, ${num(item.score)}, ${intNum(item.occurrences)}, ${arrayLit(item.reasons)}, ${arrayLit(item.sourceFiles)}, ${jsonLit(item)})
on conflict (watchlist_id, code, tier) do update set
  name = excluded.name,
  role = excluded.role,
  priority_rank = excluded.priority_rank,
  score = excluded.score,
  occurrences = excluded.occurrences,
  reasons = excluded.reasons,
  source_files = excluded.source_files,
  raw = excluded.raw;
`)
  }

  return sql.join("\n")
}

function minuteBarsSql(record) {
  const sql = []
  for (const item of record.items ?? []) {
    const code = codeBase(item.code)
    if (!code) continue
    sql.push(instrumentSql({ code, name: item.name }))
    for (const bar of item.bars ?? []) {
      sql.push(`
insert into trading.minute_bars
  (batch_id, source_batch_id, trade_date, snapshot_at, minute, code, name, interval, source, source_quality, open_price, high_price, low_price, close_price, volume, amount, cumulative_volume, cumulative_amount, synthetic_ohlc, raw)
values
  (${lit(record.id)}, ${lit(record.sourceBatchId)}, ${dateLit(record.tradeDate)}, ${tsLit(bar.snapshotAt ?? `${record.tradeDate} ${bar.minute}:00`)}, ${lit(bar.minute)}, ${lit(code)}, ${lit(item.name)}, ${lit(item.interval ?? record.interval ?? "1m")}, ${lit(item.source ?? record.source ?? "minute-bars")}, ${lit(item.sourceQuality ?? null)}, ${num(bar.open)}, ${num(bar.high)}, ${num(bar.low)}, ${num(bar.close)}, ${num(bar.volume)}, ${num(bar.amount)}, ${num(bar.cumulativeVolume)}, ${num(bar.cumulativeAmount)}, ${bar.syntheticOHLC ? "true" : "false"}, ${jsonLit({ ...bar, code, name: item.name, tradeDate: record.tradeDate })})
on conflict (trade_date, code, minute, interval, source) do update set
  batch_id = excluded.batch_id,
  source_batch_id = excluded.source_batch_id,
  name = excluded.name,
  source_quality = excluded.source_quality,
  open_price = excluded.open_price,
  high_price = excluded.high_price,
  low_price = excluded.low_price,
  close_price = excluded.close_price,
  volume = excluded.volume,
  amount = excluded.amount,
  cumulative_volume = excluded.cumulative_volume,
  cumulative_amount = excluded.cumulative_amount,
  synthetic_ohlc = excluded.synthetic_ohlc,
  raw = excluded.raw;
`)
    }
  }
  return sql.join("\n")
}

function limitUpReasonsSql(record) {
  const sql = []
  for (const item of record.reasons ?? []) {
    const code = codeBase(item.code)
    if (!code || !item.reason) continue
    sql.push(`
${instrumentSql({ code, name: item.name, industry: item.theme })}
insert into trading.limit_up_reasons
  (id, trade_date, observed_at, code, name, reason, theme, concepts, source, source_level, confidence, related_raw_path, evidence_refs, status, raw)
values
  (${lit(item.id)}, ${dateLit(item.tradeDate ?? record.tradeDate)}, ${tsLit(item.observedAt ?? record.generatedAt)}, ${lit(code)}, ${lit(item.name)}, ${lit(item.reason)}, ${lit(item.theme)}, ${arrayLit(item.concepts)}, ${lit(item.source ?? record.source)}, ${lit(item.sourceLevel ?? "C")}, ${num(item.confidence)}, ${lit(item.relatedRawPath)}, ${arrayLit(item.evidenceRefs)}, ${lit(item.status ?? "active")}, ${jsonLit(item.raw ?? item)})
on conflict (id) do update set
  reason = excluded.reason,
  theme = excluded.theme,
  concepts = excluded.concepts,
  source_level = excluded.source_level,
  confidence = excluded.confidence,
  evidence_refs = excluded.evidence_refs,
  status = excluded.status,
  raw = excluded.raw;
`)
  }
  return sql.join("\n")
}

function preopenIntelSql(record) {
  const sql = [`
insert into trading.preopen_intel
  (id, generated_at, trade_date, title, source, status, core_limit, symbols, source_files, claim, raw)
values
  (${lit(record.id)}, ${tsLit(record.generatedAt)}, ${dateLit(record.tradeDate ?? record.generatedAt)}, ${lit(record.title)}, ${lit(record.source ?? "73wiki-preopen-intel")}, ${lit(record.status ?? "active")}, ${intNum(record.coreLimit)}, ${arrayLit(record.symbols)}, ${arrayLit(record.sourceFiles)}, ${lit(record.claim)}, ${jsonLit(record)})
on conflict (id) do update set
  symbols = excluded.symbols,
  source_files = excluded.source_files,
  claim = excluded.claim,
  raw = excluded.raw;
`]

  for (const item of record.core ?? []) {
    const code = codeBase(item.code)
    if (!code) continue
    sql.push(`
${instrumentSql({ code, name: item.name })}
insert into trading.preopen_intel_items
  (id, intel_id, generated_at, trade_date, rank, code, name, role, score, themes, positives, risks, source_tags, source_files, hypothesis, raw)
values
  (${lit(`${record.id}_${code}`)}, ${lit(record.id)}, ${tsLit(record.generatedAt)}, ${dateLit(record.tradeDate ?? record.generatedAt)}, ${intNum(item.rank)}, ${lit(code)}, ${lit(item.name)}, ${lit(item.role)}, ${num(item.score)}, ${arrayLit(item.themes)}, ${arrayLit(item.positives)}, ${arrayLit(item.risks)}, ${arrayLit(item.sourceTags)}, ${arrayLit(item.sourceFiles)}, ${lit(item.hypothesis?.hypothesis)}, ${jsonLit(item)})
on conflict (intel_id, code) do update set
  rank = excluded.rank,
  name = excluded.name,
  role = excluded.role,
  score = excluded.score,
  themes = excluded.themes,
  positives = excluded.positives,
  risks = excluded.risks,
  source_tags = excluded.source_tags,
  source_files = excluded.source_files,
  hypothesis = excluded.hypothesis,
  raw = excluded.raw;
`)
  }
  return sql.join("\n")
}

function predictionCandidatesSql(record) {
  const sql = [`
insert into trading.prediction_candidates
  (id, generated_at, trade_date, title, source, status, candidate_limit, symbols, source_files, claim, raw)
values
  (${lit(record.id)}, ${tsLit(record.generatedAt)}, ${dateLit(record.tradeDate ?? record.generatedAt)}, ${lit(record.title)}, ${lit(record.source ?? "73wiki-prediction-candidates")}, ${lit(record.status ?? "active")}, ${intNum(record.candidateLimit)}, ${arrayLit(record.symbols)}, ${arrayLit(record.sourceFiles)}, ${lit(record.claim)}, ${jsonLit(record)})
on conflict (id) do update set
  symbols = excluded.symbols,
  source_files = excluded.source_files,
  claim = excluded.claim,
  raw = excluded.raw;
`]

  for (const item of record.candidates ?? []) {
    const code = codeBase(item.code)
    if (!code) continue
    sql.push(`
${instrumentSql({ code, name: item.name })}
insert into trading.prediction_candidate_items
  (id, candidate_id, generated_at, trade_date, rank, code, name, role, predicted_move, score, novelty, expectation_gap, next_day_tradeability, themes, positives, risks, reasons, invalidations, source_tags, source_files, raw)
values
  (${lit(`${record.id}_${code}`)}, ${lit(record.id)}, ${tsLit(record.generatedAt)}, ${dateLit(record.tradeDate ?? record.generatedAt)}, ${intNum(item.rank)}, ${lit(code)}, ${lit(item.name)}, ${lit(item.role)}, ${lit(item.predictedMove)}, ${num(item.score)}, ${num(item.novelty)}, ${num(item.expectationGap)}, ${num(item.nextDayTradeability)}, ${arrayLit(item.themes)}, ${arrayLit(item.positives)}, ${arrayLit(item.risks)}, ${arrayLit(item.reasons)}, ${arrayLit(item.invalidations)}, ${arrayLit(item.sourceTags)}, ${arrayLit(item.sourceFiles)}, ${jsonLit(item)})
on conflict (candidate_id, code) do update set
  rank = excluded.rank,
  name = excluded.name,
  role = excluded.role,
  predicted_move = excluded.predicted_move,
  score = excluded.score,
  novelty = excluded.novelty,
  expectation_gap = excluded.expectation_gap,
  next_day_tradeability = excluded.next_day_tradeability,
  themes = excluded.themes,
  positives = excluded.positives,
  risks = excluded.risks,
  reasons = excluded.reasons,
  invalidations = excluded.invalidations,
  source_tags = excluded.source_tags,
  source_files = excluded.source_files,
  raw = excluded.raw;
`)
  }
  return sql.join("\n")
}

function stockReasonCardsSql(record) {
  const sql = []
  for (const card of record.cards ?? []) {
    const code = codeBase(card.code)
    if (!code) continue
    sql.push(`
${instrumentSql({ code, name: card.name })}
insert into trading.stock_reason_cards
  (id, generated_at, trade_date, code, name, rank, role, confidence, inferred_reason, themes, catalysts, risks, evidence_files, raw)
values
  (${lit(card.id)}, ${tsLit(card.generatedAt ?? record.generatedAt)}, ${dateLit(card.tradeDate ?? record.tradeDate)}, ${lit(code)}, ${lit(card.name)}, ${intNum(card.rank)}, ${lit(card.role)}, ${num(card.confidence)}, ${lit(card.inferredReason)}, ${arrayLit(card.themes)}, ${arrayLit(card.catalysts)}, ${arrayLit(card.risks)}, ${arrayLit((card.evidence ?? []).map((item) => item.file))}, ${jsonLit(card)})
on conflict (id) do update set
  confidence = excluded.confidence,
  inferred_reason = excluded.inferred_reason,
  themes = excluded.themes,
  catalysts = excluded.catalysts,
  risks = excluded.risks,
  evidence_files = excluded.evidence_files,
  raw = excluded.raw;
`)
  }
  return sql.join("\n")
}

function catalystEventsSql(record) {
  const sql = []
  for (const event of record.events ?? []) {
    sql.push(`
insert into trading.catalyst_events
  (id, generated_at, event_time, trade_date, title, event_type, source, source_tier, source_path, source_url, themes, keywords, catalyst_score, summary, status, raw)
values
  (${lit(event.id)}, ${tsLit(event.generatedAt ?? record.generatedAt)}, ${tsLit(event.eventTime ?? record.generatedAt)}, ${dateLit(event.tradeDate ?? record.tradeDate)}, ${lit(event.title)}, ${lit(event.eventType)}, ${lit(event.source)}, ${lit(event.sourceTier)}, ${lit(event.sourcePath)}, ${lit(event.sourceUrl)}, ${arrayLit(event.themes)}, ${arrayLit(event.keywords)}, ${num(event.catalystScore)}, ${lit(event.summary)}, ${lit(event.status ?? "active")}, ${jsonLit(event.raw ?? event)})
on conflict (id) do update set
  catalyst_score = excluded.catalyst_score,
  summary = excluded.summary,
  status = excluded.status,
  raw = excluded.raw;
`)
  }
  for (const link of record.links ?? []) {
    const code = codeBase(link.code)
    if (!code || !link.eventId) continue
    sql.push(`
${instrumentSql({ code, name: link.name })}
insert into trading.stock_event_links
  (id, event_id, generated_at, trade_date, code, name, link_type, relation_strength, reasons, themes, source_tags, evidence_files, status, raw)
values
  (${lit(link.id)}, ${lit(link.eventId)}, ${tsLit(link.generatedAt ?? record.generatedAt)}, ${dateLit(link.tradeDate ?? record.tradeDate)}, ${lit(code)}, ${lit(link.name)}, ${lit(link.linkType)}, ${num(link.relationStrength)}, ${arrayLit(link.reasons)}, ${arrayLit(link.themes)}, ${arrayLit(link.sourceTags)}, ${arrayLit(link.evidenceFiles)}, ${lit(link.status ?? "candidate")}, ${jsonLit(link.raw ?? link)})
on conflict (event_id, code) do update set
  name = excluded.name,
  relation_strength = excluded.relation_strength,
  reasons = excluded.reasons,
  themes = excluded.themes,
  source_tags = excluded.source_tags,
  evidence_files = excluded.evidence_files,
  status = excluded.status,
  raw = excluded.raw;
`)
  }
  return sql.join("\n")
}

function intradayValidationSql(record) {
  const sql = [`
insert into trading.intraday_validations
  (id, generated_at, trade_date, source, status, summary, symbols, counts, key_times, market_emotion, raw)
values
  (${lit(record.id)}, ${tsLit(record.generatedAt)}, ${dateLit(record.tradeDate)}, ${lit(record.source ?? "73wiki-market-validate")}, ${lit(record.status ?? "active")}, ${lit(record.summary)}, ${arrayLit(record.symbols)}, ${jsonLit(record.counts)}, ${arrayLit(record.keyTimes)}, ${jsonLit(record.marketEmotion ?? [])}, ${jsonLit(record)})
on conflict (id) do update set
  status = excluded.status,
  summary = excluded.summary,
  symbols = excluded.symbols,
  counts = excluded.counts,
  key_times = excluded.key_times,
  market_emotion = excluded.market_emotion,
  raw = excluded.raw;
`]

  for (const item of record.items ?? []) {
    const code = codeBase(item.code)
    if (!code) continue
    sql.push(`
${instrumentSql({ code, name: item.name })}
insert into trading.intraday_validation_items
  (id, validation_id, generated_at, trade_date, code, name, rank, role, status, underlying_status, verdict, score, latest_change, max_change, min_change, limit_hit, burst_hit, key_facts, evidence_times, reason, raw)
values
  (${lit(`${record.id}_${code}`)}, ${lit(record.id)}, ${tsLit(record.generatedAt)}, ${dateLit(record.tradeDate)}, ${lit(code)}, ${lit(item.name)}, ${intNum(item.rank)}, ${lit(item.role)}, ${lit(item.status)}, ${lit(item.underlyingStatus)}, ${lit(item.verdict)}, ${num(item.score)}, ${num(item.latestChange)}, ${num(item.maxChange)}, ${num(item.minChange)}, ${item.limitHit ? "true" : "false"}, ${item.burstHit ? "true" : "false"}, ${arrayLit(item.keyFacts)}, ${jsonLit(item.evidenceTimes ?? [])}, ${jsonLit(item.reason ?? {})}, ${jsonLit(item)})
on conflict (validation_id, code) do update set
  name = excluded.name,
  rank = excluded.rank,
  role = excluded.role,
  status = excluded.status,
  underlying_status = excluded.underlying_status,
  verdict = excluded.verdict,
  score = excluded.score,
  latest_change = excluded.latest_change,
  max_change = excluded.max_change,
  min_change = excluded.min_change,
  limit_hit = excluded.limit_hit,
  burst_hit = excluded.burst_hit,
  key_facts = excluded.key_facts,
  evidence_times = excluded.evidence_times,
  reason = excluded.reason,
  raw = excluded.raw;
`)
  }
  return sql.join("\n")
}

function marketStrengthRankSql(record) {
  const sql = [`
insert into trading.market_strength_ranks
  (id, generated_at, evidence_trade_date, status, counts, raw)
values
  (${lit(record.id)}, ${tsLit(record.generatedAt)}, ${dateLit(record.evidenceTradeDate ?? record.generatedAt)}, ${lit(record.status ?? "active")}, ${jsonLit(record.counts)}, ${jsonLit(record)})
on conflict (id) do update set
  counts = excluded.counts,
  raw = excluded.raw;
`]
  for (const item of record.rows ?? []) {
    const code = codeBase(item.code)
    if (!code) continue
    sql.push(`
${instrumentSql({ code, name: item.name })}
insert into trading.market_strength_rank_items
  (id, rank_id, evidence_trade_date, code, name, full_market_daily_rank, amount_rank, change_percent, amount, turnover_rate, raw)
values
  (${lit(`${record.id}_${code}`)}, ${lit(record.id)}, ${dateLit(record.evidenceTradeDate ?? record.generatedAt)}, ${lit(code)}, ${lit(item.name)}, ${intNum(item.fullMarketDailyRank)}, ${intNum(item.amountRank)}, ${num(item.changePercent)}, ${num(item.amount)}, ${num(item.turnoverRate)}, ${jsonLit(item)})
on conflict (rank_id, code) do update set
  name = excluded.name,
  full_market_daily_rank = excluded.full_market_daily_rank,
  amount_rank = excluded.amount_rank,
  change_percent = excluded.change_percent,
  amount = excluded.amount,
  turnover_rate = excluded.turnover_rate,
  raw = excluded.raw;
`)
  }
  return sql.join("\n")
}

function marketFocusUniverseSql(record) {
  const sql = [`
insert into trading.market_focus_universes
  (id, generated_at, evidence_trade_date, status, market_regime, counts, raw)
values
  (${lit(record.id)}, ${tsLit(record.generatedAt)}, ${dateLit(record.evidenceTradeDate ?? record.generatedAt)}, ${lit(record.status ?? "active")}, ${jsonLit(record.marketRegime)}, ${jsonLit(record.counts)}, ${jsonLit(record)})
on conflict (id) do update set
  market_regime = excluded.market_regime,
  counts = excluded.counts,
  raw = excluded.raw;
`]
  for (const item of record.items ?? []) {
    const code = codeBase(item.code)
    if (!code) continue
    sql.push(`
${instrumentSql({ code, name: item.name })}
insert into trading.market_focus_universe_items
  (id, universe_id, evidence_trade_date, focus_rank, code, name, role, score, sources, themes, reasons, raw)
values
  (${lit(`${record.id}_${code}`)}, ${lit(record.id)}, ${dateLit(record.evidenceTradeDate ?? record.generatedAt)}, ${intNum(item.focusRank)}, ${lit(code)}, ${lit(item.name)}, ${lit(item.role)}, ${num(item.score)}, ${arrayLit(item.sources)}, ${arrayLit(item.themes)}, ${arrayLit(item.reasons)}, ${jsonLit(item)})
on conflict (universe_id, code) do update set
  focus_rank = excluded.focus_rank,
  role = excluded.role,
  score = excluded.score,
  sources = excluded.sources,
  themes = excluded.themes,
  reasons = excluded.reasons,
  raw = excluded.raw;
`)
  }
  return sql.join("\n")
}

function focusTrendValidationSql(record) {
  const sql = [`
insert into trading.focus_trend_validations
  (id, generated_at, evidence_trade_date, as_of_date, source_focus_universe_id, status, counts, raw)
values
  (${lit(record.id)}, ${tsLit(record.generatedAt)}, ${dateLit(record.evidenceTradeDate)}, ${dateLit(record.asOfDate)}, ${lit(record.sourceFocusUniverseId)}, ${lit(record.status ?? "active")}, ${jsonLit(record.counts)}, ${jsonLit(record)})
on conflict (id) do update set
  counts = excluded.counts,
  raw = excluded.raw;
`]
  for (const item of record.items ?? []) {
    const code = codeBase(item.code)
    if (!code) continue
    sql.push(`
${instrumentSql({ code, name: item.name })}
insert into trading.focus_trend_validation_items
  (id, validation_id, evidence_trade_date, as_of_date, code, name, focus_rank, focus_role, interval_strength_rank, interval_close_rank, best_max_gain_pct, best_close_gain_pct, label, raw)
values
  (${lit(`${record.id}_${code}`)}, ${lit(record.id)}, ${dateLit(record.evidenceTradeDate)}, ${dateLit(record.asOfDate)}, ${lit(code)}, ${lit(item.name)}, ${intNum(item.focusRank)}, ${lit(item.focusRole)}, ${intNum(item.intervalStrengthRank)}, ${intNum(item.intervalCloseRank)}, ${num(item.bestMaxGainPct)}, ${num(item.bestCloseGainPct)}, ${lit(item.label)}, ${jsonLit(item)})
on conflict (validation_id, code) do update set
  focus_rank = excluded.focus_rank,
  focus_role = excluded.focus_role,
  interval_strength_rank = excluded.interval_strength_rank,
  interval_close_rank = excluded.interval_close_rank,
  best_max_gain_pct = excluded.best_max_gain_pct,
  best_close_gain_pct = excluded.best_close_gain_pct,
  label = excluded.label,
  raw = excluded.raw;
`)
  }
  return sql.join("\n")
}

function predictionOutcomeReviewSql(record) {
  const sql = [`
insert into trading.prediction_outcome_reviews
  (id, generated_at, prediction_trade_date, as_of_date, prediction_record_id, status, counts, raw)
values
  (${lit(record.id)}, ${tsLit(record.generatedAt)}, ${dateLit(record.predictionTradeDate)}, ${dateLit(record.asOfDate)}, ${lit(record.predictionRecordId)}, ${lit(record.status ?? "active")}, ${jsonLit(record.counts)}, ${jsonLit(record)})
on conflict (id) do update set
  counts = excluded.counts,
  raw = excluded.raw;
`]
  for (const item of record.items ?? []) {
    const code = codeBase(item.code)
    if (!code) continue
    sql.push(`
${instrumentSql({ code, name: item.name })}
insert into trading.prediction_outcome_review_items
  (id, review_id, prediction_trade_date, as_of_date, code, name, predicted_rank, rank_by_outcome, rank_by_playbook, outcome_label, playbook, method_fit, correct, best_max_gain_pct, best_close_gain_pct, outcome_score, focus_rank, focus_role, raw)
values
  (${lit(`${record.id}_${code}`)}, ${lit(record.id)}, ${dateLit(record.predictionTradeDate)}, ${dateLit(record.asOfDate)}, ${lit(code)}, ${lit(item.name)}, ${intNum(item.rank)}, ${intNum(item.rankByOutcome)}, ${intNum(item.rankByPlaybook)}, ${lit(item.outcome?.label)}, ${lit(item.playbook?.label)}, ${lit(item.playbook?.methodFit)}, ${item.outcome?.correct ? "true" : "false"}, ${num(item.bestMaxGainPct)}, ${num(item.bestCloseGainPct)}, ${num(item.outcomeScore)}, ${intNum(item.focusUniverse?.focusRank)}, ${lit(item.focusUniverse?.role)}, ${jsonLit(item)})
on conflict (review_id, code) do update set
  predicted_rank = excluded.predicted_rank,
  rank_by_outcome = excluded.rank_by_outcome,
  rank_by_playbook = excluded.rank_by_playbook,
  outcome_label = excluded.outcome_label,
  playbook = excluded.playbook,
  method_fit = excluded.method_fit,
  correct = excluded.correct,
  best_max_gain_pct = excluded.best_max_gain_pct,
  best_close_gain_pct = excluded.best_close_gain_pct,
  outcome_score = excluded.outcome_score,
  focus_rank = excluded.focus_rank,
  focus_role = excluded.focus_role,
  raw = excluded.raw;
`)
  }
  return sql.join("\n")
}

function scoreFeedbackSql(record) {
  const sql = [`
insert into trading.score_feedback_runs
  (id, generated_at, status, counts, raw)
values
  (${lit(record.id)}, ${tsLit(record.generatedAt)}, ${lit(record.status ?? "active")}, ${jsonLit(record.counts)}, ${jsonLit(record)})
on conflict (id) do update set counts = excluded.counts, raw = excluded.raw;
`]
  for (const rule of record.rules ?? []) {
    const id = `${record.id}_${createSqlHash(`${rule.type}:${rule.key}`)}`
    sql.push(`
insert into trading.score_feedback_rules
  (id, run_id, rule_type, rule_key, action, score_delta, hit_rate, avg_best_max_gain_pct, samples, raw)
values
  (${lit(id)}, ${lit(record.id)}, ${lit(rule.type)}, ${lit(rule.key)}, ${lit(rule.action)}, ${num(rule.scoreDelta)}, ${num(rule.hitRate)}, ${num(rule.avgBestMaxGainPct)}, ${intNum(rule.evaluable ?? rule.samples)}, ${jsonLit(rule)})
on conflict (run_id, rule_type, rule_key) do update set
  action = excluded.action,
  score_delta = excluded.score_delta,
  hit_rate = excluded.hit_rate,
  avg_best_max_gain_pct = excluded.avg_best_max_gain_pct,
  samples = excluded.samples,
  raw = excluded.raw;
`)
  }
  return sql.join("\n")
}

function createSqlHash(value) {
  let hash = 0
  const text = String(value ?? "")
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0
  return Math.abs(hash).toString(16)
}

function hotlistHealthSql(record) {
  return `
insert into trading.hotlist_health_runs
  (id, generated_at, status, ok, summary, issues, warnings, raw)
values
  (${lit(record.id)}, ${tsLit(record.generatedAt)}, ${lit(record.status ?? "active")}, ${record.ok ? "true" : "false"}, ${lit(record.summary)}, ${arrayLit(record.issues)}, ${arrayLit(record.warnings)}, ${jsonLit(record)})
on conflict (id) do update set
  ok = excluded.ok,
  summary = excluded.summary,
  issues = excluded.issues,
  warnings = excluded.warnings,
  raw = excluded.raw;
`
}

function importRecord(record) {
  const sql = [batchSql(record, { scope: record.schema ?? "facts" })]
  if (record.schema === "73wiki-preopen-intel-v1") {
    sql.push(preopenIntelSql(record))
  }
  if (record.schema === "73wiki-prediction-candidates-v1") {
    sql.push(predictionCandidatesSql(record))
  }
  if (record.schema === "73wiki-stock-reason-cards-batch-v1") {
    sql.push(stockReasonCardsSql(record))
  }
  if (record.schema === "73wiki-catalyst-events-v1") {
    sql.push(catalystEventsSql(record))
  }
  if (record.schema === "73wiki-intraday-validation-v1") {
    sql.push(intradayValidationSql(record))
  }
  if (record.schema === "73wiki-minute-bars-batch-v1") {
    sql.push(minuteBarsSql(record))
  }
  if (record.schema === "73wiki-warroom-watchlist-v1") {
    sql.push(watchlistSql(record))
  }
  if (record.schema === "73wiki-limit-up-reasons-v1") {
    sql.push(limitUpReasonsSql(record))
  }
  if (record.schema === "73wiki-market-strength-rank-v1") {
    sql.push(marketStrengthRankSql(record))
  }
  if (record.schema === "73wiki-market-focus-universe-v1") {
    sql.push(marketFocusUniverseSql(record))
  }
  if (record.schema === "73wiki-focus-trend-validation-v1") {
    sql.push(focusTrendValidationSql(record))
  }
  if (record.schema === "73wiki-prediction-outcome-review-v1") {
    sql.push(predictionOutcomeReviewSql(record))
  }
  if (record.schema === "73wiki-score-feedback-v1") {
    sql.push(scoreFeedbackSql(record))
  }
  if (record.schema === "73wiki-hotlist-health-v1") {
    sql.push(hotlistHealthSql(record))
  }
  if (record.schema === "73wiki-ifind-market-snapshot-v1") {
    for (const row of record.stockQuotes ?? []) sql.push(quoteSql(record, row, { source: "ifind-mcp", scope: "watchlist" }))
    for (const row of record.indexQuotes ?? []) sql.push(indexSql(record, row))
  }
  if (record.schema === "73wiki-tencent-market-snapshot-v1") {
    for (const row of record.stockQuotes ?? []) sql.push(quoteSql(record, row, { source: "tencent-market", scope: "watchlist" }))
    for (const row of record.indexQuotes ?? []) sql.push(indexSql(record, row))
  }
  if (record.schema === "73wiki-tdx-mcp-snapshot-v1") {
    for (const item of record.quotes ?? []) {
      const row = item.rows?.[0] ?? item.summary ?? {}
      sql.push(quoteSql(record, row, { source: "tongdaxin-mcp", scope: "warroom" }))
      sql.push(`
insert into trading.warroom_quotes
  (batch_id, snapshot_at, trade_date, code, name, watchlist_source, role, source, price, change_percent, state, raw)
values
  (${lit(record.id)}, ${tsLit(record.generatedAt)}, ${dateLit(record.generatedAt)}, ${lit(codeBase(item.code))}, ${lit(item.summary?.name ?? row.sec_name)}, ${lit(item.source)}, null, 'tongdaxin-mcp', ${num(item.summary?.price ?? row.now_price)}, ${num(item.summary?.changePercent ?? row.chg)}, ${lit(item.ok ? "ok" : "error")}, ${jsonLit(item)})
on conflict (batch_id, code, source) do update set raw = excluded.raw, state = excluded.state;
`)
    }
  }
  if (record.schema === "73wiki-akshare-shortline-emotion-v1") {
    for (const poolName of ["limit_up", "burst", "limit_down", "strong"]) {
      for (const row of record.pools?.[poolName] ?? []) sql.push(poolSql(record, poolName, row))
    }
  }
  return sql.join("\n")
}

function runPsql(sql, { captureStdout = true, quiet = false } = {}) {
  const args = ["-h", HOST, "-p", PORT, "-U", USER, "-d", DATABASE, "-v", "ON_ERROR_STOP=1"]
  if (quiet) args.push("-q")
  const result = spawnSync(PSQL, args, {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", captureStdout ? "pipe" : "ignore", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    killSignal: "SIGTERM",
  })
  if (result.status !== 0) {
    throw new Error([result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n"))
  }
  return captureStdout ? result.stdout : ""
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms))
}

function main() {
  const args = parseCliArgs(process.argv.slice(2))
  const projectPath = path.resolve(args._[0] ?? DEFAULT_PROJECT_PATH)
  const records = FACT_FILES.flatMap((relative) => readJsonl(path.join(projectPath, relative), { all: args.all, recentRecords: args.recentRecords }))
  let importedFactRecords = 0
  let batch = []
  let batchChars = 0
  const maxBatchChars = 1024 * 1024
  const maxBatchRecords = 100

  function flushBatch() {
    if (batch.length === 0) return
    const sql = ["begin;", "select pg_advisory_xact_lock(hashtext('73wiki_import_facts'));", ...batch, "commit;"].join("\n")
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        runPsql(sql, { captureStdout: false, quiet: true })
        break
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/deadlock detected|could not serialize access|lock timeout/i.test(message) || attempt === 3) throw error
        sleepMs(1000 * attempt)
      }
    }
    batch = []
    batchChars = 0
  }

  for (const record of records) {
    const sql = importRecord(record)
    if (!sql.trim()) continue
    if (batch.length > 0 && (batchChars + sql.length > maxBatchChars || batch.length >= maxBatchRecords)) {
      flushBatch()
    }
    batch.push(sql)
    batchChars += sql.length
    importedFactRecords += 1
  }
  flushBatch()

  const counts = runPsql(`
select 'batches' as table_name, count(*) from trading.market_snapshot_batches
union all select 'catalyst_events', count(*) from trading.catalyst_events
union all select 'prediction_candidates', count(*) from trading.prediction_candidates
union all select 'prediction_items', count(*) from trading.prediction_candidate_items
union all select 'stock_event_links', count(*) from trading.stock_event_links
union all select 'quotes', count(*) from trading.quote_snapshots
union all select 'indexes', count(*) from trading.index_snapshots
union all select 'limit_up', count(*) from trading.limit_up_pool
union all select 'limit_up_reasons', count(*) from trading.limit_up_reasons
union all select 'preopen_intel', count(*) from trading.preopen_intel
union all select 'preopen_items', count(*) from trading.preopen_intel_items
union all select 'reason_cards', count(*) from trading.stock_reason_cards
union all select 'intraday_validations', count(*) from trading.intraday_validations
union all select 'intraday_validation_items', count(*) from trading.intraday_validation_items
union all select 'minute_bars', count(*) from trading.minute_bars
union all select 'burst', count(*) from trading.burst_pool
union all select 'limit_down', count(*) from trading.limit_down_pool
union all select 'strong', count(*) from trading.strong_pool
union all select 'warroom', count(*) from trading.warroom_quotes
union all select 'watchlists', count(*) from trading.warroom_watchlists
union all select 'watchlist_items', count(*) from trading.warroom_watchlist_items
union all select 'market_strength_ranks', count(*) from trading.market_strength_ranks
union all select 'market_strength_rank_items', count(*) from trading.market_strength_rank_items
union all select 'market_focus_universes', count(*) from trading.market_focus_universes
union all select 'market_focus_items', count(*) from trading.market_focus_universe_items
union all select 'focus_trend_validations', count(*) from trading.focus_trend_validations
union all select 'focus_trend_items', count(*) from trading.focus_trend_validation_items
union all select 'prediction_outcome_reviews', count(*) from trading.prediction_outcome_reviews
union all select 'prediction_outcome_items', count(*) from trading.prediction_outcome_review_items
union all select 'score_feedback_runs', count(*) from trading.score_feedback_runs
union all select 'score_feedback_rules', count(*) from trading.score_feedback_rules
union all select 'hotlist_health_runs', count(*) from trading.hotlist_health_runs
order by table_name;
`)
  console.log(JSON.stringify({
    ok: true,
    projectPath,
    mode: args.all ? "all" : "recent",
    recentRecords: args.all ? null : args.recentRecords,
    importedFactRecords,
    counts: counts.trim().split(/\r?\n/).slice(2, -1).map((line) => line.trim()).filter(Boolean),
  }, null, 2))
}

main()
