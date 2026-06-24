#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { classifySignalGrade, detectAiSubthemes } from "./trading-policy.mjs"
import { mergeHotFiles, readHotFiles } from "./raw-hot-files.mjs"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const FACT_PATH = "data/facts/prediction_candidates.jsonl"
const REPORT_ROOT = ".llm-wiki/prediction-candidates"
const TEXT_EXTENSIONS = new Set([".md", ".txt"])
const MAX_FILE_BYTES = 1_200_000

const SOURCE_WEIGHTS = [
  [/交割单|持仓/, 180, "position"],
  [/raw\/截图|飞书截图|user-screenshot|\.ocr\.md/i, 170, "user-screenshot"],
  [/raw\/05-研报新闻\/央媒|authority-policy|新闻联播|人民日报/i, 160, "authority-policy"],
  [/每日复盘|复盘/, 150, "daily-review"],
  [/交易计划|竞价|盘前|早报|美股|日韩/, 140, "preopen"],
  [/raw\/05-研报新闻\/公众号\/媒体号\/财联社|财联社|CLS|快讯/, 130, "cls-news"],
  [/知识星球|淘股吧|开盘啦|韭研公社/, 116, "market-community"],
  [/公众号/, 112, "wechat-post"],
  [/同花顺热榜|同花顺|热榜/, 102, "ths-signal"],
  [/东方财富|通达信|雪球|微博/, 92, "social-flow"],
  [/作战室/, 72, "warroom"],
]

const SOURCE_SIGNAL_BONUS = {
  "cls-news": { novelty: 16, gap: 10, trade: 8 },
  "market-community": { novelty: 10, gap: 8, trade: 6 },
  "wechat-post": { novelty: 12, gap: 8, trade: 5 },
  "ths-signal": { novelty: 6, gap: 4, trade: 6 },
  "social-flow": { novelty: 4, gap: 3, trade: 2 },
  "news-flow": { novelty: 10, gap: 6, trade: 4 },
}

const THEME_KEYWORDS = [
  "AI算力", "人工智能", "AI", "英伟达", "PCB", "覆铜板", "光通信", "光模块", "CPO",
  "半导体", "芯片", "存储", "商业航天", "军工", "低空经济", "机器人", "电力", "液冷",
  "数据中心", "有色", "稀土", "小金属", "铜", "钼", "黄金", "煤炭", "化工", "新材料",
  "创新药", "固态电池", "新能源", "储能", "光伏", "航运", "金融", "证券", "数字经济",
  "信创", "网络安全", "农业", "消费", "量子", "液冷散热", "算力租赁",
]

const POSITIVE_KEYWORDS = [
  "涨停", "封板", "连板", "回封", "龙头", "核心", "主线", "催化", "订单", "中标", "合作",
  "公告", "订单", "签约", "并购", "重组", "涨价", "业绩", "超预期", "突破", "新高", "放量",
  "最强", "人气", "热股", "热度", "卡位", "加强", "加速",
]

const RISK_KEYWORDS = [
  "减持", "监管", "问询", "异动", "澄清", "跌停", "炸板", "亏损", "退市", "处罚", "解禁",
  "兑现", "高位", "补跌", "杀跌", "利空",
]

const GAP_KEYWORDS = [
  "首次", "首个", "首批", "预期差", "低位", "新题材", "新方向", "国产替代", "拐点",
  "供给收缩", "价格持续上涨", "交货周期", "超市场预期", "供不应求", "渗透率", "加速落地",
  "刚刚", "最新", "盘中宝", "电报解读", "风口研报",
]

const TRADEABILITY_KEYWORDS = [
  "竞价", "承接", "弱转强", "回封", "换手", "人气", "龙头", "连板", "板块共振", "主动性",
  "明日计划", "盘前", "看盘面",
]

const BROAD_THEME_KEYWORDS = new Set([
  "AI",
  "浜哄伐鏅鸿兘",
  "娑堣垂",
  "璇佸埜",
  "閲戣瀺",
  "鏂拌兘婧?",
  "鍗婂浣?",
  "鑺墖",
  "鏁版嵁涓績",
  "鏈夎壊",
  "鍟嗕笟鑸ぉ",
])

