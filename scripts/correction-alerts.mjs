#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const FACT_PATH = "data/facts/correction_alerts.jsonl"
const REPORT_ROOT = ".llm-wiki/correction-alerts"
const RISK_KEYWORDS = [
  "减持",
  "监管",
  "问询",
  "澄清",
  "风险提示",
  "异常波动",
  "停牌",
  "跌停",
  "亏损",
  "处罚",
  "诉讼",
  "终止",
  "解禁",
  "辟谣",
  "兑现",
]

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
  const pad = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function idTimestamp(date = new Date()) {
  return nowLocalTimestamp(date).replace(/[-: ]/g, "")
}

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12)
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
}

function writeText(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, value, "utf8")
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/")
}

function projectRelative(projectPath, targetPath) {
  return toPosixPath(path.relative(path.resolve(projectPath), path.resolve(targetPath)))
}

function parseNumberLoose(value) {
  const text = String(value ?? "").replace(/,/g, "").trim()
  if (!text || text === "--") return null
  const match = text.match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : null
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))]
}

function hostFromUrl(value) {
  try {
    return new URL(String(value ?? "")).hostname.toLowerCase()
  } catch {
    return ""
  }
}

function classifyNewsAuthority(item) {
  const title = String(item?.title ?? "").trim()
  const snippet = String(item?.snippet ?? "").trim()
  const host = hostFromUrl(item?.url)
  const text = `${title} ${snippet}`

  if (!title || /^(首页|股票首页|行情中心|实时行情)/.test(title)) return { level: "noise", host }
  if (/行情|实时|指数|股票首页|首页/.test(title) && !/公告|问询|监管|异常波动|减持|停牌|处罚|风险提示/.test(text)) {
    return { level: "noise", host }
  }

  const officialHost = /(cninfo\.com\.cn|sse\.com\.cn|szse\.cn|neeq\.com\.cn|hkexnews\.hk)/
  const officialText = /公告|问询函|监管工作函|关注函|异常波动|立案|处罚|停牌核查|风险提示|减持计划|解禁|终止|退市|ST/
  if (officialHost.test(host) || (officialText.test(title) && /(公司|股份|证券|交易所|公告)/.test(text))) {
    return { level: "official", host }
  }

  const mediaHost = /(10jqka\.com\.cn|stockstar\.com|jrj\.com\.cn|finance\.sina\.com\.cn|eastmoney\.com|cfi\.cn|baidu\.com)/
  if (mediaHost.test(host)) return { level: "media", host }

  return { level: "unknown", host }
}

function riskHitsFromNews(newsItems) {
  const hits = []
  for (const item of newsItems ?? []) {
    const text = `${item?.title ?? ""} ${item?.snippet ?? ""}`
    const matched = RISK_KEYWORDS.filter((keyword) => text.includes(keyword))
    if (matched.length === 0) continue
    const authority = classifyNewsAuthority(item)
    if (authority.level === "noise") continue
    hits.push({
      title: String(item?.title ?? "").trim(),
      date: String(item?.date ?? "").trim(),
      url: String(item?.url ?? "").trim(),
      host: authority.host,
      authority: authority.level,
      keywords: matched,
    })
  }
  return hits
}

function severityLevel(score) {
  if (score >= 90) return "high"
  if (score >= 55) return "medium"
  return "low"
}

function evidenceGrade({ officialRiskHits, mediaRiskHits, changePercent, confidence }) {
  if (officialRiskHits.length > 0) return "strong"
  if (Number.isFinite(changePercent) && changePercent <= -7 && confidence >= 0.6) return "strong"
  if (mediaRiskHits.length >= 2) return "medium"
  if (Number.isFinite(changePercent) && changePercent <= -5 && confidence >= 0.6) return "medium"
  return "weak"
}

function resolveTradeDateContext(cardsBatch, ifindBatch, watchlist) {
  const planTradeDate = cardsBatch?.planTradeDate ?? cardsBatch?.tradeDate ?? watchlist?.planTradeDate ?? watchlist?.tradeDate ?? ifindBatch?.tradeDate ?? nowLocalTimestamp().slice(0, 10)
  const evidenceTradeDate = ifindBatch?.tradeDate ?? cardsBatch?.evidenceTradeDate ?? watchlist?.evidenceTradeDate ?? cardsBatch?.tradeDate ?? watchlist?.tradeDate ?? planTradeDate
  const sourceTradeDates = {
    stockReasonCardsPlan: cardsBatch?.planTradeDate ?? cardsBatch?.tradeDate ?? null,
    stockReasonCardsEvidence: cardsBatch?.evidenceTradeDate ?? null,
    ifindEnhance: ifindBatch?.tradeDate ?? null,
    marketWatchlistPlan: watchlist?.planTradeDate ?? watchlist?.tradeDate ?? null,
    marketWatchlistEvidence: watchlist?.evidenceTradeDate ?? null,
  }
  const distinct = [...new Set(Object.values(sourceTradeDates).filter(Boolean))]
  return {
    planTradeDate,
    evidenceTradeDate,
    sourceTradeDates,
    hasDateMismatch: distinct.length > 1,
  }
}

