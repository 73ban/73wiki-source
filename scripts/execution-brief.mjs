#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const REPORT_ROOT = ".llm-wiki/execution-brief"
const WARROOM_PAGE = "wiki/07-作战室/当前作战室工作页.md"
const HOLDING_PAGE = "wiki/06-持仓与资金管理/当前持仓决策.md"
const STOCK_ARCHIVE_ROOT = "wiki/03-L3个股档案"
const REVIEW_ROOTS = [
  "raw/02-每日复盘",
  "raw/03-每日交易计划",
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

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim()
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

function buildNameMap(projectPath) {
  const archiveRoot = path.join(projectPath, STOCK_ARCHIVE_ROOT)
  const map = new Map()
  if (!fs.existsSync(archiveRoot)) return map
  const files = listMarkdownFiles(archiveRoot)
  const scoreName = (name) => {
    const text = cleanText(name)
    if (!text) return -1
    if (/^RAW/i.test(text)) return 0
    if (/增量个股卡|增量骨架|模板|\d{4}-\d{2}-\d{2}/.test(text)) return 1
    return text.length
  }
  for (const item of files) {
    const fileName = path.basename(item.filePath)
    const match = fileName.match(/(\d{6})[-_－](.+?)\.md$/)
    if (!match) continue
    const code = match[1]
    const name = cleanText(match[2].replace(/-RAW增量.*$/, "").replace(/-.*骨架$/, ""))
    const current = map.get(code)
    if (scoreName(name) > scoreName(current)) map.set(code, name)
  }
  return map
}

function resolveDisplayName(code, fallbackName, nameMap) {
  if (nameMap.has(code)) return nameMap.get(code)
  return cleanText(fallbackName) || code
}

function readCoreInputs(projectPath) {
  const read = (relativePath) => readJsonMaybe(path.join(projectPath, relativePath))
  return {
    marketCollect: read(".llm-wiki/market-collect/latest-market-collect.json"),
    watchlist: read(".llm-wiki/market-watchlist/latest-warroom-watchlist.json"),
    corrections: read(".llm-wiki/correction-alerts/latest-correction-alerts.json"),
    executionAudit: read(".llm-wiki/execution-audit/latest-execution-audit.json"),
    preopen: read(".llm-wiki/preopen/latest-preopen-intel.json"),
  }
}

function correctionPenalty(item) {
  if (!item) return 0
  const severity = String(item.severity ?? "").toLowerCase()
  let penalty = 0
  if (severity === "high") penalty += 900
  else if (severity === "medium") penalty += 360
  else if (severity === "low") penalty += 120
  if (item.pushEligible) penalty += 180
  if (String(item.evidenceGrade ?? "").toLowerCase() === "strong") penalty += 90
  return penalty
}

function buildCorrectionMap(corrections) {
  const map = new Map()
  for (const item of corrections?.items ?? []) {
    if (!item?.code) continue
    map.set(String(item.code), item)
  }
  return map
}

function buildExecutionCandidates(inputs, nameMap) {
  const focus = Array.isArray(inputs.watchlist?.tiers?.focus) ? inputs.watchlist.tiers.focus : []
  const correctionMap = buildCorrectionMap(inputs.corrections)
  return focus
    .map((item, index) => {
      const code = String(item.code ?? "")
      const correction = correctionMap.get(code)
      const penalty = correctionPenalty(correction)
      return {
        code,
        name: resolveDisplayName(code, item.name, nameMap),
        baseScore: Number(item.score ?? 0),
        executionScore: Number(item.score ?? 0) - penalty,
        reviewFirst: Boolean(correction?.pushEligible) || ["high", "medium"].includes(String(correction?.severity ?? "").toLowerCase()),
        correctionSeverity: correction?.severity ?? null,
        correctionTriggers: unique(correction?.triggers ?? []).slice(0, 3),
        roleHint: cleanText(item.role ?? item.roleHint ?? "重点观察"),
        index,
      }
    })
    .filter((item) => item.code)
    .sort((left, right) => {
      if (left.executionScore !== right.executionScore) return right.executionScore - left.executionScore
      if (left.baseScore !== right.baseScore) return right.baseScore - left.baseScore
      return left.index - right.index
    })
}

function summarizeMarketState(inputs) {
  const symbolCount = Number(inputs.marketCollect?.symbolCount ?? inputs.watchlist?.symbols?.length ?? 0)
  const softFailures = Number(inputs.marketCollect?.softFailureCount ?? 0)
  if (symbolCount > 0 && softFailures === 0) return "主链可用，先主计划后备选。"
  if (symbolCount > 0) return `主链可用，但有 ${softFailures} 个软失败项，盘中要保守。`
  return "主链未形成完整观察池，盘中只能保守处理。"
}

function summarizeDataGap(planTradeDate, evidenceTradeDate, holdingSource) {
  const gaps = []
  if (planTradeDate && evidenceTradeDate && planTradeDate !== evidenceTradeDate) {
    gaps.push(`计划交易日 ${planTradeDate} 与证据交易日 ${evidenceTradeDate} 不一致，按双日期阅读。`)
  }
  if (holdingSource) {
    gaps.push(`持仓来自 ${holdingSource}，仍需你确认是否为最新真实持仓。`)
  }
  return gaps.join(" ")
}

function listTableBlocks(text) {
  const lines = String(text ?? "").split(/\r?\n/)
  const blocks = []
  let current = []
  let startLine = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*\|/.test(line)) {
      if (current.length === 0) startLine = index
      current.push(line)
      continue
    }
    if (current.length >= 2) blocks.push({ lines: current, startLine, allLines: lines })
    current = []
  }
  if (current.length >= 2) blocks.push({ lines: current, startLine, allLines: lines })
  return blocks
}

