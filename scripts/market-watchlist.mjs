#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const FACT_PATH = "data/facts/warroom_watchlists.jsonl"
const REPORT_ROOT = ".llm-wiki/market-watchlist"

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
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`)
    }
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

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))]
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

function latestTradeDate(values = []) {
  const dates = values.map((value) => normalizeTradeDate(value)).filter(Boolean)
  if (dates.length === 0) return null
  return dates.sort().at(-1) ?? null
}

function resolveWatchlistTradeDateContext(sources = {}) {
  const today = nowLocalTimestamp().slice(0, 10)
  const planTradeDate = firstTradeDate(
    sources.preopen?.tradeDate,
    sources.catalyst?.tradeDate,
    today,
  ) ?? today
  const evidenceTradeDate = latestTradeDate([
    sources.emotion?.evidenceTradeDate ?? sources.emotion?.tradeDate,
    sources.thsHotlist?.evidenceTradeDate ?? sources.thsHotlist?.tradeDate,
    sources.ifindEnhance?.evidenceTradeDate ?? sources.ifindEnhance?.tradeDate,
    sources.limitReasons?.evidenceTradeDate ?? sources.limitReasons?.tradeDate,
    sources.tencent?.evidenceTradeDate,
    (sources.postSell?.items?.length ?? 0) > 0 ? sources.postSell?.tradeDate : null,
  ]) ?? planTradeDate
  const sourceTradeDates = {
    preopen: normalizeTradeDate(sources.preopen?.tradeDate),
    postSellValidation: normalizeTradeDate((sources.postSell?.items?.length ?? 0) > 0 ? sources.postSell?.tradeDate : null),
    akshareEmotion: normalizeTradeDate(sources.emotion?.evidenceTradeDate ?? sources.emotion?.tradeDate),
    tencentMarket: normalizeTradeDate(sources.tencent?.evidenceTradeDate ?? sources.tencent?.tradeDate),
    thsHotlist: normalizeTradeDate(sources.thsHotlist?.evidenceTradeDate ?? sources.thsHotlist?.tradeDate),
    ifindEnhance: normalizeTradeDate(sources.ifindEnhance?.evidenceTradeDate ?? sources.ifindEnhance?.tradeDate),
    limitUpReasons: normalizeTradeDate(sources.limitReasons?.evidenceTradeDate ?? sources.limitReasons?.tradeDate),
    catalystEvents: normalizeTradeDate(sources.catalyst?.evidenceTradeDate ?? sources.catalyst?.tradeDate),
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

function parseNumberLoose(value) {
  const text = String(value ?? "").replace(/,/g, "").trim()
  if (!text || text === "--") return null
  const match = text.match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : null
}

function cleanName(value) {
  let name = String(value ?? "").trim()
  name = name.replace(/^.*(?:买入|看到|关注|观察|低吸|打板|半路|追高|加仓|减仓|清仓|切到|切换到|换到|卖出|持有)/, "")
  name = name.replace(/^[*＊\s]+/, "")
  if (!name) return ""
  if (/^(图片|截图|image)\s*\d+$/i.test(name)) return ""
  if (/^[*＊•·\-_=]+$/.test(name)) return ""
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

function addCandidate(byCode, code, patch) {
  if (!/^\d{6}$/.test(String(code ?? ""))) return
  const key = String(code)
  const current = byCode.get(key) ?? {
    code: key,
    name: "",
    score: 0,
    occurrences: 0,
    reasons: [],
    sourceFiles: [],
    tags: [],
    roleHint: "",
    themes: [],
  }
  const patchName = cleanName(patch.name)
  current.name = preferBetterName(current.name, patchName)
  current.score += Number(patch.score ?? 0)
  current.occurrences += Number(patch.occurrences ?? 1)
  current.reasons.push(...(patch.reasons ?? []))
  current.sourceFiles.push(...(patch.sourceFiles ?? []))
  current.tags.push(...(patch.tags ?? []))
  current.themes.push(...(patch.themes ?? []))
  if (!current.roleHint && patch.roleHint) current.roleHint = String(patch.roleHint)
  byCode.set(key, current)
}

function splitThemes(values) {
  const result = []
  for (const value of values ?? []) {
    result.push(
      ...String(value ?? "")
        .split(/[、，,\s/]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    )
  }
  return unique(result)
}

function themeCountMapFromLimitReasons(latest) {
  const counts = new Map()
  for (const item of latest?.reasons ?? []) {
    const themes = splitThemes([...(item.concepts ?? []), item.theme ?? ""])
    for (const theme of themes) counts.set(theme, (counts.get(theme) ?? 0) + 1)
  }
  return counts
}

function normalizeCandidateScore(item) {
  const tags = new Set(item.tags ?? [])
  let cap = 900
  if (tags.has("position-first")) cap = 3600
  else if (tags.has("preopen-intel") && tags.has("limit-up")) cap = 2200
  else if (tags.has("preopen-intel")) cap = 1800
  else if (tags.has("post-sell-rewatch")) cap = 1800
  else if (tags.has("back-row-limit-up") || tags.has("theme-expansion")) cap = 1800
  else if (tags.has("limit-up")) cap = 1600
  else if (tags.has("catalyst-event")) cap = 1100
  return {
    ...item,
    reasons: unique(item.reasons).slice(0, 8),
    sourceFiles: unique(item.sourceFiles).slice(0, 8),
    tags: unique(item.tags).slice(0, 12),
    themes: unique(item.themes).slice(0, 12),
    rawScore: Math.round(Number(item.score ?? 0) * 10) / 10,
    scoreCap: cap,
    score: Math.round(Math.min(Number(item.score ?? 0), cap) * 10) / 10,
  }
}

function priorityRank(item) {
  const tags = new Set(item.tags ?? [])
  if (tags.has("position-first")) return -2
  if (tags.has("preopen-intel")) return -1
  if (tags.has("post-sell-rewatch")) return 0
  if (tags.has("back-row-limit-up") || tags.has("theme-expansion")) return 1
  if (tags.has("limit-up")) return 2
  if (tags.has("catalyst-event")) return 3
  return 4
}

function collectCandidates(projectPath) {
  const byCode = new Map()
  const sourceFiles = []

  const preopenPath = path.join(projectPath, ".llm-wiki/preopen/latest-preopen-intel.json")
  const preopen = readJsonMaybe(preopenPath)
  const coreCodes = new Set()

  if (preopen?.core?.length) {
    sourceFiles.push(projectRelative(projectPath, preopenPath))
    for (const item of preopen.core) {
      const code = String(item.code ?? "")
      if (!/^\d{6}$/.test(code)) continue
      coreCodes.add(code)
      const rank = Number(item.rank ?? 99)
      addCandidate(byCode, code, {
        name: item.name,
        score: Math.max(260, 980 - rank * 42 + Number(item.score ?? 0) * 0.35),
        reasons: [
          "盘前情报核心票",
          item.hypothesis?.hypothesis ? `盘前假设：${item.hypothesis.hypothesis}` : "",
          item.themes?.length ? `盘前题材：${item.themes.join("/")}` : "",
        ],
        sourceFiles: [projectRelative(projectPath, preopenPath), ...(item.sourceFiles ?? []).slice(0, 3)],
        tags: ["preopen-intel", String(item.role ?? "").includes("持仓") ? "position-first" : ""],
        roleHint: item.role ?? "",
        themes: item.themes ?? [],
      })
    }
  }

  const postSellPath = path.join(projectPath, ".llm-wiki/post-sell-validation/latest-post-sell-validation.json")
  const postSell = readJsonMaybe(postSellPath)
  if (postSell?.items?.length) {
    sourceFiles.push(projectRelative(projectPath, postSellPath))
    for (const item of postSell.items) {
      if (item?.verdictType !== "sold_rewatch" && !item?.rewatch) continue
      const code = String(item.code ?? "")
      if (!/^\d{6}$/.test(code)) continue
      const metrics = item.metrics ?? {}
      const d1Close = Math.max(0, Number(metrics.d1CloseGainPct ?? 0))
      const d5Max = Math.max(0, Number(metrics.d5MaxGainPct ?? 0))
      const futureLimitUpCount = Math.max(0, Number(metrics.futureLimitUpCount ?? 0))
      addCandidate(byCode, code, {
        name: item.name,
        score: Math.min(1280, 620 + d1Close * 18 + d5Max * 16 + futureLimitUpCount * 160),
        reasons: [
          "卖出后继续超预期，纳入重点回看",
          futureLimitUpCount > 0 ? `卖出后仍有涨停延续(${futureLimitUpCount})` : "",
          d5Max > 0 ? `D+5最大涨幅${Math.round(d5Max * 10) / 10}%` : "",
        ],
        sourceFiles: [projectRelative(projectPath, postSellPath)],
        tags: ["post-sell-rewatch"],
        roleHint: "卖出后超预期回看",
        themes: [],
      })
    }
  }

  const emotionPath = path.join(projectPath, ".llm-wiki/akshare-emotion/latest-shortline-emotion.json")
  const emotion = readJsonMaybe(emotionPath)
  if (emotion?.pools) {
    sourceFiles.push(projectRelative(projectPath, emotionPath))
    const pools = [
      ["limit_up", 50, "akshare-limit-up", "涨停池"],
      ["strong", 40, "akshare-strong", "强势池"],
      ["previous_limit_up", 32, "akshare-previous-limit-up", "昨日涨停池"],
      ["burst", 26, "akshare-burst", "炸板池"],
    ]
    for (const [poolName, limit, tag, label] of pools) {
      const rows = (emotion.pools?.[poolName] ?? []).slice(0, limit)
      for (const item of rows) {
        const code = String(item["代码"] ?? item["证券代码"] ?? item.code ?? "")
        if (!/^\d{6}$/.test(code)) continue
        addCandidate(byCode, code, {
          name: item["名称"] ?? item["证券简称"] ?? item.name,
          score: 260 + (poolName === "limit_up" ? 420 : poolName === "strong" ? 300 : poolName === "previous_limit_up" ? 220 : 180),
          reasons: [
            `AKShare${label}`,
            item["所属行业"] ?? item["行业"] ?? item.industry ? `所属行业：${item["所属行业"] ?? item["行业"] ?? item.industry}` : "",
          ],
          sourceFiles: [projectRelative(projectPath, emotionPath)],
          tags: [tag],
          roleHint: label,
          themes: [item["所属行业"] ?? item["行业"] ?? item.industry].filter(Boolean),
        })
      }
    }
  }

  const tencentPath = path.join(projectPath, ".llm-wiki/tencent-market/latest-tencent-market.json")
  const tencent = readJsonMaybe(tencentPath)
  if (tencent?.stockQuotes?.length) {
    sourceFiles.push(projectRelative(projectPath, tencentPath))
    for (const item of tencent.stockQuotes.slice(0, 50)) {
      const code = String(item["证券代码"] ?? item.code ?? "")
      if (!/^\d{6}$/.test(code)) continue
      addCandidate(byCode, code, {
        name: item["证券简称"] ?? item.name,
        score: 180 + Math.max(-60, Math.min(60, Number(item["涨跌幅"] ?? item.changePercent ?? 0) || 0) * 10),
        reasons: [
          "Tencent quote snapshot",
          item["证券市场"] ?? item.market ? `market:${item["证券市场"] ?? item.market}` : "",
        ],
        sourceFiles: [projectRelative(projectPath, tencentPath)],
        tags: ["tencent-market"],
        roleHint: "realtime",
        themes: [item["证券市场"] ?? item.market].filter(Boolean),
      })
    }
  }

  const thsHotlistPath = path.join(projectPath, ".llm-wiki/ths-hotlist/latest-ths-hotlist.json")
  const thsHotlist = readJsonMaybe(thsHotlistPath)
  if (thsHotlist?.rows?.length) {
    sourceFiles.push(projectRelative(projectPath, thsHotlistPath))
    for (const item of thsHotlist.rows.slice(0, 100)) {
      const code = String(item.code ?? "")
      if (!/^\d{6}$/.test(code)) continue
      const rank = Math.max(1, Number(item.rank ?? 999))
      const changePercent = Number(item.changePercent ?? parseNumberLoose(item.changePercent) ?? 0)
      const turnover = Number(item.turnover ?? parseNumberLoose(item.turnover) ?? 0)
      const volumeRatio = Number(item.volumeRatio ?? parseNumberLoose(item.volumeRatio) ?? 0)
      const hotlistScore = Math.max(90, 360 - rank * 3.2)
        + Math.max(-40, Math.min(120, changePercent * 6))
        + Math.max(0, Math.min(90, turnover * 3))
        + Math.max(0, Math.min(90, volumeRatio * 18))
      addCandidate(byCode, code, {
        name: item.name,
        score: Math.round(hotlistScore * 10) / 10,
        reasons: [
          `THS hotlist rank #${rank}`,
          Number.isFinite(changePercent) ? `change ${Math.round(changePercent * 100) / 100}%` : "",
          Number.isFinite(turnover) ? `turnover ${Math.round(turnover * 100) / 100}%` : "",
          Number.isFinite(volumeRatio) ? `volume ratio ${Math.round(volumeRatio * 100) / 100}` : "",
        ],
        sourceFiles: [projectRelative(projectPath, thsHotlistPath)],
        tags: ["ths-hotlist", rank <= 10 ? "ths-hotlist-top10" : ""],
        roleHint: "crowd-attention",
        themes: [],
      })
    }
  }

  const ifindEnhancePath = path.join(projectPath, ".llm-wiki/ifind-enhance/latest-ifind-enhance.json")
  const ifindEnhance = readJsonMaybe(ifindEnhancePath)
  if (ifindEnhance?.items?.length) {
    sourceFiles.push(projectRelative(projectPath, ifindEnhancePath))
    for (const item of ifindEnhance.items.slice(0, 16)) {
      const code = String(item.code ?? "")
      if (!/^\d{6}$/.test(code)) continue
      const newsCount = Number(item.newsCount ?? 0)
      const changePercent = Number(item.changePercent ?? parseNumberLoose(item.changePercent) ?? 0)
      const confidence = Number(item.confidence ?? 0)
      const enhanceScore = 120
        + Math.min(240, newsCount * 70)
        + Math.max(-40, Math.min(100, changePercent * 5))
        + Math.round(confidence * 120)
      addCandidate(byCode, code, {
        name: item.name,
        score: Math.round(enhanceScore * 10) / 10,
        reasons: [
          "iFinD low-frequency enhancer",
          newsCount > 0 ? `licensed news hits ${newsCount}` : "",
          Number.isFinite(changePercent) ? `change ${Math.round(changePercent * 100) / 100}%` : "",
          item.summary ?? "",
        ],
        sourceFiles: [projectRelative(projectPath, ifindEnhancePath)],
        tags: ["ifind-enhance", newsCount > 0 ? "ifind-news-hit" : ""],
        roleHint: "licensed-enhancer",
        themes: item.themes ?? [],
      })
    }
  }

  const limitPath = path.join(projectPath, ".llm-wiki/limit-up-reasons/latest-limit-up-reasons.json")
  const limitReasons = readJsonMaybe(limitPath)
  if (limitReasons?.reasons?.length) {
    sourceFiles.push(projectRelative(projectPath, limitPath))
    const themeCounts = themeCountMapFromLimitReasons(limitReasons)
    for (const item of limitReasons.reasons) {
      const code = String(item.code ?? "")
      if (!/^\d{6}$/.test(code)) continue
      const height = Number(item.raw?.row?.["连板数"] ?? item.raw?.tdxReason?.height ?? 0)
      const itemThemes = splitThemes([...(item.concepts ?? []), item.theme ?? ""])
      const hotThemeBreadth = itemThemes.reduce((max, theme) => Math.max(max, themeCounts.get(theme) ?? 0), 0)
      const isWarroomHit = coreCodes.has(code) || Boolean(item.raw?.isWarroom)
      const isBackRowLimitUp = !isWarroomHit
      const themeExpansionScore = isBackRowLimitUp ? 110 + Math.min(140, hotThemeBreadth * 35) : 0
      addCandidate(byCode, code, {
        name: item.name,
        score: 360 + height * 90 + (isWarroomHit ? 260 : 0) + themeExpansionScore,
        reasons: [
          "涨停池/连板天梯热股",
          isBackRowLimitUp ? "题材后排涨停，视为板块扩散或补涨强化信号" : "",
          isBackRowLimitUp && hotThemeBreadth >= 2 ? `同题材多股涨停，扩散确认(${hotThemeBreadth})` : "",
          item.reason ? `客观涨停理由：${item.reason}` : "",
        ],
        sourceFiles: [projectRelative(projectPath, limitPath)],
        tags: [
          "limit-up",
          "eastmoney-hot",
          isWarroomHit ? "warroom-hit" : "",
          isBackRowLimitUp ? "back-row-limit-up" : "",
          isBackRowLimitUp && hotThemeBreadth >= 2 ? "theme-expansion" : "",
        ],
        themes: itemThemes,
      })
    }
  }

  const catalystPath = path.join(projectPath, ".llm-wiki/catalyst-events/latest-catalyst-events.json")
  const catalyst = readJsonMaybe(catalystPath)
  if (catalyst?.links?.length) {
    sourceFiles.push(projectRelative(projectPath, catalystPath))
    const byLinkCode = new Map()
    for (const link of catalyst.links) {
      const code = String(link.code ?? "")
      if (!/^\d{6}$/.test(code)) continue
      const current = byLinkCode.get(code) ?? {
        code,
        name: "",
        maxStrength: 0,
        reasons: [],
        sourceFiles: [],
        tags: [],
        themes: [],
      }
      if (!current.name && link.name) current.name = link.name
      current.maxStrength = Math.max(current.maxStrength, Number(link.relationStrength ?? 0))
      current.reasons.push(...(link.reasons ?? []))
      current.sourceFiles.push(...(link.evidenceFiles ?? []))
      current.tags.push(...(link.sourceTags ?? []))
      current.themes.push(...(link.themes ?? []))
      byLinkCode.set(code, current)
    }

    for (const item of byLinkCode.values()) {
      addCandidate(byCode, item.code, {
        name: item.name,
        score: Math.min(520, item.maxStrength * 2.4 + item.reasons.length * 18),
        reasons: ["催化事件关联", ...unique(item.reasons).slice(0, 3)],
        sourceFiles: [projectRelative(projectPath, catalystPath), ...unique(item.sourceFiles).slice(0, 3)],
        tags: ["catalyst-event", ...unique(item.tags).slice(0, 3)],
        themes: item.themes,
      })
    }
  }

  const dateContext = resolveWatchlistTradeDateContext({
    preopen,
    postSell,
    emotion,
    tencent,
    thsHotlist,
    ifindEnhance,
    limitReasons,
    catalyst,
  })

  return {
    tradeDate: dateContext.tradeDate,
    planTradeDate: dateContext.planTradeDate,
    evidenceTradeDate: dateContext.evidenceTradeDate,
    sourceTradeDates: dateContext.sourceTradeDates,
    hasDateMismatch: dateContext.hasDateMismatch,
    scannedFiles: sourceFiles.length,
    sourceFiles: unique(sourceFiles),
    candidates: [...byCode.values()].map(normalizeCandidateScore),
  }
}

