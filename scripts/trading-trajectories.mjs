#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const OUTPUT_PATH = "data/training/trading_trajectories.jsonl"
const REPORT_ROOT = ".llm-wiki/trading-trajectories"
const HYPOTHESES_PATH = "data/brain/hypotheses.jsonl"
const VALIDATIONS_PATH = "data/brain/validations.jsonl"
const ARTIFACTS = {
  correctionAlerts: ".llm-wiki/correction-alerts/latest-correction-alerts.json",
  watchlist: ".llm-wiki/market-watchlist/latest-warroom-watchlist.json",
  stockReasonCards: ".llm-wiki/stock-reason-cards/latest-stock-reason-cards.json",
  executionAudit: ".llm-wiki/execution-audit/latest-execution-audit.json",
  postSellValidation: ".llm-wiki/post-sell-validation/latest-post-sell-validation.json",
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

function writeJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8")
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
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line))
}

function toArray(value) {
  return Array.isArray(value) ? value : []
}

function unique(values) {
  return [...new Set(toArray(values).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))]
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function latestValidationsByTarget(validations) {
  const byTarget = new Map()
  for (const row of validations) {
    if (!row?.targetId) continue
    const previous = byTarget.get(row.targetId)
    const previousDate = normalizeTradeDate(previous?.dataHorizonTradeDate ?? previous?.createdAt) ?? ""
    const currentDate = normalizeTradeDate(row?.dataHorizonTradeDate ?? row?.createdAt) ?? ""
    if (!previous || currentDate.localeCompare(previousDate) >= 0) byTarget.set(row.targetId, row)
  }
  return byTarget
}

function compactEvidence(evidence) {
  return toArray(evidence).slice(0, 8).map((item) => ({
    file: item.file ?? null,
    sourceTag: item.sourceTag ?? null,
    excerpt: String(item.excerpt ?? "").replace(/\s+/g, " ").slice(0, 280),
    positiveHits: item.positiveHits ?? [],
    riskHits: item.riskHits ?? [],
    themeHits: item.themeHits ?? [],
  }))
}

function checkpointSummary(validation) {
  const checkpoints = validation?.checkpoints ?? {}
  const rows = Object.entries(checkpoints).map(([key, value]) => ({
    key,
    status: value?.status ?? (value?.available === false ? "data_gap" : null),
    closeGainPct: value?.closeGainPct ?? null,
    maxHighGainPct: value?.maxHighGainPct ?? null,
    sameDayCloseGainPct: value?.sameDayCloseGainPct ?? null,
    sameDayHighGainPct: value?.sameDayHighGainPct ?? null,
  }))
  const gains = rows.flatMap((row) => [row.closeGainPct, row.maxHighGainPct]).filter((value) => Number.isFinite(Number(value))).map(Number)
  return {
    rows,
    bestGainPct: gains.length ? Math.max(...gains) : null,
    finalGainPct: rows.length ? rows[rows.length - 1].closeGainPct : null,
  }
}

function labelFromValidation(validation) {
  if (!validation) return "pending"
  if (validation.result === "data_gap") return "data_gap"
  const summary = checkpointSummary(validation)
  if (validation.result === "success" || Number(summary.bestGainPct) >= 8) return "success"
  if (Number(summary.finalGainPct) <= -5) return "failure"
  return "neutral"
}

function artifactIndexByCode(items, pick) {
  const byCode = new Map()
  for (const item of items) {
    const code = String(item?.code ?? "").trim()
    if (!code) continue
    if (!byCode.has(code)) byCode.set(code, [])
    byCode.get(code).push(pick(item))
  }
  return byCode
}

function flattenWatchlist(watchlist) {
  const tiers = watchlist?.tiers ?? {}
  return [
    ...toArray(tiers.focus).map((item) => ({ ...item, tier: "focus" })),
    ...toArray(tiers.candidate).map((item) => ({ ...item, tier: "candidate" })),
    ...toArray(tiers.observe).map((item) => ({ ...item, tier: "observe" })),
  ]
}

