#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const REPORT_ROOT = ".llm-wiki/warroom-skeleton"
const SCORE_FILE_TEMPLATE = "wiki/07-作战室/{tradeDate}-作战室候选票评分表.md"
const AUCTION_FILE_TEMPLATE = "raw/03-每日交易计划/{tradeDate}-竞价监控清单.md"

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

function projectRelative(projectPath, targetPath) {
  return path.relative(path.resolve(projectPath), path.resolve(targetPath)).replace(/\\/g, "/")
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean).map((value) => cleanText(value)).filter(Boolean))]
}

function replaceTemplate(template, values) {
  let output = template
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{${key}}`, String(value))
  }
  return output
}

function loadInputs(projectPath) {
  const read = (relativePath) => readJsonMaybe(path.join(projectPath, relativePath))
  return {
    executionBrief: read(".llm-wiki/execution-brief/latest-execution-brief.json"),
    watchlist: read(".llm-wiki/market-watchlist/latest-warroom-watchlist.json"),
    cards: read(".llm-wiki/stock-reason-cards/latest-stock-reason-cards.json"),
    corrections: read(".llm-wiki/correction-alerts/latest-correction-alerts.json"),
  }
}

function buildCardMap(cards) {
  return new Map((cards?.cards ?? []).filter((item) => item?.code).map((item) => [String(item.code), item]))
}

function buildCorrectionMap(corrections) {
  return new Map((corrections?.items ?? []).filter((item) => item?.code).map((item) => [String(item.code), item]))
}

function buildWatchlistMap(watchlist) {
  const map = new Map()
  for (const [tierName, items] of Object.entries(watchlist?.tiers ?? {})) {
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if (!item?.code) continue
      const code = String(item.code)
      if (!map.has(code)) {
        map.set(code, {
          tier: tierName,
          score: Number(item.score ?? 0),
          role: cleanText(item.role ?? item.roleHint),
          themes: unique(item.themes ?? []).slice(0, 5),
          reasons: unique(item.reasons ?? []).slice(0, 4),
        })
      }
    }
  }
  return map
}

function buildCandidates(inputs, limit) {
  const cardMap = buildCardMap(inputs.cards)
  const correctionMap = buildCorrectionMap(inputs.corrections)
  const watchlistMap = buildWatchlistMap(inputs.watchlist)
  const seeds = [
    inputs.executionBrief?.primary,
    ...(inputs.executionBrief?.backups ?? []),
    ...(inputs.executionBrief?.topCandidates ?? []),
  ].filter((item) => item?.code)

  const seen = new Set()
  const rows = []
  for (const seed of seeds) {
    const code = String(seed.code)
    if (seen.has(code)) continue
    seen.add(code)
    const card = cardMap.get(code) ?? null
    const correction = correctionMap.get(code) ?? null
    const watch = watchlistMap.get(code) ?? null
    rows.push({
      code,
      name: cleanText(seed.name) || cleanText(card?.name) || code,
      executionScore: Number(seed.executionScore ?? seed.baseScore ?? watch?.score ?? 0),
      baseScore: Number(seed.baseScore ?? watch?.score ?? 0),
      role: cleanText(seed.roleHint ?? watch?.role ?? card?.role) || "观察",
      tier: cleanText(watch?.tier) || "-",
      themes: unique([...(card?.themes ?? []), ...(watch?.themes ?? [])]).slice(0, 5),
      catalysts: unique(card?.catalysts ?? []).slice(0, 4),
      risks: unique([...(card?.risks ?? []), ...(correction?.triggers ?? [])]).slice(0, 4),
      correctionSeverity: cleanText(correction?.severity) || "-",
      inferredReason: cleanText(card?.inferredReason),
      nextDayValidation: cleanText(card?.validation?.nextDay),
      failRule: cleanText(card?.validation?.fail),
      d3d5Rule: cleanText(card?.validation?.d3d5),
      reviewFirst: Boolean(seed.reviewFirst || correction?.pushEligible),
    })
  }
  return rows.slice(0, limit)
}

function buildRecord(projectPath, options = {}) {
  const inputs = loadInputs(projectPath)
  if (!inputs.executionBrief) throw new Error("Missing execution brief artifact.")
  const tradeDate = inputs.executionBrief.tradeDate
  const candidateLimit = Number(options.limit ?? 8)
  const candidates = buildCandidates(inputs, candidateLimit)
  const scoreFile = replaceTemplate(SCORE_FILE_TEMPLATE, { tradeDate })
  const auctionFile = replaceTemplate(AUCTION_FILE_TEMPLATE, { tradeDate })
  const correctionItems = (inputs.executionBrief.correctionItems ?? []).map((item) => ({
    code: item.code,
    name: item.name,
    severity: item.severity,
    triggers: unique(item.triggers ?? []).slice(0, 3),
    pushEligible: Boolean(item.pushEligible),
  }))
  return {
    schema: "73wiki-warroom-skeleton-v1",
    id: `warroom_skeleton_${tradeDate?.replace(/-/g, "")}_${idTimestamp()}_${shortHash(candidates.map((item) => item.code).join(","))}`,
    status: "active",
    title: `${tradeDate} 作战室评分与竞价骨架`,
    generatedAt: nowLocalTimestamp(),
    tradeDate,
    planTradeDate: inputs.executionBrief.planTradeDate ?? tradeDate,
    evidenceTradeDate: inputs.executionBrief.evidenceTradeDate ?? tradeDate,
    sourceTradeDates: {
      executionBriefPlan: inputs.executionBrief.planTradeDate ?? null,
      executionBriefEvidence: inputs.executionBrief.evidenceTradeDate ?? null,
      watchlistPlan: inputs.watchlist?.planTradeDate ?? null,
      watchlistEvidence: inputs.watchlist?.evidenceTradeDate ?? null,
      stockCardsPlan: inputs.cards?.planTradeDate ?? null,
      stockCardsEvidence: inputs.cards?.evidenceTradeDate ?? null,
      correctionPlan: inputs.corrections?.planTradeDate ?? null,
      correctionEvidence: inputs.corrections?.evidenceTradeDate ?? null,
    },
    hasDateMismatch: Boolean(
      (inputs.executionBrief?.hasDateMismatch ?? false)
      || (inputs.watchlist?.hasDateMismatch ?? false)
      || (inputs.cards?.hasDateMismatch ?? false)
      || (inputs.corrections?.hasDateMismatch ?? false)
      || (
        inputs.executionBrief.planTradeDate
        && inputs.executionBrief.evidenceTradeDate
        && inputs.executionBrief.planTradeDate !== inputs.executionBrief.evidenceTradeDate
      )
    ),
    projectPath,
    marketState: cleanText(inputs.executionBrief.marketState),
    positionPermission: cleanText(inputs.executionBrief.positionPermission),
    dataGap: cleanText(inputs.executionBrief.dataGap),
    primary: inputs.executionBrief.primary ?? null,
    backups: inputs.executionBrief.backups ?? [],
    candidates,
    holdings: inputs.executionBrief.holdings ?? [],
    correctionItems,
    scoreFile,
    auctionFile,
    summary: `primary=${inputs.executionBrief.primary?.code ?? "-"}, candidates=${candidates.length}, corrections=${correctionItems.length}`,
    claim: "作战室骨架只生成执行模板和竞价监控清单，不替代你对真实持仓、盘中感受和最终拍板的确认。",
    writePolicy: {
      rawWrite: true,
      wikiWrite: true,
      buyAdvice: false,
    },
  }
}

function buildScoreMarkdown(record) {
  const lines = [
    `# ${record.tradeDate} 作战室候选票评分表`,
    "",
    `生成时间: ${record.generatedAt}`,
    `计划交易日: ${record.planTradeDate ?? "-"}`,
    `证据交易日: ${record.evidenceTradeDate ?? "-"}`,
    `市场状态: ${record.marketState || "-"}`,
    `仓位权限: ${record.positionPermission || "-"}`,
    `数据缺口: ${record.dataGap || "无"}`,
    "",
    "## 主计划",
    "",
    `- Primary: ${record.primary?.name ?? "-"}(${record.primary?.code ?? "-"})`,
    `- Backups: ${(record.backups ?? []).map((item) => `${item.name}(${item.code})`).join(" / ") || "-"}`,
    "",
    "## 候选评分表",
    "",
    "| # | Code | Name | Role | ExecScore | Themes | Catalysts | Risk/Correction | Auction | Intraday | Trigger | Downgrade | Decision |",
    "|---|---|---|---|---:|---|---|---|---|---|---|---|---|",
  ]

  record.candidates.forEach((item, index) => {
    lines.push(`| ${index + 1} | ${item.code} | ${item.name} | ${item.role} | ${item.executionScore} | ${item.themes.join("/")} | ${item.catalysts.join("/")} | ${(item.risks.join("/") || item.correctionSeverity || "-")} |  |  | ${item.nextDayValidation || "-"} | ${item.failRule || "-"} |  |`)
  })

  lines.push("")
  lines.push("## 备注")
  lines.push("")
  lines.push("- Auction 和 Intraday 两列留给盘中手工回填。")
  lines.push("- 如果出现纠偏项，先复核再决定是否继续推进。")
  lines.push("")
  return `${lines.join("\n")}\n`
}

