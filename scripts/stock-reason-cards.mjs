#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const FACT_PATH = "data/facts/stock_reason_cards.jsonl"
const REPORT_ROOT = ".llm-wiki/stock-reason-cards"
const TEXT_EXTENSIONS = new Set([".md", ".txt"])
const MAX_FILE_BYTES = 1_500_000

const SOURCE_RULES = [
  [/raw\/每日复盘|raw\/02-每日复盘|复盘/i, 180, "daily-review"],
  [/raw\/交割单|raw\/01-交割单|持仓/i, 170, "position"],
  [/raw\/截图|飞书截图|user-screenshot|\.ocr\.md/i, 165, "user-screenshot"],
  [/raw\/05-研报新闻\/央媒|authority-policy|新闻联播|人民日报/i, 160, "authority-policy"],
  [/raw\/03-每日交易计划|竞价|盘前|早报|日韩早报|美股早报/i, 155, "preopen"],
  [/raw\/05-研报新闻\/公众号\/媒体号\/财联社|财联社|CLS|快讯/i, 148, "cls-news"],
  [/知识星球|淘股吧|开盘啦|韭研公社/i, 136, "market-community"],
  [/公众号/i, 134, "wechat-post"],
  [/同花顺热榜|同花顺|热榜/i, 128, "ths-signal"],
  [/东方财富|雪球|微博/i, 118, "social-flow"],
  [/wiki\/07-作战室|作战室/i, 115, "warroom"],
  [/wiki\/08-信息来源|RAW独立知识卡/i, 60, "knowledge-card"],
]

const THEME_KEYWORDS = [
  "AI算力", "英伟达", "PCB", "覆铜板", "光通信", "光模块", "半导体", "芯片",
  "商业航天", "军工", "军工电子", "航天", "航空", "大飞机", "低空经济",
  "机器人", "电力", "液冷", "有色", "稀有金属", "小金属", "钼", "铜",
  "黄金", "煤炭", "医药", "创新药", "消费电子", "固态电池", "数据中心",
  "PPE树脂", "六氟化钨", "特气", "MLCC",
  "核电", "并购重组", "涨价", "SpaceX", "Starlink",
]

const CATALYST_KEYWORDS = [
  "涨停", "封板", "连板", "一字", "回封", "炸板", "龙头", "核心", "主线",
  "中军", "补涨", "辨识度", "发酵", "催化", "公告", "订单", "中标",
  "合作", "并购", "重组", "涨价", "政策", "业绩", "超预期", "突破",
  "新高", "资金流入", "人气", "热股", "热点", "涨停原因", "原因",
]

const RISK_KEYWORDS = [
  "减持", "监管", "问询", "异动", "澄清", "跌停", "亏损", "退市", "处罚",
  "解禁", "负反馈", "高位", "补跌", "兑现", "杀跌", "后排", "跟风",
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

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/")
}

function projectRelative(projectPath, targetPath) {
  return toPosixPath(path.relative(path.resolve(projectPath), path.resolve(targetPath)))
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

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
}

function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function walkTextFiles(rootDir, limit = 30000) {
  const out = []
  function walk(dir) {
    if (out.length >= limit || !fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= limit) return
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (/node_modules|\.git|__pycache__|derived|^_规则$|^_待OCR$|^_处理失败$/i.test(entry.name)) continue
        walk(fullPath)
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const stat = fs.statSync(fullPath)
        if (stat.size > 0 && stat.size <= MAX_FILE_BYTES) out.push({ filePath: fullPath, stat })
      }
    }
  }
  walk(rootDir)
  return out
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean).map((value) => String(value)))]
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function firstTradeDate(...values) {
  for (const value of values) {
    const normalized = normalizeTradeDate(value)
    if (normalized) return normalized
  }
  return null
}

