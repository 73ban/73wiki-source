import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

export const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
export const REPORT_ROOT = ".llm-wiki/codex-ingest"
export const TEMPORAL_FACTS_PATH = "data/facts/temporal_edges.jsonl"
export const TEMPORAL_FACTS_INDEX_PATH = "data/facts/temporal_edges.index.json"
export const MARKET_SNAPSHOTS_PATH = "data/facts/market_snapshots.jsonl"
export const SHORTLINE_EMOTION_PATH = "data/facts/shortline_emotion_snapshots.jsonl"
export const TDX_MCP_SNAPSHOTS_PATH = "data/facts/tdx_mcp_snapshots.jsonl"
export const BRAIN_ROOT = "data/brain"
export const MANIFEST_SCHEMA = "73wiki-codex-ingest-manifest-v1"

export const WIKI_DIRS = Object.freeze({
  l1: "wiki/01-L1市场环境",
  l2: "wiki/02-L2方向题材",
  l3: "wiki/03-L3个股档案",
  l4: "wiki/04-L4交易模式与执行",
  warRoom: "wiki/07-作战室",
  sources: "wiki/08-信息来源",
  stats: "wiki/09-统计与进化",
  system: "wiki/10-系统配置",
})

export const EVIDENCE_PREFIXES = Object.freeze({
  wiki: "W",
  raw: "R",
  graph: "G",
  facts: "F",
  memory: "M",
  stats: "S",
})

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".jsonl", ".csv", ".tsv", ".log"])
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "target", ".obsidian", ".system"])
const BRAIN_TYPE_TO_FILE = new Map([
  ["correction", "corrections.jsonl"],
  ["thread", "active_threads.jsonl"],
  ["preference", "preferences.jsonl"],
  ["guardrail", "guardrails.jsonl"],
  ["prediction", "predictions.jsonl"],
  ["validation", "validations.jsonl"],
])
const FACT_STATUSES = new Set(["active", "superseded", "invalidated", "expired"])
const EVIDENCE_LEVELS = new Set(["A", "B", "C", "D"])
const FACT_PREDICATES = new Set([
  "HAS_CATALYST",
  "HAS_ORDER",
  "HAS_ORDER_RUMOR",
  "HAS_ORDER_INTENT",
  "HAS_CONFIRMED_ORDER",
  "HAS_DELIVERY_VALIDATION",
  "HAS_CUSTOMER",
  "HAS_CAPACITY",
  "HAS_PRICE_SIGNAL",
  "HAS_POLICY_SUPPORT",
  "HAS_PRODUCT",
  "HAS_TECH_PROGRESS",
  "HAS_SUPPLY_CONSTRAINT",
  "HAS_VALIDATION_SIGNAL",
  "PRICE_VALIDATED",
  "VOLUME_VALIDATED",
  "CUSTOMER_VALIDATED",
  "TECH_VALIDATED",
  "FUNDAMENTAL_VALIDATED",
  "HAS_RISK",
  "HAS_CLARIFICATION_RISK",
  "HAS_COMPETITION_RISK",
  "HAS_DEMAND_RISK",
  "HAS_SUPPLY_CHAIN_RISK",
  "HAS_VALUATION_RISK",
  "VALIDATES",
  "CONTRADICTS",
  "DPLUS_VALIDATED",
  "CANDIDATE_VALIDATED",
  "PATTERN_VALIDATED",
])
const AUDIT_KEYWORDS = [
  ["订单", "HAS_ORDER"],
  ["中标", "HAS_CONFIRMED_ORDER"],
  ["客户", "HAS_CUSTOMER"],
  ["涨价", "HAS_PRICE_SIGNAL"],
  ["政策", "HAS_POLICY_SUPPORT"],
  ["产能", "HAS_CAPACITY"],
  ["澄清", "HAS_CLARIFICATION_RISK"],
  ["证伪", "CONTRADICTS"],
  ["风险", "HAS_RISK"],
  ["D+1", "DPLUS_VALIDATED"],
  ["D+3", "DPLUS_VALIDATED"],
  ["D+5", "DPLUS_VALIDATED"],
  ["D+10", "DPLUS_VALIDATED"],
]

export function toPosixPath(value) {
  return String(value).replace(/\\/g, "/")
}

export function resolveProjectPath(projectPath) {
  return path.resolve(projectPath ?? DEFAULT_PROJECT_PATH)
}

export function projectRelative(projectPath, targetPath) {
  return toPosixPath(path.relative(path.resolve(projectPath), path.resolve(targetPath)))
}

export function nowLocalTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function idTimestamp() {
  return nowLocalTimestamp().replace(/[-: ]/g, "")
}

export function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16)
}

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (err) {
    if (err?.code === "ENOENT") return ""
    throw err
  }
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function appendJsonl(filePath, record) {
  await ensureDir(path.dirname(filePath))
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8")
}

async function appendUniqueJsonl(filePath, record) {
  const rows = await readJsonl(filePath)
  if (record.id && rows.some((row) => row.id === record.id)) return false
  await appendJsonl(filePath, record)
  return true
}

