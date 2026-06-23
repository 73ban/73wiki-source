#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { detectAiSubthemes } from "./trading-policy.mjs"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const REPORT_ROOT = ".llm-wiki/archive-skeletons"
const PREDICTION_PATH = ".llm-wiki/prediction-candidates/latest-prediction-candidates.json"
const CATALYST_PATH = ".llm-wiki/catalyst-events/latest-catalyst-events.json"
const STOCK_ROOT = "wiki/03-L3个股档案/RAW增量个股卡"
const THEME_ROOT = "wiki/02-L2方向题材/RAW增量题材卡"
const AUTO_META_START = "<!-- 73WIKI:AUTO_META:START -->"
const AUTO_META_END = "<!-- 73WIKI:AUTO_META:END -->"
const MAX_HISTORY_ENTRIES = 12
const GRADE_ORDER = { "A+": 4, A: 3, B: 2, C: 1 }
const BROAD_THEME_LABELS = new Set([
  "AI",
  "人工智能",
  "半导体",
  "芯片",
  "军工",
  "有色",
  "消费",
  "金融",
  "新能源",
  "医药",
  "农业",
  "数字经济",
])

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

function readJson(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing file: ${filePath}`)
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function readTextMaybe(filePath) {
  if (!fs.existsSync(filePath)) return ""
  return fs.readFileSync(filePath, "utf8")
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean))]
}

function uniqueObjects(values) {
  return unique((values ?? []).map((item) => JSON.stringify(item))).map((item) => JSON.parse(item))
}

function codeBase(value) {
  return String(value ?? "").replace(/\.(SH|SZ|BJ)$/i, "")
}

function gradeRank(value) {
  return GRADE_ORDER[String(value ?? "C")] ?? 0
}

function pickHigherGrade(left, right) {
  return gradeRank(left) >= gradeRank(right) ? left : right
}

function sanitizeSegment(value, fallback = "unknown") {
  const text = String(value ?? "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
  return text || fallback
}

function relativePath(projectPath, filePath) {
  return path.relative(path.resolve(projectPath), path.resolve(filePath)).replace(/\\/g, "/")
}

function isMeaningfulTheme(value) {
  const text = String(value ?? "").trim()
  if (!text) return false
  if (text.length < 2 || text.length > 24) return false
  if (/^\d+$/.test(text)) return false
  if (/^(公司|个股|题材|概念|消息|公告|研报|截图|图片|正文|来源|标题)$/i.test(text)) return false
  return true
}

function isLikelyDisplayName(value) {
  const text = String(value ?? "").trim()
  if (!text) return false
  if (text.length < 2 || text.length > 8) return false
  if (/^[A-Za-z0-9*]+$/.test(text)) return false
  if (/^(公司|个股|题材|概念|消息|公告|研报|截图|图片|正文|来源|标题|利好|利空)$/i.test(text)) return false
  return true
}

function collectExistingStockNames(projectPath) {
  const rootDir = path.join(projectPath, "wiki/03-L3个股档案")
  const byCode = new Map()
  if (!fs.existsSync(rootDir)) return byCode
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const base = entry.name.replace(/\.md$/i, "")
    let match = base.match(/^(\d{6})-([^-]+?)(?:-|$)/)
    if (match) {
      byCode.set(match[1], match[2])
      continue
    }
    match = base.match(/^([^-]+?)-(\d{6})(?:-|$)/)
    if (match) byCode.set(match[2], match[1])
  }
  return byCode
}

function walkFiles(rootDir, extensions, limit = 240) {
  const files = []
  function walk(currentDir) {
    if (!fs.existsSync(currentDir) || files.length >= limit) return
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (files.length >= limit) return
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
        continue
      }
      if (extensions.has(path.extname(entry.name).toLowerCase())) files.push(fullPath)
    }
  }
  walk(rootDir)
  return files
}

function collectCorpusNameHints(projectPath) {
  const counts = new Map()
  const add = (code, name) => {
    const cleanCode = codeBase(code)
    const cleanName = String(name ?? "").trim()
    if (!/^\d{6}$/.test(cleanCode) || !isLikelyDisplayName(cleanName)) return
    const key = `${cleanCode}::${cleanName}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const roots = [
    path.join(projectPath, "raw/04-行情市场数据"),
    path.join(projectPath, ".llm-wiki/akshare-emotion"),
    path.join(projectPath, ".llm-wiki/preopen"),
  ]
  const patterns = [
    /"f12"\s*:\s*"(\d{6})"[\s\S]{0,100}?"f14"\s*:\s*"([^"]{2,12})"/g,
    /"代码"\s*:\s*"(\d{6})"[\s\S]{0,100}?"名称"\s*:\s*"([^"]{2,12})"/g,
    /([\u4e00-\u9fa5A-Za-z]{2,12})\s*[（(](\d{6})[）)]/g,
  ]
  for (const rootDir of roots) {
    for (const filePath of walkFiles(rootDir, new Set([".json", ".md", ".txt"]))) {
      const stat = fs.statSync(filePath)
      if (stat.size > 2_000_000) continue
      const text = fs.readFileSync(filePath, "utf8")
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
          if (pattern === patterns[2]) add(match[2], match[1])
          else add(match[1], match[2])
        }
      }
    }
  }

  const byCode = new Map()
  for (const [key, count] of counts.entries()) {
    const [code, name] = key.split("::")
    const current = byCode.get(code)
    if (!current || count > current.count) byCode.set(code, { name, count })
  }
  return new Map([...byCode.entries()].map(([code, value]) => [code, value.name]))
}

