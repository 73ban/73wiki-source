#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const DEFAULT_PSQL = "C:/Program Files/PostgreSQL/16/bin/psql.exe"
const PSQL = process.env.WIKI73_PSQL_PATH || DEFAULT_PSQL
const HOST = process.env.WIKI73_PGHOST || "127.0.0.1"
const PORT = process.env.WIKI73_PGPORT || "55432"
const USER = process.env.WIKI73_PGUSER || "wiki73"
const DATABASE = process.env.WIKI73_PGDATABASE || "wiki73_trading"
const HYPOTHESIS_PATH = "data/brain/hypotheses.jsonl"
const VALIDATION_PATH = "data/brain/validations.jsonl"
const REPORT_ROOT = ".llm-wiki/hypothesis-validation"
const CHECKPOINTS = [
  { key: "D1", minTradingDays: 1, futureIndex: 0 },
  { key: "D3", minTradingDays: 3, futureIndex: 2 },
  { key: "D5", minTradingDays: 5, futureIndex: 4 },
]

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

function appendUniqueJsonl(filePath, record) {
  ensureDir(path.dirname(filePath))
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
    return true
  }
  const raw = fs.readFileSync(filePath, "utf8")
  const exists = raw.split(/\r?\n/).some((line) => {
    if (!line.trim()) return false
    try {
      return JSON.parse(line).id === record.id
    } catch {
      return false
    }
  })
  if (exists) return false
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
  return true
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
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

function toDateOnly(value) {
  const normalized = normalizeTradeDate(value)
  return normalized ? new Date(`${normalized}T00:00:00`) : null
}

function tradingDaysBetween(startValue, endValue) {
  const start = toDateOnly(startValue)
  const end = toDateOnly(endValue)
  if (!start || !end || start >= end) return 0
  const cursor = new Date(start)
  let count = 0
  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1)
    const weekday = cursor.getDay()
    if (weekday !== 0 && weekday !== 6) count += 1
  }
  return count
}

function pct(base, value) {
  const a = Number(base)
  const b = Number(value)
  if (!Number.isFinite(a) || a === 0 || !Number.isFinite(b)) return null
  return Number((((b - a) / a) * 100).toFixed(4))
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
    throw new Error(String(result.stderr || result.stdout || "psql failed").trim())
  }
  const text = String(result.stdout ?? "").trim()
  return text ? JSON.parse(text) : []
}

function marketPrefix(code) {
  const text = String(code ?? "").trim()
  if (/^(60|68|90)/.test(text)) return "sh"
  if (/^(00|20|30)/.test(text)) return "sz"
  if (/^(4|8)/.test(text)) return "bj"
  return "sz"
}