function buildHypothesisTrajectory(row, validation, context) {
  const code = row.code ?? validation?.code ?? null
  const summary = checkpointSummary(validation)
  return {
    schema: "73wiki-trading-trajectory-v1",
    id: `traj_${shortHash(`${row.id}:${validation?.id ?? "pending"}`)}`,
    type: "hypothesis",
    status: validation ? "resolved" : "open",
    tradeDate: normalizeTradeDate(row.tradeDate),
    code,
    name: row.name ?? validation?.name ?? null,
    sourceIds: {
      hypothesisId: row.id ?? null,
      validationId: validation?.id ?? null,
    },
    before: {
      hypothesis: row.hypothesis?.hypothesis ?? row.hypothesis ?? null,
      tradeReason: row.hypothesis?.tradeReason ?? null,
      validationPlan: row.hypothesis?.validation ?? null,
      evidence: compactEvidence(row.evidence),
    },
    during: {
      watchlist: context.watchlistByCode.get(String(code)) ?? [],
      stockReasonCards: context.cardsByCode.get(String(code)) ?? [],
      correctionAlerts: context.correctionsByCode.get(String(code)) ?? [],
      postSellValidations: context.postSellByCode.get(String(code)) ?? [],
    },
    after: {
      validationResult: validation?.result ?? null,
      checkpoints: summary.rows,
      bestGainPct: summary.bestGainPct,
      finalGainPct: summary.finalGainPct,
    },
    label: labelFromValidation(validation),
    createdAt: nowLocalTimestamp(),
  }
}

function buildCorrectionTrajectory(item) {
  return {
    schema: "73wiki-trading-trajectory-v1",
    id: `traj_corr_${shortHash(item.id ?? `${item.code}:${item.tradeDate}`)}`,
    type: "correction",
    status: "review",
    tradeDate: normalizeTradeDate(item.tradeDate),
    code: item.code ?? null,
    name: item.name ?? null,
    sourceIds: { correctionId: item.id ?? null },
    before: {
      hypothesis: item.cardInferredReason ?? null,
      tradeReason: "自动纠偏候选，不是买卖建议。",
      validationPlan: "复核官方风险、价格冲突、原因卡置信度后再决定是否提醒用户。",
      evidence: [{ sourceTag: "correction-alerts", excerpt: toArray(item.triggers).join(" / "), riskHits: item.riskHits ?? [] }],
    },
    during: {
      correctionAlerts: [item],
    },
    after: {
      validationResult: item.evidenceGrade ?? null,
      severity: item.severity ?? null,
      pushEligible: Boolean(item.pushEligible),
    },
    label: item.severity === "high" ? "risk_high" : "risk_watch",
    createdAt: nowLocalTimestamp(),
  }
}

function buildExecutionTrajectory(audit) {
  return {
    schema: "73wiki-trading-trajectory-v1",
    id: `traj_exec_${shortHash(audit?.id ?? audit?.generatedAt)}`,
    type: "execution-audit",
    status: "review",
    tradeDate: normalizeTradeDate(audit?.tradeDate),
    code: null,
    name: "执行纪律审计",
    sourceIds: { executionAuditId: audit?.id ?? null },
    before: {
      hypothesis: "对比计划票与实际交易候选，识别计划外交易和纪律风险。",
      tradeReason: audit?.reviewSource ?? null,
      validationPlan: "将计划外候选与错误库风险词联动，复盘后归因。",
      evidence: [{ sourceTag: "execution-audit", excerpt: `计划外候选：${toArray(audit?.unplannedTradeCandidates).join("、")}` }],
    },
    during: {
      planCodes: audit?.planCodes ?? [],
      tradeCodes: audit?.tradeCodes ?? [],
      riskHits: audit?.riskHits ?? [],
    },
    after: {
      severity: audit?.severity ?? null,
      unplannedTradeCandidates: audit?.unplannedTradeCandidates ?? [],
    },
    label: toArray(audit?.unplannedTradeCandidates).length > 0 ? "discipline_risk" : "discipline_clean",
    createdAt: nowLocalTimestamp(),
  }
}