function resolveStockCardTradeDateContext(sources = {}) {
  const today = nowLocalTimestamp().slice(0, 10)
  const planTradeDate = firstTradeDate(
    sources.preopen?.tradeDate,
    sources.watchlist?.planTradeDate,
    sources.watchlist?.tradeDate,
    sources.coreTradeDate,
    today,
  ) ?? today
  const evidenceTradeDate = firstTradeDate(
    sources.ifindEnhance?.tradeDate,
    sources.limitReasons?.tradeDate,
    sources.tencent?.tradeDate,
    sources.watchlist?.evidenceTradeDate,
    sources.watchlist?.tradeDate,
    planTradeDate,
  ) ?? planTradeDate
  const sourceTradeDates = {
    preopen: normalizeTradeDate(sources.preopen?.tradeDate),
    marketWatchlistPlan: normalizeTradeDate(sources.watchlist?.planTradeDate ?? sources.watchlist?.tradeDate),
    marketWatchlistEvidence: normalizeTradeDate(sources.watchlist?.evidenceTradeDate),
    tencentMarket: normalizeTradeDate(sources.tencent?.tradeDate),
    ifindEnhance: normalizeTradeDate(sources.ifindEnhance?.tradeDate),
    limitUpReasons: normalizeTradeDate(sources.limitReasons?.tradeDate),
  }
  const distinct = [...new Set(Object.values(sourceTradeDates).filter(Boolean))]
  return {
    tradeDate: planTradeDate,
    planTradeDate,
    evidenceTradeDate,
    sourceTradeDates,
    hasDateMismatch: distinct.length > 1,
  }
}

function keywordHits(text, keywords) {
  return keywords.filter((word) => text.includes(word))
}

function sourceInfo(relativePath) {
  for (const [regex, weight, tag] of SOURCE_RULES) {
    if (regex.test(relativePath)) return { weight, tag }
  }
  return { weight: 30, tag: "text" }
}

function preferredNewsEvidence(evidence) {
  const priority = ["ifind-enhance", "cls-news", "preopen", "wechat-post", "market-community", "ths-signal", "social-flow", "news-flow"]
  for (const tag of priority) {
    const hit = evidence.find((item) => item.sourceTag === tag)
    if (hit) return hit
  }
  return null
}

function contextAround(content, index, size = 260) {
  return content
    .slice(Math.max(0, index - size), Math.min(content.length, index + size))
    .replace(/\s+/g, " ")
    .trim()
}