async function readJsonl(filePath) {
  const raw = await readIfExists(filePath)
  if (!raw.trim()) return []
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export function assertSafeReadPath(relativePath) {
  const normalized = toPosixPath(String(relativePath ?? "").trim()).replace(/^\/+/, "")
  if (!normalized || normalized.includes("\0") || normalized.startsWith("../") || normalized.includes("/../") || path.isAbsolute(normalized)) {
    throw new Error(`Unsafe project-relative path: ${relativePath}`)
  }
  return normalized
}

export function assertSafeWritePath(relativePath, { allowMeta = false } = {}) {
  const normalized = assertSafeReadPath(relativePath)
  if (normalized.startsWith("raw/")) throw new Error(`Refusing to write raw path: ${normalized}`)
  if (normalized.startsWith("wiki/")) return normalized
  if (normalized === TEMPORAL_FACTS_PATH || normalized === TEMPORAL_FACTS_INDEX_PATH) return normalized
  if (normalized === MARKET_SNAPSHOTS_PATH) return normalized
  if (normalized === SHORTLINE_EMOTION_PATH) return normalized
  if (normalized === TDX_MCP_SNAPSHOTS_PATH) return normalized
  if (normalized.startsWith(`${BRAIN_ROOT}/`)) return normalized
  if (allowMeta && normalized.startsWith(".llm-wiki/")) return normalized
  throw new Error(`Unsupported write path: ${normalized}`)
}

function assertInsideProject(projectPath, absolutePath) {
  const project = path.resolve(projectPath)
  const target = path.resolve(absolutePath)
  const rel = path.relative(project, target)
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path must stay inside project: ${target}`)
  return target
}

async function listFilesRecursive(rootDir, { extensions = TEXT_EXTENSIONS, limit = 12000 } = {}) {
  const out = []
  async function walk(dir) {
    if (out.length >= limit) return
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (err?.code === "ENOENT") return
      throw err
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      if (SKIP_DIRS.has(entry.name)) continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        out.push(fullPath)
      }
    }
  }
  await walk(rootDir)
  return out
}

function isTextSource(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function stripFrontmatter(text) {
  return String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
}

function extractTitle(content, filePath) {
  const fmTitle = String(content).match(/^---\r?\n[\s\S]*?\ntitle:\s*["']?(.+?)["']?\s*\r?\n[\s\S]*?\r?\n---/m)?.[1]
  if (fmTitle) return fmTitle.trim()
  const h1 = String(content).match(/^#\s+(.+)$/m)?.[1]
  if (h1) return h1.trim()
  return path.basename(filePath).replace(/\.[^.]+$/, "")
}

function makeExcerpt(content, maxChars = 300) {
  const cleaned = stripFrontmatter(content)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (cleaned.length <= maxChars) return cleaned
  return `${cleaned.slice(0, maxChars).trimEnd()}...`
}

export function tokenize(text, limit = 120) {
  const counts = new Map()
  const add = (token, weight = 1) => {
    if (!token || /^\d+$/.test(token) || token.length > 40) return
    counts.set(token, (counts.get(token) ?? 0) + weight)
  }
  const regex = /[a-z0-9][a-z0-9._-]{1,}|[\p{Script=Han}]{2,}/giu
  for (const match of String(text ?? "").toLowerCase().matchAll(regex)) {
    const token = match[0]
    add(token, 2)
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length > 3) {
      for (let size = 2; size <= 4; size += 1) {
        for (let i = 0; i <= token.length - size; i += 1) add(token.slice(i, i + size))
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token)
}

function scoreText(content, tokens) {
  const haystack = String(content ?? "").toLowerCase()
  let score = 0
  for (const token of tokens) {
    const pos = haystack.indexOf(token)
    if (pos < 0) continue
    score += Math.min(8, token.length)
    if (pos < 1000) score += 2
  }
  return score
}

async function searchRoot(projectPath, rootRelativePath, tokens, { top = 8, excludePath = "" } = {}) {
  const root = path.join(projectPath, rootRelativePath)
  const files = await listFilesRecursive(root)
  const scored = []
  for (const filePath of files) {
    const relativePath = projectRelative(projectPath, filePath)
    if (excludePath && relativePath === excludePath) continue
    const content = await readIfExists(filePath)
    const score = scoreText(`${relativePath}\n${content}`, tokens)
    if (score <= 0) continue
    scored.push({
      path: relativePath,
      title: extractTitle(content, filePath),
      score,
      excerpt: makeExcerpt(content),
    })
  }
  return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, top)
}

function parseWikiLinks(content) {
  const links = new Set()
  for (const match of String(content ?? "").matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
    const link = match[1].trim()
    if (link) links.add(link)
  }
  return [...links]
}

async function graphNeighbors(projectPath, wikiHits, { top = 6 } = {}) {
  const out = []
  const seen = new Set(wikiHits.map((hit) => hit.path))
  for (const hit of wikiHits.slice(0, 5)) {
    const content = await readIfExists(path.join(projectPath, hit.path))
    for (const link of parseWikiLinks(content)) {
      const candidates = [
        `wiki/${link}.md`,
        ...Object.values(WIKI_DIRS).map((dir) => `${dir}/${link.replace(/^.*\//, "")}.md`),
      ]
      for (const candidate of candidates) {
        if (seen.has(candidate)) continue
        const full = path.join(projectPath, candidate)
        if (!(await exists(full))) continue
        const neighborContent = await readIfExists(full)
        seen.add(candidate)
        out.push({
          path: candidate,
          title: extractTitle(neighborContent, full),
          score: Math.max(1, Math.round(hit.score / 2)),
          excerpt: makeExcerpt(neighborContent, 240),
          from: hit.path,
        })
        break
      }
      if (out.length >= top) return out
    }
  }
  if (out.length > 0) return out
  return wikiHits.slice(1, top + 1).map((hit) => ({
    ...hit,
    from: "similarity",
  }))
}

