#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { mergeHotFiles, readHotFiles } from "./raw-hot-files.mjs"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const FACT_PATH = "data/facts/preopen_intel.jsonl"
const BRAIN_PATH = "data/brain/hypotheses.jsonl"
const REPORT_ROOT = ".llm-wiki/preopen"
const TEXT_EXTENSIONS = new Set([".md", ".txt"])
const MAX_FILE_BYTES = 1_200_000

const SOURCE_WEIGHTS = [
  [/交割单|持仓/, 180, "position"],
  [/raw\/截图|飞书截图|user-screenshot|\.ocr\.md/i, 170, "user-screenshot"],
  [/raw\/05-研报新闻\/央媒|authority-policy|新闻联播|人民日报/i, 160, "authority-policy"],
  [/每日复盘|复盘/, 150, "daily-review"],
  [/交易计划|竞价|盘前|早报|美股|日韩/, 140, "preopen"],
  [/raw\/05-研报新闻\/公众号\/媒体号\/财联社|财联社|CLS|快讯/, 122, "cls-news"],
  [/知识星球|淘股吧|开盘啦|韭研公社/, 108, "market-community"],
  [/公众号/, 106, "wechat-post"],
  [/同花顺热榜|同花顺|热榜/, 98, "ths-signal"],
  [/东方财富|通达信|雪球|微博/, 88, "social-flow"],
  [/作战室/, 70, "warroom"],
]

const SOURCE_SCORE_BONUS = {
  "cls-news": 18,
  "market-community": 10,
  "wechat-post": 12,
  "ths-signal": 6,
  "social-flow": 4,
}

const THEME_KEYWORDS = [
  "AI算力", "英伟达", "PCB", "覆铜板", "光通信", "光模块", "半导体", "芯片",
  "商业航天", "军工", "机器人", "电力", "液冷", "有色", "稀土", "小金属",
  "钼", "铜", "黄金", "煤炭", "医药", "创新药", "消费电子", "固态电池",
  "稳定币", "金融科技", "低空经济", "数据中心", "核电", "雅下水电",
]

const POSITIVE_KEYWORDS = [
  "涨停", "封板", "连板", "回封", "龙头", "核心", "主线", "发酵", "催化",
  "公告", "订单", "中标", "合作", "并购", "重组", "涨价", "政策", "业绩",
  "超预期", "突破", "新高", "资金流入", "辨识度", "人气", "热股", "热点",
]

const EVENT_KEYWORDS = [
  "会议", "国务院", "发改委", "工信部", "财政部", "商务部", "央行", "证监会",
  "印发", "发布", "实施", "推进", "支持", "试点", "规划", "行动方案", "意见",
  "突破", "首个", "首次", "重大", "加快", "高质量发展", "新质生产力",
]

