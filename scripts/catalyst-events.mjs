#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { mergeHotFiles, readHotFiles } from "./raw-hot-files.mjs"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const FACT_PATH = "data/facts/catalyst_events.jsonl"
const REPORT_ROOT = ".llm-wiki/catalyst-events"
const TEXT_EXTENSIONS = new Set([".md", ".txt"])
const MAX_FILE_BYTES = 1_200_000

const SOURCE_RULES = [
  [/raw\/截图|飞书截图|user-screenshot|\.ocr\.md/i, "user-screenshot", "S2", 92],
  [/raw\/05-研报新闻\/央媒|authority-policy|新闻联播|人民日报/i, "authority-policy", "S1", 88],
  [/raw\/05-研报新闻\/财联社|财联社/i, "cls-news", "S2", 76],
  [/巨潮|上交所|深交所|北交所|公告|监管函|问询函|互动易/i, "official-disclosure", "S1", 90],
  [/raw\/03-每日交易计划|早报|盘前|日韩早报|美股早报/i, "preopen-briefing", "S2", 78],
  [/知识星球|淘股吧|开盘啦|韭研公社/i, "market-community", "S3", 68],
  [/公众号/i, "wechat-post", "S3", 70],
  [/同花顺热榜|同花顺|热榜/i, "ths-signal", "S3", 66],
  [/东方财富|通达信|雪球|微博/i, "social-flow", "S3", 62],
  [/raw\/02-每日复盘|raw\/每日复盘|复盘/i, "daily-review", "S2", 72],
]

const THEME_KEYWORDS = [
  "AI算力", "人工智能", "AI", "英伟达", "PCB", "覆铜板", "光通信", "光模块", "CPO",
  "半导体", "芯片", "存储", "DRAM", "NAND", "商业航天", "卫星", "军工", "军工电子",
  "航天", "航空", "大飞机", "低空经济", "机器人", "电力", "核电", "液冷", "数据中心",
  "有色", "稀土", "小金属", "钼", "铜", "黄金", "煤炭", "焦炭", "化工", "新材料",
  "医药", "创新药", "消费电子", "固态电池", "新能源", "储能", "光伏", "航运", "油气",
  "金融", "证券", "稳定币", "金融科技", "国企改革", "并购重组", "一带一路", "西部大开发",
  "数字经济", "信创", "网络安全", "农业", "种业", "消费", "地产",
]

const BROAD_THEMES = new Set([
  "AI",
  "人工智能",
  "金融",
  "消费",
  "新能源",
  "新材料",
  "数字经济",
])

const EVENT_RULES = [
  [/涨价|提价|价格上调|供给收缩|停产|缺货|库存低/i, "price-up", 24],
  [/公告|披露|中标|订单|合同|合作|签署|通过|注册|获批|批复/i, "company-news", 22],
  [/并购|重组|收购|注入|借壳|股权转让|控制权/i, "restructuring", 28],
  [/政策|会议|国务院|发改委|工信部|财政部|商务部|央行|证监会|印发|发布|实施|推进|支持|规划|行动方案|意见|新质生产力/i, "policy", 20],
  [/涨停|封板|连板|一字板|回封|炸板|龙头|主线|强势|热股|人气/i, "market-confirmed", 18],
  [/美股|英伟达|特斯拉|SpaceX|Starlink|日韩|海外|美伊|霍尔木兹/i, "oversea-mapping", 18],
  [/监管|问询|异动|澄清|减持|解禁|处罚|退市|亏损/i, "risk", -18],
]

const LOW_VALUE_RULES = [
  { regex: /\u70ed\u699c\u5348\u95f4|\u70ed\u699c\u6536\u76d8|\u70ed\u80a1\u699c-\u4eba\u5de5\u6574\u7406|\u5f00\u76d8\u70ed\u699c\u524d50|\u540c\u82b1\u987a\u70ed\u699c/i, tag: "hotlist-snapshot", scorePenalty: 24, blockUpgrade: true },
  { regex: /\u5468\u56de\u987e|\u5468\u62a5|\u5468\u5ea6\u56de\u987e|\u5468\u603b\u7ed3/i, tag: "weekly-recap", scorePenalty: 32, blockUpgrade: true },
  { regex: /\u73a9\u8f6cETF|QDII-ETF|\bETF\b/i, tag: "etf-generic", scorePenalty: 28, blockUpgrade: true },
]

