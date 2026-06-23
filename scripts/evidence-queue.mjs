#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const REPORT_ROOT = ".llm-wiki/evidence-queue"

const ARTIFACTS = {
  correctionAlerts: ".llm-wiki/correction-alerts/latest-correction-alerts.json",
  watchlist: ".llm-wiki/market-watchlist/latest-warroom-watchlist.json",
  stockReasonCards: ".llm-wiki/stock-reason-cards/latest-stock-reason-cards.json",
  executionAudit: ".llm-wiki/execution-audit/latest-execution-audit.json",
  hypothesisValidation: ".llm-wiki/hypothesis-validation/latest-hypothesis-validation.json",
  postSellValidation: ".llm-wiki/post-sell-validation/latest-post-sell-validation.json",
  brainHealth: ".llm-wiki/brain-health/latest-brain-health.json",
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["write", "json", "help"].includes(key)) {
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

function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function toArray(value) {
  return Array.isArray(value) ? value : []
}

function unique(values) {
  return [...new Set(toArray(values).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))]
}

function buildTaskSeed(parts) {
  return parts.filter(Boolean).join("|")
}

function taskId(type, parts) {
  return `evt_${type}_${shortHash(buildTaskSeed(parts))}`
}

function priorityFromSeverity(severity, fallback = 50) {
  if (severity === "high") return 95
  if (severity === "medium") return 70
  if (severity === "low") return 45
  return fallback
}

function makeTask({
  type,
  title,
  summary,
  code = null,
  name = null,
  priority = 50,
  planTradeDate = null,
  evidenceTradeDate = null,
  source,
  sourceFiles = [],
  evidence = [],
  reviewRequired = true,
  suggestedAction = "review",
}) {
  return {
    schema: "73wiki-evidence-task-v1",
    id: taskId(type, [code, name, title, summary, source]),
    status: "pending",
    type,
    priority,
    reviewRequired,
    suggestedAction,
    title,
    summary,
    code,
    name,
    planTradeDate: normalizeTradeDate(planTradeDate),
    evidenceTradeDate: normalizeTradeDate(evidenceTradeDate),
    source,
    sourceFiles: unique(sourceFiles),
    evidence,
    createdAt: nowLocalTimestamp(),
  }
}

function collectCorrectionTasks(batch) {
  return toArray(batch?.items).map((item) => makeTask({
    type: "correction-alert",
    title: `纠偏提醒 ${item.severity?.toUpperCase?.() ?? ""} | ${item.name ?? item.code}`,
    summary: unique(item.triggers).join(" / ") || item.feishuReadyText || "自动纠偏候选",
    code: item.code,
    name: item.name,
    priority: priorityFromSeverity(item.severity, Number(item.severityScore ?? 50)),
    planTradeDate: item.planTradeDate ?? item.tradeDate ?? batch?.planTradeDate,
    evidenceTradeDate: item.evidenceTradeDate ?? batch?.evidenceTradeDate,
    source: "correction-alerts",
    sourceFiles: batch?.sourceFiles,
    evidence: [
      { kind: "triggers", value: unique(item.triggers) },
      { kind: "riskHits", value: toArray(item.riskHits).slice(0, 3) },
      { kind: "reason", value: item.cardInferredReason ?? null },
    ],
    reviewRequired: Boolean(item.pushEligible) || item.severity === "high",
    suggestedAction: item.suggestedAction ?? "review_and_ping_user",
  }))
}

function collectWatchlistTasks(batch) {
  const tiers = batch?.tiers ?? {}
  const rows = [
    ...toArray(tiers.focus).map((item) => ({ tier: "focus", item })),
    ...toArray(tiers.candidate).map((item) => ({ tier: "candidate", item })),
    ...toArray(tiers.observe).map((item) => ({ tier: "observe", item })),
  ]
  return rows.slice(0, 80).map(({ tier, item }) => makeTask({
    type: "watchlist-signal",
    title: `作战室股票池 ${tier} | ${item.name ?? item.code}`,
    summary: unique(item.reasons).slice(0, 5).join(" / ") || "作战室股票池候选",
    code: item.code,
    name: item.name,
    priority: tier === "focus" ? 85 : tier === "candidate" ? 62 : 42,
    planTradeDate: item.planTradeDate ?? batch?.planTradeDate ?? batch?.tradeDate,
    evidenceTradeDate: item.evidenceTradeDate ?? batch?.evidenceTradeDate,
    source: "market-watchlist",
    sourceFiles: item.sourceFiles ?? batch?.sourceFiles,
    evidence: [
      { kind: "tier", value: tier },
      { kind: "score", value: item.score ?? null },
      { kind: "tags", value: unique(item.tags) },
      { kind: "themes", value: unique(item.themes) },
    ],
    reviewRequired: tier === "focus",
    suggestedAction: tier === "focus" ? "warroom_review" : "track",
  }))
}

