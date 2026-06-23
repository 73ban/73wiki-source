#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const REPORT_ROOT = ".llm-wiki/brain-health"
const VALIDATION_REPORT_PATH = ".llm-wiki/hypothesis-validation/latest-hypothesis-validation.json"
const BRAIN_FILES = [
  "data/brain/hypotheses.jsonl",
  "data/brain/validations.jsonl",
  "data/brain/corrections.jsonl",
  "data/brain/predictions.jsonl",
  "data/brain/guardrails.jsonl",
  "data/brain/preferences.jsonl",
  "data/brain/active_threads.jsonl",
]
const PROMOTION_MARKERS = new Set([
  "validated",
  "verified",
  "ready_for_policy",
  "policy_candidate",
  "制度候选",
  "已验证可用",
])
const CHECKPOINTS = [
  { key: "D1", minTradingDays: 1 },
  { key: "D3", minTradingDays: 3 },
  { key: "D5", minTradingDays: 5 },
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

function projectRelative(projectPath, targetPath) {
  return path.relative(path.resolve(projectPath), path.resolve(targetPath)).replace(/\\/g, "/")
}

function normalizeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function toDateOnly(value) {
  const normalized = normalizeDate(value)
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

function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function readJsonlWithDiagnostics(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      exists: false,
      rows: [],
      parseErrors: [{ line: 0, reason: "missing" }],
    }
  }
  const raw = fs.readFileSync(filePath, "utf8")
  const rows = []
  const parseErrors = []
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch (error) {
      parseErrors.push({
        line: index + 1,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return {
    exists: true,
    rows,
    parseErrors,
  }
}

function isResolved(row) {
  return String(row?.status ?? "").trim().toLowerCase() === "resolved"
}

function hasPromotionMarker(row) {
  const status = String(row?.status ?? "").trim()
  if (PROMOTION_MARKERS.has(status) || PROMOTION_MARKERS.has(status.toLowerCase())) return true
  return (row?.tags ?? []).some((tag) => PROMOTION_MARKERS.has(String(tag ?? "").trim()))
}

function inspectBrainFile(projectPath, relativePath) {
  const absolutePath = path.join(projectPath, relativePath)
  const { exists, rows, parseErrors } = readJsonlWithDiagnostics(absolutePath)
  const open = rows.filter((row) => !isResolved(row)).length
  const resolved = rows.length - open
  return {
    path: relativePath,
    exists,
    records: rows.length,
    open,
    resolved,
    parseErrors,
    ok: exists && parseErrors.length === 0,
    rows,
  }
}

function latestTargetedValidations(validations) {
  const ids = new Map()
  for (const row of validations) {
    if (!row?.targetId) continue
    const previous = ids.get(row.targetId)
    const previousHorizon = normalizeDate(previous?.dataHorizonTradeDate ?? previous?.createdAt)
    const currentHorizon = normalizeDate(row.dataHorizonTradeDate ?? row.createdAt)
    if (!previous || String(currentHorizon ?? "").localeCompare(String(previousHorizon ?? "")) >= 0) {
      ids.set(row.targetId, row)
    }
  }
  return ids
}

function buildLearningCoverage(hypotheses, validations, dataHorizonTradeDate) {
  const pending = hypotheses.filter((row) => String(row?.status ?? "").trim() === "pending_validation")
  const latestByTarget = latestTargetedValidations(validations)
  const dueRows = []
  let dueCheckpointCount = 0
  let coveredCheckpointCount = 0
  let fullyCoveredHypotheses = 0
  let pendingNoDue = 0

  for (const row of pending) {
    const tradeDate = normalizeDate(row.tradeDate ?? row.generatedAt)
    const elapsed = dataHorizonTradeDate ? tradingDaysBetween(tradeDate, dataHorizonTradeDate) : 0
    const dueCheckpoints = CHECKPOINTS.filter((item) => elapsed >= item.minTradingDays).map((item) => item.key)
    const validation = latestByTarget.get(row.id)
    const completed = (validation?.completedCheckpoints ?? []).filter((key) => dueCheckpoints.includes(key))
    if (dueCheckpoints.length === 0) {
      pendingNoDue += 1
      continue
    }
    dueRows.push({
      id: row.id ?? null,
      code: row.code ?? null,
      name: row.name ?? null,
      tradeDate,
      elapsedTradingDays: elapsed,
      dueCheckpoints,
      completedCheckpoints: completed,
    })
    dueCheckpointCount += dueCheckpoints.length
    coveredCheckpointCount += completed.length
    if (completed.length === dueCheckpoints.length) fullyCoveredHypotheses += 1
  }

  const uncovered = dueRows
    .filter((row) => row.completedCheckpoints.length < row.dueCheckpoints.length)
    .sort((a, b) => String(a.tradeDate ?? "").localeCompare(String(b.tradeDate ?? "")) || String(a.code ?? "").localeCompare(String(b.code ?? "")))

  return {
    dataHorizonTradeDate,
    pendingTotal: pending.length,
    pendingNoDue,
    dueHypotheses: dueRows.length,
    fullyCoveredHypotheses,
    dueCheckpointCount,
    coveredCheckpointCount,
    uncoveredCheckpointCount: dueCheckpointCount - coveredCheckpointCount,
    checkpointCoverageRate: dueCheckpointCount > 0 ? Number((coveredCheckpointCount / dueCheckpointCount).toFixed(4)) : 1,
    uncoveredSamples: uncovered.slice(0, 10),
  }
}

function buildPromotionQueue(files) {
  const candidates = []
  for (const file of files) {
    for (const row of file.rows) {
      if (!hasPromotionMarker(row)) continue
      candidates.push({
        id: row.id ?? null,
        type: row.type ?? row.schema ?? path.basename(file.path, ".jsonl"),
        title: row.title ?? row.name ?? row.code ?? "untitled",
        status: row.status ?? null,
        source: row.source ?? null,
        createdAt: row.createdAt ?? row.generatedAt ?? null,
        tags: Array.isArray(row.tags) ? row.tags : [],
        path: file.path,
      })
    }
  }
  return candidates
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    .slice(0, 20)
}

function buildValidationLinks(hypotheses, validations, learningCoverage) {
  const hypothesisIds = new Set(hypotheses.map((row) => row.id).filter(Boolean))
  const targeted = validations.filter((row) => row.targetId)
  const matched = targeted.filter((row) => hypothesisIds.has(row.targetId))
  const unmatched = targeted.filter((row) => !hypothesisIds.has(row.targetId))
  return {
    targeted: targeted.length,
    matched: matched.length,
    unmatched: unmatched.length,
    untargeted: validations.length - targeted.length,
    pendingTotal: learningCoverage.pendingTotal,
    dueHypotheses: learningCoverage.dueHypotheses,
    dueCheckpointCount: learningCoverage.dueCheckpointCount,
    coveredCheckpointCount: learningCoverage.coveredCheckpointCount,
    checkpointCoverageRate: learningCoverage.checkpointCoverageRate,
    unmatchedTargetIds: unmatched.slice(0, 10).map((row) => row.targetId),
  }
}

function buildMarkdown(record) {
  const lines = [
    `# ${record.title}`,
    "",
    `更新时间：${record.generatedAt}`,
    `项目：${record.projectPath}`,
    `总体状态：${record.ok ? "ok" : "needs-attention"}`,
    "",
    "## 摘要",
    "",
    `- ${record.summary}`,
    "",
    "## 学习层文件",
    "",
    "| 文件 | 记录数 | 未解决 | 已解决 | 解析错误 |",
    "|---|---:|---:|---:|---:|",
  ]

  for (const item of record.files) {
    lines.push(`| ${item.path} | ${item.records} | ${item.open} | ${item.resolved} | ${item.parseErrors.length} |`)
  }

  lines.push("")
  lines.push("## 检查点闭环")
  lines.push("")
  lines.push(`- data horizon: ${record.learningCoverage.dataHorizonTradeDate ?? "-"}`)
  lines.push(`- pending hypotheses: ${record.learningCoverage.pendingTotal}`)
  lines.push(`- pending without due checkpoints: ${record.learningCoverage.pendingNoDue}`)
  lines.push(`- due hypotheses: ${record.learningCoverage.dueHypotheses}`)
  lines.push(`- fully covered hypotheses: ${record.learningCoverage.fullyCoveredHypotheses}`)
  lines.push(`- due checkpoints: ${record.learningCoverage.dueCheckpointCount}`)
  lines.push(`- covered checkpoints: ${record.learningCoverage.coveredCheckpointCount}`)
  lines.push(`- checkpoint coverage: ${(record.learningCoverage.checkpointCoverageRate * 100).toFixed(2)}%`)

  if (record.learningCoverage.uncoveredSamples.length > 0) {
    lines.push("")
    lines.push("## 未覆盖样本")
    lines.push("")
    for (const item of record.learningCoverage.uncoveredSamples) {
      lines.push(`- ${item.tradeDate ?? "-"} ${item.code ?? "-"} ${item.name ?? "-"} | due=${item.dueCheckpoints.join("/")} | covered=${item.completedCheckpoints.join("/") || "-"}`)
    }
  }

  lines.push("")
  lines.push("## 验证关联")
  lines.push("")
  lines.push(`- targeted validations: ${record.validationLinks.targeted}`)
  lines.push(`- matched targets: ${record.validationLinks.matched}`)
  lines.push(`- unmatched targets: ${record.validationLinks.unmatched}`)
  lines.push(`- untargeted validations: ${record.validationLinks.untargeted}`)

  if (record.promotionQueue.length > 0) {
    lines.push("")
    lines.push("## 制度候选池")
    lines.push("")
    for (const item of record.promotionQueue) {
      lines.push(`- ${item.title} | status=${item.status ?? "-"} | source=${item.source ?? "-"} | path=${item.path}`)
    }
  }

  if (record.issues.length > 0) {
    lines.push("")
    lines.push("## 问题")
    lines.push("")
    for (const issue of record.issues) lines.push(`- ${issue}`)
  }

  lines.push("")
  return `${lines.join("\n")}\n`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const generatedAt = nowLocalTimestamp()
  const files = BRAIN_FILES.map((relativePath) => inspectBrainFile(projectPath, relativePath))
  const hypothesesFile = files.find((item) => item.path.endsWith("hypotheses.jsonl")) ?? { rows: [] }
  const validationsFile = files.find((item) => item.path.endsWith("validations.jsonl")) ?? { rows: [] }
  const validationReport = readJsonMaybe(path.join(projectPath, VALIDATION_REPORT_PATH))
  const dataHorizonTradeDate = normalizeDate(validationReport?.dataHorizonTradeDate)
    ?? validationsFile.rows.map((row) => normalizeDate(row.dataHorizonTradeDate)).filter(Boolean).sort().slice(-1)[0]
    ?? null
  const learningCoverage = buildLearningCoverage(hypothesesFile.rows, validationsFile.rows, dataHorizonTradeDate)
  const validationLinks = buildValidationLinks(hypothesesFile.rows, validationsFile.rows, learningCoverage)
  const promotionQueue = buildPromotionQueue(files)
  const totals = files.reduce((acc, item) => {
    acc.records += item.records
    acc.open += item.open
    acc.resolved += item.resolved
    acc.parseErrors += item.parseErrors.length
    return acc
  }, { records: 0, open: 0, resolved: 0, parseErrors: 0 })

  const issues = []
  const missing = files.filter((item) => !item.exists).map((item) => item.path)
  if (missing.length > 0) issues.push(`缺少学习层文件：${missing.join("、")}`)
  if (totals.parseErrors > 0) issues.push(`学习层 JSONL 解析错误 ${totals.parseErrors} 条`)
  if (!learningCoverage.dataHorizonTradeDate) issues.push("没有可用的数据地平线，无法判断 D1/D3/D5 检查点是否到期")
  if (validationLinks.unmatched > 0) issues.push(`存在 ${validationLinks.unmatched} 条 validation 无法回链到 hypothesis`)
  if (learningCoverage.uncoveredCheckpointCount > 0) {
    issues.push(`到期检查点仍有 ${learningCoverage.uncoveredCheckpointCount} 个未覆盖，学习闭环没有完全打通`)
  }

  const summaryParts = [
    `brain records ${totals.records}`,
    `pending hypotheses ${learningCoverage.pendingTotal}`,
    `due checkpoints ${learningCoverage.coveredCheckpointCount}/${learningCoverage.dueCheckpointCount}`,
    `promotion candidates ${promotionQueue.length}`,
  ]
  if (issues.length > 0) summaryParts.push(`issues ${issues.length}`)

  const record = {
    schema: "73wiki-brain-health-v2",
    id: `brain_health_${idTimestamp()}_${shortHash(projectPath)}`,
    status: "active",
    title: "73交易大脑学习层健康页",
    generatedAt,
    projectPath,
    ok: issues.length === 0,
    totals,
    files: files.map(({ rows, ...item }) => item),
    learningCoverage,
    validationLinks,
    promotionQueue,
    issues,
    summary: summaryParts.join(", "),
    claim: "学习层健康页只做脑内账本审计、检查点覆盖和制度候选池汇总，不直接改写现行制度。",
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }

  if (!options.write) return { dryRun: true, record }

  const reportDir = path.join(projectPath, REPORT_ROOT)
  const stamp = idTimestamp()
  const jsonPath = path.join(reportDir, `${stamp}-brain-health.json`)
  const mdPath = path.join(reportDir, `${stamp}-brain-health.md`)
  const latestJson = path.join(reportDir, "latest-brain-health.json")
  const latestMd = path.join(reportDir, "latest-brain-health.md")
  writeJson(jsonPath, record)
  writeJson(latestJson, record)
  writeText(mdPath, buildMarkdown(record))
  writeText(latestMd, buildMarkdown(record))
  return {
    dryRun: false,
    record,
    written: {
      report: projectRelative(projectPath, jsonPath),
      markdown: projectRelative(projectPath, mdPath),
      latest: projectRelative(projectPath, latestJson),
    },
  }
}

function printHelp() {
  console.log(`Usage:
  npm run brain:health -- --project C:\\wiki\\73神话
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
    write: Boolean(args.write),
  })
  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(JSON.stringify({
    dryRun: result.dryRun,
    ok: result.record.ok,
    summary: result.record.summary,
    issues: result.record.issues,
    written: result.written,
  }, null, 2))
}

main()