function classify(candidates, { maxSymbols, focusLimit }) {
  const sorted = [...candidates]
    .filter((item) => item.score > 0)
    .sort((a, b) => priorityRank(a) - priorityRank(b) || b.score - a.score || a.code.localeCompare(b.code))

  const focus = sorted.slice(0, Number(focusLimit)).map((item) => ({
    ...item,
    tier: "focus",
    role: priorityRank(item) <= -2 ? "持仓处理" : "重点跟踪",
    priorityRank: priorityRank(item),
  }))

  const focusCodes = new Set(focus.map((item) => item.code))
  const normal = sorted
    .filter((item) => !focusCodes.has(item.code))
    .slice(0, Math.max(0, Number(maxSymbols) - focus.length))
    .map((item) => ({
      ...item,
      tier: "normal",
      role: "普通观察",
      priorityRank: priorityRank(item),
    }))

  return {
    focus,
    warroom: [...focus, ...normal],
    normal,
    symbols: unique([...focus, ...normal].map((item) => item.code)),
  }
}

function buildRecord(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const generatedAt = nowLocalTimestamp()
  const collected = collectCandidates(projectPath)
  const tiers = classify(collected.candidates, {
    maxSymbols: Number(options.maxSymbols ?? 50),
    focusLimit: Number(options.focusLimit ?? 10),
  })
  const summaryText = tiers.focus.map((item) => `${item.name || item.code}(${item.code})`).join("、")

  return {
    schema: "73wiki-warroom-watchlist-v1",
    id: `warroom_watchlist_${idTimestamp()}_${shortHash(JSON.stringify(tiers.symbols))}`,
    status: "active",
    title: `${collected.tradeDate} 作战室分层股票池`,
    generatedAt,
    tradeDate: collected.planTradeDate,
    planTradeDate: collected.planTradeDate,
    evidenceTradeDate: collected.evidenceTradeDate,
    sourceTradeDates: collected.sourceTradeDates,
    hasDateMismatch: collected.hasDateMismatch,
    source: "73wiki-market-watchlist",
    sourceTier: "local_brain",
    projectPath: ".",
    scannedFiles: collected.scannedFiles,
    sourceFiles: collected.sourceFiles,
    dataQuality: {
      tomorrowScoreTableFilled: false,
      note: "清单按收盘持仓处理、盘前情报、涨停结构、同花顺热榜、iFinD低频增强、催化事件综合生成，不是自动买入建议。",
    },
    tiers,
    symbols: tiers.symbols,
    summary: summaryText
      ? `作战室重点跟踪 ${tiers.focus.length} 只：${summaryText}。盘中必须用竞价、分时、连板和板块强度二次确认。`
      : "未提取到可用的作战室重点票。",
    claim: "优先级：收盘持仓处理 > 盘前情报 > 涨停结构与题材扩散 > 同花顺热榜人气确认 > iFinD低频增强复核 > 其他催化事件。它们都不是自动买入建议。",
    tags: ["warroom", "watchlist", "作战室", "重点票", "普通票"],
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: npm run market:watchlist -- --project C:\\wiki\\73神话 --write")
    return
  }

  const projectPath = path.resolve(args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH)
  const record = buildRecord({
    projectPath,
    maxSymbols: Number(args["max-symbols"] ?? 50),
    focusLimit: Number(args["focus-limit"] ?? 10),
  })

  const reportDir = path.join(projectPath, REPORT_ROOT)
  const reportPath = path.join(reportDir, `${idTimestamp()}-warroom-watchlist.json`)
  const latestPath = path.join(reportDir, "latest-warroom-watchlist.json")
  const factPath = path.join(projectPath, FACT_PATH)
  const output = {
    dryRun: !args.write,
    record,
    writePaths: {
      facts: FACT_PATH,
      reportRoot: REPORT_ROOT,
    },
  }

  if (args.write) {
    appendJsonl(factPath, record)
    writeJson(reportPath, record)
    writeJson(latestPath, record)
    output.written = {
      facts: projectRelative(projectPath, factPath),
      report: projectRelative(projectPath, reportPath),
      latest: projectRelative(projectPath, latestPath),
    }
  }

  console.log(JSON.stringify(output, null, 2))
}

main()