function buildAuctionMarkdown(record) {
  const lines = [
    `# ${record.tradeDate} 竞价监控清单`,
    "",
    `生成时间: ${record.generatedAt}`,
    `计划交易日: ${record.planTradeDate ?? "-"}`,
    `证据交易日: ${record.evidenceTradeDate ?? "-"}`,
    "",
    "## 今日口径",
    "",
    `- 市场状态: ${record.marketState || "-"}`,
    `- 仓位权限: ${record.positionPermission || "-"}`,
    `- 数据缺口: ${record.dataGap || "无"}`,
    "",
    "## 候选票竞价监控",
    "",
    "| Code | Name | 09:15 | 09:20 | 09:25 | 开盘5分钟 | 分时承接 | 板块反馈 | 动作 |",
    "|---|---|---|---|---|---|---|---|---|",
  ]

  for (const item of record.candidates) {
    lines.push(`| ${item.code} | ${item.name} |  |  |  |  |  |  |  |`)
  }

  lines.push("")
  lines.push("## 持仓监控")
  lines.push("")
  if ((record.holdings ?? []).length === 0) {
    lines.push("- 暂无自动回填持仓。")
  } else {
    lines.push("| Code | Name | Position | Cost | Close | PnL | Open Check | Exit Trigger |")
    lines.push("|---|---|---|---|---|---|---|---|")
    for (const item of record.holdings) {
      lines.push(`| ${item.code ?? "-"} | ${item.name ?? "-"} | ${item.rawPosition ?? "-"} | ${item.rawCost ?? "-"} | ${item.rawClose ?? "-"} | ${item.rawPnl ?? "-"} |  |  |`)
    }
  }

  lines.push("")
  lines.push("## 纠偏优先复核")
  lines.push("")
  if (record.correctionItems.length === 0) {
    lines.push("- 当前无自动纠偏项。")
  } else {
    for (const item of record.correctionItems) {
      lines.push(`- ${item.name}(${item.code}) | ${item.severity} | ${item.triggers.join(" / ") || "-"}`)
    }
  }

  lines.push("")
  lines.push("## 执行提醒")
  lines.push("")
  lines.push("- 你只负责拍板、补真实交易意图和现场感受。")
  lines.push("- 大鸟只生成骨架和复核线，不替你自动买卖。")
  lines.push("")
  return `${lines.join("\n")}\n`
}

