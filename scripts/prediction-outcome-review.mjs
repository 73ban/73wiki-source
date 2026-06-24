#!/usr/bin/env node
import { createHash } from "node:crypto"
import https from "node:https"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73wiki"
const REPORT_ROOT = ".llm-wiki/prediction-outcome-review"
const FACT_PATH = "data/facts/prediction_outcome_reviews.jsonl"
const TRAINING_PATH = "data/training/prediction_outcome_samples.jsonl"
const PREDICTION_FACT_PATH = "data/facts/prediction_candidates.jsonl"
const MARKET_STRENGTH_PATH = ".llm-wiki/market-strength-rank/latest-market-strength-rank.json"
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

function appendJsonl(filePath, records) {
  const rows = Array.isArray(records) ? records : [records]
  if (rows.length === 0) return
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8")
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

function tradingDaysBetween(startValue, endValue) {
  const start = normalizeTradeDate(startValue)
  const end = normalizeTradeDate(endValue)
  if (!start || !end || start > end) return 0
  let cursor = start
  let count = 0
  while (cursor <= end) {
    const day = new Date(`${cursor}T00:00:00`).getDay()
    if (day !== 0 && day !== 6) count += 1
    cursor = addDays(cursor, 1)
  }
  return count
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

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean))]
}

function pct(base, value) {
  const a = Number(base)
  const b = Number(value)
  if (!Number.isFinite(a) || a === 0 || !Number.isFinite(b)) return null
  return Math.round((((b - a) / a) * 100) * 100) / 100
}

function maxNum(values) {
  const nums = values.map(Number).filter(Number.isFinite)
  return nums.length ? Math.max(...nums) : null
}