async function searchFacts(projectPath, tokens, { top = 8, includeInvalidated = false } = {}) {
  const rows = [
    ...(await readJsonl(path.join(projectPath, TEMPORAL_FACTS_PATH)).then((items) => items.map((item) => ({ ...item, path: TEMPORAL_FACTS_PATH })))),
    ...(await readJsonl(path.join(projectPath, MARKET_SNAPSHOTS_PATH)).then((items) => items.map((item) => ({ ...item, path: MARKET_SNAPSHOTS_PATH })))),
    ...(await readJsonl(path.join(projectPath, SHORTLINE_EMOTION_PATH)).then((items) => items.map((item) => ({ ...item, path: SHORTLINE_EMOTION_PATH })))),
    ...(await readJsonl(path.join(projectPath, TDX_MCP_SNAPSHOTS_PATH)).then((items) => items.map((item) => ({ ...item, path: TDX_MCP_SNAPSHOTS_PATH })))),
  ]
  return rows
    .filter((row) => includeInvalidated || row.status === "active" || row.status == null)
    .map((row) => ({
      ...row,
      title: row.title ?? `${row.subject ?? ""} ${row.predicate ?? ""}`.trim(),
      score: scoreText(JSON.stringify(row), tokens),
      excerpt: row.claim ?? row.summary ?? JSON.stringify(row).slice(0, 280),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top)
}

async function searchBrain(projectPath, tokens, { top = 8 } = {}) {
  const files = await listFilesRecursive(path.join(projectPath, BRAIN_ROOT), { extensions: new Set([".jsonl"]) })
  const rows = []
  for (const file of files) {
    const relativePath = projectRelative(projectPath, file)
    for (const row of await readJsonl(file)) {
      const score = scoreText(JSON.stringify(row), tokens)
      if (score <= 0) continue
      rows.push({
        ...row,
        path: relativePath,
        title: row.title ?? row.type ?? row.id,
        score,
        excerpt: row.text ?? row.note ?? JSON.stringify(row).slice(0, 280),
      })
    }
  }
  return rows.sort((a, b) => b.score - a.score).slice(0, top)
}

async function searchStats(projectPath, tokens, { top = 5 } = {}) {
  const roots = ["wiki/09-统计与进化", "raw/04-行情市场数据"]
  const merged = []
  for (const root of roots) {
    merged.push(...(await searchRoot(projectPath, root, tokens, { top })))
  }
  return merged.sort((a, b) => b.score - a.score).slice(0, top)
}

function numberEvidence(prefix, items) {
  return items.map((item, index) => ({ ...item, ref: `${prefix}${index + 1}` }))
}

export async function buildAskRetrievalContext(options) {
  const projectPath = resolveProjectPath(options.projectPath)
  const query = String(options.query ?? "").trim()
  if (!query) throw new Error("Missing query")
  const tokens = tokenize(query)
  const wikiResults = await searchRoot(projectPath, "wiki", tokens, { top: Number(options.topWiki ?? 10) })
  const rawResults = await searchRoot(projectPath, "raw", tokens, { top: Number(options.topRaw ?? 6) })
  const graphResults = await graphNeighbors(projectPath, wikiResults, { top: Number(options.graphNeighbors ?? 6) })
  const factsResults = await searchFacts(projectPath, tokens, {
    top: Number(options.topFacts ?? 8),
    includeInvalidated: Boolean(options.includeInvalidated),
  })
  const brainResults = await searchBrain(projectPath, tokens, { top: Number(options.topBrain ?? 8) })
  const statsResults = await searchStats(projectPath, tokens, { top: Number(options.topStats ?? 5) })
  return {
    schema: "73wiki-rag-context-v1",
    query,
    projectPath,
    generatedAt: nowLocalTimestamp(),
    tokens,
    counts: {
      wiki: wikiResults.length,
      raw: rawResults.length,
      graph: graphResults.length,
      facts: factsResults.length,
      brain: brainResults.length,
      stats: statsResults.length,
    },
    wikiResults: numberEvidence(EVIDENCE_PREFIXES.wiki, wikiResults),
    rawResults: numberEvidence(EVIDENCE_PREFIXES.raw, rawResults),
    graphResults: numberEvidence(EVIDENCE_PREFIXES.graph, graphResults),
    factsResults: numberEvidence(EVIDENCE_PREFIXES.facts, factsResults),
    brainResults: numberEvidence(EVIDENCE_PREFIXES.memory, brainResults),
    statsResults: numberEvidence(EVIDENCE_PREFIXES.stats, statsResults),
  }
}

export function formatAskContext(context) {
  const lines = [
    "# 73WIKI RAG 证据包",
    "",
    `- query: ${context.query}`,
    `- generated_at: ${context.generatedAt}`,
    "- 证据编号：W=WIKI，R=RAW，G=图谱关联，F=Temporal Facts，M=Brain Memory，S=行情/统计",
    "",
  ]
  for (const [title, rows] of [
    ["WIKI", context.wikiResults],
    ["RAW", context.rawResults],
    ["图谱关联", context.graphResults],
    ["Temporal Facts", context.factsResults],
    ["Brain Memory", context.brainResults],
    ["行情/统计", context.statsResults],
  ]) {
    lines.push(`## ${title}`, "")
    if (rows.length === 0) {
      lines.push("(none)", "")
      continue
    }
    for (const row of rows) {
      lines.push(`- [${row.ref}] ${row.path} :: ${row.title ?? ""}`)
      if (row.from) lines.push(`  from: ${row.from}`)
      if (row.excerpt) lines.push(`  ${row.excerpt}`)
    }
    lines.push("")
  }
  return lines.join("\n")
}

export async function askWiki(options) {
  const context = await buildAskRetrievalContext(options)
  return { ...context, answer: formatAskContext(context) }
}

export async function prepareIngest(options) {
  const projectPath = resolveProjectPath(options.projectPath)
  const requestedSource = String(options.sourcePath ?? "")
  const sourcePath = assertInsideProject(projectPath, path.isAbsolute(requestedSource) ? requestedSource : path.join(projectPath, requestedSource))
  if (!isTextSource(sourcePath)) throw new Error(`Unsupported source type: ${sourcePath}`)
  const sourceContent = await fs.readFile(sourcePath, "utf8")
  const sourceRelativePath = projectRelative(projectPath, sourcePath)
  const sourceHash = shortHash(sourceContent)
  const createdAt = nowLocalTimestamp()
  const reportId = options.reportId ?? `${idTimestamp()}-${path.basename(sourcePath).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 70)}`
  const reportDir = path.join(projectPath, REPORT_ROOT, reportId)
  const retrieval = await buildAskRetrievalContext({
    projectPath,
    query: `${sourceRelativePath}\n${makeExcerpt(sourceContent, 2000)}`,
    topWiki: options.topWiki ?? 10,
    topRaw: options.topRaw ?? 5,
  })
  const manifestTemplate = {
    schema: MANIFEST_SCHEMA,
    generatedBy: "73wiki codex-ingest prepare",
    createdAt,
    projectPath,
    sourcePath,
    sourceRelativePath,
    sourceHash,
    writePolicy: {
      rawWritesAllowed: false,
      formalWikiWritesRequireApply: true,
      dailyLoopBuyAdviceAllowed: false,
      cOrDEvidenceAsConfirmedFactAllowed: false,
    },
    schemaAdapter: WIKI_DIRS,
    writes: [],
    factWrites: [],
  }
  await ensureDir(reportDir)
  await writeJson(path.join(reportDir, "changes.template.json"), manifestTemplate)
  await writeJson(path.join(reportDir, "retrieval.json"), retrieval)
  const contextMarkdown = [
    "# Codex Ingest Context",
    "",
    `- source: ${sourceRelativePath}`,
    `- source_hash: ${sourceHash}`,
    `- created_at: ${createdAt}`,
    "- hard_rule: raw/** must never be written by this CLI",
    "- hard_rule: use 73神话 L1-L10 schema adapter, do not create wiki/股票 or wiki/概念",
    "",
    formatAskContext(retrieval),
    "## Source Excerpt",
    "",
    makeExcerpt(sourceContent, 2600),
    "",
  ].join("\n")
  await fs.writeFile(path.join(reportDir, "context.md"), contextMarkdown, "utf8")
  await fs.writeFile(path.join(reportDir, "wiki-change-review.md"), "# WIKI 写入审核\n\n当前为 prepare 阶段，尚无写入项。\n", "utf8")
  return { projectPath, sourcePath, sourceRelativePath, sourceHash, createdAt, reportDir, retrieval, manifestTemplate }
}

function safeArtifactName(value) {
  return String(value)
    .replace(/\.[^.]+$/, "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 90) || "source"
}

function sourceEvidenceLevel(sourceRelativePath) {
  if (/交割单|行情市场数据|market-snapshot|候选票|统计与进化/.test(sourceRelativePath)) return "A"
  if (/研报|公告|互动|调研|知识星球/.test(sourceRelativePath)) return "B"
  if (/微信|群|公众号|淘股吧|复盘/.test(sourceRelativePath)) return "C"
  return "C"
}

function sourceKindFromPath(sourceRelativePath) {
  if (/交割单/.test(sourceRelativePath)) return "manual_review"
  if (/行情市场数据|market-snapshot/.test(sourceRelativePath)) return "market_price"
  if (/研报/.test(sourceRelativePath)) return "broker_research"
  if (/公告|互动/.test(sourceRelativePath)) return "official_announcement"
  if (/微信|群/.test(sourceRelativePath)) return "social_chat"
  if (/公众号|淘股吧|知识星球|复盘/.test(sourceRelativePath)) return "media_report"
  return "manual_review"
}

function buildFactCandidatesFromSource({ sourceRelativePath, sourceContent, sourceHash, sourceTitle }) {
  const evidenceLevel = sourceEvidenceLevel(sourceRelativePath)
  const sourceKind = sourceKindFromPath(sourceRelativePath)
  const candidates = []
  const seen = new Set()
  for (const [keyword, predicate] of AUDIT_KEYWORDS) {
    if (!sourceContent.includes(keyword)) continue
    const key = `${predicate}:${keyword}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({
      path: TEMPORAL_FACTS_PATH,
      subject: sourceTitle,
      predicate,
      object: keyword,
      claim: `来源 ${sourceRelativePath} 出现「${keyword}」相关信息；当前仅作为待验证观察项，不得直接作为确认事实或买入依据。`,
      status: "active",
      evidenceLevel,
      sourceKind,
      validAt: nowLocalTimestamp().slice(0, 10),
      sourcePath: sourceRelativePath,
      sourceHash,
    })
  }
  return candidates.slice(0, 12)
}

function fileBlock(pathValue, content) {
  return `----FILE: ${pathValue}----\n${content.trim()}\n----END FILE----\n`
}

export function parseFileBlocks(raw) {
  const blocks = []
  const text = String(raw ?? "")
  const regex = /----FILE:\s*(.+?)----\r?\n([\s\S]*?)\r?\n----END FILE----/g
  for (const match of text.matchAll(regex)) {
    blocks.push({ path: toPosixPath(match[1].trim()), content: match[2].trimEnd() })
  }
  const fenced = /````FILE\s+(.+?)\r?\n([\s\S]*?)\r?\n````/g
  for (const match of text.matchAll(fenced)) {
    blocks.push({ path: toPosixPath(match[1].trim()), content: match[2].trimEnd() })
  }
  return blocks
}

function buildStagedSourceReview({ sourceRelativePath, sourceHash, createdAt, retrieval, sourceContent }) {
  const baseName = sourceRelativePath.split("/").pop() ?? "source"
  const targetPath = `wiki/08-信息来源/CLI摄入候选/${safeArtifactName(baseName)}-${sourceHash}.md`
  const sourceTitle = baseName.replace(/\.[^.]+$/, "")
  const evidenceLines = [
    ...retrieval.wikiResults.slice(0, 5).map((item) => `- [${item.ref}] ${item.path} :: ${item.title}`),
    ...retrieval.rawResults.slice(0, 3).map((item) => `- [${item.ref}] ${item.path} :: ${item.title}`),
    ...retrieval.statsResults.slice(0, 3).map((item) => `- [${item.ref}] ${item.path} :: ${item.title}`),
  ]
  const content = [
    `# ${sourceTitle} CLI摄入候选`,
    "",
    "## 审核状态",
    "",
    "- 状态：待人工审核",
    "- 写入方式：codex:ingest staged manifest",
    "- 禁止事项：本页不是买入建议，不得绕过作战室评分、竞价确认和 D+ 验证。",
    "",
    "## 来源",
    "",
    `- source_path: ${sourceRelativePath}`,
    `- source_hash: ${sourceHash}`,
    `- generated_at: ${createdAt}`,
    "",
    "## 召回证据",
    "",
    ...(evidenceLines.length ? evidenceLines : ["- 暂无召回证据"]),
    "",
    "## 待人工判断",
    "",
    "- 是否需要进入 L1/L2/L3/L4 正式页面。",
    "- 是否只保留为信息来源证据。",
    "- 是否需要写入 Temporal Facts。",
    "- 是否存在 C/D 级信源被误当确认事实的风险。",
    "",
    "## 来源摘录",
    "",
    makeExcerpt(sourceContent, 1800),
    "",
  ].join("\n")
  return { action: "create", path: targetPath, content }
}

export async function apiRunIngest(options) {
  const prepared = await prepareIngest(options)
  const sourceContent = await fs.readFile(prepared.sourcePath, "utf8")
  const sourceTitle = path.basename(prepared.sourcePath).replace(/\.[^.]+$/, "")
  const pageWrite = buildStagedSourceReview({
    sourceRelativePath: prepared.sourceRelativePath,
    sourceHash: prepared.sourceHash,
    createdAt: prepared.createdAt,
    retrieval: prepared.retrieval,
    sourceContent,
  })
  const factWrites = buildFactCandidatesFromSource({
    sourceRelativePath: prepared.sourceRelativePath,
    sourceContent,
    sourceHash: prepared.sourceHash,
    sourceTitle,
  })
  const plan = {
    schema: "73wiki-codex-ingest-plan-v1",
    generatedAt: prepared.createdAt,
    sourceRelativePath: prepared.sourceRelativePath,
    sourceHash: prepared.sourceHash,
    mode: "local-staged",
    warnings: [
      "This local api-run creates review candidates only; it does not call an external model.",
      "All writes must pass apply dry-run and explicit --write before touching WIKI.",
      "raw/** writes are forbidden.",
    ],
    writes: [pageWrite],
    factWrites,
  }
  const analysis = [
    "# Ingest Analysis",
    "",
    `- source: ${prepared.sourceRelativePath}`,
    `- source_hash: ${prepared.sourceHash}`,
    "- mode: local-staged",
    "- conclusion: generate one information-source review candidate and optional Temporal Fact candidates; no RAW writes.",
    "",
    "## Retrieval Counts",
    "",
    `- wiki: ${prepared.retrieval.counts.wiki}`,
    `- raw: ${prepared.retrieval.counts.raw}`,
    `- graph: ${prepared.retrieval.counts.graph}`,
    `- facts: ${prepared.retrieval.counts.facts}`,
    `- brain: ${prepared.retrieval.counts.brain}`,
    `- stats: ${prepared.retrieval.counts.stats}`,
    "",
  ].join("\n")

  const filesDir = path.join(prepared.reportDir, "files")
  await ensureDir(filesDir)
  const artifactPath = path.join(filesDir, `001-${safeArtifactName(pageWrite.path)}.md`)
  await fs.writeFile(artifactPath, fileBlock(pageWrite.path, pageWrite.content), "utf8")
  const planPath = path.join(prepared.reportDir, "plan.json")
  const analysisPath = path.join(prepared.reportDir, "analysis.md")
  await writeJson(planPath, plan)
  await fs.writeFile(analysisPath, analysis, "utf8")
  const manifestPath = await writeManifestFromPlan({ prepared, plan, filesDir })
  const dryRunReport = await applyManifest({ manifestPath, projectPath: prepared.projectPath, write: false })
  return { ...prepared, analysisPath, planPath, filesDir, plan, manifestPath, dryRunReport }
}

async function writeManifestFromPlan({ prepared, plan, filesDir }) {
  const fileArtifacts = await listFilesRecursive(filesDir, { extensions: new Set([".md"]) })
  const blocks = []
  for (const artifact of fileArtifacts.sort()) {
    blocks.push(...parseFileBlocks(await fs.readFile(artifact, "utf8")))
  }
  const writes = plan.writes.map((item) => {
    const block = blocks.find((candidate) => candidate.path === item.path)
    return block ? { ...item, content: block.content } : item
  })
  const manifest = {
    ...prepared.manifestTemplate,
    generatedBy: "73wiki codex-ingest api-run local-staged",
    stages: {
      analysis: projectRelative(prepared.projectPath, path.join(prepared.reportDir, "analysis.md")),
      plan: projectRelative(prepared.projectPath, path.join(prepared.reportDir, "plan.json")),
      files: projectRelative(prepared.projectPath, filesDir),
    },
    plan: {
      schema: plan.schema,
      mode: plan.mode,
      warnings: plan.warnings,
    },
    writes,
    factWrites: plan.factWrites ?? [],
  }
  const manifestPath = path.join(prepared.reportDir, "changes.json")
  await writeJson(manifestPath, manifest)
  return manifestPath
}

export async function finalizeStagedIngest(options) {
  const reportDir = path.resolve(options.reportDir)
  const manifestTemplatePath = path.join(reportDir, "changes.template.json")
  const planPath = path.join(reportDir, "plan.json")
  const filesDir = path.join(reportDir, "files")
  const manifestTemplate = JSON.parse(await fs.readFile(manifestTemplatePath, "utf8"))
  const plan = JSON.parse(await fs.readFile(planPath, "utf8"))
  const projectPath = resolveProjectPath(options.projectPath ?? manifestTemplate.projectPath)
  const prepared = {
    projectPath,
    reportDir,
    manifestTemplate: { ...manifestTemplate, projectPath },
  }
  const manifestPath = await writeManifestFromPlan({ prepared, plan, filesDir })
  const dryRunReport = await applyManifest({ manifestPath, projectPath, write: false })
  return { projectPath, reportDir, filesDir, plan, manifestPath, dryRunReport }
}

function normalizeWriteItem(item) {
  if (!item || typeof item !== "object") throw new Error("Manifest write item must be an object")
  const action = item.action ?? "update"
  if (!["create", "update", "append"].includes(action)) throw new Error(`Unsupported write action: ${action}`)
  const safePath = assertSafeWritePath(item.path)
  if (!safePath.startsWith("wiki/")) throw new Error(`Use factWrites or brain commands for non-wiki path: ${safePath}`)
  if (typeof item.content !== "string") throw new Error(`Write content must be string: ${safePath}`)
  if (/^wiki\/(?:股票|概念|策略|模式)\//.test(safePath)) throw new Error(`Refusing Yang-style wiki directory in 73神话: ${safePath}`)
  return { action, path: safePath, content: item.content }
}

async function normalizeFactWrite(item, projectPath) {
  const record = { ...item }
  record.path = assertSafeWritePath(record.path ?? TEMPORAL_FACTS_PATH)
  if (record.path !== TEMPORAL_FACTS_PATH) throw new Error(`Temporal facts must write ${TEMPORAL_FACTS_PATH}`)
  for (const field of ["subject", "predicate", "claim", "status", "evidenceLevel", "sourceKind"]) {
    if (!String(record[field] ?? "").trim()) throw new Error(`Fact write missing ${field}`)
  }
  if (!FACT_PREDICATES.has(record.predicate)) throw new Error(`Unsupported fact predicate: ${record.predicate}`)
  if (!FACT_STATUSES.has(record.status)) throw new Error(`Unsupported fact status: ${record.status}`)
  if (!EVIDENCE_LEVELS.has(record.evidenceLevel)) throw new Error(`Unsupported evidence level: ${record.evidenceLevel}`)
  if (["C", "D"].includes(record.evidenceLevel) && /确认|确定|已经兑现|正式订单/.test(record.claim) && !/传闻|待验证|观察|未确认|需验证/.test(record.claim)) {
    throw new Error(`C/D evidence must not be written as confirmed fact: ${record.claim}`)
  }
  if (record.sourcePath) {
    const sourceRel = assertSafeReadPath(record.sourcePath)
    const sourceFull = path.join(projectPath, sourceRel)
    const sourceContent = await readIfExists(sourceFull)
    if (sourceContent) record.sourceHash = record.sourceHash ?? shortHash(sourceContent)
  }
  const identity = [
    record.subject,
    record.predicate,
    record.object ?? "",
    record.claim,
    record.sourcePath ?? "",
    record.validAt ?? record.sourceDate ?? record.observedAt ?? "",
  ].join("|")
  record.id = record.id ?? `tf_${shortHash(identity)}`
  record.observedAt = record.observedAt ?? nowLocalTimestamp()
  return record
}

function simpleDiff(before, after) {
  if (before === after) return []
  const beforeLines = String(before ?? "").split(/\r?\n/)
  const afterLines = String(after ?? "").split(/\r?\n/)
  return [
    `--- before (${beforeLines.length} lines)`,
    `+++ after (${afterLines.length} lines)`,
    ...afterLines.slice(0, 100).map((line) => `+ ${line}`),
    ...(afterLines.length > 100 ? ["+ ..."] : []),
  ]
}

export async function writeTemporalFactsIndex(projectPath) {
  const facts = await readJsonl(path.join(projectPath, TEMPORAL_FACTS_PATH))
  const byStatus = {}
  const byPredicate = {}
  const bySubject = {}
  for (const fact of facts) {
    byStatus[fact.status] = (byStatus[fact.status] ?? 0) + 1
    byPredicate[fact.predicate] = (byPredicate[fact.predicate] ?? 0) + 1
    bySubject[fact.subject] = (bySubject[fact.subject] ?? 0) + 1
  }
  const index = {
    schema: "73wiki-temporal-facts-index-v1",
    generatedAt: nowLocalTimestamp(),
    count: facts.length,
    byStatus,
    byPredicate,
    bySubject,
  }
  await writeJson(path.join(projectPath, TEMPORAL_FACTS_INDEX_PATH), index)
  return index
}

export async function applyManifest(options) {
  const manifestPath = path.resolve(options.manifestPath)
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"))
  if (manifest.schema !== MANIFEST_SCHEMA) throw new Error(`Unsupported manifest schema: ${manifest.schema}`)
  const projectPath = resolveProjectPath(options.projectPath ?? manifest.projectPath)
  const writes = (manifest.writes ?? []).map(normalizeWriteItem)
  const factWrites = []
  for (const item of manifest.factWrites ?? []) factWrites.push(await normalizeFactWrite(item, projectPath))

  const validation = []
  const diffs = []
  for (const item of writes) {
    const fullPath = path.join(projectPath, item.path)
    const existsBefore = await exists(fullPath)
    let action = item.action
    if (action === "create" && existsBefore) validation.push({ path: item.path, fatal: true, message: "Create target already exists" })
    if ((action === "update" || action === "append") && !existsBefore) action = "create"
    const before = await readIfExists(fullPath)
    const after = action === "append" && before ? `${before.replace(/\s*$/, "")}\n\n${item.content.trim()}\n` : item.content
    diffs.push({ path: item.path, action, changed: before !== after, diff: simpleDiff(before, after) })
  }

  const fatalIssues = validation.filter((issue) => issue.fatal)
  if (options.write && fatalIssues.length > 0) {
    throw new Error(`Fatal manifest validation failed:\n${fatalIssues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`)
  }

  const written = []
  const factsWritten = []
  if (options.write) {
    for (const item of writes) {
      const fullPath = path.join(projectPath, item.path)
      const before = await readIfExists(fullPath)
      const after = item.action === "append" && before ? `${before.replace(/\s*$/, "")}\n\n${item.content.trim()}\n` : item.content
      await ensureDir(path.dirname(fullPath))
      await fs.writeFile(fullPath, after, "utf8")
      written.push(item.path)
    }
    for (const fact of factWrites) {
      await appendJsonl(path.join(projectPath, TEMPORAL_FACTS_PATH), fact)
      factsWritten.push(fact.id)
    }
    if (factsWritten.length > 0) await writeTemporalFactsIndex(projectPath)
  }

  const report = {
    schema: "73wiki-codex-ingest-apply-report-v1",
    generatedAt: nowLocalTimestamp(),
    projectPath,
    manifestPath,
    dryRun: !options.write,
    diffs,
    validation,
    fatalIssues,
    plannedFactWrites: factWrites.map((fact) => ({
      id: fact.id,
      subject: fact.subject,
      predicate: fact.predicate,
      status: fact.status,
      evidenceLevel: fact.evidenceLevel,
      path: fact.path,
    })),
    written,
    factsWritten,
  }
  const reportPath = path.join(path.dirname(manifestPath), options.write ? "apply-report.json" : "apply-dry-run.json")
  await writeJson(reportPath, report)
  const reviewPath = path.join(path.dirname(manifestPath), "wiki-change-review.md")
  const review = [
    "# WIKI 写入审核",
    "",
    `- dry_run: ${report.dryRun}`,
    `- generated_at: ${report.generatedAt}`,
    `- raw_writes: forbidden and not present`,
    `- wiki_writes: ${writes.length}`,
    `- fact_writes: ${factWrites.length}`,
    `- fatal_issues: ${fatalIssues.length}`,
    "",
    "## 文件变更",
    "",
    ...(diffs.length ? diffs.map((item) => `- ${item.action} ${item.path} changed=${item.changed}`) : ["(none)"]),
    "",
    "## Facts",
    "",
    ...(factWrites.length ? factWrites.map((fact) => `- ${fact.id} ${fact.subject} ${fact.predicate} ${fact.status} ${fact.evidenceLevel}`) : ["(none)"]),
    "",
  ].join("\n")
  await fs.writeFile(reviewPath, review, "utf8")
  return { ...report, reportPath, reviewPath }
}

export async function rememberBrainMemory(options) {
  const projectPath = resolveProjectPath(options.projectPath)
  const type = String(options.type ?? "").trim()
  if (!BRAIN_TYPE_TO_FILE.has(type)) throw new Error(`Unsupported brain type: ${type}`)
  const text = String(options.text ?? "").trim()
  if (!text) throw new Error("Brain memory text is required")
  const record = {
    id: `bm_${idTimestamp()}_${shortHash(`${type}|${text}`)}`,
    type,
    title: options.title ?? text.slice(0, 80),
    text,
    status: options.status ?? "open",
    source: options.source ?? "manual",
    tags: String(options.tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
    related: String(options.related ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    createdAt: nowLocalTimestamp(),
  }
  const relativePath = `${BRAIN_ROOT}/${BRAIN_TYPE_TO_FILE.get(type)}`
  await appendJsonl(path.join(projectPath, relativePath), record)
  return { projectPath, relativePath, record }
}

export async function getBrainStatus(options = {}) {
  const projectPath = resolveProjectPath(options.projectPath)
  const files = {}
  const totals = { records: 0, open: 0, resolved: 0 }
  for (const fileName of new Set(BRAIN_TYPE_TO_FILE.values())) {
    const relativePath = `${BRAIN_ROOT}/${fileName}`
    const rows = await readJsonl(path.join(projectPath, relativePath))
    const open = rows.filter((row) => row.status !== "resolved").length
    const resolved = rows.length - open
    files[relativePath] = { records: rows.length, open, resolved }
    totals.records += rows.length
    totals.open += open
    totals.resolved += resolved
  }
  return { schema: "73wiki-brain-status-v1", generatedAt: nowLocalTimestamp(), projectPath, files, totals }
}

export async function resolveBrainMemory(options) {
  const projectPath = resolveProjectPath(options.projectPath)
  const targetId = String(options.id ?? "").trim()
  const result = String(options.result ?? "").trim()
  if (!targetId) throw new Error("Missing --id")
  if (!["success", "failure", "uncertain"].includes(result)) throw new Error("--result must be success, failure, or uncertain")
  const record = {
    id: `bv_${idTimestamp()}_${shortHash(`${targetId}|${result}|${options.note ?? ""}`)}`,
    type: "validation",
    targetId,
    result,
    note: options.note ?? "",
    status: "resolved",
    createdAt: nowLocalTimestamp(),
  }
  const relativePath = `${BRAIN_ROOT}/validations.jsonl`
  await appendJsonl(path.join(projectPath, relativePath), record)
  return { projectPath, relativePath, record }
}

export async function runTemporalFactsAudit(options = {}) {
  const projectPath = resolveProjectPath(options.projectPath)
  const files = await listFilesRecursive(path.join(projectPath, "wiki"), { extensions: new Set([".md", ".markdown"]) })
  const candidates = []
  for (const filePath of files) {
    const relativePath = projectRelative(projectPath, filePath)
    const content = await readIfExists(filePath)
    for (const [keyword, predicate] of AUDIT_KEYWORDS) {
      if (!content.includes(keyword)) continue
      candidates.push({
        path: relativePath,
        title: extractTitle(content, filePath),
        keyword,
        predicate,
        suggestedEvidenceLevel: /公告|交易所|行情快照|交割单/.test(content) ? "A" : "C",
        excerpt: makeExcerpt(content, 260),
      })
    }
  }
  const result = {
    schema: "73wiki-temporal-facts-audit-v1",
    generatedAt: nowLocalTimestamp(),
    projectPath,
    dryRun: !options.write,
    counts: { candidates: candidates.length },
    candidates: candidates.slice(0, Number(options.topN ?? 50)),
    outputs: {},
  }
  if (options.write) {
    const outDir = path.join(projectPath, ".llm-wiki/temporal-facts")
    result.outputs.json = projectRelative(projectPath, path.join(outDir, "audit.json"))
    result.outputs.markdown = projectRelative(projectPath, path.join(outDir, "audit.md"))
    await writeJson(path.join(outDir, "audit.json"), result)
    const md = [
      "# Temporal Facts Audit",
      "",
      `- generated_at: ${result.generatedAt}`,
      `- candidates: ${result.counts.candidates}`,
      "",
      ...result.candidates.map((item, index) => `- ${index + 1}. ${item.path} :: ${item.predicate} (${item.keyword})`),
      "",
    ].join("\n")
    await ensureDir(outDir)
    await fs.writeFile(path.join(outDir, "audit.md"), md, "utf8")
  }
  return result
}

export async function runHygiene(options = {}) {
  const projectPath = resolveProjectPath(options.projectPath)
  const reportRoot = path.join(projectPath, REPORT_ROOT)
  const entries = []
  try {
    for (const entry of await fs.readdir(reportRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const fullPath = path.join(reportRoot, entry.name)
      const stat = await fs.stat(fullPath)
      entries.push({ path: projectRelative(projectPath, fullPath), modifiedAt: stat.mtime.toISOString() })
    }
  } catch (err) {
    if (err?.code !== "ENOENT") throw err
  }
  return {
    schema: "73wiki-hygiene-v1",
    generatedAt: nowLocalTimestamp(),
    projectPath,
    action: options.action ?? "audit",
    dryRun: !options.write,
    reportDirs: entries,
    note: "hygiene apply intentionally does not delete files in this first-batch engine.",
  }
}

export async function runAskEval(options = {}) {
  const context = await buildAskRetrievalContext(options)
  const expectedPaths = String(options.expectedPaths ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  const returned = new Set([
    ...context.wikiResults,
    ...context.rawResults,
    ...context.graphResults,
    ...context.factsResults,
    ...context.brainResults,
    ...context.statsResults,
  ].map((item) => item.path))
  const hits = expectedPaths.filter((item) => returned.has(toPosixPath(item)))
  const result = {
    schema: "73wiki-ask-eval-v1",
    generatedAt: nowLocalTimestamp(),
    query: context.query,
    counts: context.counts,
    expectedPaths,
    hits,
    recall: expectedPaths.length ? hits.length / expectedPaths.length : null,
  }
  if (options.write) {
    const outDir = path.join(context.projectPath, ".llm-wiki/eval")
    await writeJson(path.join(outDir, `${idTimestamp()}-ask-eval.json`), result)
  }
  return result
}

export async function runDailyLoop(options = {}) {
  const projectPath = resolveProjectPath(options.projectPath)
  const mode = options.mode ?? "premarket"
  const dplus = await collectDplusFacts(projectPath)
  const result = {
    schema: "73wiki-daily-loop-v1",
    generatedAt: nowLocalTimestamp(),
    projectPath,
    mode,
    dryRun: !options.write,
    writePolicy: {
      buyAdviceAllowed: false,
      formalWikiWriteAllowed: false,
      rawWriteAllowed: false,
    },
    outputs: {
      questions: [
        "今天 L1 市场环境是否支持进攻，证据来自哪里？",
        "候选票是否匹配近期有效模式，反证是什么？",
        "竞价 9:15/9:20/9:25 分别需要确认什么？",
        "没有行情快照时必须写：数据缺失，无法判断。",
      ],
      premarketAllowed: ["市场问题清单", "候选评分草稿", "竞价确认问题"],
      postcloseAllowed: ["D+验证", "预测兑现检查", "错误样本写入 Brain Memory"],
      forbidden: ["自动生成买入建议", "直接写正式 WIKI", "写 raw/**"],
    },
    dplus: {
      candidatesScanned: dplus.filesScanned,
      factsReady: dplus.facts.length,
      facts: dplus.facts.slice(0, 30),
    },
    writes: {
      predictions: 0,
      validations: 0,
      facts: 0,
      report: null,
    },
  }
  if (options.write) {
    const outDir = path.join(projectPath, ".llm-wiki/daily-loop")
    const outPath = path.join(outDir, `${idTimestamp()}-${mode}.json`)
    result.outputPath = projectRelative(projectPath, outPath)
    result.writes.report = result.outputPath
    if (mode === "premarket" || mode === "full") {
      const prediction = {
        id: `pred_${shortHash(`${nowLocalTimestamp().slice(0, 10)}|${mode}|premarket`)}`,
        type: "prediction",
        title: `${nowLocalTimestamp().slice(0, 10)} ${mode} 盘前问题清单`,
        text: result.outputs.questions.join("\n"),
        status: "open",
        source: "daily-loop",
        tags: ["daily-loop", "premarket"],
        createdAt: result.generatedAt,
      }
      if (await appendUniqueJsonl(path.join(projectPath, BRAIN_ROOT, "predictions.jsonl"), prediction)) result.writes.predictions += 1
    }
    if (mode === "postclose" || mode === "full") {
      const validation = {
        id: `val_${shortHash(`${nowLocalTimestamp().slice(0, 10)}|${mode}|postclose|${dplus.facts.length}`)}`,
        type: "validation",
        title: `${nowLocalTimestamp().slice(0, 10)} ${mode} 盘后验证`,
        text: `本次扫描候选/D+文件 ${dplus.filesScanned} 个，可事实化 D+ 结果 ${dplus.facts.length} 条。`,
        status: "resolved",
        source: "daily-loop",
        tags: ["daily-loop", "postclose", "D+"],
        createdAt: result.generatedAt,
      }
      if (await appendUniqueJsonl(path.join(projectPath, BRAIN_ROOT, "validations.jsonl"), validation)) result.writes.validations += 1
      for (const fact of dplus.facts) {
        if (await appendUniqueJsonl(path.join(projectPath, TEMPORAL_FACTS_PATH), fact)) result.writes.facts += 1
      }
      if (result.writes.facts > 0) await writeTemporalFactsIndex(projectPath)
    }
    await writeJson(outPath, result)
  }
  return result
}

function splitMarkdownTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
}

function parseMarkdownTables(content) {
  const lines = String(content ?? "").split(/\r?\n/)
  const tables = []
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) continue
    if (!/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) continue
    const headers = splitMarkdownTableRow(lines[i])
    const rows = []
    i += 2
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
      const cells = splitMarkdownTableRow(lines[i])
      const row = {}
      headers.forEach((header, index) => {
        row[header] = cells[index] ?? ""
      })
      rows.push(row)
      i += 1
    }
    tables.push({ headers, rows })
  }
  return tables
}

function isFilledDplusValue(value) {
  const text = String(value ?? "").trim()
  if (!text) return false
  return !/^(待填|无|暂无|空|数据缺失|无法判断|-|—|N\/A|NA)$/i.test(text)
}

function rowValue(row, names) {
  for (const name of names) {
    if (row[name]) return row[name]
  }
  return ""
}

async function collectDplusFacts(projectPath) {
  const roots = ["wiki/07-作战室", "wiki/09-统计与进化"]
  const facts = []
  let filesScanned = 0
  for (const root of roots) {
    const files = await listFilesRecursive(path.join(projectPath, root), { extensions: new Set([".md", ".markdown"]) })
    for (const filePath of files) {
      const relativePath = projectRelative(projectPath, filePath)
      if (!/(候选|跟踪|评分|D\+)/i.test(relativePath)) continue
      filesScanned += 1
      const content = await readIfExists(filePath)
      const sourceHash = shortHash(content)
      for (const table of parseMarkdownTables(content)) {
        const headersJoined = table.headers.join("|")
        if (!/(D\+?1|D1|D\+?3|D3|D\+?5|D5|D\+?10|D10)/i.test(headersJoined)) continue
        for (const row of table.rows) {
          const stock = rowValue(row, ["股票", "标的", "名称", "stock", "Stock"])
          if (!stock || /^代码\/名称$|^股票$/.test(stock)) continue
          const mode = rowValue(row, ["主模式", "模式", "main_mode"])
          const conclusion = rowValue(row, ["结论", "conclusion"])
          for (const [label, names] of [
            ["D+1", ["D+1", "D1", "D1_result", "D+1结果"]],
            ["D+3", ["D+3", "D3", "D3_result", "D+3结果"]],
            ["D+5", ["D+5", "D5", "D5_result", "D+5结果"]],
            ["D+10", ["D+10", "D10", "D10_result", "D+10结果"]],
          ]) {
            const value = rowValue(row, names)
            if (!isFilledDplusValue(value)) continue
            const claim = `${stock} ${label} 跟踪结果：${value}${conclusion ? `；结论：${conclusion}` : ""}${mode ? `；模式：${mode}` : ""}。`
            facts.push({
              path: TEMPORAL_FACTS_PATH,
              id: `tf_${shortHash(`${relativePath}|${stock}|${label}|${value}`)}`,
              subject: stock,
              predicate: "DPLUS_VALIDATED",
              object: label,
              claim,
              status: "active",
              evidenceLevel: "A",
              sourceKind: "manual_review",
              validAt: nowLocalTimestamp().slice(0, 10),
              sourcePath: relativePath,
              sourceHash,
              observedAt: nowLocalTimestamp(),
              metadata: { mode, conclusion },
            })
          }
        }
      }
    }
  }
  return { filesScanned, facts }
}

function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function formatDate(date) {
  const pad = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dateRange(from, to) {
  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error("Invalid date range")
  const days = []
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const day = d.getDay()
    const formatted = formatDate(d)
    if (day !== 0 && day !== 6 && !isKnownCnMarketHoliday(formatted)) days.push(formatted)
  }
  return days
}

function isKnownCnMarketHoliday(date) {
  return [
    ["2024-10-01", "2024-10-07"],
  ].some(([from, to]) => date >= from && date <= to)
}

export async function runHistoryReplayTemplate(options = {}) {
  const projectPath = resolveProjectPath(options.projectPath)
  const from = options.from ?? "2024-09-24"
  const to = options.to ?? "2024-10-11"
  const days = dateRange(from, to)
  const outDir = path.join(projectPath, ".llm-wiki/history-replay", `${from}_${to}`)
  const templates = days.map((day) => {
    const content = [
      "---",
      `date: ${day}`,
      "review_version: V1-standard-research",
      "data_cutoff: T日收盘后",
      "lookahead_guard: true",
      "label_frozen_before_dplus: true",
      "original_reason_policy: original_reason_unknown_if_no_same_day_record",
      "old_review_role: 仅作事实校验/线索参考，不作判断依据",
      "confidence: medium",
      "---",
      "",
      `# ${day} 历史复盘试点模板`,
      "",
      "## T日已知事实",
      "",
      "- 原始交割单：",
      "- 当日市场事实：",
      "- 当日已知主线：",
      "",
      "## T日判断",
      "",
      "- L1市场环境：",
      "- 主导赚钱结构：",
      "- 核心方向/核心股/后排股：",
      "- 我的交易是否站在主流结构：",
      "- original_reason: unknown",
      "",
      "## D+验证区",
      "",
      "| 周期 | 结果 | 证据路径 | 是否验证 T 日判断 |",
      "|---|---|---|---|",
      "| D+1 | 待填 |  |  |",
      "| D+3 | 待填 |  |  |",
      "| D+5 | 待填 |  |  |",
      "| D+10 | 待填 |  |  |",
      "",
      "## 后来反证/证伪",
      "",
      "- 不得写回 T 日判断区。",
      "",
      "## 错误样本与 Brain Memory 候选",
      "",
      "- 错误类型：",
      "- 是否需要写入 data/brain：",
      "",
    ].join("\n")
    return { date: day, relativePath: `.llm-wiki/history-replay/${from}_${to}/${day}-复盘模板.md`, content }
  })
  const result = {
    schema: "73wiki-history-replay-template-v1",
    generatedAt: nowLocalTimestamp(),
    projectPath,
    from,
    to,
    dryRun: !options.write,
    count: templates.length,
    templates: templates.map(({ date, relativePath }) => ({ date, path: relativePath })),
    outputDir: projectRelative(projectPath, outDir),
  }
  if (options.write) {
    for (const item of templates) {
      await writeFileInsideProject(projectPath, item.relativePath, item.content)
    }
    await writeJson(path.join(outDir, "run-summary.json"), result)
  }
  return result
}

async function writeFileInsideProject(projectPath, relativePath, content) {
  const safePath = assertSafeWritePath(relativePath, { allowMeta: true })
  const fullPath = path.join(projectPath, safePath)
  await ensureDir(path.dirname(fullPath))
  await fs.writeFile(fullPath, content, "utf8")
}

export async function ensureEngineDataDirs(options = {}) {
  const projectPath = resolveProjectPath(options.projectPath)
  await ensureDir(path.join(projectPath, "data/facts"))
  await ensureDir(path.join(projectPath, BRAIN_ROOT))
  for (const fileName of new Set(BRAIN_TYPE_TO_FILE.values())) {
    const filePath = path.join(projectPath, BRAIN_ROOT, fileName)
    if (!(await exists(filePath))) await fs.writeFile(filePath, "", "utf8")
  }
  if (!(await exists(path.join(projectPath, TEMPORAL_FACTS_PATH)))) {
    await fs.writeFile(path.join(projectPath, TEMPORAL_FACTS_PATH), "", "utf8")
  }
  if (!(await exists(path.join(projectPath, MARKET_SNAPSHOTS_PATH)))) {
    await fs.writeFile(path.join(projectPath, MARKET_SNAPSHOTS_PATH), "", "utf8")
  }
  if (!(await exists(path.join(projectPath, SHORTLINE_EMOTION_PATH)))) {
    await fs.writeFile(path.join(projectPath, SHORTLINE_EMOTION_PATH), "", "utf8")
  }
  if (!(await exists(path.join(projectPath, TDX_MCP_SNAPSHOTS_PATH)))) {
    await fs.writeFile(path.join(projectPath, TDX_MCP_SNAPSHOTS_PATH), "", "utf8")
  }
  if (!(await exists(path.join(projectPath, TEMPORAL_FACTS_INDEX_PATH)))) {
    await writeTemporalFactsIndex(projectPath)
  }
  return { projectPath, facts: TEMPORAL_FACTS_PATH, marketSnapshots: MARKET_SNAPSHOTS_PATH, shortlineEmotion: SHORTLINE_EMOTION_PATH, tdxMcpSnapshots: TDX_MCP_SNAPSHOTS_PATH, factsIndex: TEMPORAL_FACTS_INDEX_PATH, brainRoot: BRAIN_ROOT }
}