function parseMarkdownTable(block) {
  const { lines, startLine, allLines } = block
  const rows = lines
    .filter((line) => /^\s*\|/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
  if (rows.length < 3) return null
  return {
    headers: rows[0],
    rows: rows.slice(2).filter((cells) => cells.some((cell) => cleanText(cell))),
    context: allLines.slice(Math.max(0, startLine - 5), startLine).join("\n"),
  }
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
    }
  }
  return { filePath: null, text: "" }
}

function extractHoldingRowsFromText(text, nameMap) {
  const tables = listTableBlocks(text).map(parseMarkdownTable).filter(Boolean)
  let bestTable = null
  let bestScore = -Infinity
  for (const table of tables) {
    const candidateRows = table.rows.filter((cells) => cells.some((cell) => /\b\d{6}\b/.test(cell)))
    if (candidateRows.length === 0) continue
    const headerText = table.headers.join(" | ")
    const contextText = table.context
    let score = candidateRows.length * 2
    if (/持仓|成本|收盘|浮盈|今日盈亏|股票|个股/i.test(headerText)) score += 8
    if (/持仓变动|个股复盘|当前持仓|持仓/i.test(contextText)) score += 10
    if (/净流入|涨幅|方向|主力资金/i.test(headerText)) score -= 12
    if (score > bestScore) {
      bestScore = score
      bestTable = { ...table, rows: candidateRows }
    }
  }
  if (!bestTable) return []
  const holdings = []
  for (const cells of bestTable.rows) {
    const code = (cells.join(" ").match(/\b\d{6}\b/) ?? [])[0] ?? ""
    if (!code) continue
    const codeIndex = cells.findIndex((cell) => cell.includes(code))
    const nameCell = codeIndex >= 0 ? (cells[codeIndex + 1] ?? cells[1] ?? code) : (cells[1] ?? code)
    holdings.push({
      code,
      name: resolveDisplayName(code, nameCell.replace(code, "").trim(), nameMap),
      rawPosition: cells[codeIndex + 2] ?? cells[2] ?? "",
      rawCost: cells[codeIndex + 4] ?? cells[4] ?? "",
      rawClose: cells[codeIndex + 5] ?? cells[5] ?? "",
      rawPnl: cells[cells.length - 1] ?? "",
    })
  }
  return holdings
}