function round(value, digits = 2) {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  const factor = 10 ** digits
  return Math.round(num * factor) / factor
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function httpGetJson(url) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" } }, (res) => {
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

async function fetchTencentDailyHistory(code, startDate, endDate) {
  const symbol = `${marketPrefix(code)}${codeBase(code)}`
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,${startDate},${endDate},320,qfq`
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

function latestPredictionRecords(projectPath, { recordsLimit, tradeDate }) {
  const rows = readJsonl(path.join(projectPath, PREDICTION_FACT_PATH))
    .filter((record) => record?.schema === "73wiki-prediction-candidates-v1")
    .filter((record) => normalizeTradeDate(record.planTradeDate ?? record.tradeDate))
    .filter((record) => (record.candidates?.length ?? 0) > 0)
  const byDate = new Map()
  for (const record of rows) {
    const date = normalizeTradeDate(record.planTradeDate ?? record.tradeDate)
    if (tradeDate && date !== tradeDate) continue
    byDate.set(date, record)
  }
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, Number(recordsLimit))
    .map(([, record]) => record)
}

function checkpointSlice(rows, startDate, days) {
  return rows
    .filter((row) => row.tradeDate >= startDate)
    .slice(0, Number(days))
}

function buildMetrics(rows, tradeDate) {
  const entryDay = rows.find((row) => row.tradeDate >= tradeDate) ?? null
  if (!entryDay) {
    return {
      available: false,
      reason: "no_entry_day_quote",
    }
  }
  const entryPrice = entryDay.open || entryDay.close
  const checkpoints = {}
  for (const dayCount of CHECKPOINTS) {
    const slice = checkpointSlice(rows, entryDay.tradeDate, dayCount)
    const endDay = slice.at(-1) ?? null
    checkpoints[`D${dayCount}`] = {
      available: slice.length >= dayCount,
      daysCovered: slice.length,
      entryTradeDate: entryDay.tradeDate,
      asOfTradeDate: endDay?.tradeDate ?? null,
      entryPrice,
      closeGainPct: endDay ? pct(entryPrice, endDay.close) : null,
      maxGainPct: maxNum(slice.map((row) => pct(entryPrice, row.high))),
      minDrawdownPct: maxNum(slice.map((row) => {
        const drawdown = pct(entryPrice, row.low)
        return drawdown == null ? null : -drawdown
      })),
      limitLikeDays: slice.filter((row) => pct(row.open, row.high) >= 9.5 || pct(entryPrice, row.high) >= 9.5).length,
    }
  }
  return {
    available: true,
    entryTradeDate: entryDay.tradeDate,
    entryPrice,
    checkpoints,
  }
}

function classifyOutcome(metrics) {
  if (!metrics.available) return { label: "data_gap", correct: false, reason: metrics.reason }
  const d1 = metrics.checkpoints.D1
  const d3 = metrics.checkpoints.D3
  const d5 = metrics.checkpoints.D5
  const bestMax = maxNum([d1?.maxGainPct, d3?.maxGainPct, d5?.maxGainPct]) ?? 0
  const bestClose = maxNum([d1?.closeGainPct, d3?.closeGainPct, d5?.closeGainPct]) ?? 0
  const limitLike = [d1, d3, d5].some((item) => Number(item?.limitLikeDays ?? 0) > 0)
  if ((d3?.maxGainPct ?? -Infinity) >= 15 || (d5?.maxGainPct ?? -Infinity) >= 20) return { label: "trend_big_win", correct: true, reason: "Trend move produced large 3/5-day upside." }
  if ((d3?.maxGainPct ?? -Infinity) >= 10 || (d5?.maxGainPct ?? -Infinity) >= 15) return { label: "trend_win", correct: true, reason: "Trend move produced meaningful multi-day upside." }
  if (limitLike || bestMax >= 9.5) return { label: "limit_or_near_limit_success", correct: true, reason: "Reached limit-up or near-limit strength." }
  if ((d1?.maxGainPct ?? -Infinity) >= 7 || (d1?.closeGainPct ?? -Infinity) >= 5) return { label: "next_day_big_up", correct: true, reason: "Next-day large gain without requiring a limit-up." }
  if ((d3?.maxGainPct ?? -Infinity) >= 6 || (d5?.maxGainPct ?? -Infinity) >= 8 || bestClose >= 5) return { label: "small_profit", correct: true, reason: "Prediction produced tradable profit but not a core trend winner." }
  if ((d3?.maxGainPct ?? -Infinity) < 3 && (d3?.closeGainPct ?? 0) <= -3) return { label: "failed", correct: false, reason: "No meaningful upside and weak 3-day close." }
  return { label: "uncertain", correct: false, reason: "Outcome is not strong enough yet or still needs more days." }
}

function preferredPlaybooksForRegime(marketRegime) {
  const mode = marketRegime?.mode ?? "unknown"
  if (mode === "attack") return ["limit_board", "overnight_arbitrage", "trend_leader"]
  if (mode === "mixed") return ["trend_leader", "limit_board", "overnight_arbitrage"]
  if (mode === "selective") return ["trend_leader", "swing_profit"]
  if (mode === "defensive") return ["swing_profit", "trend_leader"]
  return ["trend_leader", "limit_board", "overnight_arbitrage", "swing_profit"]
}

function buildPlaybook(metrics, outcome, marketRegime) {
  if (!metrics.available) {
    return {
      label: "data_gap",
      methodFit: "unknown",
      preferredForRegime: false,
      reason: "No quote data for method validation.",
      scores: {},
    }
  }
  const d1 = metrics.checkpoints.D1 ?? {}
  const d3 = metrics.checkpoints.D3 ?? {}
  const d5 = metrics.checkpoints.D5 ?? {}
  const bestMax = maxNum([d1.maxGainPct, d3.maxGainPct, d5.maxGainPct]) ?? 0
  const bestClose = maxNum([d1.closeGainPct, d3.closeGainPct, d5.closeGainPct]) ?? 0
  const worstDrawdown = maxNum([d1.minDrawdownPct, d3.minDrawdownPct, d5.minDrawdownPct]) ?? 0
  const limitLikeDays = [d1, d3, d5].reduce((sum, item) => sum + Number(item?.limitLikeDays ?? 0), 0)
  const limitBoardScore = round(limitLikeDays * 45 + Math.max(0, bestMax - 8) * 3 + Math.max(0, d1.closeGainPct ?? 0) * 1.2 - Math.max(0, worstDrawdown) * 1.5)
  const overnightScore = round(Math.max(0, d1.maxGainPct ?? 0) * 6 + Math.max(0, d1.closeGainPct ?? 0) * 4 - Math.max(0, d1.minDrawdownPct ?? 0) * 2)
  const trendScore = round(Math.max(0, d3.maxGainPct ?? 0) * 3.2 + Math.max(0, d5.maxGainPct ?? 0) * 3.8 + Math.max(0, bestClose) * 2 - Math.max(0, worstDrawdown) * 1.6)
  const swingScore = round(Math.max(0, bestMax) * 2 + Math.max(0, bestClose) * 1.6 - Math.max(0, worstDrawdown) * 1.2)
  let label = "failed_or_unclear"
  let reason = outcome.reason
  if (outcome.label === "trend_big_win" || outcome.label === "trend_win") {
    label = "trend_leader"
    reason = "Multi-day return is the main edge; validate as a trend-strength candidate."
  } else if (outcome.label === "limit_or_near_limit_success") {
    label = "limit_board"
    reason = "Limit-up or near-limit strength is the main edge."
  } else if (outcome.label === "next_day_big_up") {
    label = "overnight_arbitrage"
    reason = "Next-day impulse was tradable even without multi-day confirmation."
  } else if (outcome.label === "small_profit") {
    label = "swing_profit"
    reason = "The setup produced money but not a top leader; validate as secondary swing profit."
  } else if (outcome.label === "uncertain") {
    label = "pending_confirmation"
  }
  const preferred = preferredPlaybooksForRegime(marketRegime)
  const preferredForRegime = preferred.includes(label)
  return {
    label,
    methodFit: preferredForRegime ? "regime_matched" : "regime_mismatch_or_secondary",
    preferredForRegime,
    preferredPlaybooks: preferred,
    reason,
    scores: {
      limitBoardScore,
      overnightScore,
      trendScore,
      swingScore,
    },
  }
}

function buildOutcomeScore(item) {
  const d1 = item.metrics.checkpoints?.D1 ?? {}
  const d3 = item.metrics.checkpoints?.D3 ?? {}
  const d5 = item.metrics.checkpoints?.D5 ?? {}
  const bestMax = Number(item.bestMaxGainPct ?? 0)
  const bestClose = Number(item.bestCloseGainPct ?? 0)
  const drawdown = maxNum([d1.minDrawdownPct, d3.minDrawdownPct, d5.minDrawdownPct]) ?? 0
  const playbookScores = item.playbook?.scores ?? {}
  const leaderBonus = item.playbook?.label === "trend_leader" ? 18 : item.playbook?.label === "limit_board" ? 14 : item.playbook?.label === "overnight_arbitrage" ? 10 : 0
  const fitBonus = item.playbook?.preferredForRegime ? 8 : 0
  const score = bestMax * 3 + bestClose * 1.6 - Math.max(0, drawdown) * 1.8 + leaderBonus + fitBonus + Math.max(0, Number(playbookScores.trendScore ?? 0), Number(playbookScores.limitBoardScore ?? 0), Number(playbookScores.overnightScore ?? 0)) * 0.08
  return round(score)
}

function aggregateCounts(reviews, field) {
  const out = {}
  for (const review of reviews) {
    for (const [key, value] of Object.entries(review.counts?.[field] ?? {})) {
      out[key] = (out[key] ?? 0) + Number(value ?? 0)
    }
  }
  return out
}

function loadMarketStrength(projectPath, asOfDate) {
  const record = readJsonMaybe(path.join(projectPath, MARKET_STRENGTH_PATH))
  if (!record || record.status !== "active") return null
  const evidenceTradeDate = normalizeTradeDate(record.evidenceTradeDate)
  if (evidenceTradeDate !== normalizeTradeDate(asOfDate)) return null
  const byCode = new Map((record.rows ?? []).map((item) => [codeBase(item.code), item]))
  return {
    id: record.id,
    evidenceTradeDate,
    rankingScope: record.rankingScope ?? null,
    counts: record.counts ?? {},
    byCode,
  }
}

function fullMarketDailyRankFor(marketStrength, code) {
  const row = marketStrength?.byCode?.get(codeBase(code))
  if (!row) return null
  return {
    sourceId: marketStrength.id,
    evidenceTradeDate: marketStrength.evidenceTradeDate,
    scope: marketStrength.rankingScope?.type ?? "full_market_daily",
    rank: row.fullMarketDailyRank ?? null,
    percentile: row.fullMarketDailyPercentile ?? null,
    changePercent: row.changePercent ?? null,
    amountRank: row.amountRank ?? null,
    amount: row.amount ?? null,
    turnoverRate: row.turnoverRate ?? null,
  }
}

function buildSample(record, item) {
  return {
    schema: "73wiki-prediction-outcome-sample-v1",
    id: `pred_outcome_sample_${shortHash(`${record.id}:${item.code}:${item.outcome.label}`)}`,
    instruction: "Judge whether a prediction candidate was correct using real profit outcome, not only next-day limit-up.",
    input: {
      predictionDate: record.predictionTradeDate,
      code: item.code,
      name: item.name,
      rank: item.rank,
      score: item.score,
      themes: item.themes,
      reasons: item.reasons,
      marketRegime: item.marketRegime,
      playbook: item.playbook,
      ranks: {
        predictedRank: item.rank,
        outcomeRank: item.rankByOutcome ?? null,
        playbookRank: item.rankByPlaybook ?? null,
        fullMarketDailyRank: item.fullMarketDailyRank?.rank ?? null,
      },
      fullMarketDailyRank: item.fullMarketDailyRank,
      outcomeMetrics: item.metrics,
    },
    output: {
      label: item.outcome.label,
      playbook: item.playbook?.label ?? null,
      methodFit: item.playbook?.methodFit ?? null,
      correct: item.outcome.correct,
      lesson: item.lesson,
    },
    label: {
      result: item.outcome.label,
      playbook: item.playbook?.label ?? null,
      correct: item.outcome.correct,
      bestMaxGainPct: item.bestMaxGainPct,
      bestCloseGainPct: item.bestCloseGainPct,
      outcomeScore: item.outcomeScore ?? null,
      fullMarketDailyRank: item.fullMarketDailyRank?.rank ?? null,
      fullMarketDailyPercentile: item.fullMarketDailyRank?.percentile ?? null,
    },
    metadata: {
      createdAt: nowLocalTimestamp(),
      tags: ["73wiki", "prediction-outcome", item.outcome.label],
    },
  }
}

function lessonFor(item) {
  if (item.playbook?.label === "trend_leader") return "Trend行情要看区间收益排名；没有次日涨停但3/5日成为最强区间股，也应提高相似模式权重。"
  if (item.playbook?.label === "limit_board") return "连板或强封板行情要保留涨停强度、封板质量、题材共振等特征。"
  if (item.playbook?.label === "overnight_arbitrage") return "隔日套利要重视次日冲高和收盘强度，不要求后续持续趋势。"
  if (item.playbook?.label === "swing_profit") return "该信号可赚钱但不是主升核心，只能作为次级套利或观察样本。"
  if (item.outcome.label === "trend_big_win") return "Treat this as a top trend-winner pattern; raise weights for similar multi-day continuation setups."
  if (item.outcome.label === "trend_win") return "The prediction was right as a trend trade; do not punish it for lacking a next-day limit-up."
  if (item.outcome.label === "next_day_big_up") return "The catalyst translated quickly into profit; keep next-day strength features."
  if (item.outcome.label === "limit_or_near_limit_success") return "The signal had limit-up strength; preserve the evidence and scoring pattern."
  if (item.outcome.label === "small_profit") return "The signal was tradable but not a core winner; keep as secondary candidate pattern."
  if (item.outcome.label === "failed") return "The candidate failed to produce tradable upside; review source quality, market regime, and theme elasticity."
  return "Insufficient or inconclusive outcome; keep waiting before changing weights."
}

async function reviewPredictionRecord(projectPath, predictionRecord, options = {}) {
  const tradeDate = normalizeTradeDate(predictionRecord.planTradeDate ?? predictionRecord.tradeDate)
  const asOfDate = normalizeTradeDate(options.asOfDate) ?? dateOnly()
  const marketStrength = options.marketStrength ?? null
  const candidates = (predictionRecord.candidates ?? [])
    .slice(0, Number(options.candidateLimit ?? 30))
    .filter((item) => /^\d{6}$/.test(codeBase(item.code)))
  const items = []
  for (const candidate of candidates) {
    const code = codeBase(candidate.code)
    const rows = await fetchTencentDailyHistory(code, previousTradingDate(tradeDate), asOfDate)
    const metrics = buildMetrics(rows, tradeDate)
    const outcome = classifyOutcome(metrics)
    const d1 = metrics.checkpoints?.D1 ?? {}
    const d3 = metrics.checkpoints?.D3 ?? {}
    const d5 = metrics.checkpoints?.D5 ?? {}
    const bestMaxGainPct = maxNum([d1.maxGainPct, d3.maxGainPct, d5.maxGainPct])
    const bestCloseGainPct = maxNum([d1.closeGainPct, d3.closeGainPct, d5.closeGainPct])
    const marketRegime = candidate.marketRegime ?? null
    const playbook = buildPlaybook(metrics, outcome, marketRegime)
    const fullMarketDailyRank = fullMarketDailyRankFor(marketStrength, code)
    const item = {
      code,
      name: candidate.name ?? "",
      rank: candidate.rank ?? null,
      score: candidate.score ?? null,
      signalGrade: candidate.signalGrade ?? null,
      themes: candidate.themes ?? [],
      reasons: candidate.reasons ?? [],
      sourceTags: candidate.sourceTags ?? [],
      marketRegime,
      metrics,
      outcome,
      playbook,
      fullMarketDailyRank,
      bestMaxGainPct,
      bestCloseGainPct,
    }
    item.outcomeScore = buildOutcomeScore(item)
    item.lesson = lessonFor(item)
    items.push(item)
  }
  const outcomeRanked = [...items]
    .filter((item) => item.bestMaxGainPct != null)
    .sort((a, b) => Number(b.outcomeScore ?? -Infinity) - Number(a.outcomeScore ?? -Infinity) || Number(b.bestMaxGainPct ?? -Infinity) - Number(a.bestMaxGainPct ?? -Infinity))
  outcomeRanked.forEach((item, index) => {
    item.rankByOutcome = index + 1
  })
  const playbookRanked = new Map()
  for (const label of unique(items.map((item) => item.playbook?.label))) {
    const ranked = items
      .filter((item) => item.playbook?.label === label)
      .sort((a, b) => Number(b.outcomeScore ?? -Infinity) - Number(a.outcomeScore ?? -Infinity) || Number(b.bestMaxGainPct ?? -Infinity) - Number(a.bestMaxGainPct ?? -Infinity))
    ranked.forEach((item, index) => playbookRanked.set(`${label}:${item.code}`, index + 1))
  }
  for (const item of items) item.rankByPlaybook = playbookRanked.get(`${item.playbook?.label}:${item.code}`) ?? null
  const evaluable = items.filter((item) => !["data_gap"].includes(item.outcome.label))
  const correct = evaluable.filter((item) => item.outcome.correct)
  const byLabel = items.reduce((acc, item) => {
    acc[item.outcome.label] = (acc[item.outcome.label] ?? 0) + 1
    return acc
  }, {})
  const byPlaybook = items.reduce((acc, item) => {
    const label = item.playbook?.label ?? "unknown"
    acc[label] = (acc[label] ?? 0) + 1
    return acc
  }, {})
  const byMethodFit = items.reduce((acc, item) => {
    const label = item.playbook?.methodFit ?? "unknown"
    acc[label] = (acc[label] ?? 0) + 1
    return acc
  }, {})
  const trendLeaders = [...items]
    .filter((item) => item.bestMaxGainPct != null)
    .sort((a, b) => Number(b.outcomeScore ?? -Infinity) - Number(a.outcomeScore ?? -Infinity) || Number(b.bestMaxGainPct ?? -Infinity) - Number(a.bestMaxGainPct ?? -Infinity))
    .slice(0, 10)
    .map((item, index) => ({
      rankByOutcome: index + 1,
      code: item.code,
      name: item.name,
      predictedRank: item.rank,
      bestMaxGainPct: item.bestMaxGainPct,
      bestCloseGainPct: item.bestCloseGainPct,
      outcomeScore: item.outcomeScore,
      label: item.outcome.label,
      playbook: item.playbook?.label ?? null,
      methodFit: item.playbook?.methodFit ?? null,
      fullMarketDailyRank: item.fullMarketDailyRank?.rank ?? null,
      fullMarketDailyChangePercent: item.fullMarketDailyRank?.changePercent ?? null,
      themes: item.themes.slice(0, 8),
    }))
  const playbookLeaders = Object.fromEntries(["trend_leader", "limit_board", "overnight_arbitrage", "swing_profit"].map((label) => [
    label,
    items
      .filter((item) => item.playbook?.label === label)
      .sort((a, b) => Number(b.outcomeScore ?? -Infinity) - Number(a.outcomeScore ?? -Infinity) || Number(b.bestMaxGainPct ?? -Infinity) - Number(a.bestMaxGainPct ?? -Infinity))
      .slice(0, 5)
      .map((item) => ({
        rankByPlaybook: item.rankByPlaybook,
        code: item.code,
        name: item.name,
        predictedRank: item.rank,
        bestMaxGainPct: item.bestMaxGainPct,
        bestCloseGainPct: item.bestCloseGainPct,
        outcomeScore: item.outcomeScore,
        label: item.outcome.label,
        methodFit: item.playbook?.methodFit ?? null,
        fullMarketDailyRank: item.fullMarketDailyRank?.rank ?? null,
        fullMarketDailyChangePercent: item.fullMarketDailyRank?.changePercent ?? null,
      })),
  ]))
  return {
    schema: "73wiki-prediction-outcome-review-v1",
    id: `prediction_outcome_${tradeDate.replace(/-/g, "")}_${idTimestamp()}_${shortHash(predictionRecord.id)}`,
    status: "active",
    generatedAt: nowLocalTimestamp(),
    predictionRecordId: predictionRecord.id,
    predictionTradeDate: tradeDate,
    asOfDate,
    projectPath,
    counts: {
      candidates: items.length,
      evaluable: evaluable.length,
      correct: correct.length,
      moneyHitRate: evaluable.length ? Number((correct.length / evaluable.length).toFixed(4)) : 0,
      byLabel,
      byPlaybook,
      byMethodFit,
    },
    trendLeaders,
    playbookLeaders,
    rankingScope: {
      type: marketStrength ? "prediction_pool_plus_full_market_daily" : "prediction_pool",
      fullMarketDailyAvailable: Boolean(marketStrength),
      fullMarketDailySourceId: marketStrength?.id ?? null,
      note: marketStrength
        ? "Outcome ranks compare candidates in the prediction record; fullMarketDailyRank compares each stock against the whole A-share daily strength snapshot."
        : "Outcome ranks compare candidates in the prediction record. Full-market rank requires a complete all-A-share daily return snapshot.",
    },
    items,
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
      trainingSampleWrite: true,
    },
  }
}

function markdown(record) {
  const lines = [
    `# ${record.predictionTradeDate} Prediction Outcome Review`,
    "",
    `Generated: ${record.generatedAt}`,
    `As of: ${record.asOfDate}`,
    `Prediction record: ${record.predictionRecordId}`,
    "",
    "## Metrics",
    "",
    `- Candidates: ${record.counts.candidates}`,
    `- Evaluable: ${record.counts.evaluable}`,
    `- Correct money outcomes: ${record.counts.correct}`,
    `- Money hit rate: ${record.counts.moneyHitRate}`,
    `- Labels: ${Object.entries(record.counts.byLabel).map(([key, value]) => `${key}=${value}`).join(", ")}`,
    `- Playbooks: ${Object.entries(record.counts.byPlaybook ?? {}).map(([key, value]) => `${key}=${value}`).join(", ")}`,
    `- Method fit: ${Object.entries(record.counts.byMethodFit ?? {}).map(([key, value]) => `${key}=${value}`).join(", ")}`,
    `- Ranking scope: ${record.rankingScope?.type ?? "prediction_pool"}; ${record.rankingScope?.note ?? ""}`,
    "",
    "## Strongest Outcome Leaders",
    "",
  ]
  for (const item of record.trendLeaders) {
    lines.push(`- ${item.rankByOutcome}. ${item.name || item.code}(${item.code}) predictedRank=${item.predictedRank ?? "-"} max=${item.bestMaxGainPct ?? "-"}% close=${item.bestCloseGainPct ?? "-"}% score=${item.outcomeScore ?? "-"} label=${item.label} playbook=${item.playbook ?? "-"} fullMarketD1Rank=${item.fullMarketDailyRank ?? "-"}`)
  }
  lines.push("", "## Method Leaders", "")
  for (const [label, leaders] of Object.entries(record.playbookLeaders ?? {})) {
    if (!leaders.length) continue
    lines.push(`### ${label}`)
    for (const item of leaders) {
      lines.push(`- ${item.rankByPlaybook}. ${item.name || item.code}(${item.code}) predictedRank=${item.predictedRank ?? "-"} max=${item.bestMaxGainPct ?? "-"}% close=${item.bestCloseGainPct ?? "-"}% score=${item.outcomeScore ?? "-"} fit=${item.methodFit ?? "-"} fullMarketD1Rank=${item.fullMarketDailyRank ?? "-"}`)
    }
    lines.push("")
  }
  lines.push("", "## Failed / Uncertain")
  for (const item of record.items.filter((row) => ["failed", "uncertain"].includes(row.outcome.label)).slice(0, 15)) {
    lines.push(`- ${item.name || item.code}(${item.code}) predictedRank=${item.rank ?? "-"} max=${item.bestMaxGainPct ?? "-"}% close=${item.bestCloseGainPct ?? "-"}% playbook=${item.playbook?.label ?? "-"} reason=${item.outcome.reason}`)
  }
  lines.push("", "This review scores real profit outcomes across limit-board, trend, overnight-arbitrage, and swing playbooks. It is not buy advice.")
  return `${lines.join("\n").trim()}\n`
}

