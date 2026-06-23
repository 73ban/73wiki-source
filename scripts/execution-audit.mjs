#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const REPORT_ROOT = ".llm-wiki/execution-audit"

const REVIEW_ROOTS = [
  "raw/02-每日复盘",
  "raw/03-每日交易计划",
]

const RISK_PATTERNS = [
  { label: "plan_external", pattern: /计划外|临时起意|盘中临时|不在计划里|计划中没有/gi },
  { label: "chase_high", pattern: /追高|抢板|冲天炮|直线拉升去追/gi },
  { label: "impulse", pattern: /冲动|手痒|上头|情绪化/gi },
  { label: "over_position", pattern: /满仓|重仓猛干|梭哈|融资打满/gi },
  { label: "hesitation", pattern: /犹豫|不敢买|没敢加仓|错过/gi },
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
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`)
    }
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

function readTextMaybe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
  } catch {
    return ""
  }
}

function projectRelative(projectPath, targetPath) {
  return path.relative(path.resolve(projectPath), path.resolve(targetPath)).replace(/\\/g, "/")
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))]
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function extractDateFromPath(filePath) {
  const match = String(filePath ?? "").match(/(20\d{2}-\d{2}-\d{2})/)
  return match ? match[1] : null
}

function listMarkdownFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return []
  const queue = [rootDir]
  const files = []
  while (queue.length > 0) {
    const current = queue.shift()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(fullPath)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue
      const stat = fs.statSync(fullPath)
      files.push({
        filePath: fullPath,
        updatedAt: stat.mtimeMs,
        datedAt: extractDateFromPath(fullPath),
      })
    }
  }
  return files.sort((left, right) => {
    if ((left.datedAt ?? "") !== (right.datedAt ?? "")) {
      return String(right.datedAt ?? "").localeCompare(String(left.datedAt ?? ""))
    }
    return right.updatedAt - left.updatedAt
  })
}

function findLatestReviewSource(projectPath) {
  for (const relativeRoot of REVIEW_ROOTS) {
    const rootDir = path.join(projectPath, relativeRoot)
    const files = listMarkdownFiles(rootDir)
    if (files.length === 0) continue
    const latest = files[0]
    return {
      filePath: latest.filePath,
      text: readTextMaybe(latest.filePath),
      tradeDate: latest.datedAt,
    }
  }
  return {
    filePath: null,
    text: "",
    tradeDate: null,
  }
}

function collectPlanCodes(watchlist) {
  const symbols = []
  if (Array.isArray(watchlist?.symbols)) symbols.push(...watchlist.symbols)
  if (Array.isArray(watchlist?.tiers?.symbols)) symbols.push(...watchlist.tiers.symbols)
  if (Array.isArray(watchlist?.tiers?.focus)) {
    for (const item of watchlist.tiers.focus) {
      if (item?.code) symbols.push(item.code)
    }
  }
  return unique(symbols).filter((value) => /^\d{6}$/.test(value))
}

function extractTradeCodes(text) {
  const normalizedText = String(text ?? "")
  const priorityBlocks = [
    /#{1,6}\s*(今日操作记录|操作记录|交易记录|持仓变动)([\s\S]*?)(?=\n#{1,6}\s+|$)/gi,
    /#{1,6}\s*(盘中操作|买入记录|卖出记录)([\s\S]*?)(?=\n#{1,6}\s+|$)/gi,
  ]
  const priorityCodes = []
  for (const blockPattern of priorityBlocks) {
    for (const match of normalizedText.matchAll(blockPattern)) {
      priorityCodes.push(...(match[2].match(/\b\d{6}\b/g) ?? []))
    }
  }
  if (priorityCodes.length > 0) return unique(priorityCodes)
  return unique(normalizedText.match(/\b\d{6}\b/g) ?? []).slice(0, 50)
}

function findRiskHits(text) {
  return RISK_PATTERNS
    .map(({ label, pattern }) => {
      const matches = String(text ?? "").match(pattern) ?? []
      return {
        label,
        hits: matches.length,
        examples: unique(matches).slice(0, 5),
      }
    })
    .filter((item) => item.hits > 0)
}

function severityFromAudit(unplannedCount, riskHits) {
  if (unplannedCount > 0) return "high"
  if (riskHits.some((item) => ["plan_external", "chase_high", "impulse", "over_position"].includes(item.label))) return "medium"
  if (riskHits.length > 0) return "low"
  return "clean"
}

function buildSummary(unplannedTradeCandidates, riskHits) {
  if (unplannedTradeCandidates.length > 0) {
    return `发现 ${unplannedTradeCandidates.length} 个计划外交易候选：${unplannedTradeCandidates.join("、")}。优先核对是否为真实下单，还是复盘中提及的观察票。`
  }
  if (riskHits.length > 0) {
    return `没有发现明确的计划外代码，但命中了 ${riskHits.length} 类纪律风险关键词，需要复核执行质量。`
  }
  return "未发现明确的计划外交易候选，也未命中高风险纪律关键词。"
}

function buildMarkdown(record) {
  const lines = [
    `# ${record.title}`,
    "",
    `更新时间：${record.generatedAt}`,
    `计划交易日：${record.planTradeDate ?? "-"}`,
    `证据交易日：${record.evidenceTradeDate ?? "-"}`,
    `纪律风险级别：${record.severity}`,
    "",
    "## 核心结论",
    "",
    record.summary,
    "",
    "## 检查来源",
    "",
    `- 复盘/计划来源：${record.reviewSource ?? "未找到"}`,
    `- 作战室来源：${record.watchlistSource ?? "未找到"}`,
    "",
    "## 计划外交易候选",
    "",
  ]

  if (record.unplannedTradeCandidates.length === 0) {
    lines.push("- 未发现明确的计划外交易候选。")
  } else {
    for (const code of record.unplannedTradeCandidates) lines.push(`- ${code}`)
  }

  lines.push("")
  lines.push("## 风险关键词")
  lines.push("")
  if (record.riskHits.length === 0) {
    lines.push("- 未命中高风险纪律关键词。")
  } else {
    for (const item of record.riskHits) {
      lines.push(`- ${item.label}: ${item.hits} 次 (${item.examples.join(" / ")})`)
    }
  }

  lines.push("")
  lines.push("## 复盘提及代码")
  lines.push("")
  lines.push(`- ${record.tradeCodes.join(", ") || "-"}`)
  lines.push("")
  lines.push("## 作战室计划代码")
  lines.push("")
  lines.push(`- ${record.planCodes.join(", ") || "-"}`)
  lines.push("")
  lines.push("## 说明")
  lines.push("")
  lines.push("- 本页只做计划内外和纪律风险审计，不直接下买卖结论。")
  lines.push("")
  return `${lines.join("\n")}\n`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const generatedAt = nowLocalTimestamp()
  const review = findLatestReviewSource(projectPath)
  const watchlistPath = path.join(projectPath, ".llm-wiki/market-watchlist/latest-warroom-watchlist.json")
  const watchlist = readJsonMaybe(watchlistPath)
  const planTradeDate = normalizeTradeDate(watchlist?.planTradeDate ?? watchlist?.tradeDate) ?? generatedAt.slice(0, 10)
  const evidenceTradeDate = normalizeTradeDate(watchlist?.evidenceTradeDate)
  const planCodes = collectPlanCodes(watchlist)
  const tradeCodes = extractTradeCodes(review.text)
  const unplannedTradeCandidates = tradeCodes.filter((code) => !planCodes.includes(code))
  const riskHits = findRiskHits(review.text)
  const severity = severityFromAudit(unplannedTradeCandidates.length, riskHits)
  const sourceTradeDates = {
    reviewSource: review.tradeDate,
    watchlistPlan: normalizeTradeDate(watchlist?.planTradeDate ?? watchlist?.tradeDate),
    watchlistEvidence: normalizeTradeDate(watchlist?.evidenceTradeDate),
  }
  const distinctTradeDates = [...new Set(Object.values(sourceTradeDates).filter(Boolean))]
  const record = {
    schema: "73wiki-execution-audit-v1",
    id: `execution_audit_${String(planTradeDate).replace(/-/g, "")}_${idTimestamp()}_${shortHash(review.filePath ?? "none")}`,
    status: "active",
    title: `${planTradeDate} 执行纪律审计`,
    generatedAt,
    tradeDate: planTradeDate,
    planTradeDate,
    evidenceTradeDate,
    sourceTradeDates,
    hasDateMismatch: distinctTradeDates.length > 1,
    severity,
    projectPath,
    reviewSource: review.filePath ? projectRelative(projectPath, review.filePath) : null,
    watchlistSource: fs.existsSync(watchlistPath) ? projectRelative(projectPath, watchlistPath) : null,
    planCodes,
    tradeCodes,
    unplannedTradeCandidates,
    riskHits,
    summary: buildSummary(unplannedTradeCandidates, riskHits),
    claim: "这是计划内外和纪律风险的自动审计候选，不等于最终交易结论。",
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }

  if (!options.write) return { dryRun: true, record }

  const reportDir = path.join(projectPath, REPORT_ROOT)
  const stamp = idTimestamp()
  const jsonPath = path.join(reportDir, `${stamp}-execution-audit.json`)
  const mdPath = path.join(reportDir, `${stamp}-execution-audit.md`)
  const latestJson = path.join(reportDir, "latest-execution-audit.json")
  const latestMd = path.join(reportDir, "latest-execution-audit.md")
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
  npm run execution:audit -- --project C:\\wiki\\73神话 --write
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
    severity: result.record.severity,
    planTradeDate: result.record.planTradeDate,
    evidenceTradeDate: result.record.evidenceTradeDate,
    unplannedTradeCandidates: result.record.unplannedTradeCandidates,
    riskHits: result.record.riskHits,
    written: result.written,
  }, null, 2))
}

main()