function fetchTencentDailyHistory(code, startDate, endDate) {
  const symbol = `${marketPrefix(code)}${code}`
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,${startDate},${endDate},320,qfq`
  const result = spawnSync("curl.exe", ["-L", "--max-time", "20", url], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.status !== 0) return []
  try {
    const payload = JSON.parse(String(result.stdout ?? "").trim())
    const rows = payload?.data?.[symbol]?.qfqday ?? []
    return rows.map((row) => ({
      code,
      trade_date: normalizeDate(row[0]),
      open_price: Number(row[1]),
      close_price: Number(row[2]),
      high_price: Number(row[3]),
      low_price: Number(row[4]),
      sample_count: 1,
      source: "tencent-history",
    })).filter((row) => row.trade_date)
  } catch {
    return []
  }
}

function fetchDataHorizonTradeDate() {
  const rows = runPsqlJson(`
select coalesce(json_agg(x)::text, '[]')
from (
  select to_char(max((snapshot_at at time zone 'Asia/Shanghai')::date), 'YYYY-MM-DD') as trade_date
  from trading.quote_snapshots
) x;
`)
  return rows[0]?.trade_date ?? null
}

function fetchDailySummaries(minTradeDate, maxTradeDate) {
  return runPsqlJson(`
select coalesce(json_agg(x order by x.code, x.trade_date)::text, '[]')
from (
  select
    code,
    to_char((snapshot_at at time zone 'Asia/Shanghai')::date, 'YYYY-MM-DD') as trade_date,
    ((array_agg(price order by snapshot_at asc))[1])::float8 as open_price,
    ((array_agg(price order by snapshot_at desc))[1])::float8 as close_price,
    max(price)::float8 as high_price,
    min(price)::float8 as low_price,
    count(*)::int as sample_count
  from trading.quote_snapshots
  where (snapshot_at at time zone 'Asia/Shanghai')::date between date ${sqlLit(minTradeDate)} and date ${sqlLit(maxTradeDate)}
  group by code, (snapshot_at at time zone 'Asia/Shanghai')::date
) x;
`)
}

function fetchLimitUpDays(minTradeDate, maxTradeDate) {
  return runPsqlJson(`
select coalesce(json_agg(x order by x.code, x.trade_date)::text, '[]')
from (
  select
    code,
    to_char(trade_date, 'YYYY-MM-DD') as trade_date,
    count(*)::int as limit_up_count
  from trading.limit_up_pool
  where trade_date between date ${sqlLit(minTradeDate)} and date ${sqlLit(maxTradeDate)}
  group by code, trade_date
) x;
  `)
}

function mergeDailyFallbacks(hypotheses, dailyMap, dataHorizonTradeDate) {
  const startByCode = new Map()
  for (const row of hypotheses) {
    const elapsed = tradingDaysBetween(row.tradeDate, dataHorizonTradeDate)
    if (elapsed < 1) continue
    const code = String(row.code ?? "").trim()
    if (!code) continue
    const current = startByCode.get(code)
    const tradeDate = normalizeTradeDate(row.tradeDate)
    if (!current || String(tradeDate).localeCompare(String(current)) < 0) {
      startByCode.set(code, tradeDate)
    }
  }
  for (const [code, startDate] of startByCode.entries()) {
    const existingDates = new Set((dailyMap.get(code) ?? []).map((row) => row.trade_date))
    const fallbackRows = fetchTencentDailyHistory(code, startDate, dataHorizonTradeDate)
      .filter((row) => !existingDates.has(row.trade_date))
    if (fallbackRows.length === 0) continue
    const merged = [...(dailyMap.get(code) ?? []), ...fallbackRows]
      .sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))
    dailyMap.set(code, merged)
  }
}

function mergeRowsWithTencentFallback(code, tradeDate, dataHorizonTradeDate, dailyRows) {
  const existingDates = new Set((dailyRows ?? []).map((row) => row.trade_date))
  const fallbackRows = fetchTencentDailyHistory(code, tradeDate, dataHorizonTradeDate)
    .filter((row) => !existingDates.has(row.trade_date))
  if (fallbackRows.length === 0) return dailyRows ?? []
  return [...(dailyRows ?? []), ...fallbackRows]
    .sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))
}

function latestValidationCoverage(validations) {
  const map = new Map()
  for (const row of validations) {
    if (!row?.targetId) continue
    const previous = map.get(row.targetId)
    const prevDate = normalizeTradeDate(previous?.dataHorizonTradeDate ?? previous?.createdAt)
    const nextDate = normalizeTradeDate(row.dataHorizonTradeDate ?? row.createdAt)
    if (!previous || String(nextDate ?? "").localeCompare(String(prevDate ?? "")) >= 0) {
      map.set(row.targetId, row)
    }
  }
  return map
}

function checkpointStatus(key, payload) {
  const high = payload.maxHighGainPct ?? -Infinity
  const close = payload.closeGainPct ?? null
  const limitUps = payload.limitUpDays ?? 0
  if (key === "D1") {
    if (limitUps >= 1 || high >= 7 || (close ?? -Infinity) >= 4) return "success"
    if ((close ?? Infinity) <= -4 && high < 2) return "failure"
    return "mixed"
  }
  if (key === "D3") {
    if (limitUps >= 1 || high >= 10 || (close ?? -Infinity) >= 6) return "success"
    if ((close ?? Infinity) <= -5 && high < 3) return "failure"
    return "mixed"
  }
  if (limitUps >= 2 || high >= 15 || (close ?? -Infinity) >= 8) return "success"
  if ((close ?? Infinity) <= -6 && high < 4) return "failure"
  return "mixed"
}

function computeCheckpoints(hypothesis, dailyRows, limitRows, dataHorizonTradeDate) {
  const tradeDate = normalizeTradeDate(hypothesis.tradeDate)
  const elapsedTradingDays = tradingDaysBetween(tradeDate, dataHorizonTradeDate)
  const dueCheckpoints = CHECKPOINTS.filter((item) => elapsedTradingDays >= item.minTradingDays).map((item) => item.key)
  if (dueCheckpoints.length === 0) {
    return {
      elapsedTradingDays,
      dueCheckpoints,
      completedCheckpoints: [],
      checkpoints: {},
      result: "waiting",
      summary: "No due checkpoints yet for current data horizon.",
      dataGap: false,
    }
  }

  const baseDay = dailyRows.find((row) => row.trade_date === tradeDate) ?? null
  const futureDays = dailyRows.filter((row) => row.trade_date > tradeDate)
  const checkpoints = {}
  const completedCheckpoints = []
  let dataGap = baseDay == null

  for (const checkpoint of CHECKPOINTS) {
    if (!dueCheckpoints.includes(checkpoint.key)) continue
    const checkpointDay = futureDays[checkpoint.futureIndex] ?? null
    const checkpointEndDate = checkpointDay?.trade_date ?? dataHorizonTradeDate
    const limitUpDays = limitRows.filter((row) => row.trade_date > tradeDate && row.trade_date <= checkpointEndDate).length
    if (!baseDay || (!checkpointDay && limitUpDays === 0)) {
      checkpoints[checkpoint.key] = {
        due: true,
        available: false,
      }
      dataGap = true
      continue
    }
    const slice = checkpointDay ? futureDays.slice(0, checkpoint.futureIndex + 1) : []
    const maxHighPrice = slice.length > 0
      ? Math.max(...slice.map((row) => Number(row.high_price ?? Number.NEGATIVE_INFINITY)))
      : null
    const payload = {
      due: true,
      available: true,
      asOfTradeDate: checkpointEndDate,
      entryPrice: baseDay.open_price ?? baseDay.close_price,
      sameDayCloseGainPct: pct(baseDay.open_price ?? baseDay.close_price, baseDay.close_price),
      sameDayHighGainPct: pct(baseDay.open_price ?? baseDay.close_price, baseDay.high_price),
      closeGainPct: checkpointDay ? pct(baseDay.open_price ?? baseDay.close_price, checkpointDay.close_price) : null,
      maxHighGainPct: checkpointDay && Number.isFinite(maxHighPrice) ? pct(baseDay.open_price ?? baseDay.close_price, maxHighPrice) : null,
      limitUpDays,
    }
    payload.status = checkpointStatus(checkpoint.key, payload)
    checkpoints[checkpoint.key] = payload
    completedCheckpoints.push(checkpoint.key)
  }

  const availableStatuses = completedCheckpoints.map((key) => checkpoints[key]?.status).filter(Boolean)
  let result = "uncertain"
  if (availableStatuses.includes("success")) result = "success"
  else if (availableStatuses.length > 0 && availableStatuses.every((status) => status === "failure")) result = "failure"
  if (completedCheckpoints.length === 0) result = "data_gap"

  return {
    elapsedTradingDays,
    dueCheckpoints,
    completedCheckpoints,
    checkpoints,
    result,
    summary: `Due checkpoints ${dueCheckpoints.join("/")}, covered ${completedCheckpoints.join("/") || "none"}`,
    dataGap,
  }
}

function buildValidationRecord(hypothesis, checkpointResult, dataHorizonTradeDate) {
  const idSeed = JSON.stringify({
    result: checkpointResult.result,
    dueCheckpoints: checkpointResult.dueCheckpoints,
    completedCheckpoints: checkpointResult.completedCheckpoints,
    checkpoints: checkpointResult.checkpoints,
  })
  return {
    schema: "73wiki-hypothesis-validation-v1",
    id: `hypval_${hypothesis.id}_${dataHorizonTradeDate.replace(/-/g, "")}_${shortHash(idSeed)}`,
    type: "validation",
    targetId: hypothesis.id,
    title: `${hypothesis.tradeDate} ${hypothesis.name ?? hypothesis.code} checkpoint validation`,
    status: "resolved",
    source: "73wiki-hypothesis-validation",
    result: checkpointResult.result === "waiting" ? "uncertain" : checkpointResult.result,
    code: hypothesis.code,
    name: hypothesis.name,
    tradeDate: normalizeTradeDate(hypothesis.tradeDate),
    dataHorizonTradeDate,
    dueCheckpoints: checkpointResult.dueCheckpoints,
    completedCheckpoints: checkpointResult.completedCheckpoints,
    elapsedTradingDays: checkpointResult.elapsedTradingDays,
    checkpoints: checkpointResult.checkpoints,
    summary: checkpointResult.summary,
    tags: ["hypothesis-validation", ...checkpointResult.completedCheckpoints],
    createdAt: nowLocalTimestamp(),
  }
}

function mergeCheckpointCoverage(checkpointResult, latestValidation, dataHorizonTradeDate) {
  const latestHorizon = normalizeTradeDate(latestValidation?.dataHorizonTradeDate ?? latestValidation?.createdAt)
  if (!latestValidation || latestHorizon !== dataHorizonTradeDate) return checkpointResult

  const dueSet = new Set(checkpointResult.dueCheckpoints ?? [])
  const mergedCompleted = Array.from(new Set([
    ...(checkpointResult.completedCheckpoints ?? []),
    ...((latestValidation.completedCheckpoints ?? []).filter((key) => dueSet.has(key))),
  ]))
  if (mergedCompleted.length === (checkpointResult.completedCheckpoints ?? []).length) return checkpointResult

  const mergedCheckpoints = { ...(checkpointResult.checkpoints ?? {}) }
  for (const key of mergedCompleted) {
    if (mergedCheckpoints[key]?.available) continue
    const latestPayload = latestValidation?.checkpoints?.[key]
    if (latestPayload) mergedCheckpoints[key] = latestPayload
  }

  const availableStatuses = mergedCompleted
    .map((key) => mergedCheckpoints[key]?.status)
    .filter(Boolean)
  let result = "uncertain"
  if (availableStatuses.includes("success")) result = "success"
  else if (availableStatuses.length > 0 && availableStatuses.every((status) => status === "failure")) result = "failure"
  if (mergedCompleted.length === 0) result = "data_gap"

  return {
    ...checkpointResult,
    completedCheckpoints: mergedCompleted,
    checkpoints: mergedCheckpoints,
    result,
    summary: `Due checkpoints ${checkpointResult.dueCheckpoints.join("/")}, covered ${mergedCompleted.join("/") || "none"}`,
    dataGap: mergedCompleted.length === 0,
  }
}

function buildMarkdown(record) {
  const lines = [
    `# ${record.title}`,
    "",
    `更新时间：${record.generatedAt}`,
    `数据地平线：${record.dataHorizonTradeDate ?? "-"}`,
    `写入条数：${record.written}`,
    `应回填假设：${record.dueHypotheses}`,
    `完全覆盖：${record.fullyCovered}`,
    `数据缺口：${record.dataGapHypotheses}`,
    "",
    "## 检查点覆盖",
    "",
    `- due checkpoints: ${record.dueCheckpointCount}`,
    `- covered checkpoints: ${record.coveredCheckpointCount}`,
    "",
  ]

  if (record.samples.length > 0) {
    lines.push("## 本次样本")
    lines.push("")
    for (const item of record.samples) {
      lines.push(`- ${item.tradeDate} ${item.code} ${item.name} | due=${item.dueCheckpoints.join("/") || "-"} | covered=${item.completedCheckpoints.join("/") || "-"} | result=${item.result}`)
    }
    lines.push("")
  }

  return `${lines.join("\n")}\n`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const dataHorizonTradeDate = normalizeTradeDate(options.dataHorizonTradeDate ?? fetchDataHorizonTradeDate())
  if (!dataHorizonTradeDate) throw new Error("No quote snapshot data horizon available.")

  const hypotheses = readJsonl(path.join(projectPath, HYPOTHESIS_PATH))
    .filter((row) => row?.id && normalizeTradeDate(row.tradeDate))
    .filter((row) => String(row.status ?? "").trim() === "pending_validation")
  const validations = readJsonl(path.join(projectPath, VALIDATION_PATH))
  const coverage = latestValidationCoverage(validations)
  const eligible = hypotheses.filter((row) => normalizeTradeDate(row.tradeDate) <= dataHorizonTradeDate)
  const minTradeDate = eligible.reduce((min, row) => min == null || row.tradeDate < min ? row.tradeDate : min, null)
  const dailySummaries = minTradeDate ? fetchDailySummaries(minTradeDate, dataHorizonTradeDate) : []
  const limitUpDays = minTradeDate ? fetchLimitUpDays(minTradeDate, dataHorizonTradeDate) : []
  const dailyMap = new Map()
  const limitMap = new Map()
  for (const row of dailySummaries) {
    const list = dailyMap.get(row.code) ?? []
    list.push(row)
    dailyMap.set(row.code, list)
  }
  for (const row of limitUpDays) {
    const list = limitMap.get(row.code) ?? []
    list.push(row)
    limitMap.set(row.code, list)
  }
  mergeDailyFallbacks(eligible, dailyMap, dataHorizonTradeDate)

  let written = 0
  let dueHypotheses = 0
  let fullyCovered = 0
  let dataGapHypotheses = 0
  let dueCheckpointCount = 0
  let coveredCheckpointCount = 0
  const samples = []

  for (const hypothesis of eligible) {
    const hypothesisRows = mergeRowsWithTencentFallback(
      hypothesis.code,
      hypothesis.tradeDate,
      dataHorizonTradeDate,
      dailyMap.get(hypothesis.code) ?? [],
    )
    const checkpointResult = computeCheckpoints(
      hypothesis,
      hypothesisRows,
      limitMap.get(hypothesis.code) ?? [],
      dataHorizonTradeDate,
    )
    if (checkpointResult.dueCheckpoints.length === 0) continue
    const latest = coverage.get(hypothesis.id)
    const effectiveResult = mergeCheckpointCoverage(checkpointResult, latest, dataHorizonTradeDate)
    dueHypotheses += 1
    dueCheckpointCount += effectiveResult.dueCheckpoints.length
    coveredCheckpointCount += effectiveResult.completedCheckpoints.length
    if (effectiveResult.completedCheckpoints.length === effectiveResult.dueCheckpoints.length) fullyCovered += 1
    if (effectiveResult.dataGap) dataGapHypotheses += 1

    const latestCovered = new Set(latest?.completedCheckpoints ?? [])
    const alreadyCovered = checkpointResult.dueCheckpoints.every((key) => latestCovered.has(key))
      && normalizeTradeDate(latest?.dataHorizonTradeDate) === dataHorizonTradeDate
    if (alreadyCovered) continue

    const record = buildValidationRecord(hypothesis, checkpointResult, dataHorizonTradeDate)
    if (options.write && appendUniqueJsonl(path.join(projectPath, VALIDATION_PATH), record)) written += 1
    samples.push({
      tradeDate: hypothesis.tradeDate,
      code: hypothesis.code,
      name: hypothesis.name,
      dueCheckpoints: effectiveResult.dueCheckpoints,
      completedCheckpoints: effectiveResult.completedCheckpoints,
      result: effectiveResult.result,
    })
  }

  const report = {
    schema: "73wiki-hypothesis-validation-report-v1",
    id: `hypothesis_validation_${idTimestamp()}_${shortHash(dataHorizonTradeDate)}`,
    title: "73交易大脑假设检查点回填",
    generatedAt: nowLocalTimestamp(),
    projectPath,
    dataHorizonTradeDate,
    eligibleHypotheses: eligible.length,
    dueHypotheses,
    fullyCovered,
    dataGapHypotheses,
    dueCheckpointCount,
    coveredCheckpointCount,
    written,
    samples: samples.slice(0, 30),
    summary: `horizon ${dataHorizonTradeDate}, due hypotheses ${dueHypotheses}, checkpoint coverage ${coveredCheckpointCount}/${dueCheckpointCount}, written ${written}`,
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }

  if (!options.write) return { dryRun: true, report }

  const reportDir = path.join(projectPath, REPORT_ROOT)
  const stamp = idTimestamp()
  const jsonPath = path.join(reportDir, `${stamp}-hypothesis-validation.json`)
  const mdPath = path.join(reportDir, `${stamp}-hypothesis-validation.md`)
  const latestJson = path.join(reportDir, "latest-hypothesis-validation.json")
  const latestMd = path.join(reportDir, "latest-hypothesis-validation.md")
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
      validations: VALIDATION_PATH,
    },
  }
}

function printHelp() {
  console.log(`Usage:
  npm run hypothesis:validate -- --project C:\\wiki\\73神话
`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  const result = run({
    projectPath: args.project ?? args._[0],
    dataHorizonTradeDate: args["data-horizon"],
    write: Boolean(args.write),
  })
  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(JSON.stringify({
    dryRun: result.dryRun,
    summary: result.report.summary,
    written: result.written,
  }, null, 2))
}

main()