function cleanContext(context) {
  return String(context ?? "")
    .split(/##\s*关联标签|关联标签\s*[-：:]/)[0]
    .replace(/source_hash:[^\s]+/gi, "")
    .replace(/内容hash[:：][^\s]+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
}

function cleanName(value) {
  let name = String(value ?? "").trim()
  name = name.replace(/^.*(?:买入|看到|关注|观察|低吸|打板|半路|追高|加仓|减仓|清仓|切到|切换到|换到|卖出|持有)/, "")
  name = name.replace(/^[*＊\s]+/, "")
  return name
}

function nameQuality(value) {
  const name = cleanName(value)
  if (!name) return -Infinity
  let score = 0
  const hasCjk = /[\u4e00-\u9fff]/.test(name)
  const hasAscii = /[A-Za-z]/.test(name)
  const asciiOnly = /^[A-Za-z0-9.]+$/.test(name)
  if (hasCjk) score += 50
  if (hasAscii && hasCjk) score += 8
  if (asciiOnly) score -= 30
  if (name.length <= 2 && !hasCjk) score -= 40
  if (name.length >= 4) score += 4
  return score
}

function preferBetterName(current, candidate) {
  const currentName = cleanName(current)
  const candidateName = cleanName(candidate)
  if (!candidateName) return currentName
  if (!currentName) return candidateName
  return nameQuality(candidateName) > nameQuality(currentName) ? candidateName : currentName
}

function loadCoreStocks(projectPath, maxCards) {
  const preopen = readJsonMaybe(path.join(projectPath, ".llm-wiki/preopen/latest-preopen-intel.json"))
  const watchlist = readJsonMaybe(path.join(projectPath, ".llm-wiki/market-watchlist/latest-warroom-watchlist.json"))
  const tencentSnapshot = readJsonMaybe(path.join(projectPath, ".llm-wiki/tencent-market/latest-tencent-market.json"))
  const quoteByCode = new Map()
  for (const item of tencentSnapshot?.stockQuotes ?? []) {
    const code = String(item["证券代码"] ?? item.code ?? "").trim()
    const name = String(item["证券简称"] ?? item.name ?? "").trim()
    if (/^\d{6}$/.test(code) && name) quoteByCode.set(code, name)
  }
  const stocks = []
  for (const item of preopen?.core ?? []) {
    const code = String(item.code)
    const name = preferBetterName(quoteByCode.get(code), item.name ?? "")
    stocks.push({ code, name, rank: item.rank, role: item.role, source: "preopen" })
  }
  for (const item of watchlist?.tiers?.focus ?? []) {
    if (!stocks.some((stock) => stock.code === String(item.code))) {
      const code = String(item.code)
      const name = preferBetterName(quoteByCode.get(code), item.name ?? "")
      stocks.push({ code, name, rank: stocks.length + 1, role: item.role, source: "watchlist" })
    }
  }
  return {
    tradeDate: firstTradeDate(
      preopen?.tradeDate,
      watchlist?.planTradeDate,
      watchlist?.tradeDate,
      nowLocalTimestamp().slice(0, 10),
    ) ?? nowLocalTimestamp().slice(0, 10),
    stocks: stocks.slice(0, Number(maxCards)),
  }
}

function loadLimitReasonMap(projectPath) {
  const latest = readJsonMaybe(path.join(projectPath, ".llm-wiki/limit-up-reasons/latest-limit-up-reasons.json"))
  const map = new Map()
  for (const item of latest?.reasons ?? latest?.items ?? []) {
    if (item.code) map.set(String(item.code), item)
  }
  return map
}

function loadIfindEnhanceMap(projectPath) {
  const latest = readJsonMaybe(path.join(projectPath, ".llm-wiki/ifind-enhance/latest-ifind-enhance.json"))
  const map = new Map()
  for (const item of latest?.items ?? []) {
    if (item?.code) map.set(String(item.code), item)
  }
  return map
}

function buildIfindEvidence(projectPath, item) {
  if (!item) return null
  const newsTitles = (item.newsItems ?? [])
    .map((news) => String(news?.title ?? "").trim())
    .filter(Boolean)
    .slice(0, 2)
  const newsSnippets = (item.newsItems ?? [])
    .map((news) => String(news?.snippet ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 2)
  const excerptBits = unique([item.summary, ...newsTitles, ...newsSnippets]).slice(0, 4)
  if (excerptBits.length === 0) return null

  const evidenceText = excerptBits.join(" ")
  const newsCount = Number(item.newsCount ?? 0)
  const changePercent = Number(item.changePercent ?? 0)
  const confidence = Number(item.confidence ?? 0)
  const score = 180
    + Math.min(160, newsCount * 45)
    + Math.max(-40, Math.min(80, changePercent * 4))
    + Math.round(confidence * 80)

  return {
    file: projectRelative(projectPath, path.join(projectPath, ".llm-wiki/ifind-enhance/latest-ifind-enhance.json")),
    sourceTag: "ifind-enhance",
    score,
    themes: unique(item.themes ?? []),
    catalysts: keywordHits(evidenceText, CATALYST_KEYWORDS),
    risks: keywordHits(evidenceText, RISK_KEYWORDS),
    excerpt: evidenceText.slice(0, 320),
  }
}

function scanEvidence(projectPath, stocks, options = {}) {
  const roots = [
    path.join(projectPath, "raw"),
    path.join(projectPath, "wiki/07-作战室"),
    path.join(projectPath, "wiki/08-信息来源"),
  ]
  const files = roots.flatMap((root) => walkTextFiles(root, Number(options.fileLimit ?? 30000)))
  const byCode = new Map(stocks.map((stock) => [stock.code, []]))
  let filesScanned = 0

  for (const file of files) {
    const relativePath = projectRelative(projectPath, file.filePath)
    if (/\.html?$|\.csv$/i.test(relativePath)) continue
    if (/RAW全量沉淀索引|原始缓存|2024-标准化|derived/i.test(relativePath)) continue
    if (/raw\/(?:01-)?交割单/i.test(relativePath) && !/2026-06-12\/交割单\.md$/i.test(relativePath)) continue
    const info = sourceInfo(relativePath)
    const content = fs.readFileSync(file.filePath, "utf8")
    filesScanned += 1
    for (const stock of stocks) {
      const needles = unique([stock.code, stock.name]).filter((item) => item.length >= 2)
      for (const needle of needles) {
        let index = content.indexOf(needle)
        let seenInFile = 0
        while (index >= 0 && seenInFile < 4) {
          const context = cleanContext(contextAround(content, index))
          if (!/source_hash|内容hash|--weui-|data:image|<style/i.test(context)) {
            const themes = keywordHits(context, THEME_KEYWORDS)
            const catalysts = keywordHits(context, CATALYST_KEYWORDS)
            const risks = keywordHits(context, RISK_KEYWORDS)
            const directReason = /涨停原因|原因|催化|主线|热股|涨停|封板|连板|核心|龙头|SpaceX|公告|订单|涨价/.test(context)
            const score = info.weight + themes.length * 10 + catalysts.length * 18 - risks.length * 10 + (directReason ? 60 : 0)
            byCode.get(stock.code).push({
              file: relativePath,
              sourceTag: info.tag,
              score,
              themes,
              catalysts,
              risks,
              excerpt: context.slice(0, 320),
            })
          }
          seenInFile += 1
          index = content.indexOf(needle, index + needle.length)
        }
      }
    }
  }

  return {
    filesScanned,
    evidenceByCode: byCode,
  }
}

function weightedTop(evidence, field, limit) {
  const scores = new Map()
  for (const item of evidence) {
    for (const value of item[field] ?? []) {
      scores.set(value, (scores.get(value) ?? 0) + Number(item.score ?? 0))
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Number(limit))
    .map(([value]) => value)
}

function buildReasonText({ stock, limitReason, evidence }) {
  const topThemes = weightedTop(evidence, "themes", 8)
  const topCatalysts = weightedTop(evidence, "catalysts", 8)
  const topRisks = weightedTop(evidence, "risks", 6)
  const review = evidence.find((item) => item.sourceTag === "daily-review")
  const warroom = evidence.find((item) => item.sourceTag === "warroom")
  const news = preferredNewsEvidence(evidence)
  const objective = limitReason?.reason ? `客观涨停骨架：${limitReason.reason}` : "客观涨停骨架：未在当前涨停池找到。"
  const limitText = `${limitReason?.theme ?? ""} ${limitReason?.reason ?? ""} ${stock.name ?? ""}`

  let inference = ""
  const leadingThemes = topThemes.slice(0, 4)
  if (/电力|大唐发电/.test(limitText) || topThemes.includes("电力")) {
    inference = "市场解释偏向电力方向与个股监管/情绪修复逻辑，需结合持仓预案处理。"
  } else if (/军工|航天|航空|中航|宗申动力|航天发展/.test(limitText) || topThemes.slice(0, 2).some((theme) => ["商业航天", "航天", "军工电子", "军工", "航空", "大飞机", "低空经济"].includes(theme))) {
    inference = "市场解释偏向商业航天/军工电子事件催化与板块扩散。"
  } else if (/化学制品|PPE树脂|六氟化钨|特气|MLCC|圣泉集团|和远气体|宿迁联盛/.test(limitText) || leadingThemes.some((theme) => ["PPE树脂", "六氟化钨", "特气", "MLCC"].includes(theme))) {
    inference = "市场解释偏向半导体材料/AI硬件上游/涨价映射催化。"
  } else if (/小金属|工业金属|有色|钼|洛阳钼业|金钼股份|盛龙股份/.test(limitText) || leadingThemes.some((theme) => ["钼", "有色", "小金属", "稀有金属"].includes(theme))) {
    inference = "市场解释偏向资源链/稀有金属涨价或产业催化。"
  } else if (leadingThemes.some((theme) => ["商业航天", "航天", "军工电子", "军工", "航空", "大飞机", "低空经济"].includes(theme))) {
    inference = "市场解释偏向商业航天/军工电子事件催化与板块扩散。"
  } else {
    inference = "市场解释仍需同花顺、开盘啦或更多文本源确认。"
  }

  const reason = [
    objective,
    review ? `复盘证据：${review.excerpt}` : "",
    warroom ? `作战室证据：${warroom.excerpt}` : "",
    news ? `消息/热榜证据：${news.excerpt}` : "",
    inference,
  ].filter(Boolean)

  const confidence = Math.min(0.95, 0.25 + (limitReason ? 0.18 : 0) + Math.min(0.28, evidence.length * 0.025) + (review ? 0.16 : 0) + (news ? 0.12 : 0))

  return {
    objective,
    inferredReason: inference,
    reason,
    themes: topThemes,
    catalysts: topCatalysts,
    risks: topRisks,
    confidence: Number(confidence.toFixed(2)),
    validation: {
      nextDay: "9:15/9:20/9:25 竞价强弱，9:31-9:50 分时承接，板块内核心票和高标反馈。",
      fail: topRisks.length ? `若出现 ${topRisks.slice(0, 3).join("/")} 或同题材核心负反馈，则降级。` : "若无板块共振、无主动资金、冲高回落，则降级。",
      d3d5: "3日/5日后验证是否跑赢同题材、是否仍被热榜/涨停/消息源反复确认。",
    },
  }
}

function buildCards(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const generatedAt = nowLocalTimestamp()
  const { tradeDate: coreTradeDate, stocks } = loadCoreStocks(projectPath, Number(options.maxCards ?? 10))
  const preopenBatch = readJsonMaybe(path.join(projectPath, ".llm-wiki/preopen/latest-preopen-intel.json"))
  const watchlistBatch = readJsonMaybe(path.join(projectPath, ".llm-wiki/market-watchlist/latest-warroom-watchlist.json"))
  const tencentBatch = readJsonMaybe(path.join(projectPath, ".llm-wiki/tencent-market/latest-tencent-market.json"))
  const limitReasonBatch = readJsonMaybe(path.join(projectPath, ".llm-wiki/limit-up-reasons/latest-limit-up-reasons.json"))
  const ifindBatch = readJsonMaybe(path.join(projectPath, ".llm-wiki/ifind-enhance/latest-ifind-enhance.json"))
  const dateContext = resolveStockCardTradeDateContext({
    coreTradeDate,
    preopen: preopenBatch,
    watchlist: watchlistBatch,
    tencent: tencentBatch,
    ifindEnhance: ifindBatch,
    limitReasons: limitReasonBatch,
  })
  const tradeDate = dateContext.planTradeDate
  const limitReasonMap = loadLimitReasonMap(projectPath)
  const ifindEnhanceMap = loadIfindEnhanceMap(projectPath)
  const scanned = scanEvidence(projectPath, stocks, options)
  const cards = stocks.map((stock) => {
    const allEvidence = [...(scanned.evidenceByCode.get(stock.code) ?? [])]
    const ifindEvidence = buildIfindEvidence(projectPath, ifindEnhanceMap.get(stock.code))
    if (ifindEvidence) allEvidence.push(ifindEvidence)
    const evidence = allEvidence
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(options.evidenceLimit ?? 12))
    const reason = buildReasonText({ stock, limitReason: limitReasonMap.get(stock.code), evidence })
    return {
      schema: "73wiki-stock-reason-card-v1",
      id: `srcard_${tradeDate.replace(/-/g, "")}_${stock.code}_${shortHash(JSON.stringify(reason.reason))}`,
      status: "active",
      generatedAt,
      tradeDate,
      planTradeDate: dateContext.planTradeDate,
      evidenceTradeDate: dateContext.evidenceTradeDate,
      code: stock.code,
      name: stock.name,
      rank: stock.rank,
      role: stock.role,
      source: "73wiki-stock-reason-cards",
      sourceTier: "raw_derived",
      objectiveLimitUp: limitReasonMap.get(stock.code) ?? null,
      licensedEnhancer: ifindEnhanceMap.get(stock.code) ?? null,
      themes: reason.themes,
      catalysts: reason.catalysts,
      risks: reason.risks,
      inferredReason: reason.inferredReason,
      reason: reason.reason,
      confidence: reason.confidence,
      evidence,
      validation: reason.validation,
      claim: "本卡片由 RAW/WIKI/涨停池证据提炼，仍需盘中竞价、分时、板块强度验证；不是自动买入建议。",
    }
  })

  return {
    schema: "73wiki-stock-reason-cards-batch-v1",
    id: `stock_reason_cards_${tradeDate.replace(/-/g, "")}_${idTimestamp()}_${shortHash(cards.map((item) => item.code).join(","))}`,
    status: "active",
    generatedAt,
    tradeDate,
    planTradeDate: dateContext.planTradeDate,
    evidenceTradeDate: dateContext.evidenceTradeDate,
    sourceTradeDates: dateContext.sourceTradeDates,
    hasDateMismatch: dateContext.hasDateMismatch,
    source: "73wiki-stock-reason-cards",
    projectPath,
    filesScanned: scanned.filesScanned,
    cardCount: cards.length,
    cards,
    symbols: cards.map((item) => item.code),
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }
}

function markdownReport(record) {
  const outputLines = [
    `# ${record.tradeDate} 核心票涨停原因卡`,
    "",
    `生成时间: ${record.generatedAt}`,
    `计划交易日: ${record.planTradeDate || record.tradeDate}`,
    `证据交易日: ${record.evidenceTradeDate || record.tradeDate}`,
    `扫描文件: ${record.filesScanned}`,
    `日期状态: ${record.hasDateMismatch ? "计划与证据日期不一致" : "一致"}`,
    "",
  ]
  for (const card of record.cards) {
    outputLines.push(`## ${card.rank}. ${card.name || card.code} (${card.code})`)
    outputLines.push(`- 角色: ${card.role || "-"}`)
    outputLines.push(`- 置信度: ${card.confidence}`)
    outputLines.push(`- 题材: ${card.themes.join("、") || "未确认"}`)
    outputLines.push(`- 催化词: ${card.catalysts.join("、") || "未确认"}`)
    outputLines.push(`- 风险词: ${card.risks.join("、") || "无"}`)
    outputLines.push(`- 归因: ${card.inferredReason}`)
    outputLines.push(`- 客观涨停原因: ${card.objectiveLimitUp?.reason ?? "当前涨停池未找到"}`)
    outputLines.push(`- 计划交易日: ${card.planTradeDate || card.tradeDate}`)
    outputLines.push(`- 证据交易日: ${card.evidenceTradeDate || card.tradeDate}`)
    outputLines.push("- 证据链:")
    for (const item of card.evidence.slice(0, 5)) {
      outputLines.push(`  - ${item.sourceTag} / ${item.file}: ${item.excerpt}`)
    }
    outputLines.push(`- 次日验证: ${card.validation.nextDay}`)
    outputLines.push(`- 失败条件: ${card.validation.fail}`)
    outputLines.push(`- 3/5日验证: ${card.validation.d3d5}`)
    outputLines.push("")
  }
  return `${outputLines.join("\n")}\n`

  const lines = [
    `# ${record.tradeDate} 核心票涨停原因卡`,
    "",
    `生成时间：${record.generatedAt}`,
    `扫描文件：${record.filesScanned}`,
    "",
  ]
  for (const card of record.cards) {
    lines.push(`## ${card.rank}. ${card.name || card.code}（${card.code}）`)
    lines.push(`- 角色：${card.role}`)
    lines.push(`- 置信度：${card.confidence}`)
    lines.push(`- 题材：${card.themes.join("、") || "未确认"}`)
    lines.push(`- 催化词：${card.catalysts.join("、") || "未确认"}`)
    lines.push(`- 风险词：${card.risks.join("、") || "无"}`)
    lines.push(`- 归因：${card.inferredReason}`)
    lines.push(`- 客观数据：${card.objectiveLimitUp?.reason ?? "当前涨停池未找到"}`)
    lines.push("- 证据链：")
    for (const item of card.evidence.slice(0, 5)) {
      lines.push(`  - ${item.sourceTag} / ${item.file}：${item.excerpt}`)
    }
    lines.push(`- 次日验证：${card.validation.nextDay}`)
    lines.push(`- 失败条件：${card.validation.fail}`)
    lines.push(`- 3/5日验证：${card.validation.d3d5}`)
    lines.push("")
  }
  return `${lines.join("\n")}\n`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const record = buildCards({ ...options, projectPath })
  if (options.write) {
    const factPath = path.join(projectPath, FACT_PATH)
    const reportDir = path.join(projectPath, REPORT_ROOT)
    const jsonPath = path.join(reportDir, `${idTimestamp()}-stock-reason-cards.json`)
    const mdPath = path.join(reportDir, `${idTimestamp()}-stock-reason-cards.md`)
    const latestJson = path.join(reportDir, "latest-stock-reason-cards.json")
    const latestMd = path.join(reportDir, "latest-stock-reason-cards.md")
    appendJsonl(factPath, record)
    writeJson(jsonPath, record)
    writeJson(latestJson, record)
    writeText(mdPath, markdownReport(record))
    writeText(latestMd, markdownReport(record))
    return {
      dryRun: false,
      record,
      written: {
        facts: FACT_PATH,
        report: projectRelative(projectPath, jsonPath),
        markdown: projectRelative(projectPath, mdPath),
        latest: projectRelative(projectPath, latestJson),
      },
    }
  }
  return { dryRun: true, record }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`Usage:
  npm run stock:reasons -- C:\\wiki\\73神话 10 write
  npm run stock:reasons -- --project C:\\wiki\\73神话 --max-cards 10 --write
`)
    return
  }
  const result = run({
    projectPath: args.project ?? args._[0],
    maxCards: args["max-cards"] ?? args._[1] ?? 10,
    fileLimit: args["file-limit"] ?? 30000,
    evidenceLimit: args["evidence-limit"] ?? 12,
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
    filesScanned: result.record.filesScanned,
    cards: result.record.cards.map((card) => ({
      rank: card.rank,
      code: card.code,
      name: card.name,
      confidence: card.confidence,
      themes: card.themes.slice(0, 5),
      catalysts: card.catalysts.slice(0, 5),
      inferredReason: card.inferredReason,
    })),
    written: result.written,
  }, null, 2))
}

main()
