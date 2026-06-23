#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const L2_ROOT = "wiki/02-L2方向题材"
const REPORT_ROOT = ".llm-wiki/concept-pools"
const WATCHLIST_PATH = ".llm-wiki/market-watchlist/latest-warroom-watchlist.json"
const STOCK_REASON_PATH = ".llm-wiki/stock-reason-cards/latest-stock-reason-cards.json"

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["write", "json", "help"].includes(key)) {
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

function walkMarkdown(dirPath) {
  if (!fs.existsSync(dirPath)) return []
  const out = []
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) out.push(...walkMarkdown(fullPath))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(fullPath)
  }
  return out
}

function toArray(value) {
  return Array.isArray(value) ? value : []
}

function unique(values) {
  return [...new Set(toArray(values).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))]
}

function cleanTitle(filePath) {
  const base = path.basename(filePath, ".md")
  return base
    .replace(/-\d{4}-\d{2}-\d{2}$/g, "")
    .replace(/^\d+[-_]/g, "")
    .replace(/^-+/, "")
    .trim()
}

function qualityFlags(title) {
  const flags = []
  if (!title || title.length <= 1) flags.push("weak-title")
  if (/^\d+$/.test(title)) flags.push("numeric-title")
  if (/^[-\d\s]+$/.test(title)) flags.push("date-or-noise")
  if (title.length > 42) flags.push("too-long")
  return flags
}

function collectLiveThemes(projectPath) {
  const watchlist = readJsonMaybe(path.join(projectPath, WATCHLIST_PATH))
  const cards = readJsonMaybe(path.join(projectPath, STOCK_REASON_PATH))
  const values = []
  const tiers = watchlist?.tiers ?? {}
  for (const item of [...toArray(tiers.focus), ...toArray(tiers.candidate), ...toArray(tiers.observe)]) {
    values.push(...toArray(item.themes), ...toArray(item.tags))
  }
  for (const card of toArray(cards?.cards)) {
    values.push(...toArray(card.objectiveLimitUp?.concepts), card.objectiveLimitUp?.theme, ...toArray(card.licensedEnhancer?.themes))
  }
  return unique(values).filter((value) => value.length >= 2)
}

function scoreConcept(projectPath, filePath, liveThemes) {
  const stat = fs.statSync(filePath)
  const relativePath = path.relative(projectPath, filePath).replace(/\\/g, "/")
  const title = cleanTitle(filePath)
  const flags = qualityFlags(title)
  const lowerPath = relativePath.toLowerCase()
  const liveHits = title.length >= 2
    ? liveThemes.filter((theme) => title.includes(theme) || theme.includes(title)).slice(0, 8)
    : []
  const ageDays = Math.max(0, (Date.now() - stat.mtimeMs) / 86400000)
  let score = 0
  score += Math.max(0, 45 - Math.floor(ageDays))
  score += liveHits.length * 30
  if (lowerPath.includes("raw增量题材卡".toLowerCase())) score += 18
  if (lowerPath.includes("核心题材生命周期")) score += 20
  if (flags.length === 0) score += 12
  else score -= flags.length * 12
  return {
    title: title || path.basename(filePath, ".md"),
    path: relativePath,
    score,
    lastModified: nowLocalTimestamp(stat.mtime),
    liveHits,
    flags,
  }
}

function buildReport(projectPath) {
  const liveThemes = collectLiveThemes(projectPath)
  const files = walkMarkdown(path.join(projectPath, L2_ROOT))
  const concepts = files.map((filePath) => scoreConcept(projectPath, filePath, liveThemes))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh-Hans-CN"))
  const active = concepts.filter((item) => item.flags.length === 0 || item.liveHits.length > 0).slice(0, 50)
  const activePaths = new Set(active.map((item) => item.path))
  const candidate = concepts.filter((item) => !activePaths.has(item.path) && item.score >= 10).slice(0, 300)
  const candidatePaths = new Set(candidate.map((item) => item.path))
  const archive = concepts.filter((item) => !activePaths.has(item.path) && !candidatePaths.has(item.path))
  return {
    schema: "73wiki-concept-pools-v1",
    id: `concept_pools_${idTimestamp()}_${shortHash(concepts.length)}`,
    status: "active",
    generatedAt: nowLocalTimestamp(),
    projectPath,
    sourceRoot: L2_ROOT,
    liveThemes,
    counts: {
      total: concepts.length,
      active: active.length,
      candidate: candidate.length,
      archive: archive.length,
      noisyTitle: concepts.filter((item) => item.flags.length > 0).length,
    },
    pools: { active, candidate, archive },
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      reorgWrite: false,
    },
  }
}

function tableRows(items) {
  return items.map((item) => `| ${item.score} | ${item.title.replace(/\|/g, "/")} | ${item.liveHits.join("、")} | ${item.path} |`).join("\n")
}

function buildMarkdown(report) {
  return `# Concept Pools\n\n生成时间：${report.generatedAt}\n\n## 摘要\n\n- 总 L2 页面：${report.counts.total}\n- 活跃主线池：${report.counts.active}\n- 候选题材池：${report.counts.candidate}\n- 历史归档池：${report.counts.archive}\n- 疑似脏标题：${report.counts.noisyTitle}\n\n## 活跃主线池\n\n| 分数 | 题材 | 当前命中 | 文件 |\n|---:|---|---|---|\n${tableRows(report.pools.active.slice(0, 50))}\n\n## 候选题材池 Top 80\n\n| 分数 | 题材 | 当前命中 | 文件 |\n|---:|---|---|---|\n${tableRows(report.pools.candidate.slice(0, 80))}\n\n## 边界\n\n本脚本只分层，不移动、不改名、不删除任何页面。\n`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/concept-pools.mjs --project C:/wiki/73神话 --write")
    return
  }
  const projectPath = path.resolve(args.project ?? DEFAULT_PROJECT_PATH)
  const report = buildReport(projectPath)
  if (args.write) {
    const stamp = idTimestamp()
    const outDir = path.join(projectPath, REPORT_ROOT)
    writeJson(path.join(outDir, `${stamp}-concept-pools.json`), report)
    writeText(path.join(outDir, `${stamp}-concept-pools.md`), buildMarkdown(report))
    writeJson(path.join(outDir, "latest-concept-pools.json"), report)
    writeText(path.join(outDir, "latest-concept-pools.md"), buildMarkdown(report))
  }
  if (args.json || !args.write) console.log(JSON.stringify(report, null, 2))
  else console.log(`[concept-pools] total=${report.counts.total} active=${report.counts.active} candidate=${report.counts.candidate}`)
}

main()