function extractHoldings(projectPath, nameMap) {
  for (const relativeRoot of REVIEW_ROOTS) {
    const rootDir = path.join(projectPath, relativeRoot)
    for (const file of listMarkdownFiles(rootDir)) {
      const rows = extractHoldingRowsFromText(readTextMaybe(file.filePath), nameMap)
      if (rows.length === 0) continue
      return {
        sourcePath: projectRelative(projectPath, file.filePath),
        rows: rows.slice(0, 12),
      }
    }
  }
  return {
    sourcePath: null,
    rows: [],
  }
}

function buildWarRoomPage(record) {
  const lines = [
    "# 当前作战室工作页",
    "",
    `更新时间：${record.generatedAt}`,
    "",
    "## 基本信息",
    "",
    "```yaml",
    `date: ${record.planTradeDate ?? "-"}`,
    `plan_trade_date: ${record.planTradeDate ?? "-"}`,
    `evidence_trade_date: ${record.evidenceTradeDate ?? "-"}`,
    `market_state: ${record.marketState}`,
    `position_permission: ${record.positionPermission}`,
    `data_gap: ${record.dataGap || "无"}`,
    "```",
    "",
    "## 今日结论",
    "",
    "```text",
    record.summary,
    "```",
    "",
    "## 主计划",
    "",
    "| 代码 | 名称 | 角色 | 盘中要求 | 备注 |",
    "|---|---|---|---|---|",
  ]

  if (record.primary) {
    lines.push(`| ${record.primary.code} | ${record.primary.name} | 主做 | 只做确认，不做无逻辑追高 | ${record.primary.reviewFirst ? "先复核再动作" : "优先盯盘"} |`)
  } else {
    lines.push("| - | - | - | - | - |")
  }

  lines.push("")
  lines.push("## 备选计划")
  lines.push("")
  lines.push("| 代码 | 名称 | 角色 | 盘中要求 |")
  lines.push("|---|---|---|---|")
  if (record.backups.length === 0) {
    lines.push("| - | - | - | - |")
  } else {
    for (const item of record.backups) {
      lines.push(`| ${item.code} | ${item.name} | 备选 | 只观察是否强于同题材，避免追高 |`)
    }
  }

  lines.push("")
  lines.push("## 自动纠偏待复核")
  lines.push("")
  lines.push("| 代码 | 名称 | 等级 | 触发 | 动作 |")
  lines.push("|---|---|---|---|---|")
  if (record.correctionItems.length === 0) {
    lines.push("| - | - | - | 未命中中高等级纠偏 | 正常按主计划执行 |")
  } else {
    for (const item of record.correctionItems) {
      lines.push(`| ${item.code} | ${item.name} | ${item.severity} | ${item.triggers.join(" / ") || "-"} | ${item.pushEligible ? "先复核并准备提醒" : "盘中先核对"} |`)
    }
  }

  lines.push("")
  lines.push("## 纪律审计")
  lines.push("")
  lines.push(`- 级别：${record.auditSeverity}`)
  lines.push(`- 计划外候选：${record.unplannedTradeCandidates.join("、") || "无"}`)
  lines.push("")
  lines.push("## 执行短名单")
  lines.push("")
  lines.push("| 代码 | 名称 | 执行分 | 是否先复核 |")
  lines.push("|---|---|---|---|")
  for (const item of record.topCandidates) {
    lines.push(`| ${item.code} | ${item.name} | ${item.executionScore} | ${item.reviewFirst ? "是" : "否"} |`)
  }
  lines.push("")
  return `${lines.join("\n")}\n`
}