const LOW_VALUE_RULES = [
  { regex: /\u70ed\u699c\u5348\u95f4|\u70ed\u699c\u6536\u76d8|\u70ed\u80a1\u699c-\u4eba\u5de5\u6574\u7406|\u5f00\u76d8\u70ed\u699c\u524d50|\u540c\u82b1\u987a\u70ed\u699c/i, tag: "hotlist-snapshot", scorePenalty: 95, capNovelty: 16, capGap: 18, capTradeability: 28, blockUpgrade: true },
  { regex: /\u5468\u56de\u987e|\u5468\u62a5|\u5468\u5ea6\u56de\u987e|\u5468\u603b\u7ed3/i, tag: "weekly-recap", scorePenalty: 135, capNovelty: 12, capGap: 14, capTradeability: 24, blockUpgrade: true },
  { regex: /\u73a9\u8f6cETF|QDII-ETF|\bETF\b/i, tag: "etf-generic", scorePenalty: 120, capNovelty: 14, capGap: 16, capTradeability: 24, blockUpgrade: true },
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
    if (["write", "help", "json"].includes(key)) {
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

function dateOnly(date = new Date()) {
  return nowLocalTimestamp(date).slice(0, 10)
}

function nextTradingDate(date = new Date()) {
  const out = new Date(date)
  out.setDate(out.getDate() + 1)
  while (out.getDay() === 0 || out.getDay() === 6) out.setDate(out.getDate() + 1)
  return dateOnly(out)
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(\d{4})[-./]?(\d{2})[-./]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function latestTradeDate(values = []) {
  return values
    .map((value) => normalizeTradeDate(value))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .at(-1) ?? null
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00`)
  date.setDate(date.getDate() + Number(days))
  return dateOnly(date)
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

function walkTextFiles(rootDir, limit = 12000) {
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
        out.push(fullPath)
      }
    }
  }
  walk(rootDir)
  return out
}

function sanitizeRawContent(value) {
  return String(value ?? "")
    .replace(/\u60f3\u5feb\u4eba\u4e00\u6b65[\s\S]*$/m, "")
    .replace(/# \*\*618[\s\S]*$/m, "")
}

function extractDateFromText(value) {
  const text = String(value ?? "")
  const match = text.match(/20\d{2}[-./]\d{1,2}[-./]\d{1,2}/)
  if (!match) return null
  const [y, m, d] = match[0].split(/[-./]/)
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

function resolvePredictionTradeDateContext(projectPath, planTradeDate, sourceFiles = []) {
  const preopen = readJsonMaybe(path.join(projectPath, ".llm-wiki/preopen/latest-preopen-intel.json"))
  const watchlist = readJsonMaybe(path.join(projectPath, ".llm-wiki/market-watchlist/latest-warroom-watchlist.json"))
  const postSell = readJsonMaybe(path.join(projectPath, ".llm-wiki/post-sell-validation/latest-post-sell-validation.json"))
  const validPostSellTradeDate = (postSell?.items?.length ?? 0) > 0 ? postSell?.tradeDate : null
  const rawEvidenceDate = latestTradeDate(sourceFiles.map((file) => extractDateFromText(file)))
  const evidenceTradeDate = latestTradeDate([
    rawEvidenceDate,
    normalizeTradeDate(watchlist?.evidenceTradeDate),
    validPostSellTradeDate,
  ]) ?? normalizeTradeDate(planTradeDate) ?? dateOnly()
  const sourceTradeDates = {
    requestedTradeDate: normalizeTradeDate(planTradeDate),
    preopen: normalizeTradeDate(preopen?.tradeDate),
    marketWatchlistPlan: normalizeTradeDate(watchlist?.planTradeDate ?? watchlist?.tradeDate),
    marketWatchlistEvidence: normalizeTradeDate(watchlist?.evidenceTradeDate),
    rawEvidence: rawEvidenceDate,
    postSellValidation: normalizeTradeDate(validPostSellTradeDate),
  }
  const distinct = [...new Set(Object.values(sourceTradeDates).filter(Boolean))]
  return {
    tradeDate: normalizeTradeDate(planTradeDate) ?? dateOnly(),
    planTradeDate: normalizeTradeDate(planTradeDate) ?? dateOnly(),
    evidenceTradeDate,
    sourceTradeDates,
    hasDateMismatch: distinct.length > 1,
  }
}

function recentRawFiles(projectPath, { sinceDays, sourceLimit, tradeDate }) {
  const rawRoot = path.join(projectPath, "raw")
  const cutoff = Date.now() - Number(sinceDays) * 24 * 60 * 60 * 1000
  const cutoffDate = addDays(tradeDate, -Number(sinceDays))
  const standardFiles = walkTextFiles(rawRoot)
    .map((filePath) => {
      const stat = fs.statSync(filePath)
      const relativePath = projectRelative(projectPath, filePath)
      return { filePath, stat, relativePath, fileDate: extractDateFromText(relativePath) }
    })
    .filter((item) => {
      if (item.stat.size <= 0 || item.stat.size > MAX_FILE_BYTES) return false
      if (/\/_|raw\/06-|raw\/07-/.test(item.relativePath)) return false
      if (/\u76ee\u5f55\u8bf4\u660e|\u5206\u7c7b\u6e05\u5355|\u89c4\u5219/.test(item.relativePath)) return false
      if (item.fileDate) return item.fileDate >= cutoffDate && item.fileDate <= tradeDate
      return item.stat.mtimeMs >= cutoff
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, Number(sourceLimit))
  const hotFiles = readHotFiles(projectPath, {
    allowedExtensions: TEXT_EXTENSIONS,
    maxFileBytes: MAX_FILE_BYTES,
  })
  return mergeHotFiles(standardFiles, hotFiles, Number(sourceLimit))
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean))]
}

function cleanName(value) {
  let name = String(value ?? "").trim()
  name = name.replace(/^.*(?:买入|看到|关注|观察|低吸|打板|半路|追高|加仓|减仓|清仓|切到|切换到|换到|卖出|持有)/, "")
  name = name.replace(/^[*＊\s]+/, "")
  if (!name) return ""
  if (/^(图片|截图|image)\s*\d+$/i.test(name)) return ""
  if (/^[*+=_#@!~`^|\\/-]+$/.test(name)) return ""
  if (/^[A-Za-z][\u4e00-\u9fff]{1,3}$/.test(name) && !/^[NCU]/i.test(name)) return ""
  if (/^[A-Za-z]{2}[\u4e00-\u9fff]{1,3}$/.test(name) && !/^(ST|XD)/i.test(name)) return ""
  return name
}

function splitThemeTokens(value) {
  return String(value ?? "")
    .split(/[/.銆侊紝,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function codeBase(value) {
  return String(value ?? "").replace(/\.(SH|SZ|BJ)$/i, "")
}

function keywordHits(text, keywords) {
  return unique(keywords.filter((word) => String(text ?? "").includes(word)))
}

function isBroadTheme(theme) {
  return BROAD_THEME_KEYWORDS.has(String(theme ?? "").trim())
}

function normalizeThemes(themes, knownThemes = []) {
  const merged = unique([...(themes ?? []), ...(knownThemes ?? [])].flatMap((item) => splitThemeTokens(item)))
  const specific = merged.filter((item) => !isBroadTheme(item))
  const broad = merged.filter((item) => isBroadTheme(item))
  return {
    merged,
    specific,
    broad,
    effective: specific.length > 0 ? specific : broad,
  }
}

function sourceInfo(relativePath, content) {
  for (const [regex, weight, tag] of SOURCE_WEIGHTS) {
    if (regex.test(relativePath)) return { weight, tag }
    if (!["position", "daily-review"].includes(tag) && regex.test(content.slice(0, 800))) return { weight, tag }
  }
  return { weight: 35, tag: "raw" }
}

function sourceSignalBonus(tag) {
  return SOURCE_SIGNAL_BONUS[tag] ?? { novelty: 0, gap: 0, trade: 0 }
}

function downgradeInfo(relativePath, context = "", srcTag = "") {
  const basis = `${relativePath}\n${context}\n${srcTag}`
  const hits = LOW_VALUE_RULES.filter((rule) => rule.regex.test(basis))
  if (hits.length === 0) return null
  return {
    tags: unique(hits.map((rule) => rule.tag)),
    scorePenalty: hits.reduce((sum, rule) => sum + rule.scorePenalty, 0),
    capNovelty: Math.min(...hits.map((rule) => rule.capNovelty)),
    capGap: Math.min(...hits.map((rule) => rule.capGap)),
    capTradeability: Math.min(...hits.map((rule) => rule.capTradeability)),
    blockUpgrade: hits.some((rule) => rule.blockUpgrade),
  }
}

function codeMatches(content) {
  const matches = []
  const codeRegex = /(?<!\d)(?:SH|SZ)?((?:00\d{4}|30[01]\d{3}|60[0135]\d{3}|68[89]\d{3}|83\d{4}|87\d{4}|92\d{4}))(?:\.(?:SH|SZ))?(?!\d)/gi
  for (const match of String(content ?? "").matchAll(codeRegex)) {
    const code = match[1]
    if (/^0{4,}|^(\d)\1{5}$/.test(code)) continue
    matches.push({ code, index: match.index ?? 0 })
  }
  return matches
}

function extractName(content, code, index) {
  const near = String(content ?? "").slice(Math.max(0, index - 40), Math.min(String(content ?? "").length, index + 60))
  const before = near.match(new RegExp(`([\\u4e00-\\u9fa5A-Za-z*]{2,12})[（(]?[\\s]*${code}(?:\\.(?:SH|SZ))?`, "i"))?.[1]
  if (before && !/^(股票|代码|名称|证券|今日|明日|持仓)$/.test(before)) return before.replace(/^.*[-:：]/, "")
  const after = near.match(new RegExp(`${code}(?:\\.(?:SH|SZ))?[）)]?[\\s|,，、:：]*([\\u4e00-\\u9fa5A-Za-z*]{2,12})`, "i"))?.[1]
  if (after && !/^(最新|行情|涨跌|成交|来源|题材|概念|公告|消息)$/.test(after)) return after
  return ""
}

function isLikelyStockName(name) {
  const text = String(name ?? "").trim()
  if (!text) return false
  if (/^[A-Za-z][\u4e00-\u9fff]{1,3}$/.test(text) && !/^[NCU]/i.test(text)) return false
  if (/^[A-Za-z]{2}[\u4e00-\u9fff]{1,3}$/.test(text) && !/^(ST|XD)/i.test(text)) return false
  if (text.length < 2 || text.length > 8) return false
  if (/合作|精要|本本|新村|来源|公告|解读|盘中宝|风口|公司具备|深度|正文|资料|摘要/.test(text)) return false
  if (/^[A-Za-z0-9*]+$/.test(text)) return false
  return /股份|科技|电子|通信|光电|新材|材料|半导体|电气|动力|能源|光学|精密|信息|发展|电力|集团|软件|智能|电缆|通信|电源|微|创/.test(text) || text.length <= 4
}

function contextAround(content, index, size = 200) {
  return String(content ?? "")
    .slice(Math.max(0, index - size), Math.min(String(content ?? "").length, index + size))
    .replace(/\s+/g, " ")
    .trim()
}

function isTableLikeText(text) {
  const value = String(text ?? "")
  const pipeCount = (value.match(/|/g) ?? []).length
  const lineCount = value.split(/\r?\n/).length
  return pipeCount >= 8 || (pipeCount >= 4 && lineCount >= 3)
}

function isGenericReviewContext(text) {
  const value = String(text ?? "")
  return /(\u5927\u76d8\u73af\u5883\u8bc4\u4f30|\u4e3b\u529b\u8d44\u91d1\u51c0\u6d41\u5165|TOP10|\u8fde\u677f\u5929\u68af|\u70ed\u699c|\u5348\u95f4|\u6536\u76d8|\u699c\u5355)/i.test(value)
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
  const currentClean = cleanName(current)
  const candidateClean = cleanName(candidate)
  if (!candidateClean) return currentClean
  if (!currentClean) return candidateClean
  return nameQuality(candidateClean) > nameQuality(currentClean) ? candidateClean : currentClean
}

function collectKnownStocks(projectPath) {
  const byCode = new Map()
  const add = (code, name, source, themes = []) => {
    const cleanCode = codeBase(code)
    if (!/^\d{6}$/.test(cleanCode)) return
    const old = byCode.get(cleanCode) ?? { code: cleanCode, name: "", sources: [], themes: [] }
    const clean = cleanName(name)
    old.name = preferBetterName(old.name, clean)
    old.sources.push(source)
    old.themes.push(...(themes ?? []))
    old.sources = unique(old.sources)
    old.themes = unique(old.themes)
    byCode.set(cleanCode, old)
  }

  const watchlist = readJsonMaybe(path.join(projectPath, ".llm-wiki/market-watchlist/latest-warroom-watchlist.json"))
  for (const section of ["focus", "warroom", "normal"]) {
    for (const item of watchlist?.tiers?.[section] ?? []) add(item.code, item.name, `watchlist:${section}`, item.themes ?? [])
  }

  const preopen = readJsonMaybe(path.join(projectPath, ".llm-wiki/preopen/latest-preopen-intel.json"))
  for (const item of preopen?.core ?? []) add(item.code, item.name, "preopen", item.themes ?? [])

  const limitReasons = readJsonMaybe(path.join(projectPath, ".llm-wiki/limit-up-reasons/latest-limit-up-reasons.json"))
  for (const item of limitReasons?.reasons ?? []) {
    add(item.code, item.name, "limit-up-reasons", [
      ...(item.concepts ?? []),
      ...(item.theme ? String(item.theme).split(/[.、，,\s]+/) : []),
    ])
  }

  const cards = readJsonMaybe(path.join(projectPath, ".llm-wiki/stock-reason-cards/latest-stock-reason-cards.json"))
  for (const card of cards?.cards ?? []) add(card.code, card.name, "reason-card", card.themes ?? [])

  const skeletons = readJsonMaybe(path.join(projectPath, ".llm-wiki/archive-skeletons/latest-archive-skeletons.json"))
  for (const stock of skeletons?.stocks ?? []) {
    add(stock.code, stock.name, "archive-skeleton", [
      ...(stock.themes ?? []),
      ...(stock.aiSubthemes ?? []),
    ])
  }

  const emotion = readJsonMaybe(path.join(projectPath, ".llm-wiki/akshare-emotion/latest-shortline-emotion.json"))
  for (const poolName of ["limit_up", "strong", "previous_limit_up", "burst"]) {
    for (const item of emotion?.pools?.[poolName] ?? []) {
      add(item["代码"] ?? item["证券代码"] ?? item.code, item["名称"] ?? item["证券简称"] ?? item.name, `akshare:${poolName}`, [item["所属行业"] ?? item["行业"] ?? item.industry].filter(Boolean))
    }
  }

  const tencent = readJsonMaybe(path.join(projectPath, ".llm-wiki/tencent-market/latest-tencent-market.json"))
  for (const item of tencent?.stockQuotes ?? []) {
    add(item["证券代码"] ?? item.code, item["证券简称"] ?? item.name, "tencent-market", [item["证券市场"] ?? item.market].filter(Boolean))
  }

  const postSell = readJsonMaybe(path.join(projectPath, ".llm-wiki/post-sell-validation/latest-post-sell-validation.json"))
  for (const item of postSell?.items ?? []) {
    if (item?.verdictType !== "sold_rewatch" && !item?.rewatch) continue
    add(item.code, item.name, "post-sell-rewatch", item.themes ?? [])
  }

  return byCode
}

function mergeCandidate(map, code, patch) {
  const current = map.get(code) ?? {
    code,
    name: "",
    score: 0,
    mentions: 0,
    novelty: 0,
    expectationGap: 0,
    nextDayTradeability: 0,
    sourceTags: [],
    sourceFiles: [],
    themes: [],
    positives: [],
    risks: [],
    reasons: [],
    invalidations: [],
    evidence: [],
    lowValueMentions: 0,
    downgradeTags: [],
    marketRegimeAdjustments: [],
  }
  const patchName = cleanName(patch.name)
  current.name = preferBetterName(current.name, patchName)
  current.score += Number(patch.score ?? 0)
  current.mentions += Number(patch.mentions ?? 1)
  current.novelty = Math.min(100, current.novelty + Number(patch.novelty ?? 0))
  current.expectationGap = Math.min(100, current.expectationGap + Number(patch.expectationGap ?? 0))
  current.nextDayTradeability = Math.min(100, current.nextDayTradeability + Number(patch.nextDayTradeability ?? 0))
  current.sourceTags.push(...(patch.sourceTags ?? []))
  current.sourceFiles.push(...(patch.sourceFiles ?? []))
  current.themes.push(...(patch.themes ?? []))
  current.positives.push(...(patch.positives ?? []))
  current.risks.push(...(patch.risks ?? []))
  current.reasons.push(...(patch.reasons ?? []))
  current.invalidations.push(...(patch.invalidations ?? []))
  current.evidence.push(...(patch.evidence ?? []))
  current.lowValueMentions += Number(patch.isLowValue ? 1 : 0)
  current.downgradeTags.push(...(patch.downgradeTags ?? []))
  if (patch.marketRegime) current.marketRegimeAdjustments.push(patch.marketRegime)
  map.set(code, current)
}

function candidatePriority(item) {
  if (item.sourceTags.includes("position")) return -2
  if (item.sourceTags.includes("daily-review")) return -1
  if (item.sourceTags.includes("post-sell-rewatch")) return 0
  if (item.sourceTags.includes("user-screenshot")) return 1
  return 2
}

function normalizeCandidateScore(rawScore, mentions, sourceTags = []) {
  const divisor = Math.max(1, 0.9 + Number(mentions ?? 1) * 0.65)
  const normalized = Number(rawScore ?? 0) / divisor
  const positionBoost = sourceTags.includes("position") ? 1.08 : 1
  return Math.min(999, Math.round(normalized * positionBoost * 10) / 10)
}

function clampScore(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0))
}

function loadMarketRegime(projectPath) {
  const regime = readJsonMaybe(path.join(projectPath, ".llm-wiki/market-regime/latest-market-regime.json"))
  if (!regime || regime.status !== "active") return null
  return regime
}

function summarizeMarketRegime(regime) {
  if (!regime) return null
  return {
    id: regime.id,
    evidenceTradeDate: regime.evidenceTradeDate ?? regime.tradeDate,
    mode: regime.mode,
    riskLevel: regime.riskLevel,
    profitEffectScore: regime.profitEffectScore,
    metrics: regime.metrics ?? {},
    topThemes: (regime.topThemes ?? []).slice(0, 12),
    recommendedBias: regime.recommendedBias ?? "",
    summary: regime.summary ?? "",
  }
}

function matchMarketThemes(themes = [], marketRegime = null) {
  const entries = Object.values(marketRegime?.themeScores ?? {})
  const tokens = unique((themes ?? []).map((item) => String(item ?? "").trim()).filter((item) => item.length >= 2))
  const matches = []
  for (const token of tokens) {
    for (const entry of entries) {
      const name = String(entry.name ?? "").trim()
      if (!name) continue
      if (token === name || token.includes(name) || name.includes(token)) {
        matches.push({ theme: token, marketTheme: name, score: Number(entry.score ?? 0), latestCount: Number(entry.latestCount ?? 0) })
      }
    }
  }
  return matches
    .sort((a, b) => b.score - a.score || b.latestCount - a.latestCount || a.theme.localeCompare(b.theme))
    .slice(0, 5)
}

function marketRegimeAdjustment({ themes, srcTag, risks, marketRegime }) {
  if (!marketRegime) {
    return {
      active: false,
      scoreDelta: 0,
      tradeabilityDelta: 0,
      expectationGapDelta: 0,
      reasons: [],
      invalidations: [],
      matchedThemes: [],
    }
  }
  const mode = marketRegime.mode ?? "unknown"
  const riskLevel = marketRegime.riskLevel ?? "unknown"
  const profitEffectScore = Number(marketRegime.profitEffectScore ?? 50)
  const matchedThemes = matchMarketThemes(themes, marketRegime)
  const bestThemeScore = matchedThemes[0]?.score ?? 0
  let scoreDelta = 0
  let tradeabilityDelta = 0
  let expectationGapDelta = 0
  const reasons = []
  const invalidations = []

  if (mode === "attack") {
    scoreDelta += 8
    tradeabilityDelta += 3
    expectationGapDelta += 1
    reasons.push("Market regime supports attack: recent profit effect is strong")
  } else if (mode === "mixed") {
    scoreDelta += 3
    tradeabilityDelta += 1
    reasons.push("Market regime is mixed: only theme-confirmed candidates get upgraded")
  } else if (mode === "selective") {
    scoreDelta -= 5
    tradeabilityDelta -= 2
    invalidations.push("Market regime is selective; avoid weak follow-through")
  } else if (mode === "defensive") {
    scoreDelta -= 12
    tradeabilityDelta -= 5
    expectationGapDelta -= 3
    invalidations.push("Market regime is defensive; standalone catalysts need confirmation")
  }

  if (matchedThemes.length > 0) {
    const themeBonus = clampScore(Math.round(bestThemeScore * 1.1), 0, 14)
    scoreDelta += themeBonus
    tradeabilityDelta += clampScore(Math.round(bestThemeScore * 0.35), 0, 5)
    reasons.push(`Market hot-theme match: ${matchedThemes.map((item) => item.marketTheme).join(" / ")}`)
  } else if (["selective", "defensive"].includes(mode) && !["position", "post-sell-rewatch"].includes(srcTag)) {
    scoreDelta -= 10
    tradeabilityDelta -= 3
    invalidations.push("No recent hot-theme confirmation")
  }

  if (riskLevel === "high") {
    scoreDelta -= 10
    tradeabilityDelta -= 4
    invalidations.push("High burst/limit-down pressure reduces next-day certainty")
  } else if (riskLevel === "medium" && risks.length > 0) {
    scoreDelta -= 5
    tradeabilityDelta -= 2
    invalidations.push("Medium market risk plus stock-specific risk")
  }

  if (srcTag === "position" && scoreDelta < 0) scoreDelta = Math.round(scoreDelta * 0.55)
  return {
    active: true,
    mode,
    riskLevel,
    profitEffectScore,
    scoreDelta,
    tradeabilityDelta,
    expectationGapDelta,
    matchedThemes,
    reasons,
    invalidations,
  }
}

function summarizeCandidateRegimeAdjustments(adjustments = []) {
  const active = adjustments.filter((item) => item?.active)
  if (active.length === 0) return null
  const avg = (field) => Math.round((active.reduce((sum, item) => sum + Number(item[field] ?? 0), 0) / active.length) * 10) / 10
  return {
    mode: active[0].mode,
    riskLevel: active[0].riskLevel,
    profitEffectScore: active[0].profitEffectScore,
    averageScoreDelta: avg("scoreDelta"),
    averageTradeabilityDelta: avg("tradeabilityDelta"),
    evidenceCount: active.length,
    matchedThemes: unique(active.flatMap((item) => item.matchedThemes?.map((match) => match.marketTheme) ?? [])).slice(0, 8),
  }
}

function scorePatch({ src, direct, positives, risks, themes, context, known, relativePath, marketRegime }) {
  const normalizedThemes = normalizeThemes(themes, known?.themes ?? [])
  const gapHits = keywordHits(context, GAP_KEYWORDS)
  const tradeHits = keywordHits(context, TRADEABILITY_KEYWORDS)
  const downgrade = downgradeInfo(relativePath, context, src.tag)
  const reviewTable = src.tag === "daily-review" && isTableLikeText(context)
  const genericReview = src.tag === "daily-review" && isGenericReviewContext(context)
  const sourceBonus = sourceSignalBonus(src.tag)
  let novelty = Math.min(100, 12 + (direct ? 18 : 0) + gapHits.length * 18 + (src.tag === "user-screenshot" ? 20 : 0) + (src.tag === "authority-policy" ? 16 : 0) + sourceBonus.novelty)
  let expectationGap = Math.min(100, 8 + gapHits.length * 20 + positives.length * 8 + (!known?.sources?.includes("limit-up-reasons") ? 16 : 0) + (!known?.sources?.some((item) => item.startsWith("watchlist:")) ? 8 : 0) + sourceBonus.gap)
  const specificThemeBoost = normalizedThemes.specific.length * 8
  const broadThemeBoost = normalizedThemes.specific.length > 0 ? 0 : normalizedThemes.broad.length * 2
  const broadThemePenalty = normalizedThemes.specific.length === 0 && normalizedThemes.broad.length > 0 ? 10 : 0
  let nextDayTradeability = Math.min(100, 10 + Math.round(src.weight * 0.22) + positives.length * 10 + tradeHits.length * 12 + specificThemeBoost + broadThemeBoost - risks.length * 14 + (direct ? 10 : 0) + sourceBonus.trade)
  if (downgrade) {
    novelty = Math.min(novelty, downgrade.capNovelty)
    expectationGap = Math.min(expectationGap, downgrade.capGap)
    nextDayTradeability = Math.min(nextDayTradeability, downgrade.capTradeability)
  }
  if (reviewTable || genericReview) {
    novelty = Math.min(novelty, 18)
    expectationGap = Math.min(expectationGap, 20)
    nextDayTradeability = Math.min(nextDayTradeability, 30)
  }
  const regimeAdjustment = marketRegimeAdjustment({
    themes: normalizedThemes.effective,
    srcTag: src.tag,
    risks,
    marketRegime,
  })
  expectationGap = clampScore(expectationGap + regimeAdjustment.expectationGapDelta)
  nextDayTradeability = clampScore(nextDayTradeability + regimeAdjustment.tradeabilityDelta)
  let score = Math.round((novelty * 1.5 + expectationGap * 1.9 + nextDayTradeability * 2.2 + src.weight * 0.7 - risks.length * 12 - broadThemePenalty) * 10) / 10
  score = Math.max(0, Math.round((score + regimeAdjustment.scoreDelta) * 10) / 10)
  if (downgrade) score = Math.max(0, score - downgrade.scorePenalty)
  if (reviewTable) score = Math.max(0, score - 110)
  if (genericReview) score = Math.max(0, score - 70)
  return {
    score,
    novelty,
    expectationGap,
    nextDayTradeability,
    themes: normalizedThemes.effective,
    isLowValue: Boolean(downgrade || reviewTable || genericReview),
    downgradeTags: unique([...(downgrade?.tags ?? []), ...(reviewTable ? ["daily-review-table"] : []), ...(genericReview ? ["daily-review-generic"] : [])]),
    blockUpgrade: Boolean(downgrade?.blockUpgrade),
    marketRegime: regimeAdjustment,
    reasons: unique([
      downgrade ? `Downgraded low-signal source: ${downgrade.tags.join(" / ")}` : "",
      reviewTable ? "Daily review table is evidence-only, not standalone catalyst" : "",
      genericReview ? "Generic review summary is evidence-only, not standalone catalyst" : "",
      ...regimeAdjustment.reasons,
      gapHits.length > 0 ? `?????????${gapHits.join("??")}` : "",
      positives.length > 0 ? `????????${positives.slice(0, 4).join("??")}` : "",
      themes.length > 0 ? `????????${themes.slice(0, 4).join("??")}` : "",
    ].filter(Boolean)),
    invalidations: unique([
      (downgrade?.blockUpgrade || reviewTable || genericReview) ? "facts-only source; do not promote standalone candidate" : "",
      ...regimeAdjustment.invalidations,
      "?????????",
      "9:31-9:50 ?????",
      themes.length > 0 ? "????????" : "",
      risks.length > 0 ? `??????${risks.slice(0, 3).join("??")}` : "",
    ].filter(Boolean)),
  }
}

function scanPredictionSignals(projectPath, options = {}) {
  const knownStocks = collectKnownStocks(projectPath)
  const marketRegime = loadMarketRegime(projectPath)
  const candidates = new Map()
  const tradeDate = options.tradeDate ?? nextTradingDate()
  const files = recentRawFiles(projectPath, {
    sinceDays: Number(options.sinceDays ?? 3),
    sourceLimit: Number(options.sourceLimit ?? 600),
    tradeDate,
  })

  for (const file of files) {
    const content = fs.readFileSync(file.filePath, "utf8")
    const src = sourceInfo(file.relativePath, content)
    const fileThemes = keywordHits(file.relativePath, THEME_KEYWORDS)
    const directCodes = codeMatches(content)

    for (const match of directCodes) {
      const known = knownStocks.get(match.code)
      const context = contextAround(content, match.index)
      if (/申购|配号/.test(context) || /source_hash|内容hash|hash[:：]/i.test(context)) continue
      if (src.tag === "position" && /卖出/.test(context) && !/当前持仓|持仓/.test(context)) continue
      const positives = keywordHits(context, POSITIVE_KEYWORDS)
      const risks = keywordHits(context, RISK_KEYWORDS)
      const themes = unique([...fileThemes, ...keywordHits(context, THEME_KEYWORDS)])
      const name = preferBetterName(known?.name, extractName(content, match.code, match.index))
      if (!known && !isLikelyStockName(name)) continue
      if (!name && !known) continue
      const metrics = scorePatch({ src, direct: true, positives, risks, themes, context, known, relativePath: file.relativePath, marketRegime })
      mergeCandidate(candidates, match.code, {
        name,
        ...metrics,
        sourceTags: [src.tag],
        sourceFiles: [file.relativePath],
        themes: metrics.themes,
        positives,
        risks,
        evidence: [{
          file: file.relativePath,
          sourceTag: src.tag,
          excerpt: context.slice(0, 260),
          positiveHits: positives,
          riskHits: risks,
          themeHits: metrics.themes,
        }],
      })
    }

    for (const stock of knownStocks.values()) {
      if (!stock.name || stock.name.length < 2 || !content.includes(stock.name)) continue
      const index = content.indexOf(stock.name)
      const context = contextAround(content, index)
      if (/申购|配号/.test(context) || /source_hash|内容hash|hash[:：]/i.test(context)) continue
      if (src.tag === "position" && /卖出/.test(context) && !/当前持仓|持仓/.test(context)) continue
      const positives = keywordHits(context, POSITIVE_KEYWORDS)
      const risks = keywordHits(context, RISK_KEYWORDS)
      const themes = unique([...fileThemes, ...keywordHits(context, THEME_KEYWORDS), ...(stock.themes ?? [])])
      if (positives.length === 0 && themes.length === 0 && !/持仓|明日|盘前|早报|复盘/.test(context)) continue
      const metrics = scorePatch({ src, direct: false, positives, risks, themes, context, known: stock, relativePath: file.relativePath, marketRegime })
      mergeCandidate(candidates, stock.code, {
        name: stock.name,
        ...metrics,
        sourceTags: [src.tag],
        sourceFiles: [file.relativePath],
        themes: metrics.themes,
        positives,
        risks,
        evidence: [{
          file: file.relativePath,
          sourceTag: src.tag,
          excerpt: context.slice(0, 260),
          positiveHits: positives,
          riskHits: risks,
          themeHits: metrics.themes,
        }],
      })
    }
  }

  const postSellPath = path.join(projectPath, ".llm-wiki/post-sell-validation/latest-post-sell-validation.json")
  const postSell = readJsonMaybe(postSellPath)
  for (const item of postSell?.items ?? []) {
    if (item?.verdictType !== "sold_rewatch" && !item?.rewatch) continue
    const code = codeBase(item.code)
    if (!/^\d{6}$/.test(code)) continue
    const known = knownStocks.get(code)
    const metrics = item.metrics ?? {}
    const d1Close = Math.max(0, Number(metrics.d1CloseGainPct ?? 0))
    const d5Max = Math.max(0, Number(metrics.d5MaxGainPct ?? 0))
    const futureLimitUpCount = Math.max(0, Number(metrics.futureLimitUpCount ?? 0))
    const sameDayAfterHigh = Math.max(0, Number(metrics.sameDayAfterHighGainPct ?? 0))
    mergeCandidate(candidates, code, {
      name: item.name || known?.name || "",
      score: Math.min(580, 220 + d1Close * 8 + d5Max * 10 + sameDayAfterHigh * 6 + futureLimitUpCount * 90),
      mentions: 2,
      novelty: 24,
      expectationGap: Math.min(100, 26 + Math.round(d5Max)),
      nextDayTradeability: Math.min(100, 28 + Math.round(d1Close + futureLimitUpCount * 18)),
      sourceTags: ["post-sell-rewatch"],
      sourceFiles: [projectRelative(projectPath, postSellPath)],
      themes: [],
      positives: unique([
        "卖出后超预期",
        d5Max >= 0 ? `D+5最大涨幅${Math.round(d5Max * 10) / 10}%` : "",
        d1Close > 0 ? `D+1收盘继续走强${Math.round(d1Close * 10) / 10}%` : "",
        futureLimitUpCount > 0 ? `卖出后再现涨停${futureLimitUpCount}次` : "",
      ]),
      risks: [],
      reasons: [
        "卖出后继续走强，纳入重点回看样本",
        futureLimitUpCount > 0 ? "卖出后仍有涨停延续，需提高龙头识别权重" : "卖出后持续超预期，需复盘是否错过龙头演化",
      ],
      invalidations: [
        "次日竞价明显转弱",
        "9:31-9:50 无承接",
        "板块扩散失败",
      ],
      evidence: [{
        file: projectRelative(projectPath, postSellPath),
        sourceTag: "post-sell-rewatch",
        excerpt: `${item.name || code} 卖出后回看: D+1收盘=${d1Close || 0}%, D+5最大=${d5Max || 0}%, future_limit_up=${futureLimitUpCount}`.slice(0, 260),
        positiveHits: unique([
          "卖出后超预期",
          d1Close > 0 ? "D+1继续走强" : "",
          futureLimitUpCount > 0 ? "卖出后仍涨停" : "",
        ]),
        riskHits: [],
        themeHits: [],
      }],
    })
  }

  return {
    marketRegime: summarizeMarketRegime(marketRegime),
    filesScanned: files.length,
    sourceFiles: files.map((item) => item.relativePath),
    candidates: [...candidates.values()]
      .map((item) => ({
        ...item,
        rawScore: item.score,
        score: normalizeCandidateScore(item.score, item.mentions, item.sourceTags),
        name: knownStocks.get(item.code)?.name || item.name,
        sourceTags: unique(item.sourceTags),
        sourceFiles: unique(item.sourceFiles),
        themes: unique(item.themes).slice(0, 12),
        positives: unique(item.positives).slice(0, 12),
        risks: unique(item.risks).slice(0, 10),
        reasons: unique(item.reasons).slice(0, 6),
        invalidations: unique(item.invalidations).slice(0, 6),
        evidence: item.evidence.slice(0, 6),
        lowValueOnly: Number(item.lowValueMentions ?? 0) >= Number(item.mentions ?? 0),
        downgradeTags: unique(item.downgradeTags).slice(0, 6),
        marketRegime: summarizeCandidateRegimeAdjustments(item.marketRegimeAdjustments),
      }))
      .filter((item) => item.name || item.sourceTags.includes("position") || item.sourceTags.includes("daily-review") || item.sourceTags.includes("post-sell-rewatch")),
  }
}

function classifyCandidates(candidates, limit) {
  const sorted = [...candidates]
    .filter((item) => (item.score >= 80 || item.sourceTags.includes("position")) && (!item.lowValueOnly || item.sourceTags.includes("position") || item.sourceTags.includes("post-sell-rewatch")))
    .sort((a, b) => candidatePriority(a) - candidatePriority(b) || b.score - a.score || b.nextDayTradeability - a.nextDayTradeability || a.code.localeCompare(b.code))
    .slice(0, Number(limit))
    .map((item, index) => {
      const gradeRule = classifySignalGrade(item)
      const aiSubthemes = detectAiSubthemes([...(item.themes ?? []), ...(item.positives ?? []), ...(item.reasons ?? [])])
      return {
        ...item,
        rank: index + 1,
        role: item.sourceTags.includes("position")
          ? "holding-first"
          : item.sourceTags.includes("post-sell-rewatch")
            ? "post-sell-rewatch"
            : "prediction-core",
        predictedMove: gradeRule.enterCorePool ? "high-conviction" : gradeRule.enterCandidatePool ? "watch-open" : "observe",
        signalGrade: gradeRule.grade,
        policy: {
          writeThemeCard: gradeRule.writeThemeCard,
          writeStockCard: gradeRule.writeStockCard,
          enterCandidatePool: gradeRule.enterCandidatePool,
          enterCorePool: gradeRule.enterCorePool,
        },
        aiSubthemes,
        summary: `${item.name || item.code} next-day candidate: grade=${gradeRule.grade}, novelty=${item.novelty}, gap=${item.expectationGap}, tradeability=${item.nextDayTradeability}`,
      }
    })
  return {
    candidates: sorted,
    symbols: sorted.map((item) => item.code),
  }
}

function markdownReport(record) {
  const lines = [
    `# ${record.title}`,
    "",
    `Generated: ${record.generatedAt}`,
    `Plan trade date: ${record.planTradeDate || record.tradeDate}`,
    `Evidence trade date: ${record.evidenceTradeDate || record.tradeDate}`,
    `Files scanned: ${record.filesScanned}`,
    `Date status: ${record.hasDateMismatch ? "mismatch" : "aligned"}`,
    "",
  ]
  if (record.marketRegime) {
    lines.push("## Market Regime")
    lines.push("")
    lines.push(`- Mode: ${record.marketRegime.mode}`)
    lines.push(`- Risk level: ${record.marketRegime.riskLevel}`)
    lines.push(`- Profit effect score: ${record.marketRegime.profitEffectScore}`)
    lines.push(`- Evidence trade date: ${record.marketRegime.evidenceTradeDate}`)
    lines.push(`- Bias: ${record.marketRegime.recommendedBias || "n/a"}`)
    lines.push("")
  }
  lines.push("## Top Prediction Candidates", "")
  for (const item of record.candidates) {
    lines.push(`### ${item.rank}. ${item.name || item.code} (${item.code})`)
    lines.push(`- Score: ${item.score}`)
    lines.push(`- Grade: ${item.signalGrade}`)
    lines.push(`- Novelty: ${item.novelty}`)
    lines.push(`- Expectation gap: ${item.expectationGap}`)
    lines.push(`- Next-day tradeability: ${item.nextDayTradeability}`)
    lines.push(`- Themes: ${item.themes.join(" / ") || "n/a"}`)
    lines.push(`- AI subthemes: ${item.aiSubthemes?.join(" / ") || "n/a"}`)
    lines.push(`- Reasons: ${item.reasons.join(" | ") || "n/a"}`)
    lines.push(`- Invalidations: ${item.invalidations.join(" | ") || "n/a"}`)
    if (item.marketRegime) lines.push(`- Market regime: mode=${item.marketRegime.mode}, risk=${item.marketRegime.riskLevel}, avgScoreDelta=${item.marketRegime.averageScoreDelta}, matched=${item.marketRegime.matchedThemes.join(" / ") || "n/a"}`)
    lines.push(`- Source tags: ${item.sourceTags.join(" / ") || "n/a"}`)
    for (const ev of item.evidence.slice(0, 3)) lines.push(`- Evidence: ${ev.file} :: ${ev.excerpt}`)
    lines.push("")
  }
  lines.push("This layer is for preopen prediction and validation. It is not buy advice.")
  return `${lines.join("\n").trim()}\n`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const generatedAt = nowLocalTimestamp()
  const tradeDate = options.tradeDate ?? nextTradingDate()
  const scanned = scanPredictionSignals(projectPath, { ...options, tradeDate })
  const dateContext = resolvePredictionTradeDateContext(projectPath, tradeDate, scanned.sourceFiles)
  const classified = classifyCandidates(scanned.candidates, Number(options.candidateLimit ?? 30))
  const record = {
    schema: "73wiki-prediction-candidates-v1",
    id: `prediction_candidates_${dateContext.planTradeDate.replace(/-/g, "")}_${idTimestamp()}_${shortHash(classified.symbols.join(","))}`,
    status: "active",
    title: `${dateContext.planTradeDate} 预判候选池`,
    generatedAt,
    tradeDate: dateContext.planTradeDate,
    planTradeDate: dateContext.planTradeDate,
    evidenceTradeDate: dateContext.evidenceTradeDate,
    sourceTradeDates: dateContext.sourceTradeDates,
    hasDateMismatch: dateContext.hasDateMismatch,
    source: "73wiki-prediction-candidates",
    sourceTier: "raw_prediction",
    projectPath,
    filesScanned: scanned.filesScanned,
    sourceFiles: scanned.sourceFiles.slice(0, 120),
    marketRegime: scanned.marketRegime,
    candidateLimit: Number(options.candidateLimit ?? 30),
    candidates: classified.candidates,
    symbols: classified.symbols,
    summary: `prediction candidates ${classified.candidates.length}, built from raw-first signals rather than post limit-up explanations.`,
    claim: "This layer exists to predict next-day trade candidates from raw signals before market confirmation.",
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }

  if (options.write) {
    const factPath = path.join(projectPath, FACT_PATH)
    const reportDir = path.join(projectPath, REPORT_ROOT)
    const jsonPath = path.join(reportDir, `${idTimestamp()}-prediction-candidates.json`)
    const mdPath = path.join(reportDir, `${idTimestamp()}-prediction-candidates.md`)
    const latestJson = path.join(reportDir, "latest-prediction-candidates.json")
    const latestMd = path.join(reportDir, "latest-prediction-candidates.md")
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
    console.log("Usage: node scripts/prediction-candidates.mjs --project <wiki-root> --write")
    return
  }
  const projectPath = args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH
  const result = run({
    projectPath,
    sinceDays: Number(args["since-days"] ?? args._[1] ?? 3),
    sourceLimit: Number(args["source-limit"] ?? 600),
    candidateLimit: Number(args["candidate-limit"] ?? 30),
    tradeDate: args["trade-date"] ?? nextTradingDate(),
    write: Boolean(args.write || args._.includes("write")),
  })
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(JSON.stringify({
      dryRun: result.dryRun,
      id: result.record.id,
      tradeDate: result.record.tradeDate,
      planTradeDate: result.record.planTradeDate,
      evidenceTradeDate: result.record.evidenceTradeDate,
      hasDateMismatch: result.record.hasDateMismatch,
      marketRegime: result.record.marketRegime ? {
        mode: result.record.marketRegime.mode,
        riskLevel: result.record.marketRegime.riskLevel,
        profitEffectScore: result.record.marketRegime.profitEffectScore,
      } : null,
      filesScanned: result.record.filesScanned,
      candidates: result.record.candidates.slice(0, 10).map((item) => ({
        rank: item.rank,
        code: item.code,
        name: item.name,
        score: item.score,
        novelty: item.novelty,
        expectationGap: item.expectationGap,
        nextDayTradeability: item.nextDayTradeability,
      })),
      written: result.written ?? null,
    }, null, 2))
  }
}

main()