function buildAlert(card, ifindItem, watchlistItem) {
  if (!card || !ifindItem) return null

  const changePercent = parseNumberLoose(ifindItem.changePercent)
  const newsCount = Number(ifindItem.newsCount ?? 0)
  const confidence = Number(card.confidence ?? 0)
  const watchlistScore = Number(watchlistItem?.score ?? 0)
  const watchlistRole = String(watchlistItem?.role ?? "")
  const riskHits = riskHitsFromNews(ifindItem.newsItems)
  const officialRiskHits = riskHits.filter((item) => item.authority === "official")
  const mediaRiskHits = riskHits.filter((item) => item.authority === "media")
  const uniqueRiskKeywords = unique(riskHits.flatMap((item) => item.keywords))
  const triggers = []
  let severityScore = 0

  if (officialRiskHits.length > 0) {
    const joined = unique(officialRiskHits.flatMap((item) => item.keywords)).join("/")
    triggers.push(`官方风险信号: ${joined}`)
    severityScore += 74 + Math.min(18, officialRiskHits.length * 6)
  } else if (mediaRiskHits.length >= 2 && uniqueRiskKeywords.length > 0) {
    triggers.push(`媒体重复风险信号: ${uniqueRiskKeywords.join("/")}`)
    severityScore += 28 + Math.min(14, mediaRiskHits.length * 4)
  } else if (mediaRiskHits.length === 1 && uniqueRiskKeywords.length > 0) {
    triggers.push(`媒体风险线索: ${uniqueRiskKeywords.join("/")}`)
    severityScore += 10
  }

  if (Number.isFinite(changePercent) && changePercent <= -7 && confidence >= 0.6) {
    triggers.push(`高置信原因卡与价格表现冲突: ${changePercent}%`)
    severityScore += 42 + Math.min(14, confidence * 10)
  } else if (Number.isFinite(changePercent) && changePercent <= -5 && confidence >= 0.6) {
    triggers.push(`原因卡偏强但价格转弱: ${changePercent}%`)
    severityScore += 24
  }

  if (newsCount === 0 && confidence >= 0.82) {
    triggers.push("高置信原因卡缺少近期 iFinD 支撑")
    severityScore += 10
  }

  if (/盘前核心|核心/.test(watchlistRole) || watchlistScore >= 250) severityScore += 6

  if (triggers.length === 0) return null

  const severity = severityLevel(severityScore)
  const grade = evidenceGrade({ officialRiskHits, mediaRiskHits, changePercent, confidence })
  const pushEligible = severity === "high"
    || (
      severity === "medium"
      && (
        officialRiskHits.length > 0
        || (Number.isFinite(changePercent) && changePercent <= -7 && confidence >= 0.6 && watchlistScore >= 200)
      )
    )

  const topNews = (ifindItem.newsItems ?? [])
    .map((item) => String(item?.title ?? "").trim())
    .filter(Boolean)
    .slice(0, 2)

  return {
    schema: "73wiki-correction-alert-item-v1",
    id: `corr_${card.tradeDate?.replace(/-/g, "") ?? "na"}_${card.code}_${shortHash(triggers.join("|"))}`,
    code: card.code,
    name: card.name,
    tradeDate: card.tradeDate,
    severity,
    severityScore,
    evidenceGrade: grade,
    cardConfidence: confidence,
    changePercent,
    newsCount,
    triggers,
    cardInferredReason: card.inferredReason ?? card.inferred_reason ?? "",
    ifindSummary: ifindItem.summary ?? "",
    riskHits,
    officialRiskHitCount: officialRiskHits.length,
    mediaRiskHitCount: mediaRiskHits.length,
    topNews,
    watchlistScore,
    watchlistRole,
    watchlistTags: watchlistItem?.tags ?? [],
    pushEligible,
    suggestedAction: pushEligible ? "review_and_ping_user" : severity === "medium" ? "review_before_ping" : "log_only",
    feishuReadyText: `纠偏提醒 ${severity.toUpperCase()} | ${card.name}(${card.code}) | ${triggers.join(" | ")} | 原因卡: ${card.inferredReason ?? card.inferred_reason ?? "无"} | iFinD: ${ifindItem.summary ?? "无摘要"}`,
  }
}

