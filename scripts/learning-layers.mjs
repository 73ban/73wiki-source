#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const REPORT_ROOT = ".llm-wiki/learning-layers"
const WIKI_PAGE = "wiki/09-统计与进化/当前学习层分层报告.md"
const HYPOTHESIS_PATH = "data/brain/hypotheses.jsonl"
const VALIDATION_PATH = "data/brain/validations.jsonl"
const CORRECTION_PATH = ".llm-wiki/correction-alerts/latest-correction-alerts.json"
const WATCHLIST_PATH = ".llm-wiki/market-watchlist/latest-warroom-watchlist.json"
const EXECUTION_BRIEF_PATH = ".llm-wiki/execution-brief/latest-execution-brief.json"
const VALIDATION_REPORT_PATH = ".llm-wiki/hypothesis-validation/latest-hypothesis-validation.json"

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

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))]
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function truncateText(value, max = 120) {
  const text = cleanText(value)
  if (!text) return ""
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`
}

function compareFreshness(left, right) {
  const a = normalizeTradeDate(left?.dataHorizonTradeDate ?? left?.tradeDate ?? left?.createdAt ?? left?.generatedAt) ?? ""
  const b = normalizeTradeDate(right?.dataHorizonTradeDate ?? right?.tradeDate ?? right?.createdAt ?? right?.generatedAt) ?? ""
  if (a !== b) return a.localeCompare(b)
  return String(left?.createdAt ?? left?.generatedAt ?? "").localeCompare(String(right?.createdAt ?? right?.generatedAt ?? ""))
}

function dedupeLatest(rows, keyFn) {
  const map = new Map()
  for (const row of rows) {
    const key = keyFn(row)
    if (!key) continue
    const previous = map.get(key)
    if (!previous || compareFreshness(previous, row) <= 0) {
      map.set(key, row)
    }
  }
  return map
}

function inferMethodFamily(hypothesis) {
  const explicit = cleanText(hypothesis?.learningMeta?.methodFamily)
  if (explicit) return explicit
  const sourceType = cleanText(hypothesis?.sourceType)
  if (sourceType) return sourceType
  const sourceRecordId = cleanText(hypothesis?.sourceRecordId)
  if (sourceRecordId.startsWith("preopen_")) return "preopen_core_candidates"
  if (sourceRecordId.startsWith("postsell_")) return "post_sell_review"
  return "general_hypothesis"
}

function inferSourceLabel(hypothesis) {
  const sourceRecordId = cleanText(hypothesis?.sourceRecordId)
  if (sourceRecordId.startsWith("preopen_")) return "preopen-intel"
  if (sourceRecordId.startsWith("postsell_")) return "post-sell-validation"
  return cleanText(hypothesis?.learningMeta?.sourceLabel) || "brain-hypothesis"
}

function collectThemeHints(hypothesis) {
  const hints = []
  for (const item of hypothesis?.evidence ?? []) {
    if (Array.isArray(item?.themeHits)) hints.push(...item.themeHits)
  }
  return unique(hints).slice(0, 4)
}

function flattenWatchlistCodes(watchlist) {
  const result = new Map()
  const tiers = watchlist?.tiers ?? {}
  for (const [tierName, items] of Object.entries(tiers)) {
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if (!item?.code) continue
      const code = String(item.code)
      if (!result.has(code)) {
        result.set(code, {
          tier: tierName,
          score: Number(item.score ?? 0),
          role: cleanText(item.role ?? item.roleHint),
          tags: unique(item.tags ?? []),
        })
      }
    }
  }
  return result
}

function validationSummary(validation) {
  if (!validation) return null
  const due = Array.isArray(validation.dueCheckpoints) ? validation.dueCheckpoints : []
  const completed = Array.isArray(validation.completedCheckpoints) ? validation.completedCheckpoints : []
  const checkpointValues = Object.values(validation.checkpoints ?? {})
  const successCount = checkpointValues.filter((item) => item?.status === "success").length
  const mixedCount = checkpointValues.filter((item) => item?.status === "mixed").length
  const failureCount = checkpointValues.filter((item) => item?.status === "failure").length
  return {
    result: cleanText(validation.result) || "unknown",
    dueCount: due.length,
    completedCount: completed.length,
    successCount,
    mixedCount,
    failureCount,
    due,
    completed,
  }
}

function chooseLayer({ dueCheckpoints, validation, correction }) {
  const severity = cleanText(correction?.severity).toLowerCase()
  const summary = validationSummary(validation)
  if (["high", "medium"].includes(severity)) return "conflict_queue"
  if (!summary) return dueCheckpoints.length === 0 ? "learning_observation" : "pending_validation"
  if (summary.result === "failure") return "conflict_queue"
  if (summary.result === "data_gap") return "pending_validation"
  if (summary.completedCount < summary.dueCount) return "pending_validation"
  if (summary.due.includes("D5") && summary.failureCount === 0 && (summary.successCount >= 1 || summary.result === "success")) {
    return "verified_usable"
  }
  if (summary.completedCount > 0) return "provisional_valid"
  return "pending_validation"
}

function layerLabel(layer) {
  switch (layer) {
    case "learning_observation":
      return "学习观察"
    case "pending_validation":
      return "待验证"
    case "provisional_valid":
      return "初步有效"
    case "verified_usable":
      return "已验证可用"
    case "conflict_queue":
      return "冲突待提醒"
    default:
      return layer
  }
}

function buildPolicyCandidate(item) {
  if (item.layer !== "verified_usable") return null
  if ((item.validation?.dueCount ?? 0) < 3) return null
  if (["high", "medium"].includes(cleanText(item.correction?.severity).toLowerCase())) return null
  return {
    id: `policy_${item.id}`,
    type: "policy_candidate",
    code: item.code,
    name: item.name,
    layer: item.layer,
    methodFamily: item.methodFamily,
    tradeDate: item.tradeDate,
    dataHorizonTradeDate: item.dataHorizonTradeDate,
    summary: `${item.name || item.code} completed ${item.validation.completed.join("/") || "no"} with result ${item.validation.result}.`,
    checkpoints: item.validation.completed,
    sourceLabel: item.sourceLabel,
    themes: item.themes,
  }
}

function buildPushItems(items, executionBrief) {
  const currentFocus = new Set([
    executionBrief?.primary?.code,
    ...(executionBrief?.backups ?? []).map((item) => item?.code),
    ...(executionBrief?.topCandidates ?? []).map((item) => item?.code),
  ].filter(Boolean).map(String))

  const queue = []
  for (const item of items) {
    if (item.layer === "conflict_queue") {
      queue.push({
        id: `push_conflict_${item.id}`,
        type: "conflict",
        priority: ["high", "medium"].includes(cleanText(item.correction?.severity).toLowerCase()) ? "high" : "medium",
        code: item.code,
        name: item.name,
        tradeDate: item.tradeDate,
        currentPlan: currentFocus.has(item.code),
        title: `${item.name || item.code} learning conflict`,
        message: truncateText([
          currentFocus.has(item.code) ? "Current plan / watchlist item." : "",
          `Layer=${layerLabel(item.layer)}.`,
          item.correction?.triggers?.length ? `Correction=${item.correction.triggers.slice(0, 3).join(" / ")}.` : "",
          item.validation?.result ? `Validation=${item.validation.result}.` : "",
        ].filter(Boolean).join(" "), 220),
        fingerprint: shortHash(`${item.code}|${item.tradeDate}|${item.correction?.id ?? ""}|${item.validation?.result ?? ""}`),
      })
      continue
    }
    const candidate = buildPolicyCandidate(item)
    if (!candidate) continue
    queue.push({
      id: `push_policy_${item.id}`,
      type: "policy_candidate",
      priority: "medium",
      code: item.code,
      name: item.name,
      tradeDate: item.tradeDate,
      currentPlan: currentFocus.has(item.code),
      title: `${item.name || item.code} verified method candidate`,
      message: truncateText(`${candidate.summary} Themes=${candidate.themes.join("/") || "-"} Method=${candidate.methodFamily}.`, 220),
      fingerprint: shortHash(`${item.code}|${item.tradeDate}|${candidate.checkpoints.join(",")}|policy`),
    })
  }

  return queue
    .sort((left, right) => {
      const priorityScore = (value) => value === "high" ? 2 : value === "medium" ? 1 : 0
      if (priorityScore(left.priority) !== priorityScore(right.priority)) {
        return priorityScore(right.priority) - priorityScore(left.priority)
      }
      if (left.currentPlan !== right.currentPlan) return Number(right.currentPlan) - Number(left.currentPlan)
      return String(right.tradeDate ?? "").localeCompare(String(left.tradeDate ?? ""))
    })
    .slice(0, 12)
}

function buildMethodBuckets(items) {
  const map = new Map()
  for (const item of items) {
    const key = item.methodFamily
    if (!map.has(key)) {
      map.set(key, {
        methodFamily: key,
        total: 0,
        learningObservation: 0,
        pendingValidation: 0,
        provisionalValid: 0,
        verifiedUsable: 0,
        conflictQueue: 0,
      })
    }
    const bucket = map.get(key)
    bucket.total += 1
    if (item.layer === "learning_observation") bucket.learningObservation += 1
    if (item.layer === "pending_validation") bucket.pendingValidation += 1
    if (item.layer === "provisional_valid") bucket.provisionalValid += 1
    if (item.layer === "verified_usable") bucket.verifiedUsable += 1
    if (item.layer === "conflict_queue") bucket.conflictQueue += 1
  }
  return [...map.values()].sort((left, right) => right.total - left.total)
}

function buildRecord(projectPath) {
  const hypotheses = [...dedupeLatest(
    readJsonl(path.join(projectPath, HYPOTHESIS_PATH)),
    (row) => row?.id,
  ).values()]
  const validations = [...dedupeLatest(
    readJsonl(path.join(projectPath, VALIDATION_PATH)),
    (row) => row?.targetId,
  ).values()]
  const corrections = readJsonMaybe(path.join(projectPath, CORRECTION_PATH))
  const correctionMap = new Map((corrections?.items ?? []).filter((item) => item?.code).map((item) => [String(item.code), item]))
  const watchlist = readJsonMaybe(path.join(projectPath, WATCHLIST_PATH))
  const executionBrief = readJsonMaybe(path.join(projectPath, EXECUTION_BRIEF_PATH))
  const validationReport = readJsonMaybe(path.join(projectPath, VALIDATION_REPORT_PATH))
  const watchlistMap = flattenWatchlistCodes(watchlist)
  const validationMap = new Map(validations.filter((row) => row?.targetId).map((row) => [String(row.targetId), row]))
  const dataHorizonTradeDate = normalizeTradeDate(validationReport?.dataHorizonTradeDate)
  const generatedAt = nowLocalTimestamp()

  const items = hypotheses
    .map((hypothesis) => {
      const tradeDate = normalizeTradeDate(hypothesis.tradeDate ?? hypothesis.generatedAt)
      const validation = validationMap.get(String(hypothesis.id)) ?? null
      const dueCheckpoints = dataHorizonTradeDate
        ? CHECKPOINTS.filter((item) => tradingDaysBetween(tradeDate, dataHorizonTradeDate) >= item.minTradingDays).map((item) => item.key)
        : []
      const code = cleanText(hypothesis.code)
      const correction = correctionMap.get(code) ?? null
      const watch = watchlistMap.get(code) ?? null
      const layer = chooseLayer({ dueCheckpoints, validation, correction })
      const summary = validationSummary(validation)
      return {
        id: String(hypothesis.id),
        code,
        name: cleanText(hypothesis.name) || code,
        tradeDate,
        generatedAt: cleanText(hypothesis.generatedAt),
        sourceLabel: inferSourceLabel(hypothesis),
        methodFamily: inferMethodFamily(hypothesis),
        layer,
        layerLabel: layerLabel(layer),
        dataHorizonTradeDate,
        dueCheckpoints,
        elapsedTradingDays: dataHorizonTradeDate ? tradingDaysBetween(tradeDate, dataHorizonTradeDate) : 0,
        hypothesis: truncateText(hypothesis?.hypothesis?.hypothesis ?? hypothesis?.hypothesis, 180),
        tradeReason: truncateText(hypothesis?.hypothesis?.tradeReason, 180),
        themes: collectThemeHints(hypothesis),
        correction: correction ? {
          id: correction.id,
          severity: correction.severity,
          triggers: unique(correction.triggers ?? []).slice(0, 4),
          pushEligible: Boolean(correction.pushEligible),
        } : null,
        watchlist: watch,
        validation: summary,
      }
    })
    .filter((item) => item.id && item.code)
    .sort((left, right) => {
      if (left.tradeDate !== right.tradeDate) return String(right.tradeDate ?? "").localeCompare(String(left.tradeDate ?? ""))
      return String(right.generatedAt ?? "").localeCompare(String(left.generatedAt ?? ""))
    })

  const layers = {
    learningObservation: items.filter((item) => item.layer === "learning_observation"),
    pendingValidation: items.filter((item) => item.layer === "pending_validation"),
    provisionalValid: items.filter((item) => item.layer === "provisional_valid"),
    verifiedUsable: items.filter((item) => item.layer === "verified_usable"),
    conflictQueue: items.filter((item) => item.layer === "conflict_queue"),
  }
  const policyCandidates = layers.verifiedUsable.map(buildPolicyCandidate).filter(Boolean).slice(0, 20)
  const pushEligibleItems = buildPushItems(items, executionBrief)
  const summary = [
    `items=${items.length}`,
    `observation=${layers.learningObservation.length}`,
    `pending=${layers.pendingValidation.length}`,
    `provisional=${layers.provisionalValid.length}`,
    `verified=${layers.verifiedUsable.length}`,
    `conflicts=${layers.conflictQueue.length}`,
    `policy=${policyCandidates.length}`,
    `push=${pushEligibleItems.length}`,
  ].join(", ")

  return {
    schema: "73wiki-learning-layers-v1",
    id: `learning_layers_${idTimestamp()}_${shortHash(summary)}`,
    status: "active",
    title: "73交易大脑学习层分层报告",
    generatedAt,
    projectPath,
    tradeDate: executionBrief?.tradeDate ?? watchlist?.tradeDate ?? null,
    planTradeDate: executionBrief?.planTradeDate ?? watchlist?.planTradeDate ?? null,
    evidenceTradeDate: executionBrief?.evidenceTradeDate ?? watchlist?.evidenceTradeDate ?? null,
    sourceTradeDates: {
      executionBriefPlan: executionBrief?.planTradeDate ?? null,
      executionBriefEvidence: executionBrief?.evidenceTradeDate ?? null,
      watchlistPlan: watchlist?.planTradeDate ?? null,
      watchlistEvidence: watchlist?.evidenceTradeDate ?? null,
      validationDataHorizon: dataHorizonTradeDate ?? null,
    },
    hasDateMismatch: Boolean(
      (executionBrief?.hasDateMismatch ?? false)
      || (watchlist?.hasDateMismatch ?? false)
      || (
        (executionBrief?.planTradeDate ?? watchlist?.planTradeDate)
        && (executionBrief?.evidenceTradeDate ?? watchlist?.evidenceTradeDate)
        && (executionBrief?.planTradeDate ?? watchlist?.planTradeDate) !== (executionBrief?.evidenceTradeDate ?? watchlist?.evidenceTradeDate)
      )
    ),
    dataHorizonTradeDate,
    validationCoverage: validationReport ? {
      dueHypotheses: Number(validationReport.dueHypotheses ?? 0),
      fullyCovered: Number(validationReport.fullyCovered ?? 0),
      dueCheckpointCount: Number(validationReport.dueCheckpointCount ?? 0),
      coveredCheckpointCount: Number(validationReport.coveredCheckpointCount ?? 0),
      dataGapHypotheses: Number(validationReport.dataGapHypotheses ?? 0),
    } : null,
    methodBuckets: buildMethodBuckets(items),
    counts: {
      total: items.length,
      learningObservation: layers.learningObservation.length,
      pendingValidation: layers.pendingValidation.length,
      provisionalValid: layers.provisionalValid.length,
      verifiedUsable: layers.verifiedUsable.length,
      conflictQueue: layers.conflictQueue.length,
      policyCandidates: policyCandidates.length,
      pushEligible: pushEligibleItems.length,
    },
    layers,
    policyCandidates,
    pushEligibleItems,
    summary,
    claim: "学习层只负责方法观察、验证分层、制度候选和冲突提醒，不直接改写现行制度，也不直接下买卖指令。",
    writePolicy: {
      rawWrite: false,
      wikiWrite: true,
      buyAdvice: false,
    },
  }
}

function renderLayerTable(items) {
  const lines = [
    "| Code | Name | TradeDate | Method | Due | Validation | Correction | Watchlist |",
    "|---|---|---|---|---|---|---|---|",
  ]
  for (const item of items.slice(0, 12)) {
    lines.push(`| ${item.code} | ${item.name} | ${item.tradeDate ?? "-"} | ${item.methodFamily} | ${(item.dueCheckpoints ?? []).join("/") || "-"} | ${item.validation?.result ?? "-"} | ${item.correction?.severity ?? "-"} | ${item.watchlist?.tier ?? "-"} |`)
  }
  return lines.join("\n")
}

function buildMarkdown(record) {
  const lines = [
    `# ${record.title}`,
    "",
    `生成时间: ${record.generatedAt}`,
    `计划交易日: ${record.planTradeDate ?? "-"}`,
    `证据交易日: ${record.evidenceTradeDate ?? "-"}`,
    `验证数据截止: ${record.dataHorizonTradeDate ?? "-"}`,
    "",
    "## 摘要",
    "",
    `- ${record.summary}`,
    "",
    "## 方法族分布",
    "",
    "| Method | Total | Observation | Pending | Provisional | Verified | Conflicts |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ]

  for (const item of record.methodBuckets.slice(0, 12)) {
    lines.push(`| ${item.methodFamily} | ${item.total} | ${item.learningObservation} | ${item.pendingValidation} | ${item.provisionalValid} | ${item.verifiedUsable} | ${item.conflictQueue} |`)
  }

  lines.push("")
  lines.push("## 制度候选")
  lines.push("")
  if (record.policyCandidates.length === 0) {
    lines.push("- 暂无达到制度候选门槛的学习项。")
  } else {
    for (const item of record.policyCandidates.slice(0, 8)) {
      lines.push(`- ${item.name}(${item.code}) | ${item.methodFamily} | ${item.summary}`)
    }
  }

  lines.push("")
  lines.push("## 飞书提醒队列")
  lines.push("")
  if (record.pushEligibleItems.length === 0) {
    lines.push("- 当前没有需要主动飞书提醒的学习冲突或制度候选。")
  } else {
    for (const item of record.pushEligibleItems.slice(0, 8)) {
      lines.push(`- [${item.type}] ${item.name}(${item.code}) | ${item.priority} | ${item.message}`)
    }
  }

  const orderedLayers = [
    ["学习观察", record.layers.learningObservation],
    ["待验证", record.layers.pendingValidation],
    ["初步有效", record.layers.provisionalValid],
    ["已验证可用", record.layers.verifiedUsable],
    ["冲突待提醒", record.layers.conflictQueue],
  ]

  for (const [label, items] of orderedLayers) {
    lines.push("")
    lines.push(`## ${label}`)
    lines.push("")
    if (items.length === 0) {
      lines.push("- 空")
      continue
    }
    lines.push(renderLayerTable(items))
  }

  lines.push("")
  lines.push("## 说明")
  lines.push("")
  lines.push("- 学习层和制度层隔离。只有进入制度候选后，才允许进入人工讨论。")
  lines.push("- 飞书提醒只发冲突待提醒和制度候选，不把全部学习噪音推给你。")
  lines.push("")
  return `${lines.join("\n")}\n`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const record = buildRecord(projectPath)
  if (!options.write) return { dryRun: true, record }

  const reportDir = path.join(projectPath, REPORT_ROOT)
  const stamp = idTimestamp()
  const jsonPath = path.join(reportDir, `${stamp}-learning-layers.json`)
  const mdPath = path.join(reportDir, `${stamp}-learning-layers.md`)
  const latestJson = path.join(reportDir, "latest-learning-layers.json")
  const latestMd = path.join(reportDir, "latest-learning-layers.md")
  const wikiPagePath = path.join(projectPath, WIKI_PAGE)
  const markdown = buildMarkdown(record)
  writeJson(jsonPath, record)
  writeJson(latestJson, record)
  writeText(mdPath, markdown)
  writeText(latestMd, markdown)
  writeText(wikiPagePath, markdown)
  return {
    dryRun: false,
    record,
    written: {
      report: projectRelative(projectPath, jsonPath),
      markdown: projectRelative(projectPath, mdPath),
      latest: projectRelative(projectPath, latestJson),
      wikiPage: WIKI_PAGE,
    },
  }
}

function printHelp() {
  console.log(`Usage:
  npm run learning:layers -- --project C:\\wiki\\73神话
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
    summary: result.record.summary,
    counts: result.record.counts,
    written: result.written,
  }, null, 2))
}

main()
