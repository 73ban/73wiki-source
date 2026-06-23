#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const REPORT_ROOT = ".llm-wiki/next-limitup-review"
const FACT_PATH = "data/facts/next_limitup_reviews.jsonl"
const TRAINING_PATH = "data/training/next_limitup_review_samples.jsonl"
const TEXT_EXTENSIONS = new Set([".md", ".txt"])
const MAX_FILE_BYTES = 1_200_000

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

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00`)
  date.setDate(date.getDate() + Number(days))
  return nowLocalTimestamp(date).slice(0, 10)
}

function previousTradingDate(isoDate) {
  let current = addDays(isoDate, -1)
  while ([0, 6].includes(new Date(`${current}T00:00:00`).getDay())) current = addDays(current, -1)
  return current
}

function codeBase(value) {
  return String(value ?? "").replace(/\.(SH|SZ|BJ)$/i, "").replace(/\D/g, "").padStart(6, "0").slice(-6)
}

function toArray(value) {
  return Array.isArray(value) ? value : []
}

function unique(values) {
  return [...new Set(toArray(values).filter(Boolean).map((item) => String(item).trim()).filter(Boolean))]
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
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter(Boolean)
}

function jsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return []
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dirPath, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
}

function recordDate(record) {
  return normalizeTradeDate(record?.planTradeDate ?? record?.tradeDate ?? record?.evidenceTradeDate)
}

function latestRecordForDate({ projectPath, reportRoot, factPath, tradeDate }) {
  const fromReports = jsonFiles(path.join(projectPath, reportRoot))
    .map(readJsonMaybe)
    .filter(Boolean)
    .find((record) => recordDate(record) === tradeDate)
  if (fromReports) return fromReports
  return readJsonl(path.join(projectPath, factPath)).reverse().find((record) => recordDate(record) === tradeDate) ?? null
}

function latestLimitUpRecord(projectPath, tradeDate) {
  if (tradeDate) {
    return latestRecordForDate({
      projectPath,
      reportRoot: ".llm-wiki/limit-up-reasons",
      factPath: "data/facts/limit_up_reasons.jsonl",
      tradeDate,
    })
  }
  return readJsonMaybe(path.join(projectPath, ".llm-wiki/limit-up-reasons/latest-limit-up-reasons.json"))
}

function latestPredictionRecord(projectPath, tradeDate) {
  return latestRecordForDate({
    projectPath,
    reportRoot: ".llm-wiki/prediction-candidates",
    factPath: "data/facts/prediction_candidates.jsonl",
    tradeDate,
  })
}

function projectRelative(projectPath, targetPath) {
  return path.relative(path.resolve(projectPath), path.resolve(targetPath)).replace(/\\/g, "/")
}

function fileDate(relativePath) {
  return normalizeTradeDate(relativePath)
}

function walkTextFiles(rootDir, limit = 25000) {
  const out = []
  const stack = [rootDir]
  while (stack.length > 0 && out.length < limit) {
    const current = stack.pop()
    if (!fs.existsSync(current)) continue
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (/node_modules|\.git|__pycache__|derived|^_|06-|07-/i.test(entry.name)) continue
        stack.push(fullPath)
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const stat = fs.statSync(fullPath)
        if (stat.size > 0 && stat.size <= MAX_FILE_BYTES) out.push({ filePath: fullPath, stat })
      }
    }
  }
  return out
}

function contextAround(text, index, size = 240) {
  return String(text ?? "")
    .slice(Math.max(0, index - size), Math.min(String(text ?? "").length, index + size))
    .replace(/\s+/g, " ")
    .trim()
}

function sourceTag(relativePath) {
  if (/CLS|cailian|财联社|快讯|璐㈣仈|蹇/i.test(relativePath)) return "cls-news"
  if (/公告|announcement|A股公告|鍏憡/i.test(relativePath)) return "announcement"
  if (/游资|淘股吧|youzi|tgb|娓歌祫|娣樿偂/i.test(relativePath)) return "youzi-community"
  if (/同花顺|热榜|hotlist|ths|鍚岃姳|鐑/i.test(relativePath)) return "hotlist"
  if (/复盘|review|澶嶇洏/i.test(relativePath)) return "daily-review"
  if (/早报|盘前|preopen|鏃╂姤|鐩樺墠/i.test(relativePath)) return "preopen"
  if (/新闻联播|人民日报|央视|authority|policy|浜烘皯|澶獟/i.test(relativePath)) return "authority-policy"
  return "raw"
}

function rowValue(row, patterns, fallback = null) {
  for (const [key, value] of Object.entries(row ?? {})) {
    if (patterns.some((pattern) => pattern.test(key))) return value
  }
  return fallback
}

function reasonStrength(reason) {
  const row = reason?.raw?.row ?? {}
  const firstLimitTime = String(rowValue(row, [/首.*封板.*时间/, /棣栨.*灏.*鏃堕棿/], ""))
  const height = Number(rowValue(row, [/连板/, /杩炴澘/], 1))
  const burst = Number(rowValue(row, [/炸板/, /鐐告澘/], 0))
  let score = 50
  if (/^09:25/.test(firstLimitTime)) score += 25
  else if (/^09:3/.test(firstLimitTime)) score += 15
  if (height >= 2) score += 10
  if (height >= 3) score += 10
  if (burst === 0) score += 8
  if (reason?.raw?.isWarroom) score += 10
  return Math.max(0, Math.min(100, score))
}

function scanPriorEvidence(projectPath, limitUps, tradeDate, daysBack) {
  const minDate = addDays(tradeDate, -Number(daysBack))
  const maxDate = previousTradingDate(tradeDate)
  const targets = limitUps.map((item) => ({
    code: codeBase(item.code),
    name: String(item.name ?? "").trim(),
    concepts: unique([item.theme, ...(item.concepts ?? [])]),
  }))
  const evidence = new Map(targets.map((item) => [item.code, { direct: [], theme: [] }]))

  for (const file of walkTextFiles(path.join(projectPath, "raw"))) {
    const relativePath = projectRelative(projectPath, file.filePath)
    const date = fileDate(relativePath)
    if (date && (date < minDate || date > maxDate)) continue
    if (!date && file.stat.mtimeMs < new Date(`${minDate}T00:00:00`).getTime()) continue
    const content = fs.readFileSync(file.filePath, "utf8")
    for (const target of targets) {
      const bucket = evidence.get(target.code)
      if (!bucket) continue
      for (const needle of unique([target.code, target.name]).filter((item) => item.length >= 2)) {
        const index = content.indexOf(needle)
        if (index >= 0 && bucket.direct.length < 8) {
          bucket.direct.push({ file: relativePath, sourceTag: sourceTag(relativePath), excerpt: contextAround(content, index) })
        }
      }
      if (bucket.direct.length > 0) continue
      for (const concept of target.concepts.filter((item) => item.length >= 2)) {
        const index = content.indexOf(concept)
        if (index >= 0 && bucket.theme.length < 5) {
          bucket.theme.push({ file: relativePath, sourceTag: sourceTag(relativePath), concept, excerpt: contextAround(content, index) })
          break
        }
      }
    }
  }
  return evidence
}

function predictionIndex(record) {
  const byCode = new Map()
  for (const item of record?.candidates ?? []) byCode.set(codeBase(item.code), item)
  return byCode
}

function classifyReview({ candidate, evidence, coreLimit }) {
  if (candidate && Number(candidate.rank ?? 999) <= Number(coreLimit)) return "hit_core"
  if (candidate) return "hit_low_priority"
  if (evidence.direct.length > 0) return "scoring_gap"
  if (evidence.theme.length > 0) return "mapping_gap"
  return "information_gap"
}

function lessonFor(label) {
  if (label === "hit_core") return "The signal was correctly promoted into the core next-day pool; preserve the evidence and scoring pattern."
  if (label === "hit_low_priority") return "The stock was seen but underweighted; raise weights for similar catalyst, timing, and tradeability features."
  if (label === "scoring_gap") return "The information was available before the limit-up, but the scoring system failed to promote it."
  if (label === "mapping_gap") return "The theme was visible, but the system did not map the theme to the correct elastic stock."
  return "The prior evidence scan did not find the stock or its theme; improve source coverage or ingestion freshness."
}

function actionFor(label) {
  if (label === "hit_core") return "keep_pattern"
  if (label === "hit_low_priority") return "boost_scoring_weights"
  if (label === "scoring_gap") return "fix_scoring_model"
  if (label === "mapping_gap") return "improve_theme_to_stock_mapping"
  return "improve_information_coverage"
}

function buildSample(row) {
  return {
    schema: "73wiki-next-limitup-review-sample-v1",
    id: `nlur_sample_${shortHash(`${row.tradeDate}:${row.code}:${row.label}`)}`,
    instruction: "Review whether yesterday's evidence and scoring system correctly anticipated today's limit-up stock.",
    input: {
      tradeDate: row.tradeDate,
      code: row.code,
      name: row.name,
      actualLimitUpReason: row.actual.reason,
      actualTheme: row.actual.theme,
      prediction: row.prediction,
      priorEvidence: row.priorEvidence,
    },
    output: {
      label: row.label,
      lesson: row.lesson,
      requiredAction: row.requiredAction,
    },
    label: {
      result: row.label,
      predicted: Boolean(row.prediction),
      rank: row.prediction?.rank ?? null,
      reasonStrength: row.actual.reasonStrength,
    },
    metadata: {
      createdAt: nowLocalTimestamp(),
      tags: ["73wiki", "next-limitup-review", row.label],
    },
  }
}

function buildReview(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const limitRecord = latestLimitUpRecord(projectPath, normalizeTradeDate(options.tradeDate))
  if (!limitRecord) throw new Error("No limit-up reason record found")
  const tradeDate = normalizeTradeDate(limitRecord.planTradeDate ?? limitRecord.tradeDate ?? options.tradeDate)
  if (!tradeDate) throw new Error("Cannot resolve trade date from limit-up reason record")

  const prediction = latestPredictionRecord(projectPath, tradeDate)
  const limitUps = toArray(limitRecord.reasons ?? limitRecord.items)
    .map((item) => ({ ...item, code: codeBase(item.code) }))
    .filter((item) => /^\d{6}$/.test(item.code))
  const predictedByCode = predictionIndex(prediction)
  const priorEvidence = scanPriorEvidence(projectPath, limitUps, tradeDate, Number(options.daysBack ?? 5))
  const coreLimit = Number(options.coreLimit ?? 10)

  const items = limitUps.map((reason) => {
    const candidate = predictedByCode.get(reason.code)
    const evidence = priorEvidence.get(reason.code) ?? { direct: [], theme: [] }
    const label = classifyReview({ candidate, evidence, coreLimit })
    const row = reason.raw?.row ?? {}
    return {
      schema: "73wiki-next-limitup-review-item-v1",
      tradeDate,
      code: reason.code,
      name: reason.name ?? candidate?.name ?? "",
      label,
      requiredAction: actionFor(label),
      lesson: lessonFor(label),
      actual: {
        reason: reason.reason ?? "",
        theme: reason.theme ?? "",
        concepts: reason.concepts ?? [],
        firstLimitTime: rowValue(row, [/首.*封板.*时间/, /棣栨.*灏.*鏃堕棿/]),
        height: rowValue(row, [/连板/, /杩炴澘/]),
        burstCount: rowValue(row, [/炸板/, /鐐告澘/]),
        reasonStrength: reasonStrength(reason),
        sourceLevel: reason.sourceLevel ?? null,
      },
      prediction: candidate ? {
        rank: candidate.rank ?? null,
        score: candidate.score ?? null,
        signalGrade: candidate.signalGrade ?? null,
        sourceTags: candidate.sourceTags ?? [],
        reasons: candidate.reasons ?? [],
        evidence: toArray(candidate.evidence).slice(0, 3),
      } : null,
      priorEvidence: {
        directCount: evidence.direct.length,
        themeCount: evidence.theme.length,
        direct: evidence.direct.slice(0, 3),
        theme: evidence.theme.slice(0, 2),
      },
    }
  }).sort((a, b) => b.actual.reasonStrength - a.actual.reasonStrength || a.code.localeCompare(b.code))

  const counts = items.reduce((acc, item) => {
    acc[item.label] = (acc[item.label] ?? 0) + 1
    return acc
  }, {})
  const predictedCount = items.filter((item) => item.prediction).length
  const coreHitCount = items.filter((item) => item.label === "hit_core").length
  const reviewedCount = items.length
  const generatedAt = nowLocalTimestamp()
  return {
    schema: "73wiki-next-limitup-review-v1",
    id: `next_limitup_review_${tradeDate.replace(/-/g, "")}_${idTimestamp()}_${shortHash(items.map((item) => `${item.code}:${item.label}`).join("|"))}`,
    status: "active",
    generatedAt,
    tradeDate,
    previousTradeDate: previousTradingDate(tradeDate),
    projectPath,
    predictionRecordId: prediction?.id ?? null,
    limitUpRecordId: limitRecord.id ?? null,
    coreLimit,
    counts: {
      reviewed: reviewedCount,
      predicted: predictedCount,
      coreHits: coreHitCount,
      hitRate: reviewedCount ? Number((predictedCount / reviewedCount).toFixed(4)) : 0,
      coreHitRate: reviewedCount ? Number((coreHitCount / reviewedCount).toFixed(4)) : 0,
      byLabel: counts,
    },
    improvementQueue: {
      informationGaps: items.filter((item) => item.label === "information_gap").slice(0, 30),
      scoringGaps: items.filter((item) => item.label === "scoring_gap" || item.label === "hit_low_priority").slice(0, 30),
      mappingGaps: items.filter((item) => item.label === "mapping_gap").slice(0, 30),
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
    `# ${record.tradeDate} Next Limit-up Review`,
    "",
    `Generated: ${record.generatedAt}`,
    `Previous trade date: ${record.previousTradeDate}`,
    `Prediction record: ${record.predictionRecordId ?? "missing"}`,
    `Limit-up record: ${record.limitUpRecordId ?? "missing"}`,
    "",
    "## Metrics",
    "",
    `- Reviewed limit-ups: ${record.counts.reviewed}`,
    `- Predicted by yesterday pool: ${record.counts.predicted}`,
    `- Core top-${record.coreLimit} hits: ${record.counts.coreHits}`,
    `- Hit rate: ${record.counts.hitRate}`,
    `- Core hit rate: ${record.counts.coreHitRate}`,
    `- Labels: ${Object.entries(record.counts.byLabel).map(([key, value]) => `${key}=${value}`).join(", ")}`,
    "",
    "## Scoring Gaps",
  ]
  for (const item of record.improvementQueue.scoringGaps.slice(0, 12)) {
    lines.push(`- ${item.name || item.code}(${item.code}) ${item.label} rank=${item.prediction?.rank ?? "-"} strength=${item.actual.reasonStrength} reason=${item.actual.reason}`)
  }
  lines.push("", "## Mapping Gaps")
  for (const item of record.improvementQueue.mappingGaps.slice(0, 12)) {
    lines.push(`- ${item.name || item.code}(${item.code}) theme=${item.actual.theme} themeEvidence=${item.priorEvidence.themeCount} reason=${item.actual.reason}`)
  }
  lines.push("", "## Information Gaps")
  for (const item of record.improvementQueue.informationGaps.slice(0, 12)) {
    lines.push(`- ${item.name || item.code}(${item.code}) theme=${item.actual.theme} strength=${item.actual.reasonStrength} reason=${item.actual.reason}`)
  }
  lines.push("", "This is a scoring and information-coverage audit. It is not buy advice.")
  return `${lines.join("\n")}\n`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/next-limitup-review.mjs --project C:/wiki/73神话 --trade-date 2026-06-23 --write")
    return
  }
  const projectPath = path.resolve(args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH)
  const record = buildReview({
    projectPath,
    tradeDate: args["trade-date"] ?? args.date,
    daysBack: args["days-back"] ?? 5,
    coreLimit: args["core-limit"] ?? 10,
  })
  if (args.write) {
    const stamp = idTimestamp()
    const reportDir = path.join(projectPath, REPORT_ROOT)
    writeJson(path.join(reportDir, `${stamp}-next-limitup-review.json`), record)
    writeJson(path.join(reportDir, "latest-next-limitup-review.json"), record)
    writeText(path.join(reportDir, `${stamp}-next-limitup-review.md`), markdown(record))
    writeText(path.join(reportDir, "latest-next-limitup-review.md"), markdown(record))
    appendJsonl(path.join(projectPath, FACT_PATH), record)
    appendJsonl(path.join(projectPath, TRAINING_PATH), record.items.map(buildSample))
  }
  const summary = {
    ok: true,
    id: record.id,
    tradeDate: record.tradeDate,
    reviewed: record.counts.reviewed,
    predicted: record.counts.predicted,
    coreHits: record.counts.coreHits,
    hitRate: record.counts.hitRate,
    coreHitRate: record.counts.coreHitRate,
    byLabel: record.counts.byLabel,
  }
  if (args.json) console.log(JSON.stringify(record, null, 2))
  else console.log(JSON.stringify(summary, null, 2))
}

main()