function buildRecord(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const cardsPath = path.join(projectPath, ".llm-wiki/stock-reason-cards/latest-stock-reason-cards.json")
  const ifindPath = path.join(projectPath, ".llm-wiki/ifind-enhance/latest-ifind-enhance.json")
  const watchlistPath = path.join(projectPath, ".llm-wiki/market-watchlist/latest-warroom-watchlist.json")
  const cardsBatch = readJsonMaybe(cardsPath)
  const ifindBatch = readJsonMaybe(ifindPath)
  const watchlist = readJsonMaybe(watchlistPath)
  const dateContext = resolveTradeDateContext(cardsBatch, ifindBatch, watchlist)

  const watchlistRows = [
    ...(watchlist?.tiers?.warroom ?? []),
    ...(watchlist?.tiers?.focus ?? []),
    ...(watchlist?.tiers?.observe ?? []),
  ]
  const watchlistMap = new Map(watchlistRows.map((item) => [String(item.code ?? ""), item]))
  const ifindMap = new Map((ifindBatch?.items ?? []).map((item) => [String(item.code ?? ""), item]))
  const items = []

  for (const card of cardsBatch?.cards ?? []) {
    const code = String(card.code ?? "")
    if (!/^\d{6}$/.test(code)) continue
    const ifindItem = ifindMap.get(code)
    const watchlistItem = watchlistMap.get(code)
    const alert = buildAlert(card, ifindItem, watchlistItem)
    if (!alert) continue
    items.push(alert)
  }

  items.sort((left, right) => right.severityScore - left.severityScore || left.code.localeCompare(right.code))
  const high = items.filter((item) => item.severity === "high")
  const medium = items.filter((item) => item.severity === "medium")
  const low = items.filter((item) => item.severity === "low")
  const pushItems = items.filter((item) => item.pushEligible)
  const generatedAt = nowLocalTimestamp()

  return {
    schema: "73wiki-correction-alerts-v1",
    id: `correction_alerts_${idTimestamp()}_${shortHash(items.map((item) => item.code).join(","))}`,
    status: "active",
    title: `${generatedAt.slice(0, 10)} 自动纠偏提醒`,
    generatedAt,
    tradeDate: dateContext.planTradeDate,
    planTradeDate: dateContext.planTradeDate,
    evidenceTradeDate: dateContext.evidenceTradeDate,
    sourceTradeDates: dateContext.sourceTradeDates,
    hasDateMismatch: dateContext.hasDateMismatch,
    source: "73wiki-correction-alerts",
    sourceTier: "local_brain",
    projectPath: ".",
    sourceFiles: [
      projectRelative(projectPath, cardsPath),
      projectRelative(projectPath, ifindPath),
      projectRelative(projectPath, watchlistPath),
    ],
    counts: {
      total: items.length,
      high: high.length,
      medium: medium.length,
      low: low.length,
      pushEligible: pushItems.length,
    },
    total: items.length,
    high: high.length,
    medium: medium.length,
    low: low.length,
    pushEligible: pushItems.length,
    summary: [
      dateContext.hasDateMismatch
        ? `计划交易日 ${dateContext.planTradeDate}；最新证据交易日 ${dateContext.evidenceTradeDate}。`
        : "",
      high.length > 0
        ? `高优先级纠偏提醒：${high.map((item) => `${item.name}(${item.code})`).join("，")}。`
        : pushItems.length > 0
          ? `已达到飞书提醒条件：${pushItems.map((item) => `${item.name}(${item.code})`).join("，")}。`
          : items.length > 0
            ? `已记录纠偏线索：${items.slice(0, 5).map((item) => `${item.name}(${item.code})`).join("，")}。`
            : "本次没有触发纠偏提醒。",
    ].filter(Boolean).join(" "),
    claim: "这是给 Codex/大鸟 的复核与提醒候选集，不是买卖建议。只有强证据项才进入飞书主动提醒。",
    tags: ["correction", "ifind", "feishu-ready", "review-first"],
    items,
    feishuReady: pushItems.slice(0, 5).map((item) => item.feishuReadyText),
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }
}