function collectStockReasonTasks(batch) {
  return toArray(batch?.cards).slice(0, 50).map((card) => makeTask({
    type: "stock-reason-card",
    title: `原因卡复核 | ${card.name ?? card.code}`,
    summary: card.summary ?? card.inferredReason ?? card.objectiveLimitUp?.reason ?? "个股原因卡候选",
    code: card.code,
    name: card.name,
    priority: card.rank ? Math.max(40, 82 - Number(card.rank) * 3) : 55,
    planTradeDate: card.planTradeDate ?? card.tradeDate ?? batch?.planTradeDate,
    evidenceTradeDate: card.evidenceTradeDate ?? batch?.evidenceTradeDate,
    source: "stock-reason-cards",
    sourceFiles: unique([...(card.sourceFiles ?? []), ...(batch?.sourceFiles ?? [])]),
    evidence: [
      { kind: "role", value: card.role ?? null },
      { kind: "objectiveLimitUp", value: card.objectiveLimitUp?.reason ?? null },
      { kind: "licensedEnhancer", value: card.licensedEnhancer?.summary ?? null },
    ],
    reviewRequired: Number(card.rank ?? 99) <= 5,
    suggestedAction: "reason_card_review",
  }))
}

function collectExecutionAuditTasks(audit) {
  const tasks = []
  if (toArray(audit?.unplannedTradeCandidates).length > 0) {
    tasks.push(makeTask({
      type: "execution-audit",
      title: "纪律审计 | 计划外候选",
      summary: `计划外候选：${audit.unplannedTradeCandidates.join("、")}`,
      priority: priorityFromSeverity(audit?.severity, 80),
      planTradeDate: audit?.planTradeDate ?? audit?.tradeDate,
      evidenceTradeDate: audit?.evidenceTradeDate,
      source: "execution-audit",
      sourceFiles: [audit?.reviewSource, audit?.watchlistSource],
      evidence: [
        { kind: "unplannedTradeCandidates", value: audit.unplannedTradeCandidates },
        { kind: "riskHits", value: audit.riskHits ?? [] },
      ],
      reviewRequired: true,
      suggestedAction: "discipline_review",
    }))
  }
  return tasks
}

function collectValidationTasks(report) {
  const tasks = []
  if (Number(report?.dueHypotheses ?? 0) > 0) {
    tasks.push(makeTask({
      type: "hypothesis-validation",
      title: "预判验证 | 到期检查点",
      summary: `到期假设 ${report.dueHypotheses} 条，覆盖 ${report.coveredCheckpointCount}/${report.dueCheckpointCount}`,
      priority: Number(report.dataGapHypotheses ?? 0) > 0 ? 78 : 55,
      planTradeDate: report?.tradeDate ?? null,
      evidenceTradeDate: report?.dataHorizonTradeDate,
      source: "hypothesis-validation",
      sourceFiles: [ARTIFACTS.hypothesisValidation],
      evidence: [
        { kind: "dueHypotheses", value: report.dueHypotheses },
        { kind: "dataGapHypotheses", value: report.dataGapHypotheses },
      ],
      reviewRequired: Number(report.dataGapHypotheses ?? 0) > 0,
      suggestedAction: "validation_backfill",
    }))
  }
  return tasks
}

function collectPostSellTasks(report) {
  return toArray(report?.items).map((item) => makeTask({
    type: "post-sell-validation",
    title: `卖出后验证 | ${item.name ?? item.code}`,
    summary: item.summary ?? item.result ?? "卖出后验证候选",
    code: item.code,
    name: item.name,
    priority: item.label === "tooEarly" ? 85 : item.label === "tooLate" ? 70 : 45,
    planTradeDate: report?.planTradeDate ?? report?.tradeDate,
    evidenceTradeDate: report?.evidenceTradeDate,
    source: "post-sell-validation",
    sourceFiles: [ARTIFACTS.postSellValidation],
    evidence: [{ kind: "item", value: item }],
    reviewRequired: item.label === "tooEarly" || item.label === "tooLate",
    suggestedAction: "post_sell_review",
  }))
}