const RISK_KEYWORDS = [
  "减持", "监管", "问询", "异动", "澄清", "跌停", "炸板", "亏损", "退市",
  "处罚", "解禁", "负反馈", "高位", "补跌", "兑现", "杀跌",
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

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00`)
  date.setDate(date.getDate() + Number(days))
  return dateOnly(date)
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  return extractDateFromText(text)
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

function extractDateFromText(value) {
  const text = String(value ?? "")
  const match = text.match(/20\d{2}[-./]\d{1,2}[-./]\d{1,2}/)
  if (!match) return null
  const [y, m, d] = match[0].split(/[-./]/)
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
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
  return [...new Set(values.filter(Boolean))]
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
    if (!/^\d{6}$/.test(String(code ?? ""))) return
    const old = byCode.get(code) ?? { code, name: "", sources: [], themes: [] }
    const clean = cleanName(name)
    if (!old.name || preferBetterName(old.name, clean) !== cleanName(old.name)) old.name = preferBetterName(old.name, clean)
    old.sources.push(source)
    old.themes.push(...(themes ?? []))
    old.sources = unique(old.sources)
    old.themes = unique(old.themes)
    byCode.set(code, old)
  }

  const watchlist = readJsonMaybe(path.join(projectPath, ".llm-wiki/market-watchlist/latest-warroom-watchlist.json"))
  for (const section of ["focus", "warroom", "normal"]) {
    for (const item of watchlist?.tiers?.[section] ?? []) add(item.code, item.name, "latest-watchlist")
  }

  const limitReasons = readJsonMaybe(path.join(projectPath, ".llm-wiki/limit-up-reasons/latest-limit-up-reasons.json"))
  for (const item of limitReasons?.items ?? limitReasons?.reasons ?? []) {
    add(item.code ?? item.symbol, item.name, "limit-up-reasons", [
      ...(item.concepts ?? []),
      ...(item.theme ? String(item.theme).split(/[.、，,；;\s]+/) : []),
    ])
  }

  const reasonCards = readJsonMaybe(path.join(projectPath, ".llm-wiki/stock-reason-cards/latest-stock-reason-cards.json"))
  for (const card of reasonCards?.cards ?? []) {
    add(card.code, card.name, "stock-reason-card", card.themes ?? [])
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

function sourceInfo(relativePath, content) {
  for (const [regex, weight, tag] of SOURCE_WEIGHTS) {
    if (regex.test(relativePath)) return { weight, tag }
    if (!["position", "daily-review"].includes(tag) && regex.test(content.slice(0, 800))) return { weight, tag }
  }
  return { weight: 35, tag: "raw" }
}

function sourceScoreBonus(tag) {
  return SOURCE_SCORE_BONUS[tag] ?? 0
}

function usefulAuthorityThemes(themes) {
  const broad = new Set(["消费", "金融", "农业"])
  return unique(themes).filter((theme) => !broad.has(theme))
}

function intersectThemes(a, b) {
  const right = new Set((b ?? []).map((item) => String(item).toLowerCase()))
  return unique(a).filter((item) => right.has(String(item).toLowerCase()))
}

function codeMatches(content) {
  const matches = []
  const codeRegex = /(?<!\d)(?:SH|SZ)?((?:00\d{4}|30[01]\d{3}|60[0135]\d{3}|68[89]\d{3}|83\d{4}|87\d{4}|92\d{4}))(?:\.(?:SH|SZ))?(?!\d)/gi
  for (const match of content.matchAll(codeRegex)) {
    const code = match[1]
    if (/^0{4,}|^(\d)\1{5}$/.test(code)) continue
    matches.push({ code, index: match.index ?? 0 })
  }
  return matches
}

function extractName(content, code, index) {
  const near = content.slice(Math.max(0, index - 40), Math.min(content.length, index + 60))
  const beforeParen = near.match(new RegExp(`([\\u4e00-\\u9fa5A-Za-z*]{2,12})[（(]?\\s*${code}(?:\\.(?:SH|SZ))?`, "i"))?.[1]
  if (beforeParen && !/^(股票|代码|名称|证券|今日|明日|持仓)$/.test(beforeParen)) return beforeParen.replace(/^.*[-:：]/, "")
  const after = near.match(new RegExp(`${code}(?:\\.(?:SH|SZ))?[）)]?[\\s|,，、:：-]*([\\u4e00-\\u9fa5A-Za-z*]{2,12})`, "i"))?.[1]
  if (after && !/^(最新|行情|涨跌|成交|来源|题材|概念|公告|消息)$/.test(after)) return after
  return ""
}

function contextAround(content, index, size = 180) {
  return content
    .slice(Math.max(0, index - size), Math.min(content.length, index + size))
    .replace(/\s+/g, " ")
    .trim()
}

function keywordHits(text, keywords) {
  return keywords.filter((word) => text.includes(word))
}

function mergeCandidate(map, code, patch) {
  const current = map.get(code) ?? {
    code,
    name: "",
    score: 0,
    sourceTags: [],
    sourceFiles: [],
    themes: [],
    positives: [],
    risks: [],
    evidence: [],
    mentions: 0,
  }
  const patchName = cleanName(patch.name)
  current.name = preferBetterName(current.name, patchName)
  current.score += Number(patch.score ?? 0)
  current.mentions += Number(patch.mentions ?? 1)
  current.sourceTags.push(...(patch.sourceTags ?? []))
  current.sourceFiles.push(...(patch.sourceFiles ?? []))
  current.themes.push(...(patch.themes ?? []))
  current.positives.push(...(patch.positives ?? []))
  current.risks.push(...(patch.risks ?? []))
  current.evidence.push(...(patch.evidence ?? []))
  map.set(code, current)
}

function scanRawIntel(projectPath, options = {}) {
  const knownStocks = collectKnownStocks(projectPath)
  const candidates = new Map()
  const tradeDate = options.tradeDate ?? nextTradingDate()
  const files = recentRawFiles(projectPath, {
    sinceDays: Number(options.sinceDays ?? 3),
    sourceLimit: Number(options.sourceLimit ?? 500),
    tradeDate,
  })

  for (const file of files) {
    const content = fs.readFileSync(file.filePath, "utf8")
    const src = sourceInfo(file.relativePath, content)
    const fileThemes = keywordHits(file.relativePath, THEME_KEYWORDS)
    const contentThemes = keywordHits(content, THEME_KEYWORDS)
    const directMatches = codeMatches(content)

    for (const match of directMatches) {
      const context = contextAround(content, match.index)
      if (/申购|配号/.test(context)) continue
      if (/source_hash|内容hash|hash[:：]/i.test(context)) continue
      if (src.tag === "position" && /卖出/.test(context) && !/当前持仓|持仓/.test(context)) continue
      const positives = keywordHits(context, POSITIVE_KEYWORDS)
      const risks = keywordHits(context, RISK_KEYWORDS)
      const themes = unique([...fileThemes, ...keywordHits(context, THEME_KEYWORDS)])
      const known = knownStocks.get(match.code)
      const name = preferBetterName(known?.name, extractName(content, match.code, match.index))
      if (!name && !known) continue
      const sourceBonus = src.weight + sourceScoreBonus(src.tag)
      const score = sourceBonus + positives.length * 18 + themes.length * 10 - risks.length * 16
      mergeCandidate(candidates, match.code, {
        name,
        score,
        sourceTags: [src.tag],
        sourceFiles: [file.relativePath],
        themes,
        positives,
        risks,
        evidence: [{
          file: file.relativePath,
          sourceTag: src.tag,
          excerpt: context.slice(0, 260),
          positiveHits: positives,
          riskHits: risks,
          themeHits: themes,
        }],
      })
    }

    for (const stock of knownStocks.values()) {
      if (!stock.name || stock.name.length < 2 || !content.includes(stock.name)) continue
      const index = content.indexOf(stock.name)
      const context = contextAround(content, index)
      if (/申购|配号/.test(context)) continue
      if (/source_hash|内容hash|hash[:：]/i.test(context)) continue
      if (src.tag === "position" && /卖出/.test(context) && !/当前持仓|持仓/.test(context)) continue
      const positives = keywordHits(context, POSITIVE_KEYWORDS)
      const risks = keywordHits(context, RISK_KEYWORDS)
      const themes = unique([...fileThemes, ...keywordHits(context, THEME_KEYWORDS)])
      if (positives.length === 0 && themes.length === 0 && !/持仓|明日|盘前|早报|复盘/.test(context)) continue
      const score = src.weight + sourceScoreBonus(src.tag) + positives.length * 18 + themes.length * 10 - risks.length * 16
      mergeCandidate(candidates, stock.code, {
        name: stock.name,
        score,
        sourceTags: [src.tag],
        sourceFiles: [file.relativePath],
        themes,
        positives,
        risks,
        evidence: [{
          file: file.relativePath,
          sourceTag: src.tag,
          excerpt: context.slice(0, 260),
          positiveHits: positives,
          riskHits: risks,
          themeHits: themes,
        }],
      })
    }

    if (src.tag === "authority-policy") {
      const themes = usefulAuthorityThemes([...fileThemes, ...contentThemes])
      const positives = unique([...keywordHits(content, POSITIVE_KEYWORDS), ...keywordHits(content, EVENT_KEYWORDS)])
      if (themes.length > 0 && positives.length > 0) {
        for (const stock of knownStocks.values()) {
          const matchedThemes = intersectThemes(themes, stock.themes ?? [])
          if (matchedThemes.length === 0) continue
          const sourceBoost = stock.sources.includes("limit-up-reasons") ? 80 : 30
          const score = src.weight + matchedThemes.length * 55 + positives.length * 10 + sourceBoost
          mergeCandidate(candidates, stock.code, {
            name: stock.name,
            score,
            sourceTags: [src.tag],
            sourceFiles: [file.relativePath],
            themes: matchedThemes,
            positives,
            risks: [],
            evidence: [{
              file: file.relativePath,
              sourceTag: src.tag,
              excerpt: `央媒政策题材映射：${matchedThemes.join("、")}；来源=${stock.sources.join("、")}；${content.slice(0, 220).replace(/\s+/g, " ")}`,
              positiveHits: positives,
              riskHits: [],
              themeHits: matchedThemes,
            }],
          })
        }
      }
    }
  }

  const latestPredictionPath = path.join(projectPath, ".llm-wiki/prediction-candidates/latest-prediction-candidates.json")
  const latestPrediction = readJsonMaybe(latestPredictionPath)
  if (latestPrediction?.candidates?.length) {
    for (const item of latestPrediction.candidates) {
      const code = String(item.code ?? "")
      if (!/^\d{6}$/.test(code)) continue
      mergeCandidate(candidates, code, {
        name: item.name ?? "",
        score: Math.min(620, Number(item.score ?? 0) * 0.8 + Number(item.novelty ?? 0) * 1.3 + Number(item.expectationGap ?? 0) * 1.7 + Number(item.nextDayTradeability ?? 0) * 1.9),
        sourceTags: ["prediction-candidate", ...(item.sourceTags ?? []).slice(0, 2)],
        sourceFiles: [projectRelative(projectPath, latestPredictionPath), ...(item.sourceFiles ?? []).slice(0, 4)],
        themes: item.themes ?? [],
        positives: unique(["预判候选", ...(item.positives ?? [])]).slice(0, 10),
        risks: item.risks ?? [],
        evidence: [{
          file: projectRelative(projectPath, latestPredictionPath),
          sourceTag: "prediction-candidate",
          excerpt: `${item.name || code} prediction: novelty=${item.novelty ?? 0}, gap=${item.expectationGap ?? 0}, tradeability=${item.nextDayTradeability ?? 0}; ${(item.reasons ?? []).slice(0, 3).join("；")}`.slice(0, 260),
          positiveHits: unique(["预判候选", ...(item.positives ?? [])]).slice(0, 10),
          riskHits: item.risks ?? [],
          themeHits: item.themes ?? [],
        }],
      })
    }
  }

  const postSellPath = path.join(projectPath, ".llm-wiki/post-sell-validation/latest-post-sell-validation.json")
  const postSell = readJsonMaybe(postSellPath)
  for (const item of postSell?.items ?? []) {
    if (item?.verdictType !== "sold_rewatch" && !item?.rewatch) continue
    const code = String(item.code ?? "")
    if (!/^\d{6}$/.test(code)) continue
    const metrics = item.metrics ?? {}
    const d1Close = Math.max(0, Number(metrics.d1CloseGainPct ?? 0))
    const d5Max = Math.max(0, Number(metrics.d5MaxGainPct ?? 0))
    const futureLimitUpCount = Math.max(0, Number(metrics.futureLimitUpCount ?? 0))
    mergeCandidate(candidates, code, {
      name: item.name ?? knownStocks.get(code)?.name ?? "",
      score: Math.min(680, 260 + d1Close * 10 + d5Max * 12 + futureLimitUpCount * 120),
      sourceTags: ["post-sell-rewatch"],
      sourceFiles: [projectRelative(projectPath, postSellPath)],
      themes: [],
      positives: unique([
        "卖出后超预期",
        d1Close > 0 ? `D+1收盘继续走强${Math.round(d1Close * 10) / 10}%` : "",
        futureLimitUpCount > 0 ? `卖出后再现涨停${futureLimitUpCount}次` : "",
      ]),
      risks: [],
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

  const catalyst = readJsonMaybe(path.join(projectPath, ".llm-wiki/catalyst-events/latest-catalyst-events.json"))
  const catalystByCode = new Map()
  for (const link of catalyst?.links ?? []) {
    const code = String(link.code ?? "")
    if (!/^\d{6}$/.test(code)) continue
    const old = catalystByCode.get(code) ?? {
      code,
      name: "",
      maxStrength: 0,
      eventCount: 0,
      themes: [],
      sourceFiles: [],
      reasons: [],
      risk: false,
    }
    if (!old.name && link.name) old.name = link.name
    old.maxStrength = Math.max(old.maxStrength, Number(link.relationStrength ?? 0))
    old.eventCount += 1
    old.themes.push(...(link.themes ?? []))
    old.sourceFiles.push(...(link.evidenceFiles ?? []))
    old.reasons.push(...(link.reasons ?? []))
    old.risk = old.risk || link.status === "risk"
    catalystByCode.set(code, old)
  }
  for (const link of catalystByCode.values()) {
    mergeCandidate(candidates, link.code, {
      name: link.name ?? "",
      score: Math.min(460, link.maxStrength * 2.2 + Math.min(link.eventCount * 12, 120)),
      sourceTags: ["catalyst-event"],
      sourceFiles: unique(link.sourceFiles).slice(0, 8),
      themes: unique(link.themes).slice(0, 10),
      positives: ["催化"],
      risks: link.risk ? ["风险"] : [],
      evidence: [{
        file: unique(link.sourceFiles)[0] ?? ".llm-wiki/catalyst-events/latest-catalyst-events.json",
        sourceTag: "catalyst-event",
        excerpt: `事件关联：${unique(link.reasons).slice(0, 4).join("；").slice(0, 260)}`,
        positiveHits: ["催化"],
        riskHits: link.risk ? ["风险"] : [],
        themeHits: unique(link.themes).slice(0, 10),
      }],
    })
  }

  return {
    filesScanned: files.length,
    sourceFiles: files.map((item) => item.relativePath),
    candidates: [...candidates.values()].map((item) => ({
      ...item,
      sourceTags: unique(item.sourceTags),
      sourceFiles: unique(item.sourceFiles),
      themes: unique(item.themes),
      positives: unique(item.positives),
      risks: unique(item.risks),
      evidence: item.evidence.slice(0, 6),
    })),
  }
}

function buildHypothesis(item, rank) {
  const themes = item.themes.length ? item.themes.join("/") : "未归因题材"
  const positives = item.positives.length ? item.positives.slice(0, 5).join("/") : "RAW 多次出现"
  const risks = item.risks.length ? `风险：${item.risks.slice(0, 4).join("/")}` : "暂无明确风险词"
  return {
    rank,
    code: item.code,
    name: item.name,
    hypothesis: `${item.name || item.code} 进入盘前核心观察：${themes}；触发词=${positives}；${risks}。`,
    tradeReason: "只作为盘前候选，必须经过竞价、分时、板块强度、持仓反馈二次确认。",
    validation: {
      nextDay: "9:15/9:20/9:25 竞价强弱；9:31-9:50 承接、主动性、板块共振；弱于预期则降级。",
      d3: "验证是否跑赢同题材、是否仍被热股/涨停/新闻源反复提到。",
      d5: "验证催化是否兑现为持续赚钱效应，失败样本写入 data/brain/hypotheses.jsonl。",
    },
  }
}

function classifyIntel(candidates, { coreLimit }) {
  const hasActionableSignal = (item) => {
    if (item.sourceTags.includes("position") || item.sourceTags.includes("daily-review") || item.sourceTags.includes("post-sell-rewatch")) return true
    const actionablePositive = item.positives.some((word) => word !== "公告")
    if (actionablePositive) return true
    if (item.themes.length > 0 && item.risks.length === 0 && item.mentions >= 2) return true
    return false
  }
  const sorted = candidates
    .filter((item) => item.name || item.sourceTags.includes("position") || item.sourceTags.includes("daily-review") || item.sourceTags.includes("post-sell-rewatch"))
    .filter((item) => (item.score >= 50 || item.sourceTags.includes("position")) && hasActionableSignal(item))
    .sort((a, b) => {
      const pa = a.sourceTags.includes("position") ? -2 : a.sourceTags.includes("daily-review") ? -1 : a.sourceTags.includes("post-sell-rewatch") ? 0 : 1
      const pb = b.sourceTags.includes("position") ? -2 : b.sourceTags.includes("daily-review") ? -1 : b.sourceTags.includes("post-sell-rewatch") ? 0 : 1
      return pa - pb || b.score - a.score || b.mentions - a.mentions || a.code.localeCompare(b.code)
    })

  const core = sorted.slice(0, Number(coreLimit)).map((item, index) => ({
    ...item,
    rank: index + 1,
    role: item.sourceTags.includes("position") ? "持仓处理" : "盘前核心",
    hypothesis: buildHypothesis(item, index + 1),
  }))
  return {
    core,
    candidates: sorted,
    symbols: core.map((item) => item.code),
  }
}

function resolvePreopenTradeDateContext(tradeDate, sourceFiles = []) {
  const planTradeDate = normalizeTradeDate(tradeDate)
  const rawTradeDates = unique((sourceFiles ?? []).map((item) => normalizeTradeDate(item)).filter(Boolean)).sort()
  const evidenceTradeDate = rawTradeDates.at(-1) ?? planTradeDate
  const sourceTradeDates = {
    preopenPlan: planTradeDate,
    rawIntelEvidence: rawTradeDates.length <= 1 ? (rawTradeDates[0] ?? null) : rawTradeDates,
  }
  const distinctTradeDates = [...new Set([planTradeDate, evidenceTradeDate, ...rawTradeDates].filter(Boolean))]
  return {
    planTradeDate,
    evidenceTradeDate,
    sourceTradeDates,
    hasDateMismatch: distinctTradeDates.length > 1,
  }
}

function markdownReport(record) {
  const lines = [
    `# ${record.title}`,
    "",
    `生成时间：${record.generatedAt}`,
    `扫描 RAW 文件：${record.filesScanned} 个`,
    "",
    "## 核心票（不超过10只）",
    "",
  ]
  if (record.core.length === 0) {
    lines.push("未提取到足够可靠的盘前核心票。")
  }
  for (const item of record.core) {
    lines.push(`### ${item.rank}. ${item.name || item.code}（${item.code}）`)
    lines.push(`- 角色：${item.role}`)
    lines.push(`- 分数：${item.score}`)
    lines.push(`- 题材：${item.themes.join("、") || "未归因"}`)
    lines.push(`- 触发词：${item.positives.join("、") || "无"}`)
    lines.push(`- 风险词：${item.risks.join("、") || "无"}`)
    lines.push(`- 假设：${item.hypothesis.hypothesis}`)
    lines.push(`- 次日验证：${item.hypothesis.validation.nextDay}`)
    lines.push(`- 3日验证：${item.hypothesis.validation.d3}`)
    lines.push(`- 5日验证：${item.hypothesis.validation.d5}`)
    lines.push("- 证据：")
    for (const ev of item.evidence.slice(0, 3)) {
      lines.push(`  - ${ev.file}：${ev.excerpt}`)
    }
    lines.push("")
  }
  lines.push("## 说明")
  lines.push("")
  lines.push("本文件是盘前情报提炼，不是自动买入建议。盘中必须再用竞价、分时、板块、连板和持仓反馈确认。")
  return `${lines.join("\n")}\n`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const generatedAt = nowLocalTimestamp()
  const tradeDate = options.tradeDate ?? nextTradingDate()
  const scanned = scanRawIntel(projectPath, { ...options, tradeDate })
  const classified = classifyIntel(scanned.candidates, { coreLimit: Number(options.coreLimit ?? 10) })
  const tradeDateContext = resolvePreopenTradeDateContext(tradeDate, scanned.sourceFiles)
  const record = {
    schema: "73wiki-preopen-intel-v1",
    id: `preopen_${tradeDate.replace(/-/g, "")}_${idTimestamp()}_${shortHash(classified.symbols.join(","))}`,
    status: "active",
    title: `${tradeDate} 盘前情报与核心票`,
    generatedAt,
    tradeDate,
    planTradeDate: tradeDateContext.planTradeDate,
    evidenceTradeDate: tradeDateContext.evidenceTradeDate,
    sourceTradeDates: tradeDateContext.sourceTradeDates,
    hasDateMismatch: tradeDateContext.hasDateMismatch,
    source: "73wiki-preopen-intel",
    sourceTier: "raw_derived",
    projectPath,
    filesScanned: scanned.filesScanned,
    sourceFiles: scanned.sourceFiles.slice(0, 80),
    coreLimit: Number(options.coreLimit ?? 10),
    core: classified.core,
    candidates: classified.candidates.slice(0, 80),
    symbols: classified.symbols,
    claim: "RAW 原文不改动；本记录只保存盘前情报提炼、候选假设和验证计划，不等于买入建议。",
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }

  if (options.write) {
    const factPath = path.join(projectPath, FACT_PATH)
    const brainPath = path.join(projectPath, BRAIN_PATH)
    const reportDir = path.join(projectPath, REPORT_ROOT)
    const jsonPath = path.join(reportDir, `${idTimestamp()}-preopen-intel.json`)
    const mdPath = path.join(reportDir, `${idTimestamp()}-preopen-intel.md`)
    const latestJson = path.join(reportDir, "latest-preopen-intel.json")
    const latestMd = path.join(reportDir, "latest-preopen-intel.md")

    appendJsonl(factPath, record)
    for (const item of record.core) {
      appendJsonl(brainPath, {
        schema: "73wiki-trading-hypothesis-v1",
        id: `hyp_${record.tradeDate.replace(/-/g, "")}_${item.code}_${shortHash(item.hypothesis.hypothesis)}`,
        status: "pending_validation",
        generatedAt,
        tradeDate: record.tradeDate,
        sourceRecordId: record.id,
        code: item.code,
        name: item.name,
        rank: item.rank,
        hypothesis: item.hypothesis,
        evidence: item.evidence,
        sourceType: "preopen_core_candidates",
        learningMeta: {
          sourceLabel: "preopen-intel",
          methodFamily: "preopen_core_candidates",
          stage: "learning_observation",
          promotionState: "learning_only",
        },
        validationDue: {
          d1: "next trading day close",
          d3: "third trading day close",
          d5: "fifth trading day close",
        },
      })
    }
    writeJson(jsonPath, record)
    writeJson(latestJson, record)
    writeText(mdPath, markdownReport(record))
    writeText(latestMd, markdownReport(record))
    return {
      dryRun: false,
      record,
      written: {
        facts: FACT_PATH,
        brain: BRAIN_PATH,
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
  npm run preopen:intel -- C:\\wiki\\73神话 --write
  npm run preopen:intel -- --project C:\\wiki\\73神话 --since-days 3 --source-limit 500 --core-limit 10 --write
`)
    return
  }
  const result = run({
    projectPath: args.project ?? args._[0],
    sinceDays: args["since-days"] ?? args._[1] ?? 3,
    sourceLimit: args["source-limit"] ?? args._[2] ?? 500,
    coreLimit: args["core-limit"] ?? args._[3] ?? 10,
    tradeDate: args["trade-date"],
    write: Boolean(args.write) || args._.includes("write"),
  })
  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  const record = result.record
  console.log(JSON.stringify({
    dryRun: result.dryRun,
    id: record.id,
    tradeDate: record.tradeDate,
    planTradeDate: record.planTradeDate,
    evidenceTradeDate: record.evidenceTradeDate,
    hasDateMismatch: record.hasDateMismatch,
    filesScanned: record.filesScanned,
    core: record.core.map((item) => ({
      rank: item.rank,
      code: item.code,
      name: item.name,
      role: item.role,
      score: item.score,
      themes: item.themes.slice(0, 5),
      positives: item.positives.slice(0, 5),
      risks: item.risks.slice(0, 5),
    })),
    written: result.written,
  }, null, 2))
}

main()