function buildArtifactMarkdown(record) {
  const lines = [
    `# ${record.title}`,
    "",
    `生成时间: ${record.generatedAt}`,
    `计划交易日: ${record.planTradeDate ?? "-"}`,
    `证据交易日: ${record.evidenceTradeDate ?? "-"}`,
    `评分表: ${record.scoreFile}`,
    `竞价清单: ${record.auctionFile}`,
    "",
    "## 候选概览",
    "",
  ]
  for (const item of record.candidates) {
    lines.push(`- ${item.name}(${item.code}) | exec=${item.executionScore} | role=${item.role} | correction=${item.correctionSeverity || "-"}`)
  }
  lines.push("")
  return `${lines.join("\n")}\n`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const record = buildRecord(projectPath, options)
  if (!options.write) return { dryRun: true, record }

  const reportDir = path.join(projectPath, REPORT_ROOT)
  const stamp = idTimestamp()
  const jsonPath = path.join(reportDir, `${stamp}-warroom-skeleton.json`)
  const mdPath = path.join(reportDir, `${stamp}-warroom-skeleton.md`)
  const latestJson = path.join(reportDir, "latest-warroom-skeleton.json")
  const latestMd = path.join(reportDir, "latest-warroom-skeleton.md")
  const scorePath = path.join(projectPath, record.scoreFile)
  const auctionPath = path.join(projectPath, record.auctionFile)
  writeJson(jsonPath, record)
  writeJson(latestJson, record)
  writeText(mdPath, buildArtifactMarkdown(record))
  writeText(latestMd, buildArtifactMarkdown(record))
  writeText(scorePath, buildScoreMarkdown(record))
  writeText(auctionPath, buildAuctionMarkdown(record))
  return {
    dryRun: false,
    record,
    written: {
      report: projectRelative(projectPath, jsonPath),
      markdown: projectRelative(projectPath, mdPath),
      latest: projectRelative(projectPath, latestJson),
      scoreFile: record.scoreFile,
      auctionFile: record.auctionFile,
    },
  }
}

function printHelp() {
  console.log(`Usage:
  npm run warroom:skeleton -- --project C:\\wiki\\73神话
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
    limit: args.limit ?? args._[1],
    write: Boolean(args.write),
  })
  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(JSON.stringify({
    dryRun: result.dryRun,
    summary: result.record.summary,
    written: result.written,
  }, null, 2))
}

main()