function dedupeTasks(tasks) {
  const byId = new Map()
  for (const task of tasks) {
    const previous = byId.get(task.id)
    if (!previous || Number(task.priority) > Number(previous.priority)) byId.set(task.id, task)
  }
  return [...byId.values()].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
}

function buildMarkdown(report) {
  const lines = [
    `# Evidence Queue`,
    ``,
    `生成时间：${report.generatedAt}`,
    `项目：${report.projectPath}`,
    ``,
    `## 摘要`,
    ``,
    `- 总任务：${report.counts.total}`,
    `- high：${report.counts.high}`,
    `- medium：${report.counts.medium}`,
    `- low：${report.counts.low}`,
    `- 需要人工复核：${report.counts.reviewRequired}`,
    ``,
    `## 高优先级任务`,
    ``,
    `| 优先级 | 类型 | 标的 | 标题 | 动作 |`,
    `|---:|---|---|---|---|`,
  ]
  for (const task of report.tasks.filter((item) => item.priority >= 70).slice(0, 40)) {
    lines.push(`| ${task.priority} | ${task.type} | ${task.code ?? ""} ${task.name ?? ""} | ${String(task.title).replace(/\|/g, "/")} | ${task.suggestedAction} |`)
  }
  lines.push(``, `## 写入策略`, ``, `- 本脚本只写 .llm-wiki/evidence-queue，不写 raw/**。`, `- 本脚本不直接写正式 wiki 页面。`, `- 后续正式写入必须走 review manifest。`, ``)
  return `${lines.join("\n")}\n`
}

function buildReport(projectPath) {
  const now = new Date()
  const artifacts = Object.fromEntries(Object.entries(ARTIFACTS).map(([key, relativePath]) => [
    key,
    readJsonMaybe(path.join(projectPath, relativePath)),
  ]))
  const tasks = dedupeTasks([
    ...collectCorrectionTasks(artifacts.correctionAlerts),
    ...collectWatchlistTasks(artifacts.watchlist),
    ...collectStockReasonTasks(artifacts.stockReasonCards),
    ...collectExecutionAuditTasks(artifacts.executionAudit),
    ...collectValidationTasks(artifacts.hypothesisValidation),
    ...collectPostSellTasks(artifacts.postSellValidation),
  ])
  const counts = {
    total: tasks.length,
    high: tasks.filter((item) => item.priority >= 80).length,
    medium: tasks.filter((item) => item.priority >= 55 && item.priority < 80).length,
    low: tasks.filter((item) => item.priority < 55).length,
    reviewRequired: tasks.filter((item) => item.reviewRequired).length,
  }
  return {
    schema: "73wiki-evidence-queue-v1",
    id: `evidence_queue_${idTimestamp(now)}_${shortHash(`${projectPath}:${tasks.length}`)}`,
    status: "active",
    generatedAt: nowLocalTimestamp(now),
    projectPath,
    sourceArtifacts: ARTIFACTS,
    counts,
    tasks,
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
      reviewRequiredBeforeWikiWrite: true,
    },
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/evidence-queue.mjs --project C:/wiki/73神话 --write")
    return
  }
  const projectPath = path.resolve(args.project ?? DEFAULT_PROJECT_PATH)
  const report = buildReport(projectPath)
  if (args.write) {
    const stamp = idTimestamp()
    const outDir = path.join(projectPath, REPORT_ROOT)
    writeJson(path.join(outDir, `${stamp}-evidence-queue.json`), report)
    writeText(path.join(outDir, `${stamp}-evidence-queue.md`), buildMarkdown(report))
    writeJson(path.join(outDir, "latest-evidence-queue.json"), report)
    writeText(path.join(outDir, "latest-evidence-queue.md"), buildMarkdown(report))
  }
  if (args.json || !args.write) console.log(JSON.stringify(report, null, 2))
  else console.log(`[evidence-queue] tasks=${report.counts.total} reviewRequired=${report.counts.reviewRequired}`)
}

main()