async function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const asOfDate = normalizeTradeDate(options.asOfDate) ?? dateOnly()
  const latestDefaultEvaluableDate = previousTradingDate(asOfDate)
  const marketStrength = loadMarketStrength(projectPath, asOfDate)
  const records = latestPredictionRecords(projectPath, {
    recordsLimit: Number(options.recordsLimit ?? 5),
    tradeDate: normalizeTradeDate(options.tradeDate),
  }).filter((record) => {
    const planDate = normalizeTradeDate(record.planTradeDate ?? record.tradeDate)
    if (options.includeAsOfDate) return tradingDaysBetween(planDate, asOfDate) >= 1
    return planDate <= latestDefaultEvaluableDate
  })
  const reviews = []
  for (const record of records) {
    reviews.push(await reviewPredictionRecord(projectPath, record, { ...options, marketStrength }))
  }
  const generatedAt = nowLocalTimestamp()
  const summary = {
    schema: "73wiki-prediction-outcome-review-batch-v1",
    id: `prediction_outcome_batch_${idTimestamp()}_${shortHash(reviews.map((item) => item.id).join("|"))}`,
    status: "active",
    generatedAt,
    projectPath,
    asOfDate,
    reviews,
    counts: {
      reviewedRecords: reviews.length,
      candidates: reviews.reduce((sum, item) => sum + item.counts.candidates, 0),
      evaluable: reviews.reduce((sum, item) => sum + item.counts.evaluable, 0),
      correct: reviews.reduce((sum, item) => sum + item.counts.correct, 0),
      byPlaybook: aggregateCounts(reviews, "byPlaybook"),
      byMethodFit: aggregateCounts(reviews, "byMethodFit"),
    },
    marketStrength: marketStrength ? {
      id: marketStrength.id,
      evidenceTradeDate: marketStrength.evidenceTradeDate,
      counts: marketStrength.counts,
      rankingScope: marketStrength.rankingScope,
    } : null,
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
      trainingSampleWrite: true,
    },
  }
  summary.counts.moneyHitRate = summary.counts.evaluable ? Number((summary.counts.correct / summary.counts.evaluable).toFixed(4)) : 0
  if (options.write) {
    const stamp = idTimestamp()
    const outDir = path.join(projectPath, REPORT_ROOT)
    const latestJson = path.join(outDir, "latest-prediction-outcome-review.json")
    const latestMd = path.join(outDir, "latest-prediction-outcome-review.md")
    writeJson(path.join(outDir, `${stamp}-prediction-outcome-review.json`), summary)
    writeJson(latestJson, summary)
    writeText(path.join(outDir, `${stamp}-prediction-outcome-review.md`), reviews.map(markdown).join("\n---\n"))
    writeText(latestMd, reviews.map(markdown).join("\n---\n"))
    appendJsonl(path.join(projectPath, FACT_PATH), reviews)
    appendJsonl(path.join(projectPath, TRAINING_PATH), reviews.flatMap((record) => record.items.map((item) => buildSample(record, item))))
    return {
      dryRun: false,
      record: summary,
      written: {
        facts: FACT_PATH,
        training: TRAINING_PATH,
        latest: projectRelative(projectPath, latestJson),
        markdown: projectRelative(projectPath, latestMd),
      },
    }
  }
  return { dryRun: true, record: summary }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/prediction-outcome-review.mjs --project <wiki-root> --records 5 --candidate-limit 30 --write")
    return
  }
  const result = await run({
    projectPath: args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH,
    tradeDate: args["trade-date"],
    asOfDate: args["as-of"],
    recordsLimit: Number(args.records ?? args["records-limit"] ?? 5),
    candidateLimit: Number(args["candidate-limit"] ?? 30),
    includeAsOfDate: Boolean(args["include-as-of-date"]),
    write: Boolean(args.write || args._.includes("write")),
  })
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(JSON.stringify({
      dryRun: result.dryRun,
      id: result.record.id,
      asOfDate: result.record.asOfDate,
      reviewedRecords: result.record.counts.reviewedRecords,
      candidates: result.record.counts.candidates,
      evaluable: result.record.counts.evaluable,
      correct: result.record.counts.correct,
      moneyHitRate: result.record.counts.moneyHitRate,
      byPlaybook: result.record.counts.byPlaybook,
      byMethodFit: result.record.counts.byMethodFit,
      written: result.written ?? null,
    }, null, 2))
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