function buildHoldingPage(record) {
  const lines = [
    "# 当前持仓决策",
    "",
    `更新时间：${record.generatedAt}`,
    "",
    "## 基本信息",
    "",
    "```yaml",
    `date: ${record.planTradeDate ?? "-"}`,
    `plan_trade_date: ${record.planTradeDate ?? "-"}`,
    `evidence_trade_date: ${record.evidenceTradeDate ?? "-"}`,
    `market_state: ${record.marketState}`,
    `position_permission: ${record.positionPermission}`,
    `data_gap: ${record.dataGap || "无"}`,
    "```",
    "",
    "## 当前结论",
    "",
    "```text",
    record.holdingSummary,
    "```",
    "",
    "## 当前持仓表",
    "",
    "| 股票/代码 | 原始持仓信息 | 与主计划关系 | 当前状态 | 处理结论 | 数据备注 |",
    "|---|---|---|---|---|---|",
  ]

  if (record.holdings.length === 0) {
    lines.push("| - | - | - | 未提取到结构化持仓 | 先等你确认真实持仓 | 无 |")
  } else {
    for (const item of record.holdings) {
      const relation = record.primary && item.code === record.primary.code ? "属于当前主计划" : "非当前主计划持仓"
      lines.push(`| ${item.name} ${item.code} | 持仓:${item.rawPosition || "-"} 成本:${item.rawCost || "-"} 收盘:${item.rawClose || "-"} | ${relation} | 待你确认真实仓位 | 优先确认是否仍持有，再决定留撤 | 来源: ${record.holdingSource ?? "-"} |`)
    }
  }

  lines.push("")
  lines.push("## 风险栏")
  lines.push("")
  lines.push("| 风险项 | 当前状态 | 对持仓影响 |")
  lines.push("|---|---|---|")
  lines.push(`| 自动纠偏 | ${record.correctionItems.length > 0 ? "命中" : "未命中"} | ${record.correctionItems.length > 0 ? record.correctionItems.map((item) => `${item.code}:${item.severity}`).join(" / ") : "暂无中高等级冲突"} |`)
  lines.push(`| 纪律审计 | ${record.auditSeverity} | ${record.unplannedTradeCandidates.length > 0 ? `发现计划外候选 ${record.unplannedTradeCandidates.join("、")}` : "未发现明确计划外代码"} |`)
  lines.push(`| 数据完整度 | ${record.holdingSource ? "部分可用" : "不足"} | ${record.holdingSource ? `持仓来自 ${record.holdingSource}，仍需你确认。` : "还没有抓到足够的持仓结构。"} |`)
  lines.push("")
  return `${lines.join("\n")}\n`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const nameMap = buildNameMap(projectPath)
  const inputs = readCoreInputs(projectPath)
  const candidates = buildExecutionCandidates(inputs, nameMap)
  const primary = candidates[0] ?? null
  const backups = candidates.slice(1, 3)
  const correctionItems = (inputs.corrections?.items ?? [])
    .filter((item) => ["high", "medium"].includes(String(item.severity ?? "").toLowerCase()) || item.pushEligible)
    .map((item) => ({
      code: String(item.code),
      name: resolveDisplayName(String(item.code), item.name, nameMap),
      severity: String(item.severity ?? "").toLowerCase(),
      triggers: unique(item.triggers ?? []).slice(0, 3),
      pushEligible: Boolean(item.pushEligible),
    }))
  const holdingExtract = extractHoldings(projectPath, nameMap)
  const planTradeDate = normalizeTradeDate(inputs.watchlist?.planTradeDate ?? inputs.watchlist?.tradeDate) ?? normalizeTradeDate(inputs.marketCollect?.planTradeDate ?? inputs.marketCollect?.tradeDate)
  const evidenceTradeDate = normalizeTradeDate(inputs.watchlist?.evidenceTradeDate ?? inputs.marketCollect?.evidenceTradeDate)
  const sourceTradeDates = {
    marketCollectPlan: normalizeTradeDate(inputs.marketCollect?.planTradeDate ?? inputs.marketCollect?.tradeDate),
    marketCollectEvidence: normalizeTradeDate(inputs.marketCollect?.evidenceTradeDate),
    watchlistPlan: normalizeTradeDate(inputs.watchlist?.planTradeDate ?? inputs.watchlist?.tradeDate),
    watchlistEvidence: normalizeTradeDate(inputs.watchlist?.evidenceTradeDate),
    executionAuditPlan: normalizeTradeDate(inputs.executionAudit?.planTradeDate ?? inputs.executionAudit?.tradeDate),
    executionAuditEvidence: normalizeTradeDate(inputs.executionAudit?.evidenceTradeDate),
  }
  const distinctTradeDates = [...new Set(Object.values(sourceTradeDates).filter(Boolean))]
  const generatedAt = nowLocalTimestamp()
  const marketState = summarizeMarketState(inputs)
  const dataGap = summarizeDataGap(planTradeDate, evidenceTradeDate, holdingExtract.sourcePath)
  const summary = primary
    ? `主做只留 ${primary.name}(${primary.code}) 1 只，备选最多保留 ${backups.map((item) => `${item.name}(${item.code})`).join("、") || "无"}。`
    : "当前没有形成可执行主计划，只能先等新的盘前确认。"
  const holdingSummary = holdingExtract.rows.length > 0
    ? `已从最近复盘中提取到 ${holdingExtract.rows.length} 条持仓线索。自动脚本只做回填，不替代你对真实持仓、仓位和意图的最终确认。`
    : "还没有提取到可靠持仓结构，当前持仓页只保留风险提醒，等你补最新真实持仓。"

  const record = {
    schema: "73wiki-execution-brief-v1",
    id: `execution_brief_${String(planTradeDate ?? generatedAt.slice(0, 10)).replace(/-/g, "")}_${idTimestamp()}_${shortHash(summary)}`,
    status: "active",
    title: `${planTradeDate ?? generatedAt.slice(0, 10)} 执行短名单`,
    generatedAt,
    tradeDate: planTradeDate,
    planTradeDate,
    evidenceTradeDate,
    sourceTradeDates,
    hasDateMismatch: distinctTradeDates.length > 1,
    projectPath,
    marketState,
    positionPermission: primary ? "标准试错仓" : "仅观察，不加风险",
    dataGap,
    primary,
    backups,
    topCandidates: candidates.slice(0, 5),
    correctionItems,
    auditSeverity: String(inputs.executionAudit?.severity ?? "unknown"),
    unplannedTradeCandidates: unique(inputs.executionAudit?.unplannedTradeCandidates ?? []),
    holdings: holdingExtract.rows,
    holdingSource: holdingExtract.sourcePath,
    summary,
    holdingSummary,
    claim: "这是盘前执行短名单和持仓回填页，不等于自动买卖指令。",
    writePolicy: {
      rawWrite: false,
      wikiWrite: true,
      buyAdvice: false,
    },
  }

  if (!options.write) return { dryRun: true, record }

  const reportDir = path.join(projectPath, REPORT_ROOT)
  const stamp = idTimestamp()
  const jsonPath = path.join(reportDir, `${stamp}-execution-brief.json`)
  const mdPath = path.join(reportDir, `${stamp}-execution-brief.md`)
  const latestJson = path.join(reportDir, "latest-execution-brief.json")
  const latestMd = path.join(reportDir, "latest-execution-brief.md")
  const warRoomPath = path.join(projectPath, WARROOM_PAGE)
  const holdingPagePath = path.join(projectPath, HOLDING_PAGE)
  writeJson(jsonPath, record)
  writeJson(latestJson, record)
  writeText(mdPath, buildWarRoomPage(record))
  writeText(latestMd, buildWarRoomPage(record))
  writeText(warRoomPath, buildWarRoomPage(record))
  writeText(holdingPagePath, buildHoldingPage(record))
  return {
    dryRun: false,
    record,
    written: {
      report: projectRelative(projectPath, jsonPath),
      markdown: projectRelative(projectPath, mdPath),
      latest: projectRelative(projectPath, latestJson),
      warRoom: projectRelative(projectPath, warRoomPath),
      holdings: projectRelative(projectPath, holdingPagePath),
    },
  }
}

function printHelp() {
  console.log(`Usage:
  npm run execution:brief -- --project C:\\wiki\\73神话 --write
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
    planTradeDate: result.record.planTradeDate,
    evidenceTradeDate: result.record.evidenceTradeDate,
    primary: result.record.primary ? { code: result.record.primary.code, name: result.record.primary.name } : null,
    backups: result.record.backups.map((item) => ({ code: item.code, name: item.name })),
    holdings: result.record.holdings.length,
    written: result.written,
  }, null, 2))
}

main()