function buildContext(projectPath) {
  const correctionAlerts = readJsonMaybe(path.join(projectPath, ARTIFACTS.correctionAlerts))
  const watchlist = readJsonMaybe(path.join(projectPath, ARTIFACTS.watchlist))
  const cards = readJsonMaybe(path.join(projectPath, ARTIFACTS.stockReasonCards))
  const postSell = readJsonMaybe(path.join(projectPath, ARTIFACTS.postSellValidation))
  return {
    correctionAlerts,
    executionAudit: readJsonMaybe(path.join(projectPath, ARTIFACTS.executionAudit)),
    correctionsByCode: artifactIndexByCode(toArray(correctionAlerts?.items), (item) => ({
      id: item.id,
      severity: item.severity,
      evidenceGrade: item.evidenceGrade,
      triggers: item.triggers,
      pushEligible: item.pushEligible,
    })),
    watchlistByCode: artifactIndexByCode(flattenWatchlist(watchlist), (item) => ({
      tier: item.tier,
      score: item.score,
      roleHint: item.roleHint,
      reasons: toArray(item.reasons).slice(0, 5),
      themes: item.themes ?? [],
      tags: item.tags ?? [],
    })),
    cardsByCode: artifactIndexByCode(toArray(cards?.cards), (item) => ({
      id: item.id,
      rank: item.rank,
      role: item.role,
      objectiveLimitUp: item.objectiveLimitUp?.reason ?? null,
      themes: unique([...(item.objectiveLimitUp?.concepts ?? []), item.objectiveLimitUp?.theme]),
    })),
    postSellByCode: artifactIndexByCode(toArray(postSell?.items), (item) => ({
      label: item.label,
      summary: item.summary,
      result: item.result,
    })),
  }
}

function buildReport(projectPath, trajectories) {
  const byType = trajectories.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] ?? 0) + 1
    return acc
  }, {})
  const byLabel = trajectories.reduce((acc, item) => {
    acc[item.label] = (acc[item.label] ?? 0) + 1
    return acc
  }, {})
  return {
    schema: "73wiki-trading-trajectories-report-v1",
    id: `trading_trajectories_${idTimestamp()}_${shortHash(trajectories.length)}`,
    status: "active",
    generatedAt: nowLocalTimestamp(),
    projectPath,
    outputPath: OUTPUT_PATH,
    counts: {
      total: trajectories.length,
      byType,
      byLabel,
    },
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      datasetWrite: true,
    },
  }
}

function buildMarkdown(report) {
  const typeLines = Object.entries(report.counts.byType).map(([key, value]) => `- ${key}: ${value}`).join("\n") || "- 无"
  const labelLines = Object.entries(report.counts.byLabel).map(([key, value]) => `- ${key}: ${value}`).join("\n") || "- 无"
  return `# Trading Trajectories\n\n生成时间：${report.generatedAt}\n\n## 输出\n\n- ${report.outputPath}\n\n## 类型\n\n${typeLines}\n\n## 标签\n\n${labelLines}\n\n## 边界\n\n- 只生成训练轨迹，不写 raw/**，不写正式 wiki。\n- correction/execution 类型默认进入 review，不自动转成交易结论。\n`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/trading-trajectories.mjs --project C:/wiki/73神话 --write")
    return
  }
  const projectPath = path.resolve(args.project ?? DEFAULT_PROJECT_PATH)
  const context = buildContext(projectPath)
  const hypotheses = readJsonl(path.join(projectPath, HYPOTHESES_PATH))
  const validations = readJsonl(path.join(projectPath, VALIDATIONS_PATH))
  const validationsByTarget = latestValidationsByTarget(validations)
  const trajectories = [
    ...hypotheses.map((row) => buildHypothesisTrajectory(row, validationsByTarget.get(row.id), context)),
    ...toArray(context.correctionAlerts?.items).map(buildCorrectionTrajectory),
    ...(context.executionAudit ? [buildExecutionTrajectory(context.executionAudit)] : []),
  ].sort((a, b) => String(a.tradeDate ?? "").localeCompare(String(b.tradeDate ?? "")) || a.id.localeCompare(b.id))
  const report = buildReport(projectPath, trajectories)
  if (args.write) {
    writeJsonl(path.join(projectPath, OUTPUT_PATH), trajectories)
    const stamp = idTimestamp()
    const outDir = path.join(projectPath, REPORT_ROOT)
    writeJson(path.join(outDir, `${stamp}-trading-trajectories-report.json`), report)
    writeText(path.join(outDir, `${stamp}-trading-trajectories-report.md`), buildMarkdown(report))
    writeJson(path.join(outDir, "latest-trading-trajectories-report.json"), report)
    writeText(path.join(outDir, "latest-trading-trajectories-report.md"), buildMarkdown(report))
  }
  if (args.json || !args.write) console.log(JSON.stringify({ report, trajectories: trajectories.slice(0, 5) }, null, 2))
  else console.log(`[trading-trajectories] total=${report.counts.total} output=${OUTPUT_PATH}`)
}

main()