function stockFileName(stock) {
  if (stock.code && stock.name) return `${sanitizeSegment(stock.code)}-${sanitizeSegment(stock.name)}-RAW增量骨架.md`
  if (stock.code) return `${sanitizeSegment(stock.code)}-RAW增量骨架.md`
  return `${sanitizeSegment(stock.name || "unknown-stock")}-RAW增量骨架.md`
}

function themeFileName(theme) {
  return `${sanitizeSegment(theme)}-RAW增量骨架.md`
}

function isBroadThemeLabel(theme) {
  return BROAD_THEME_LABELS.has(String(theme ?? "").trim())
}

function normalizeThemeList(themes, limit = 16, broadLimit = 4) {
  const merged = unique(themes).filter(isMeaningfulTheme)
  const specific = merged.filter((item) => !isBroadThemeLabel(item))
  const broad = merged.filter((item) => isBroadThemeLabel(item))
  return [...specific, ...broad.slice(0, broadLimit)].slice(0, limit)
}

function themeSpecificityRank(theme) {
  return isBroadThemeLabel(theme?.theme ?? theme) ? 0 : 1
}

function summarizeList(items, limit = 4, maxLength = 120) {
  const text = unique(items).slice(0, limit).join(" / ")
  if (!text) return ""
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text
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

function extractManagedMeta(filePath) {
  const text = readTextMaybe(filePath)
  if (!text) return null
  const start = text.indexOf(AUTO_META_START)
  const end = text.indexOf(AUTO_META_END)
  if (start < 0 || end < 0 || end <= start) return null
  const payload = text.slice(start + AUTO_META_START.length, end).trim()
  if (!payload) return null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

function historyFingerprint(entry = {}) {
  return [
    entry.subject ?? "",
    entry.tradeDate ?? "",
    entry.signalGrade ?? "",
    entry.changeType ?? "",
    entry.summary ?? "",
  ].join("::")
}

function mergeHistory(existingEntries, nextEntry, limit = MAX_HISTORY_ENTRIES) {
  const merged = new Map()
  for (const entry of [...(existingEntries ?? []), nextEntry].filter(Boolean)) {
    const fingerprint = historyFingerprint(entry)
    const current = merged.get(fingerprint)
    if (!current || String(entry.timestamp ?? "") > String(current.timestamp ?? "")) merged.set(fingerprint, entry)
  }
  return [...merged.values()]
    .sort((left, right) => String(right.timestamp ?? "").localeCompare(String(left.timestamp ?? "")))
    .slice(0, limit)
}

function resolveChangeType(existingMeta, nextGrade, nextCoverageSize) {
  if (!existingMeta) return "auto-create"
  if (gradeRank(nextGrade) > gradeRank(existingMeta.signalGrade)) return "signal-upgrade"
  if (Number(nextCoverageSize ?? 0) > Number(existingMeta.coverageSize ?? 0)) return "coverage-expanded"
  return "auto-refresh"
}

function buildManagedMeta(kind, subject, item, record, existingMeta) {
  const coverageSize = kind === "stock" ? (item.themes?.length ?? 0) : (item.stocks?.length ?? 0)
  const latestCatalyst = summarizeList(item.reasons, 3, 100) || "待补充"
  const changeType = resolveChangeType(existingMeta, item.signalGrade, coverageSize)
  const summary =
    kind === "stock"
      ? `themes=${summarizeList(item.themes, 4, 80) || "none"}; catalyst=${latestCatalyst}`
      : `stocks=${item.stocks?.length ?? 0}; catalyst=${latestCatalyst}`
  const nextEntry = {
    timestamp: record.generatedAt,
    tradeDate: record.tradeDate,
    subject,
    signalGrade: item.signalGrade,
    changeType,
    summary,
  }
  return {
    kind,
    subject,
    firstSeenAt: existingMeta?.firstSeenAt ?? record.generatedAt,
    lastUpdated: record.generatedAt,
    signalGrade: item.signalGrade,
    changeType,
    latestCatalyst,
    coverageSize,
    sourceFiles: unique(item.sourceFiles).slice(0, 12),
    sourceTags: unique(item.sourceTags).slice(0, 8),
    history: mergeHistory(existingMeta?.history, nextEntry),
  }
}

function managedMetaBlock(meta) {
  return `${AUTO_META_START}\n${JSON.stringify(meta, null, 2)}\n${AUTO_META_END}`
}

function renderHistory(history) {
  if (!history?.length) return ["- 暂无记录"]
  return history.map((entry) => `- ${entry.timestamp} | ${entry.changeType} | signal=${entry.signalGrade} | ${entry.summary}`)
}

function collectStocks(predictionRecord, catalystRecord, maxStocks, existingNames) {
  const stocks = new Map()
  const touch = (code, patch) => {
    const cleanCode = codeBase(code)
    if (!/^\d{6}$/.test(cleanCode)) return
    const current = stocks.get(cleanCode) ?? {
      code: cleanCode,
      name: "",
      signalGrade: "C",
      scores: [],
      themes: [],
      aiSubthemes: [],
      reasons: [],
      invalidations: [],
      evidence: [],
      sourceFiles: [],
      sourceTags: [],
      candidates: [],
      relationStrength: 0,
      policy: {
        writeThemeCard: false,
        writeStockCard: false,
        enterCandidatePool: false,
        enterCorePool: false,
      },
    }
    if (patch.name && !current.name) current.name = patch.name
    current.signalGrade = pickHigherGrade(current.signalGrade, patch.signalGrade ?? "C")
    current.relationStrength = Math.max(current.relationStrength, Number(patch.relationStrength ?? 0))
    current.scores.push(...(patch.scores ?? []))
    current.themes.push(...(patch.themes ?? []))
    current.aiSubthemes.push(...(patch.aiSubthemes ?? []))
    current.reasons.push(...(patch.reasons ?? []))
    current.invalidations.push(...(patch.invalidations ?? []))
    current.sourceFiles.push(...(patch.sourceFiles ?? []))
    current.sourceTags.push(...(patch.sourceTags ?? []))
    current.candidates.push(...(patch.candidates ?? []))
    current.evidence.push(...(patch.evidence ?? []))
    current.policy = {
      writeThemeCard: current.policy.writeThemeCard || Boolean(patch.policy?.writeThemeCard),
      writeStockCard: current.policy.writeStockCard || Boolean(patch.policy?.writeStockCard),
      enterCandidatePool: current.policy.enterCandidatePool || Boolean(patch.policy?.enterCandidatePool),
      enterCorePool: current.policy.enterCorePool || Boolean(patch.policy?.enterCorePool),
    }
    stocks.set(cleanCode, current)
  }

  for (const item of predictionRecord?.candidates ?? []) {
    touch(item.code, {
      name: item.name,
      signalGrade: item.signalGrade,
      scores: [Number(item.score ?? 0)],
      themes: [...(item.themes ?? []), ...(item.aiSubthemes ?? [])],
      aiSubthemes: item.aiSubthemes ?? [],
      reasons: item.reasons ?? [],
      invalidations: item.invalidations ?? [],
      sourceFiles: item.sourceFiles ?? [],
      sourceTags: item.sourceTags ?? [],
      evidence: item.evidence ?? [],
      candidates: [item.summary].filter(Boolean),
      policy: item.policy,
    })
  }

  for (const link of catalystRecord?.links ?? []) {
    touch(link.code, {
      name: link.name,
      relationStrength: Number(link.relationStrength ?? 0),
      themes: link.themes ?? [],
      reasons: link.reasons ?? [],
      sourceFiles: link.evidenceFiles ?? [],
      sourceTags: link.sourceTags ?? [],
      evidence: (link.raw?.evidence ?? []).slice(0, 3),
      policy: {
        writeThemeCard: link.raw?.upgradeEligible !== false,
        writeStockCard: link.raw?.upgradeEligible !== false,
        enterCandidatePool: false,
        enterCorePool: false,
      },
    })
  }

  return [...stocks.values()]
    .map((stock) => ({
      ...stock,
      name:
        existingNames.get(stock.code) ??
        ((stock.sourceTags ?? []).some((tag) => /position|watchlist|limit-up-reason/.test(tag)) && isLikelyDisplayName(stock.name)
          ? stock.name
          : ""),
      score: Math.max(...stock.scores, 0),
      themes: normalizeThemeList(stock.themes, 16, 4),
      aiSubthemes: unique(stock.aiSubthemes).filter(isMeaningfulTheme).slice(0, 12),
      reasons: unique(stock.reasons).slice(0, 8),
      invalidations: unique(stock.invalidations).slice(0, 6),
      sourceFiles: unique(stock.sourceFiles).slice(0, 12),
      sourceTags: unique(stock.sourceTags).slice(0, 8),
      candidates: unique(stock.candidates).slice(0, 4),
      evidence: uniqueObjects(stock.evidence).slice(0, 6),
    }))
    .filter((stock) => Boolean(stock.name))
    .sort((left, right) =>
      gradeRank(right.signalGrade) - gradeRank(left.signalGrade) ||
      right.score - left.score ||
      right.relationStrength - left.relationStrength ||
      left.code.localeCompare(right.code)
    )
    .slice(0, Number(maxStocks))
}

function collectThemes(predictionRecord, catalystRecord, stocks, maxThemes) {
  const themes = new Map()
  const touch = (themeName, patch) => {
    const theme = String(themeName ?? "").trim()
    if (!isMeaningfulTheme(theme)) return
    const current = themes.get(theme) ?? {
      theme,
      signalGrade: "C",
      stocks: [],
      aiSubthemes: [],
      reasons: [],
      sourceFiles: [],
      sourceTags: [],
      catalystEvents: [],
      scores: [],
    }
    current.signalGrade = pickHigherGrade(current.signalGrade, patch.signalGrade ?? "C")
    current.stocks.push(...(patch.stocks ?? []))
    current.aiSubthemes.push(...(patch.aiSubthemes ?? []))
    current.reasons.push(...(patch.reasons ?? []))
    current.sourceFiles.push(...(patch.sourceFiles ?? []))
    current.sourceTags.push(...(patch.sourceTags ?? []))
    current.catalystEvents.push(...(patch.catalystEvents ?? []))
    current.scores.push(...(patch.scores ?? []))
    themes.set(theme, current)
  }

  for (const stock of stocks) {
    for (const theme of stock.themes) {
      touch(theme, {
        signalGrade: stock.signalGrade,
        stocks: [{ code: stock.code, name: stock.name, signalGrade: stock.signalGrade }],
        aiSubthemes: detectAiSubthemes([theme, ...(stock.aiSubthemes ?? []), ...(stock.reasons ?? [])]),
        reasons: stock.reasons.slice(0, 4),
        sourceFiles: stock.sourceFiles,
        sourceTags: stock.sourceTags,
        scores: [stock.score],
      })
    }
  }

  for (const event of catalystRecord?.events ?? []) {
    for (const theme of event.themes ?? []) {
      touch(theme, {
        signalGrade: "B",
        reasons: [event.summary].filter(Boolean),
        sourceFiles: [event.raw?.sourceFile, event.sourcePath].filter(Boolean),
        sourceTags: [event.source, event.sourceTier].filter(Boolean),
        catalystEvents: [{ title: event.title, source: event.source, score: event.catalystScore }],
        scores: [Number(event.catalystScore ?? 0)],
      })
    }
  }

  return [...themes.values()]
    .map((theme) => ({
      ...theme,
      score: Math.max(...theme.scores, 0),
      stocks: uniqueObjects(theme.stocks).slice(0, 16),
      aiSubthemes: unique(theme.aiSubthemes).filter(isMeaningfulTheme).slice(0, 8),
      reasons: unique(theme.reasons).slice(0, 8),
      sourceFiles: unique(theme.sourceFiles).slice(0, 12),
      sourceTags: unique(theme.sourceTags).slice(0, 8),
      catalystEvents: uniqueObjects(theme.catalystEvents).slice(0, 8),
      scope: isBroadThemeLabel(theme.theme) ? "broad" : "specific",
    }))
    .sort((left, right) =>
      gradeRank(right.signalGrade) - gradeRank(left.signalGrade) ||
      themeSpecificityRank(right) - themeSpecificityRank(left) ||
      right.score - left.score ||
      right.stocks.length - left.stocks.length ||
      left.theme.localeCompare(right.theme)
    )
    .slice(0, Number(maxThemes))
}

function stockCardMarkdown(stock, record, existingMeta) {
  const meta = buildManagedMeta("stock", stock.code, stock, record, existingMeta)
  const lines = [
    `# ${stock.name || stock.code} RAW增量骨架档案`,
    "",
    "```yaml",
    `code: ${stock.code}`,
    `name: ${stock.name || ""}`,
    `trade_date: ${record.tradeDate}`,
    `plan_trade_date: ${record.planTradeDate || record.tradeDate}`,
    `evidence_trade_date: ${record.evidenceTradeDate || record.tradeDate}`,
    `generated_at: ${record.generatedAt}`,
    `first_seen_at: ${meta.firstSeenAt}`,
    `last_updated: ${meta.lastUpdated}`,
    `change_type: ${meta.changeType}`,
    `signal_grade: ${stock.signalGrade}`,
    `score: ${stock.score}`,
    `relation_strength: ${stock.relationStrength}`,
    `theme_count: ${stock.themes.length}`,
    `source_file_count: ${meta.sourceFiles.length}`,
    `write_stock_card: ${stock.policy.writeStockCard}`,
    `enter_candidate_pool: ${stock.policy.enterCandidatePool}`,
    `enter_core_pool: ${stock.policy.enterCorePool}`,
    `latest_catalyst_summary: ${meta.latestCatalyst}`,
    "```",
    "",
    "## 当前定位",
    "",
    "- 来源：RAW 提到且存在催化，先建骨架档，不直接替代正式厚卡。",
    `- 当前等级：${stock.signalGrade}`,
    `- 当前状态：${stock.policy.enterCorePool ? "重点核心候选" : stock.policy.enterCandidatePool ? "观察候选" : "仅建档跟踪"}`,
    "",
    "## 自动补卡状态",
    "",
    `- 首次建档：${meta.firstSeenAt}`,
    `- 最近更新：${meta.lastUpdated}`,
    `- 本次变更：${meta.changeType}`,
    `- 最新催化摘要：${meta.latestCatalyst}`,
    `- 来源文件数：${meta.sourceFiles.length}`,
    "",
    "## 关联题材",
    "",
    ...(stock.themes.length ? stock.themes.map((theme) => `- ${theme}`) : ["- 待补充"]),
    "",
    "## AI细分",
    "",
    ...(stock.aiSubthemes.length ? stock.aiSubthemes.map((theme) => `- ${theme}`) : ["- 暂无"]),
    "",
    "## 最近催化",
    "",
    ...(stock.reasons.length ? stock.reasons.map((reason) => `- ${reason}`) : ["- 待补充"]),
    "",
    "## 失效条件",
    "",
    ...(stock.invalidations.length ? stock.invalidations.map((item) => `- ${item}`) : ["- 待补充"]),
    "",
    "## 证据来源",
    "",
    ...(stock.evidence.length
      ? stock.evidence.map((item) => `- ${item.file ?? "unknown"} :: ${String(item.excerpt ?? "").slice(0, 180)}`)
      : meta.sourceFiles.length
        ? meta.sourceFiles.map((file) => `- ${file}`)
        : ["- 待补充"]),
    "",
    "## 制度化更新记录",
    "",
    ...renderHistory(meta.history),
    "",
    managedMetaBlock(meta),
    "",
  ]
  return `${lines.join("\n").trim()}\n`
}

function themeCardMarkdown(theme, record, existingMeta) {
  const meta = buildManagedMeta("theme", theme.theme, theme, record, existingMeta)
  const lines = [
    `# ${theme.theme} RAW增量骨架档案`,
    "",
    "```yaml",
    `theme: ${theme.theme}`,
    `trade_date: ${record.tradeDate}`,
    `plan_trade_date: ${record.planTradeDate || record.tradeDate}`,
    `evidence_trade_date: ${record.evidenceTradeDate || record.tradeDate}`,
    `generated_at: ${record.generatedAt}`,
    `first_seen_at: ${meta.firstSeenAt}`,
    `last_updated: ${meta.lastUpdated}`,
    `change_type: ${meta.changeType}`,
    `theme_scope: ${theme.scope ?? "specific"}`,
    `signal_grade: ${theme.signalGrade}`,
    `score: ${theme.score}`,
    `related_stocks: ${theme.stocks.length}`,
    `source_file_count: ${meta.sourceFiles.length}`,
    `latest_catalyst_summary: ${meta.latestCatalyst}`,
    "```",
    "",
    "## 当前定位",
    "",
    "- 来源：RAW 首次或再次提到该题材后自动建档。",
    `- 当前等级：${theme.signalGrade}`,
    `- 当前状态：${theme.signalGrade === "A+" || theme.signalGrade === "A" ? "进入重点跟踪" : theme.signalGrade === "B" ? "进入知识补卡" : "仅建骨架"}`,
    `- 题材层级：${theme.scope === "broad" ? "宽题材背景" : "可交易细分题材"}`,
    "",
    "## 自动补卡状态",
    "",
    `- 首次建档：${meta.firstSeenAt}`,
    `- 最近更新：${meta.lastUpdated}`,
    `- 本次变更：${meta.changeType}`,
    `- 最新催化摘要：${meta.latestCatalyst}`,
    "",
    "## 题材理解",
    "",
    "- 待继续厚化：定义、产业链、受益方向、预期差、失效条件。",
    "",
    "## 关联个股",
    "",
    ...(theme.stocks.length
      ? theme.stocks.map((stock) => `- ${stock.code}${stock.name ? ` ${stock.name}` : ""} | grade=${stock.signalGrade}`)
      : ["- 待补充"]),
    "",
    "## 最近催化",
    "",
    ...(theme.reasons.length ? theme.reasons.map((reason) => `- ${reason}`) : ["- 待补充"]),
    "",
    "## AI细分",
    "",
    ...(theme.aiSubthemes.length ? theme.aiSubthemes.map((item) => `- ${item}`) : ["- 暂无"]),
    "",
    "## 证据来源",
    "",
    ...(meta.sourceFiles.length ? meta.sourceFiles.map((file) => `- ${file}`) : ["- 待补充"]),
    "",
    "## 制度化更新记录",
    "",
    ...renderHistory(meta.history),
    "",
    managedMetaBlock(meta),
    "",
  ]
  return `${lines.join("\n").trim()}\n`
}

function markdownReport(record) {
  const lines = [
    `# ${record.title}`,
    "",
    `Generated: ${record.generatedAt}`,
    `Trade date: ${record.tradeDate}`,
    `Plan trade date: ${record.planTradeDate || record.tradeDate}`,
    `Evidence trade date: ${record.evidenceTradeDate || record.tradeDate}`,
    `Date status: ${record.hasDateMismatch ? "mismatch" : "aligned"}`,
    `Stocks written: ${record.counts.stocks}`,
    `Themes written: ${record.counts.themes}`,
    "",
    "## Top Stocks",
    "",
    ...record.topStocks.map((item) => `- ${item.code}${item.name ? ` ${item.name}` : ""} | grade=${item.signalGrade} | score=${item.score}`),
    "",
    "## Top Themes",
    "",
    ...record.topThemes.map((item) => `- ${item.theme} | grade=${item.signalGrade} | stocks=${item.stocks}`),
    "",
  ]
  return `${lines.join("\n").trim()}\n`
}

function buildRecord({ projectPath, maxStocks, maxThemes }) {
  const generatedAt = nowLocalTimestamp()
  const predictionRecord = readJson(path.join(projectPath, PREDICTION_PATH))
  const catalystRecord = readJson(path.join(projectPath, CATALYST_PATH))
  const planTradeDate = firstTradeDate(
    predictionRecord?.planTradeDate,
    predictionRecord?.tradeDate,
    catalystRecord?.planTradeDate,
    catalystRecord?.tradeDate,
    generatedAt.slice(0, 10),
  ) ?? generatedAt.slice(0, 10)
  const sourceTradeDates = {
    predictionPlan: normalizeTradeDate(predictionRecord?.planTradeDate ?? predictionRecord?.tradeDate),
    predictionEvidence: normalizeTradeDate(predictionRecord?.evidenceTradeDate),
    catalystPlan: normalizeTradeDate(catalystRecord?.planTradeDate ?? catalystRecord?.tradeDate),
    catalystEvidence: normalizeTradeDate(catalystRecord?.evidenceTradeDate),
  }
  const evidenceTradeDate = latestTradeDate([
    sourceTradeDates.predictionEvidence,
    sourceTradeDates.catalystEvidence,
  ]) ?? planTradeDate
  const tradeDate = planTradeDate
  const distinctTradeDates = [...new Set(Object.values(sourceTradeDates).filter(Boolean))]
  const existingNames = new Map([
    ...collectExistingStockNames(projectPath).entries(),
    ...collectCorpusNameHints(projectPath).entries(),
  ])
  const stocks = collectStocks(predictionRecord, catalystRecord, maxStocks, existingNames)
  const themes = collectThemes(predictionRecord, catalystRecord, stocks, maxThemes)
  return {
    schema: "73wiki-archive-skeletons-v1",
    id: `archive_skeletons_${tradeDate.replace(/-/g, "")}_${idTimestamp()}`,
    title: `${tradeDate} RAW增量骨架档案`,
    generatedAt,
    tradeDate,
    planTradeDate,
    evidenceTradeDate,
    sourceTradeDates,
    hasDateMismatch: distinctTradeDates.length > 1,
    source: "73wiki-archive-skeletons",
    projectPath,
    stocks,
    themes,
    counts: {
      stocks: stocks.length,
      themes: themes.length,
    },
    topStocks: stocks.slice(0, 12).map((item) => ({
      code: item.code,
      name: item.name,
      signalGrade: item.signalGrade,
      score: item.score,
    })),
    topThemes: themes.slice(0, 12).map((item) => ({
      theme: item.theme,
      signalGrade: item.signalGrade,
      stocks: item.stocks.length,
    })),
  }
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const record = buildRecord({
    projectPath,
    maxStocks: Number(options.maxStocks ?? 120),
    maxThemes: Number(options.maxThemes ?? 80),
  })
  if (!options.write) return { dryRun: true, record }

  const stockDir = path.join(projectPath, STOCK_ROOT)
  const themeDir = path.join(projectPath, THEME_ROOT)
  const reportDir = path.join(projectPath, REPORT_ROOT)
  const stockFiles = []
  const themeFiles = []

  for (const stock of record.stocks) {
    const filePath = path.join(stockDir, stockFileName(stock))
    const existingMeta = extractManagedMeta(filePath)
    writeText(filePath, stockCardMarkdown(stock, record, existingMeta))
    stockFiles.push(relativePath(projectPath, filePath))
  }

  for (const theme of record.themes) {
    const filePath = path.join(themeDir, themeFileName(theme.theme))
    const existingMeta = extractManagedMeta(filePath)
    writeText(filePath, themeCardMarkdown(theme, record, existingMeta))
    themeFiles.push(relativePath(projectPath, filePath))
  }

  const jsonPath = path.join(reportDir, `${idTimestamp()}-archive-skeletons.json`)
  const mdPath = path.join(reportDir, `${idTimestamp()}-archive-skeletons.md`)
  const latestJson = path.join(reportDir, "latest-archive-skeletons.json")
  const latestMd = path.join(reportDir, "latest-archive-skeletons.md")

  writeJson(jsonPath, { ...record, stockFiles, themeFiles })
  writeJson(latestJson, { ...record, stockFiles, themeFiles })
  writeText(mdPath, markdownReport(record))
  writeText(latestMd, markdownReport(record))

  return {
    dryRun: false,
    record,
    written: {
      stockFiles,
      themeFiles,
      report: relativePath(projectPath, jsonPath),
      markdown: relativePath(projectPath, mdPath),
      latest: relativePath(projectPath, latestJson),
    },
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/archive-skeletons.mjs --project C:\\wiki\\73神话 --write")
    return
  }
  const result = run({
    projectPath: args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH,
    maxStocks: Number(args["max-stocks"] ?? 120),
    maxThemes: Number(args["max-themes"] ?? 80),
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
      counts: result.record.counts,
      topStocks: result.record.topStocks,
      topThemes: result.record.topThemes,
      written: result.written ?? null,
    }, null, 2))
  }
}

main()