function markdownReport(record) {
  const lines = [
    `# ${record.tradeDate} 自动纠偏简报`,
    "",
    `生成时间: ${record.generatedAt}`,
    `计划交易日: ${record.planTradeDate || record.tradeDate}`,
    `证据交易日: ${record.evidenceTradeDate || record.tradeDate}`,
    `总数: ${record.counts.total} | 高: ${record.counts.high} | 中: ${record.counts.medium} | 低: ${record.counts.low} | 可推送: ${record.counts.pushEligible}`,
    "",
    "说明: 这里只生成 Codex/大鸟 的纠偏候选，不是买卖建议。只有强证据项才进入飞书推送候选。",
    "",
  ]

  if ((record.items ?? []).length === 0) {
    lines.push("## 结果")
    lines.push("")
    lines.push("- 本次没有触发纠偏候选。")
    lines.push("")
    return `${lines.join("\n")}\n`
  }

  for (const item of record.items) {
    lines.push(`## ${item.name} (${item.code})`)
    lines.push("")
    lines.push(`- 等级: ${item.severity}`)
    lines.push(`- 证据强度: ${item.evidenceGrade}`)
    lines.push(`- 分数: ${item.severityScore}`)
    lines.push(`- 是否可推送: ${item.pushEligible ? "是" : "否"}`)
    lines.push(`- 原因卡置信度: ${item.cardConfidence}`)
    lines.push(`- iFinD 近期新闻数: ${item.newsCount}`)
    lines.push(`- 最新涨跌幅: ${item.changePercent ?? "NA"}%`)
    lines.push(`- 官方风险命中: ${item.officialRiskHitCount}`)
    lines.push(`- 媒体风险命中: ${item.mediaRiskHitCount}`)
    lines.push(`- 作战室角色: ${item.watchlistRole || "NA"}`)
    lines.push(`- 触发条件: ${item.triggers.join(" | ")}`)
    lines.push(`- 原因卡判断: ${item.cardInferredReason || "无"}`)
    lines.push(`- iFinD 摘要: ${item.ifindSummary || "无"}`)
    if ((item.topNews ?? []).length > 0) lines.push(`- 重点新闻: ${item.topNews.join(" | ")}`)
    if ((item.riskHits ?? []).length > 0) {
      lines.push(`- 风险命中: ${item.riskHits.map((hit) => `${hit.authority}:${hit.date} ${hit.title}`).join(" | ")}`)
    }
    lines.push(`- 飞书文本: ${item.feishuReadyText}`)
    lines.push("")
  }

  return `${lines.join("\n")}\n`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const record = buildRecord({ ...options, projectPath })
  if (options.write) {
    const factPath = path.join(projectPath, FACT_PATH)
    const reportDir = path.join(projectPath, REPORT_ROOT)
    const stamp = idTimestamp()
    const reportPath = path.join(reportDir, `${stamp}-correction-alerts.json`)
    const latestPath = path.join(reportDir, "latest-correction-alerts.json")
    const reportMdPath = path.join(reportDir, `${stamp}-correction-alerts.md`)
    const latestMdPath = path.join(reportDir, "latest-correction-alerts.md")
    appendJsonl(factPath, record)
    writeJson(reportPath, record)
    writeJson(latestPath, record)
    writeText(reportMdPath, markdownReport(record))
    writeText(latestMdPath, markdownReport(record))
    return {
      dryRun: false,
      record,
      written: {
        facts: FACT_PATH,
        report: projectRelative(projectPath, reportPath),
        latest: projectRelative(projectPath, latestPath),
        markdown: projectRelative(projectPath, reportMdPath),
        latestMarkdown: projectRelative(projectPath, latestMdPath),
      },
    }
  }
  return { dryRun: true, record }
}

function printHelp() {
  console.log(`Usage:
  npm run correction:alerts -- --project C:\\wiki\\73神话 --write
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
    write: Boolean(args.write) || args._.includes("write"),
  })
  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(JSON.stringify({
    dryRun: result.dryRun,
    id: result.record.id,
    tradeDate: result.record.tradeDate,
    planTradeDate: result.record.planTradeDate,
    evidenceTradeDate: result.record.evidenceTradeDate,
    hasDateMismatch: result.record.hasDateMismatch,
    counts: result.record.counts,
    items: result.record.items.slice(0, 5).map((item) => ({
      code: item.code,
      name: item.name,
      severity: item.severity,
      evidenceGrade: item.evidenceGrade,
      severityScore: item.severityScore,
      pushEligible: item.pushEligible,
      triggers: item.triggers,
    })),
    written: result.written,
  }, null, 2))
}

main()