const SUMMARY_SOURCE_REGEX = /(\u5927\u4f6c\u6301\u4ed3\u8ddf\u8e2a|\u70b9\u91d1\u4e92\u52a8\u6613|\u7535\u62a5\u89e3\u8bfb|2\.1\s*\u6838\u5fc3\u4e2a\u80a1\u8868\u73b0|\u6838\u5fc3\u4e2a\u80a1\u8868\u73b0)/i
const COLUMN_SOURCE_REGEX = /(\u76d8\u4e2d\u5b9d|\u4e5d\u70b9\u7279\u4f9b|\u98ce\u53e3\u7814\u62a5|\u7814\u9009|\u516c\u544a\u5168\u77e5\u9053|\u673a\u6784\u8c03\u7814)/i
const GENERIC_LIMITUP_THEMES = new Set([
  "\u4e13\u4e1a\u5de5\u7a0b",
  "\u901a\u7528\u8bbe\u5907",
  "\u5176\u4ed6\u7535\u5b50",
  "\u7535\u5b50\u5316\u5b66",
  "\u519c\u4ea7\u54c1\u52a0\u5de5",
  "\u5143\u4ef6",
  "\u5c0f\u91d1\u5c5e",
  "\u7535\u7f51\u8bbe\u5907",
])

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["write", "help"].includes(key)) {
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

function printHelp() {
  console.log(`Usage:
  npm run catalyst:events -- --project C:\\wiki\\73神话 --since-days 3 --max-events 120 --write
  npm run catalyst:events -- C:\\wiki\\73神话 3 120 write

This builds event-first facts:
  catalyst_events: what happened
  stock_event_links: which stocks the event may affect
`)
}

function nowLocalTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function dateOnly(date = new Date()) {
  return nowLocalTimestamp(date).slice(0, 10)
}

function nextTradingDate(date = new Date()) {
  const out = new Date(date)
  out.setDate(out.getDate() + 1)
  while (out.getDay() === 0 || out.getDay() === 6) out.setDate(out.getDate() + 1)
  return dateOnly(out)
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00`)
  date.setDate(date.getDate() + Number(days))
  return dateOnly(date)
}

function idTimestamp(date = new Date()) {
  return nowLocalTimestamp(date).replace(/[-: ]/g, "")
}

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12)
}

function contentHash(value) {
  return createHash("sha256").update(String(value)).digest("hex")
}

function resolveProjectPath(projectPath) {
  return path.resolve(projectPath ?? DEFAULT_PROJECT_PATH)
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

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
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

function walkTextFiles(rootDir, limit = 30000) {
  const out = []
  function walk(dir) {
    if (out.length >= limit || !fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= limit) return
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (/node_modules|\.git|derived|__pycache__|^_规则$|^_待OCR$|^_处理失败$/i.test(entry.name)) continue
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
  return [...new Set((values ?? []).filter(Boolean).map((item) => String(item).trim()).filter(Boolean))]
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function maxTradeDate(values) {
  return (values ?? [])
    .map((value) => normalizeTradeDate(value))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .at(-1) ?? null
}

function resolveCatalystTradeDateContext({ tradeDate, events }) {
  const planTradeDate = normalizeTradeDate(tradeDate) ?? dateOnly()
  const preopenDates = (events ?? [])
    .filter((event) => event.source === "preopen-briefing")
    .map((event) => event.eventTime ?? event.tradeDate)
  const evidenceDates = (events ?? [])
    .filter((event) => event.source !== "preopen-briefing")
    .map((event) => event.eventTime ?? event.tradeDate)
  const sourceTradeDates = {
    requestedTradeDate: planTradeDate,
    preopenBriefing: maxTradeDate(preopenDates),
    evidence: maxTradeDate(evidenceDates),
  }
  const evidenceTradeDate = sourceTradeDates.evidence ?? sourceTradeDates.preopenBriefing ?? planTradeDate
  const distinct = [...new Set(Object.values(sourceTradeDates).filter(Boolean))]
  return {
    tradeDate: planTradeDate,
    planTradeDate,
    evidenceTradeDate,
    sourceTradeDates,
    hasDateMismatch: distinct.length > 1,
  }
}

function isWeakName(name) {
  const text = String(name ?? "").trim()
  return !text
    || /^[A-Z]{1,4}$/.test(text)
    || /^[A-Za-z]{1,3}\d?$/.test(text)
    || /^[*#._-]{1,6}$/.test(text)
}

function keywordHits(text, keywords) {
  return unique(keywords.filter((word) => String(text).includes(word)))
}

function sourceInfo(relativePath, content) {
  for (const [regex, tag, tier, baseScore] of SOURCE_RULES) {
    if (regex.test(relativePath) || regex.test(content.slice(0, 1000))) return { tag, tier, baseScore }
  }
  return { tag: "raw", tier: "S3", baseScore: 45 }
}

function downgradeInfo(relativePath, block = "", srcTag = "") {
  const basis = `${relativePath}\n${block}\n${srcTag}`
  const hits = LOW_VALUE_RULES.filter((rule) => rule.regex.test(basis))
  if (hits.length === 0) return null
  return {
    tags: unique(hits.map((rule) => rule.tag)),
    scorePenalty: hits.reduce((sum, rule) => sum + rule.scorePenalty, 0),
    blockUpgrade: hits.some((rule) => rule.blockUpgrade),
  }
}

function isSummaryLikeSource(relativePath, title = "", srcTag = "", block = "") {
  return SUMMARY_SOURCE_REGEX.test(`${relativePath}\n${title}\n${srcTag}\n${block.slice(0, 500)}`)
}

function isColumnLikeSource(relativePath, title = "", srcTag = "", block = "") {
  return COLUMN_SOURCE_REGEX.test(`${relativePath}\n${title}\n${srcTag}\n${block.slice(0, 500)}`)
}

function hasRiskSignal(text = "") {
  return /(\u98ce\u9669|\u975e\u7406\u6027\u7092\u4f5c|\u51cf\u6301|\u8be2\u4ef7\u8f6c\u8ba9|\u7acb\u6848\u8c03\u67e5|\u8bc1\u76d1\u4f1a\u7acb\u6848|\u76d1\u7ba1|\u95ee\u8be2|\u5f02\u52a8|\u6f84\u6e05|\u89e3\u7981|\u5904\u7f5a|\u9000\u5e02|\u4e8f\u635f)/.test(String(text))
}

function eventTypes(text) {
  const hits = []
  let score = 0
  for (const [regex, type, weight] of EVENT_RULES) {
    if (regex.test(text)) {
      hits.push(type)
      score += weight
    }
  }
  return { types: unique(hits), score }
}

function extractDate(value) {
  const match = String(value ?? "").match(/20\d{2}[-./]\d{1,2}[-./]\d{1,2}/)
  if (!match) return null
  const [y, m, d] = match[0].split(/[-./]/)
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

function isWeakTitle(value) {
  const text = String(value ?? "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim()
  if (!text) return true
  if (/^(?:图片|圖|图|image|img|screenshot|截图)\s*[\d一二三四五六七八九十-]*$/i.test(text)) return true
  if (/^(?:ocr|原图|附件|文件)\s*[\d一二三四五六七八九十-]*$/i.test(text)) return true
  return false
}

function sanitizeBlockText(text) {
  return String(text ?? "")
    .replace(/\u60f3\u5feb\u4eba\u4e00\u6b65[\s\S]*$/m, "")
    .replace(/# \*\*618[\s\S]*$/m, "")
    .split(/\r?\n/)
    .filter((line) => !/^\u6839\u636e\u60a8\u63d0\u4f9b\u7684\u56fe\u7247\u5185\u5bb9/.test(line.trim()))
    .join("\n")
}

function compactTitle(text, fallback) {
  const lines = sanitizeBlockText(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const heading = lines
    .filter((line) => /^#{1,3}\s+/.test(line))
    .map((line) => line.replace(/^#{1,3}\s+/, "").trim())
    .find((line) => line.length >= 4 && !isWeakTitle(line))
  if (heading) return heading.slice(0, 80)
  const firstLine = lines.find((line) => line.length >= 8 && !isWeakTitle(line))
  const fallbackTitle = !isWeakTitle(fallback) ? fallback : ""
  return (firstLine || fallbackTitle || "未命名事件").slice(0, 80)
}

function isTableLikeBlock(text) {
  const value = String(text ?? "")
  const pipeCount = (value.match(/|/g) ?? []).length
  const lineCount = value.split(/\r?\n/).length
  return pipeCount >= 12 || (pipeCount >= 6 && lineCount >= 4)
}

function isGenericReviewBlock(text, title = "") {
  const value = `${title}\n${text}`
  return /(\u5927\u76d8\u73af\u5883\u8bc4\u4f30|\u4e3b\u529b\u8d44\u91d1\u51c0\u6d41\u5165|TOP10|\u8fde\u677f\u5929\u68af|\u70ed\u699c|\u5348\u95f4|\u6536\u76d8|\u699c\u5355)/i.test(value)
}

function splitChunks(content) {
  const blocks = String(content ?? "")
    .split(/\n(?=#{1,3}\s+)|\n-{3,}\n/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 30)
    .filter((item) => !/^(?:本地图|原图|assets\/|https?:\/\/\S+\.(?:png|jpg|jpeg|webp))/im.test(item))
    .filter((item) => !isTableLikeBlock(item) || /(\u4e70\u5165|\u5356\u51fa|\u6301\u4ed3|\u516c\u544a|\u8ba2\u5355|\u5408\u4f5c|\u5e76\u8d2d\u91cd\u7ec4|\u6da8\u505c\u539f\u56e0)/.test(item))
    .filter((item) => !isGenericReviewBlock(item) || /(\u4e70\u5165|\u5356\u51fa|\u6301\u4ed3|\u5e76\u8d2d\u91cd\u7ec4|\u516c\u544a|\u8ba2\u5355|\u5408\u4f5c|\u6da8\u505c\u539f\u56e0)/.test(item))
  if (blocks.length > 0) return blocks.slice(0, 80)
  return [String(content ?? "").slice(0, 2500)]
}

function codeMatches(content) {
  const out = []
  const regex = /(?<!\d)(?:SH|SZ)?((?:00[0-3]\d{3}|30[01]\d{3}|60[0135]\d{3}|68[89]\d{3}|83\d{4}|87\d{4}|92\d{4}))(?:\.(?:SH|SZ))?(?!\d)/gi
  for (const match of String(content ?? "").matchAll(regex)) {
    const code = match[1]
    if (/^0{4,}|^(\d)\1{5}$/.test(code)) continue
    out.push({ code, index: match.index ?? 0 })
  }
  return out
}

function extractName(content, code, index) {
  const near = String(content ?? "").slice(Math.max(0, index - 40), Math.min(String(content ?? "").length, index + 70))
  const before = near.match(new RegExp(`([\\u4e00-\\u9fa5A-Za-z*]{2,12})[（(]?\\s*${code}(?:\\.(?:SH|SZ))?`, "i"))?.[1]
  if (before && !/^(股票|代码|名称|证券|今日|明日|持仓|来源)$/.test(before)) return before.replace(/^.*[-:：]/, "")
  const after = near.match(new RegExp(`${code}(?:\\.(?:SH|SZ))?[）)]?[\\s|,，、:：-]*([\\u4e00-\\u9fa5A-Za-z*]{2,12})`, "i"))?.[1]
  if (after && !/^(最新|行情|涨跌|成交|来源|题材|概念|公告|消息)$/.test(after)) return after
  return ""
}

function hasStrongCodeContext(content, index) {
  const near = String(content ?? "").slice(Math.max(0, index - 80), Math.min(String(content ?? "").length, index + 160))
  return /(\u516c\u544a|\u4e2d\u6807|\u8ba2\u5355|\u5408\u4f5c|\u7b7e\u7ea6|\u5e76\u8d2d|\u91cd\u7ec4|\u6ce8\u5165|\u505c\u4ea7|\u6da8\u4ef7|\u4e92\u52a8\u6613|\u6269\u4ea7|\u4f9b\u5e94|\u5ba2\u6237|\u6da8\u505c\u539f\u56e0|\u50ac\u5316)/.test(near)
}

function relationThemes(text) {
  return keywordHits(text, THEME_KEYWORDS)
}

function specificThemes(themes) {
  return unique(themes).filter((theme) => !BROAD_THEMES.has(theme))
}

function hasStrongStockContext(sourceTags = []) {
  return (sourceTags ?? []).some((tag) => /^(watchlist:focus|watchlist:warroom|preopen|limit-up-reason|reason-card|archive-skeleton)/.test(String(tag ?? "")))
}

function hasWeakOnlyStockContext(sourceTags = []) {
  const tags = (sourceTags ?? []).map((tag) => String(tag ?? "")).filter(Boolean)
  if (tags.length === 0) return true
  return tags.every((tag) => /^(watchlist:normal|akshare:|hotlist:)/.test(tag))
}

function linkEligible({ directName, themeMatches, stock }) {
  if (directName) return true
  if ((themeMatches ?? []).length >= 2) return true
  if ((themeMatches ?? []).length >= 1 && hasStrongStockContext(stock?.sourceTags ?? [])) return true
  return false
}

function relationStrength({ sourceInfo: src, themes, eventScore, direct }) {
  let score = src.baseScore + Math.min(themes.length * 8, 40) + eventScore
  if (direct) score += 32
  if (src.tier === "S1") score += 14
  if (src.tag === "user-screenshot") score += 18
  return Math.max(0, Math.min(100, score))
}

function buildStockUniverse(projectPath) {
  const byCode = new Map()
  const add = (code, name, sourceTag, themes = []) => {
    const cleanCode = String(code ?? "").replace(/\.(SH|SZ|BJ)$/i, "")
    if (!/^\d{6}$/.test(cleanCode)) return
    const old = byCode.get(cleanCode) ?? { code: cleanCode, name: "", sourceTags: [], themes: [] }
    if ((isWeakName(old.name) || !old.name) && !isWeakName(name)) old.name = String(name)
    old.sourceTags.push(sourceTag)
    old.themes.push(...themes)
    old.sourceTags = unique(old.sourceTags)
    old.themes = unique(old.themes)
    byCode.set(cleanCode, old)
  }

  const watchlist = readJsonMaybe(path.join(projectPath, ".llm-wiki/market-watchlist/latest-warroom-watchlist.json"))
  for (const section of ["focus", "warroom", "normal"]) {
    for (const item of watchlist?.tiers?.[section] ?? []) add(item.code, item.name, `watchlist:${section}`, [])
  }

  const preopen = readJsonMaybe(path.join(projectPath, ".llm-wiki/preopen/latest-preopen-intel.json"))
  for (const item of preopen?.core ?? []) add(item.code, item.name, "preopen", [])

  const reasons = readJsonMaybe(path.join(projectPath, ".llm-wiki/limit-up-reasons/latest-limit-up-reasons.json"))
  for (const item of reasons?.reasons ?? []) {
    add(item.code, item.name, "limit-up-reason", [
      ...(item.concepts ?? []),
      ...(item.theme ? String(item.theme).split(/[.、，,；;\s]+/) : []),
    ])
  }

  const cards = readJsonMaybe(path.join(projectPath, ".llm-wiki/stock-reason-cards/latest-stock-reason-cards.json"))
  for (const card of cards?.cards ?? []) add(card.code, card.name, "reason-card", [])

  return byCode
}

function sourceFiles(projectPath, sinceDays, sourceLimit, tradeDate) {
  const rawRoot = path.join(projectPath, "raw")
  const cutoff = Date.now() - Number(sinceDays) * 24 * 60 * 60 * 1000
  const cutoffDate = addDays(tradeDate, -Number(sinceDays))
  return walkTextFiles(rawRoot)
    .map(({ filePath, stat }) => ({ filePath, stat, relativePath: projectRelative(projectPath, filePath), fileDate: extractDate(filePath) }))
    .filter((item) => {
      if (/raw\/07-系统脚本|2024-标准化|derived/i.test(item.relativePath)) return false
      if (item.fileDate) return item.fileDate >= cutoffDate && item.fileDate <= tradeDate
      return item.stat.mtimeMs >= cutoff
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, Number(sourceLimit))
}

function sourceFilesWithHot(projectPath, sinceDays, sourceLimit, tradeDate) {
  const standardFiles = sourceFiles(projectPath, sinceDays, sourceLimit, tradeDate)
  const hotFiles = readHotFiles(projectPath, {
    allowedExtensions: TEXT_EXTENSIONS,
    maxFileBytes: MAX_FILE_BYTES,
  })
  return mergeHotFiles(standardFiles, hotFiles, Number(sourceLimit))
}

function buildEvent({ projectPath, relativePath, block, src, tradeDate }) {
  const cleanBlock = sanitizeBlockText(block)
  const themes = relationThemes(`${relativePath}\n${cleanBlock}`)
  const eventHit = eventTypes(cleanBlock)
  if (themes.length === 0 && eventHit.types.length === 0) return null
  if (eventHit.types.length === 0 && src.tag === "raw") return null
  const downgrade = downgradeInfo(relativePath, cleanBlock, src.tag)
  const title = compactTitle(cleanBlock, path.basename(relativePath))
  const summaryLike = isSummaryLikeSource(relativePath, title, src.tag, cleanBlock)
  const columnLike = isColumnLikeSource(relativePath, title, src.tag, cleanBlock)
  const reviewTable = src.tag === "daily-review" && isTableLikeBlock(cleanBlock)
  const genericReview = src.tag === "daily-review" && isGenericReviewBlock(cleanBlock, title)
  const hasRisk = eventHit.types.includes("risk") || hasRiskSignal(`${title}\n${cleanBlock}`)
  const eventType = eventHit.types[0] ?? (themes.length > 0 ? "theme-signal" : "raw-signal")
  let score = relationStrength({ sourceInfo: src, themes, eventScore: eventHit.score, direct: false })
  if (downgrade) score = Math.max(0, score - downgrade.scorePenalty)
  if (summaryLike) score = Math.max(0, score - 28)
  if (columnLike) score = Math.max(0, score - 12)
  if (reviewTable) score = Math.max(0, score - 38)
  if (genericReview) score = Math.max(0, score - 24)
  if (hasRisk) score = Math.max(0, score - 22)
  return {
    id: `cat_${tradeDate.replace(/-/g, "")}_${shortHash(`${relativePath}|${title}|${block.slice(0, 800)}`)}`,
    generatedAt: nowLocalTimestamp(),
    eventTime: extractDate(relativePath) ?? tradeDate,
    tradeDate,
    title,
    eventType,
    source: src.tag,
    sourceTier: src.tier,
    sourcePath: relativePath,
    sourceUrl: cleanBlock.match(/https?:\/\/[^\s)]+/)?.[0] ?? "",
    themes,
    keywords: unique([...eventHit.types, ...keywordHits(cleanBlock, THEME_KEYWORDS)]).slice(0, 20),
    catalystScore: score,
    summary: cleanBlock.replace(/\s+/g, " ").slice(0, 600),
    status: hasRisk || eventType === "risk" ? "risk" : "active",
    raw: {
      contentHash: contentHash(cleanBlock),
      sourceFile: relativePath,
      excerpt: cleanBlock.slice(0, 1200),
      projectPath: projectRelative(projectPath, projectPath) || ".",
      hasRisk,
      lowValueTags: unique([...(downgrade?.tags ?? []), ...(summaryLike ? ["summary-brief"] : []), ...(columnLike ? ["column-brief"] : []), ...(reviewTable ? ["daily-review-table"] : []), ...(genericReview ? ["daily-review-generic"] : [])]),
      upgradeEligible: downgrade || summaryLike || reviewTable || genericReview ? false : true,
    },
  }
}

function buildLinks({ event, block, stockUniverse }) {
  const links = new Map()
  for (const match of codeMatches(block)) {
    const known = stockUniverse.get(match.code)
    const extracted = extractName(block, match.code, match.index)
    const name = !isWeakName(extracted) ? extracted : known?.name || ""
    const strongCodeContext = hasStrongCodeContext(block, match.index)
    if (!known && !name) continue
    if (event.raw?.upgradeEligible === false && !strongCodeContext) continue
    const themes = unique([...event.themes, ...(known?.themes ?? [])])
    links.set(match.code, {
      eventId: event.id,
      code: match.code,
      name,
      linkType: "direct_mention",
      relationStrength: Math.min(100, event.catalystScore + 20 + (strongCodeContext ? 8 : -10)),
      reasons: ["????????????", event.title],
      themes,
      sourceTags: [event.source],
      evidenceFiles: [event.sourcePath],
      status: event.status === "risk" ? "risk" : "candidate",
      raw: { matchIndex: match.index, strongCodeContext, lowValueTags: event.raw?.lowValueTags ?? [], upgradeEligible: event.raw?.upgradeEligible !== false },
    })
  }

  for (const stock of stockUniverse.values()) {

    if (isWeakName(stock.name) || stock.name.length < 2) continue
    const directName = block.includes(stock.name)
    const themeMatches = specificThemes(event.themes.filter((theme) => stock.themes.includes(theme)))
    if (themeMatches.length === 0 && !directName) continue
    if (!linkEligible({ directName, themeMatches, stock })) continue
    const weakOnly = hasWeakOnlyStockContext(stock.sourceTags ?? [])
    if (!directName && weakOnly && themeMatches.length < 2) continue
    const old = links.get(stock.code)
    const strength = Math.min(100, event.catalystScore + (directName ? 18 : 0) + themeMatches.length * 10 + (hasStrongStockContext(stock.sourceTags ?? []) ? 6 : 0) - (weakOnly && !directName ? 8 : 0))
    links.set(stock.code, {
      eventId: event.id,
      code: stock.code,
      name: old?.name || stock.name,
      linkType: directName ? "name_mention" : "theme_match",
      relationStrength: Math.max(old?.relationStrength ?? 0, strength),
      reasons: unique([...(old?.reasons ?? []), directName ? "??????????" : ("???????" + themeMatches.join("?")), event.title]),
      themes: unique([...(old?.themes ?? []), ...themeMatches, ...(directName ? event.themes.slice(0, 2) : [])]),
      sourceTags: unique([...(old?.sourceTags ?? []), event.source, ...(stock.sourceTags ?? [])]),
      evidenceFiles: unique([...(old?.evidenceFiles ?? []), event.sourcePath]),
      status: event.status === "risk" ? "risk" : "candidate",
      raw: { stockThemes: stock.themes, stockSourceTags: stock.sourceTags, lowValueTags: event.raw?.lowValueTags ?? [], upgradeEligible: event.raw?.upgradeEligible !== false, directName, themeMatches, weakOnly },
    })
  }

  return [...links.values()]
}

function collectFromFacts(projectPath, tradeDate, stockUniverse) {
  const events = []
  const links = []

  const authorityRecords = readJsonl(path.join(projectPath, "data/facts/authority_policy_events.jsonl")).slice(-20)
  for (const record of authorityRecords) {
    for (const item of record.items ?? []) {
      const block = `${item.title}\n${item.summary ?? ""}`
      const src = { tag: item.source ?? "authority-policy", tier: "S1", baseScore: 88 }
      const event = buildEvent({
        projectPath,
        relativePath: item.sourceUrl || record.id,
        block,
        src,
        tradeDate: record.tradeDate ?? tradeDate,
      })
      if (!event) continue
      event.id = item.id ? `cat_${item.id}` : event.id
      event.sourcePath = item.sourceUrl ?? event.sourcePath
      event.raw.factRecordId = record.id
      events.push(event)
      links.push(...buildLinks({ event, block, stockUniverse }))
    }
  }

  const limitReasons = readJsonMaybe(path.join(projectPath, ".llm-wiki/limit-up-reasons/latest-limit-up-reasons.json"))
  for (const item of limitReasons?.reasons ?? []) {
    const block = `${item.name} ${item.code}\n${item.reason}\n${item.theme ?? ""}\n${(item.concepts ?? []).join(" ")}`
    const src = { tag: item.source ?? "limit-up-reason", tier: item.sourceLevel === "A" ? "S2" : "S3", baseScore: item.sourceLevel === "A" ? 82 : 68 }
    const event = buildEvent({ projectPath, relativePath: ".llm-wiki/limit-up-reasons/latest-limit-up-reasons.json", block, src, tradeDate: item.tradeDate ?? tradeDate })
    if (!event) continue
    const genericLimitup = GENERIC_LIMITUP_THEMES.has(String(item.theme ?? "").trim()) && String(item.sourceLevel ?? "").toUpperCase() !== "A"
    event.id = `cat_lur_${item.id}`
    event.title = `${item.name}?????${String(item.theme ?? item.reason).slice(0, 40)}`
    event.eventType = "market-confirmed"
    event.sourcePath = ".llm-wiki/limit-up-reasons/latest-limit-up-reasons.json"
    event.raw.limitUpReasonId = item.id
    if (genericLimitup) {
      event.catalystScore = Math.max(0, event.catalystScore - 26)
      event.raw.lowValueTags = unique([...(event.raw.lowValueTags ?? []), "generic-limitup-theme"])
      event.raw.upgradeEligible = false
    }
    events.push(event)
    links.push(...buildLinks({ event, block, stockUniverse }))
  }


  return { events, links }
}

function collect({ projectPath, sinceDays, sourceLimit, maxEvents, tradeDate }) {
  const stockUniverse = buildStockUniverse(projectPath)
  const events = []
  const links = []
  const files = sourceFilesWithHot(projectPath, sinceDays, sourceLimit, tradeDate)

  for (const file of files) {
    const content = fs.readFileSync(file.filePath, "utf8")
    const src = sourceInfo(file.relativePath, content)
    for (const block of splitChunks(content)) {
      const event = buildEvent({ projectPath, relativePath: file.relativePath, block, src, tradeDate })
      if (!event) continue
      events.push(event)
      links.push(...buildLinks({ event, block, stockUniverse }))
    }
  }

  const factCollected = collectFromFacts(projectPath, tradeDate, stockUniverse)
  events.push(...factCollected.events)
  links.push(...factCollected.links)

  const byEvent = new Map()
  for (const event of events) {
    const old = byEvent.get(event.id)
    if (!old || event.catalystScore > old.catalystScore) byEvent.set(event.id, event)
  }
  const selectedEvents = [...byEvent.values()]
    .sort((a, b) => b.catalystScore - a.catalystScore || String(b.generatedAt).localeCompare(String(a.generatedAt)))
    .slice(0, Number(maxEvents))
  const eventIds = new Set(selectedEvents.map((event) => event.id))
  const selectedLinks = links
    .filter((link) => eventIds.has(link.eventId ?? ""))
  const fixedLinks = links
    .filter((link) => eventIds.has(link.eventId ?? ""))
  if (fixedLinks.length === 0) {
    for (const event of selectedEvents) {
      const related = links.filter((link) => link.evidenceFiles?.includes(event.sourcePath))
      for (const link of related) fixedLinks.push({ ...link, eventId: event.id })
    }
  }

  const byLink = new Map()
  for (const link of fixedLinks) {
    const key = `${link.eventId}_${link.code}`
    const old = byLink.get(key)
    if (!old || link.relationStrength > old.relationStrength) byLink.set(key, { ...link, id: `sel_${shortHash(key)}` })
  }

  return {
    stockUniverse,
    files,
    events: selectedEvents,
    links: [...byLink.values()].sort((a, b) => b.relationStrength - a.relationStrength),
  }
}

function buildRecord({ projectPath, sinceDays, sourceLimit, maxEvents, tradeDate }) {
  const generatedAt = nowLocalTimestamp()
  const collected = collect({ projectPath, sinceDays, sourceLimit, maxEvents, tradeDate })
  const events = collected.events.map((event) => ({ ...event, generatedAt }))
  const dateContext = resolveCatalystTradeDateContext({ tradeDate, events })
  const eventIds = new Set(events.map((event) => event.id))
  const links = collected.links
    .filter((link) => eventIds.has(link.eventId))
    .map((link) => ({
      id: `link_${shortHash(`${link.eventId}|${link.code}`)}`,
      eventId: link.eventId,
      generatedAt,
      tradeDate: dateContext.planTradeDate,
      code: link.code,
      name: link.name,
      linkType: link.linkType,
      relationStrength: link.relationStrength,
      reasons: link.reasons,
      themes: link.themes,
      sourceTags: link.sourceTags,
      evidenceFiles: link.evidenceFiles,
      status: link.status,
      raw: link.raw ?? {},
    }))
  const themes = unique(events.flatMap((event) => event.themes))
  const preferredTopLinks = links.filter((link) => link.status !== "risk" && link.raw?.upgradeEligible !== false && !(link.raw?.lowValueTags ?? []).includes("column-brief"))
  const fallbackTopLinks = links.filter((link) => link.status !== "risk" && link.raw?.upgradeEligible !== false && (link.raw?.lowValueTags ?? []).includes("column-brief"))
  const topLinks = [...preferredTopLinks, ...fallbackTopLinks].slice(0, 15).map((link) => ({
    code: link.code,
    name: link.name,
    relationStrength: link.relationStrength,
    themes: link.themes.slice(0, 6),
    reasons: link.reasons.slice(0, 3),
  }))
  const topRiskLinks = links.filter((link) => link.status === "risk").slice(0, 10).map((link) => ({
    code: link.code,
    name: link.name,
    relationStrength: link.relationStrength,
    themes: link.themes.slice(0, 6),
    reasons: link.reasons.slice(0, 3),
  }))
  return {
    schema: "73wiki-catalyst-events-v1",
    id: `catalyst_events_${dateContext.planTradeDate.replace(/-/g, "")}_${idTimestamp()}_${shortHash(events.map((event) => event.id).join(","))}`,
    status: "active",
    title: `${tradeDate} 催化事件与股票关联`,
    generatedAt,
    tradeDate: dateContext.planTradeDate,
    planTradeDate: dateContext.planTradeDate,
    evidenceTradeDate: dateContext.evidenceTradeDate,
    sourceTradeDates: dateContext.sourceTradeDates,
    hasDateMismatch: dateContext.hasDateMismatch,
    source: "73wiki-catalyst-events",
    sourceTier: "event_first_brain",
    sinceDays: Number(sinceDays),
    sourceLimit: Number(sourceLimit),
    events,
    links,
    counts: {
      scannedFiles: collected.files.length,
      events: events.length,
      links: links.length,
      linkedStocks: new Set(links.map((link) => link.code)).size,
      sourceFiles: unique(events.map((event) => event.sourcePath)).length,
      riskLinks: links.filter((link) => link.status === "risk").length,
    },
    themes,
    topLinks,
    topRiskLinks,
    summary: `催化事件 ${events.length} 条，股票关联 ${links.length} 条，涉及股票 ${new Set(links.map((link) => link.code)).size} 只；主题：${themes.slice(0, 12).join("、") || "未识别"}。`,
    claim: "本记录是事件驱动候选，不是买入建议；必须经过热榜、竞价、分时、板块共振和持仓约束验证。",
    tags: ["catalyst-events", "stock-event-links", "消息驱动", "盘前预判"],
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }
}

function markdown(record) {
  const outputLines = [
    `# ${record.title}`,
    "",
    `生成时间: ${record.generatedAt}`,
    `计划交易日: ${record.planTradeDate || record.tradeDate}`,
    `证据交易日: ${record.evidenceTradeDate || record.tradeDate}`,
    `扫描文件: ${record.counts.scannedFiles}`,
    `催化事件: ${record.counts.events}`,
    `股票关联: ${record.counts.links}`,
    `日期状态: ${record.hasDateMismatch ? "计划与证据日期不一致" : "一致"}`,
    "",
    "## 股票关联 Top",
    "",
  ]
  for (const item of record.topLinks) {
    outputLines.push(`- ${item.name || item.code}(${item.code}) / ${item.relationStrength} / ${item.themes.join("、")} / ${item.reasons.join("；")}`)
  }
  outputLines.push("", "## 高分事件", "")
  for (const event of record.events.slice(0, 30)) {
    outputLines.push(`### ${event.title}`)
    outputLines.push(`- 来源: ${event.source} / ${event.sourceTier}`)
    outputLines.push(`- 类型: ${event.eventType}`)
    outputLines.push(`- 分数: ${event.catalystScore}`)
    outputLines.push(`- 题材: ${event.themes.join("、") || "未识别"}`)
    outputLines.push(`- 证据: ${event.sourcePath}`)
    outputLines.push(`- 事件时间: ${event.eventTime || record.evidenceTradeDate || record.tradeDate}`)
    outputLines.push("")
    outputLines.push(event.summary)
    outputLines.push("")
  }
  return `${outputLines.join("\n").trim()}\n`

  const lines = [
    `# ${record.title}`,
    "",
    `- 生成时间：${record.generatedAt}`,
    `- 扫描文件：${record.counts.scannedFiles}`,
    `- 催化事件：${record.counts.events}`,
    `- 股票关联：${record.counts.links}`,
    "",
    "## 股票关联 Top",
    "",
  ]
  for (const item of record.topLinks) {
    lines.push(`- ${item.name || item.code}(${item.code})：${item.relationStrength}；${item.themes.join("、")}；${item.reasons.join("；")}`)
  }
  lines.push("", "## 高分事件", "")
  for (const event of record.events.slice(0, 30)) {
    lines.push(`### ${event.title}`)
    lines.push(`- 来源：${event.source} / ${event.sourceTier}`)
    lines.push(`- 类型：${event.eventType}`)
    lines.push(`- 分数：${event.catalystScore}`)
    lines.push(`- 题材：${event.themes.join("、") || "未识别"}`)
    lines.push(`- 证据：${event.sourcePath}`)
    lines.push("")
    lines.push(event.summary)
    lines.push("")
  }
  return `${lines.join("\n").trim()}\n`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (args._.includes("write")) args.write = true
  const projectPath = resolveProjectPath(args.project ?? args._[0])
  const sinceDays = Number(args["since-days"] ?? args._[1] ?? 3)
  const maxEvents = Number(args["max-events"] ?? args._[2] ?? 160)
  const sourceLimit = Number(args["source-limit"] ?? 700)
  const tradeDate = args["trade-date"] ?? nextTradingDate()
  const record = buildRecord({ projectPath, sinceDays, sourceLimit, maxEvents, tradeDate })
  const reportDir = path.join(projectPath, REPORT_ROOT)
  const reportPath = path.join(reportDir, `${idTimestamp()}-catalyst-events.json`)
  const mdPath = path.join(reportDir, `${idTimestamp()}-catalyst-events.md`)
  const latestPath = path.join(reportDir, "latest-catalyst-events.json")
  const factPath = path.join(projectPath, FACT_PATH)
  const output = {
    dryRun: !args.write,
    id: record.id,
    tradeDate: record.tradeDate,
    planTradeDate: record.planTradeDate,
    evidenceTradeDate: record.evidenceTradeDate,
    hasDateMismatch: record.hasDateMismatch,
    counts: record.counts,
    topLinks: record.topLinks,
    writePaths: {
      facts: FACT_PATH,
      reportRoot: REPORT_ROOT,
    },
  }
  if (args.write) {
    appendJsonl(factPath, record)
    writeJson(reportPath, record)
    writeJson(latestPath, record)
    writeText(mdPath, markdown(record))
    output.written = {
      facts: projectRelative(projectPath, factPath),
      report: projectRelative(projectPath, reportPath),
      markdown: projectRelative(projectPath, mdPath),
      latest: projectRelative(projectPath, latestPath),
    }
  }
  console.log(JSON.stringify(output, null, 2))
}

main()
