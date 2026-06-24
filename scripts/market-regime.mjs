#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73绁炶瘽"
const REPORT_ROOT = ".llm-wiki/market-regime"
const FACT_PATH = "data/facts/market_regime.jsonl"

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

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/")
}

function projectRelative(projectPath, targetPath) {
  return toPosixPath(path.relative(path.resolve(projectPath), path.resolve(targetPath)))
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0))
}

function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round((Number(value) || 0) * factor) / factor
}

function average(values) {
  const nums = values.map(Number).filter(Number.isFinite)
  if (nums.length === 0) return 0
  return nums.reduce((sum, value) => sum + value, 0) / nums.length
}

function numberAfter(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = String(text ?? "").match(new RegExp(`"${escaped}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`))
  return match ? Number(match[1]) : 0
}

function stringAfter(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = String(text ?? "").match(new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`))
  return match ? match[1] : ""
}

function extractIndustriesFromText(text) {
  const section = String(text ?? "").match(/"limitUpIndustries"\s*:\s*\[([\s\S]*?)\n\s*\]/)?.[1] ?? ""
  const out = []
  const regex = /"name"\s*:\s*"([^"]+)"\s*,\s*"count"\s*:\s*(\d+)/g
  for (const match of section.matchAll(regex)) {
    out.push({ name: match[1], count: Number(match[2]) })
  }
  return out
}

function parseSnapshot(filePath) {
  const text = fs.readFileSync(filePath, "utf8")
  try {
    const parsed = JSON.parse(text)
    return {
      file: filePath,
      tradeDate: normalizeTradeDate(parsed.evidenceTradeDate ?? parsed.planTradeDate ?? parsed.tradeDate),
      generatedAt: parsed.generatedAt ?? "",
      counts: {
        limit_up: Number(parsed.counts?.limit_up ?? 0),
        burst: Number(parsed.counts?.burst ?? 0),
        limit_down: Number(parsed.counts?.limit_down ?? 0),
        strong: Number(parsed.counts?.strong ?? 0),
        previous_limit_up: Number(parsed.counts?.previous_limit_up ?? 0),
      },
      maxLimitUpHeight: Number(parsed.maxLimitUpHeight ?? 0),
      limitUpIndustries: Array.isArray(parsed.limitUpIndustries) ? parsed.limitUpIndustries : [],
      parseMode: "json",
    }
  } catch {
    return {
      file: filePath,
      tradeDate: normalizeTradeDate(stringAfter(text, "evidenceTradeDate") || stringAfter(text, "planTradeDate") || stringAfter(text, "tradeDate")),
      generatedAt: stringAfter(text, "generatedAt"),
      counts: {
        limit_up: numberAfter(text, "limit_up"),
        burst: numberAfter(text, "burst"),
        limit_down: numberAfter(text, "limit_down"),
        strong: numberAfter(text, "strong"),
        previous_limit_up: numberAfter(text, "previous_limit_up"),
      },
      maxLimitUpHeight: numberAfter(text, "maxLimitUpHeight"),
      limitUpIndustries: extractIndustriesFromText(text),
      parseMode: "salvaged",
    }
  }
}

function loadRecentSnapshots(projectPath, lookbackDays) {
  const dir = path.join(projectPath, ".llm-wiki/akshare-emotion")
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir)
    .filter((name) => /shortline-emotion\.json$/i.test(name))
    .map((name) => {
      const filePath = path.join(dir, name)
      return { filePath, stat: fs.statSync(filePath) }
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)

  const byDate = new Map()
  for (const item of files) {
    const snapshot = parseSnapshot(item.filePath)
    if (!snapshot.tradeDate) continue
    if (!byDate.has(snapshot.tradeDate)) byDate.set(snapshot.tradeDate, snapshot)
    if (byDate.size >= Number(lookbackDays)) break
  }
  return [...byDate.values()].sort((a, b) => b.tradeDate.localeCompare(a.tradeDate))
}

function buildThemeScores(snapshots) {
  const scores = new Map()
  snapshots.forEach((snapshot, index) => {
    const recencyWeight = 1 / (index + 1)
    for (const item of snapshot.limitUpIndustries ?? []) {
      const name = String(item.name ?? "").trim()
      const count = Number(item.count ?? 0)
      if (!name || count <= 0) continue
      const current = scores.get(name) ?? { name, count: 0, latestCount: 0, score: 0, days: 0 }
      current.count += count
      current.score += count * recencyWeight
      current.days += 1
      if (index === 0) current.latestCount = count
      scores.set(name, current)
    }
  })
  const top = [...scores.values()]
    .map((item) => ({ ...item, score: round(item.score, 2) }))
    .sort((a, b) => b.score - a.score || b.latestCount - a.latestCount || a.name.localeCompare(b.name))
    .slice(0, 30)
  return {
    topThemes: top,
    themeScores: Object.fromEntries(top.map((item) => [item.name, item])),
  }
}

function classifyRegime(metrics) {
  if (metrics.profitEffectScore >= 72 && metrics.maxLimitUpHeight >= 4 && metrics.burstPressure < 0.42) return "attack"
  if (metrics.profitEffectScore >= 58) return "mixed"
  if (metrics.profitEffectScore >= 43) return "selective"
  return "defensive"
}

function riskLevel(metrics) {
  if (metrics.burstPressure >= 0.45 || metrics.limitDownPressure >= 0.35) return "high"
  if (metrics.burstPressure >= 0.32 || metrics.limitDownPressure >= 0.22) return "medium"
  return "low"
}

function buildRegime(projectPath, options = {}) {
  const lookbackDays = Number(options.lookbackDays ?? 5)
  const snapshots = loadRecentSnapshots(projectPath, lookbackDays)
  const generatedAt = nowLocalTimestamp()
  if (snapshots.length === 0) {
    return {
      schema: "73wiki-market-regime-v1",
      id: `market_regime_${idTimestamp()}_empty`,
      status: "warning",
      generatedAt,
      projectPath,
      lookbackDays,
      snapshots: [],
      summary: "No akshare emotion snapshots found.",
      writePolicy: { rawWrite: false, wikiWrite: false, buyAdvice: false },
    }
  }

  const latest = snapshots[0]
  const previous = snapshots.slice(1)
  const avgLimitUp = average(snapshots.map((item) => item.counts.limit_up))
  const avgBurst = average(snapshots.map((item) => item.counts.burst))
  const avgLimitDown = average(snapshots.map((item) => item.counts.limit_down))
  const avgHeight = average(snapshots.map((item) => item.maxLimitUpHeight))
  const previousAvgLimitUp = previous.length ? average(previous.map((item) => item.counts.limit_up)) : latest.counts.limit_up
  const limitUpTrend = latest.counts.limit_up - previousAvgLimitUp
  const burstPressure = avgBurst / Math.max(1, avgLimitUp + avgBurst)
  const limitDownPressure = avgLimitDown / Math.max(1, avgLimitUp + avgLimitDown)
  const themeBreadth = latest.limitUpIndustries?.filter((item) => Number(item.count ?? 0) >= 3).length ?? 0
  const profitEffectScore = clamp(
    50
      + (avgLimitUp - 45) * 0.45
      + (avgHeight - 3) * 6
      + limitUpTrend * 0.16
      + Math.min(12, themeBreadth * 2)
      - burstPressure * 35
      - limitDownPressure * 25,
    0,
    100,
  )
  const metrics = {
    avgLimitUp: round(avgLimitUp, 1),
    avgBurst: round(avgBurst, 1),
    avgLimitDown: round(avgLimitDown, 1),
    avgLimitUpHeight: round(avgHeight, 1),
    maxLimitUpHeight: Math.max(...snapshots.map((item) => Number(item.maxLimitUpHeight ?? 0))),
    latestLimitUp: latest.counts.limit_up,
    latestBurst: latest.counts.burst,
    latestLimitDown: latest.counts.limit_down,
    limitUpTrend: round(limitUpTrend, 1),
    burstPressure: round(burstPressure, 3),
    limitDownPressure: round(limitDownPressure, 3),
    themeBreadth,
    profitEffectScore: round(profitEffectScore, 1),
  }
  const mode = classifyRegime(metrics)
  const risk = riskLevel(metrics)
  const themeData = buildThemeScores(snapshots)
  const bias = mode === "attack"
    ? "Favor front-line leaders in hot themes; allow higher next-day tradeability."
    : mode === "mixed"
      ? "Favor confirmed hot themes; reduce weak follow-up candidates."
      : mode === "selective"
        ? "Only upgrade candidates with strong evidence and market-matched themes."
        : "Defense first; penalize standalone catalysts without theme confirmation."

  return {
    schema: "73wiki-market-regime-v1",
    id: `market_regime_${latest.tradeDate.replace(/-/g, "")}_${idTimestamp()}_${shortHash(JSON.stringify(metrics))}`,
    status: "active",
    generatedAt,
    projectPath,
    lookbackDays,
    evidenceTradeDate: latest.tradeDate,
    tradeDate: latest.tradeDate,
    source: "akshare-emotion-derived",
    sourceTier: "derived_market_context",
    mode,
    riskLevel: risk,
    profitEffectScore: metrics.profitEffectScore,
    metrics,
    latest: {
      tradeDate: latest.tradeDate,
      counts: latest.counts,
      maxLimitUpHeight: latest.maxLimitUpHeight,
      parseMode: latest.parseMode,
      file: projectRelative(projectPath, latest.file),
    },
    snapshots: snapshots.map((item) => ({
      tradeDate: item.tradeDate,
      generatedAt: item.generatedAt,
      counts: item.counts,
      maxLimitUpHeight: item.maxLimitUpHeight,
      parseMode: item.parseMode,
      file: projectRelative(projectPath, item.file),
    })),
    topThemes: themeData.topThemes,
    themeScores: themeData.themeScores,
    recommendedBias: bias,
    summary: `mode=${mode}, risk=${risk}, profitEffect=${metrics.profitEffectScore}, avgLimitUp=${metrics.avgLimitUp}, burstPressure=${metrics.burstPressure}, topThemes=${themeData.topThemes.slice(0, 5).map((item) => item.name).join("/")}`,
    claim: "Market regime summarizes recent profit effect before scoring next-day candidates.",
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }
}

function markdownReport(record) {
  const lines = [
    "# Market Regime",
    "",
    `Generated: ${record.generatedAt}`,
    `Evidence trade date: ${record.evidenceTradeDate ?? "n/a"}`,
    `Mode: ${record.mode ?? "n/a"}`,
    `Risk level: ${record.riskLevel ?? "n/a"}`,
    `Profit effect score: ${record.profitEffectScore ?? "n/a"}`,
    `Bias: ${record.recommendedBias ?? "n/a"}`,
    "",
    "## Metrics",
    "",
  ]
  for (const [key, value] of Object.entries(record.metrics ?? {})) lines.push(`- ${key}: ${value}`)
  lines.push("", "## Hot Themes", "")
  for (const item of record.topThemes ?? []) lines.push(`- ${item.name}: score=${item.score}, latest=${item.latestCount}, days=${item.days}`)
  lines.push("", "This layer is context for candidate scoring, not buy advice.")
  return `${lines.join("\n").trim()}\n`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const record = buildRegime(projectPath, options)
  if (options.write) {
    const stamp = idTimestamp()
    const outDir = path.join(projectPath, REPORT_ROOT)
    const jsonPath = path.join(outDir, `${stamp}-market-regime.json`)
    const mdPath = path.join(outDir, `${stamp}-market-regime.md`)
    writeJson(jsonPath, record)
    writeText(mdPath, markdownReport(record))
    writeJson(path.join(outDir, "latest-market-regime.json"), record)
    writeText(path.join(outDir, "latest-market-regime.md"), markdownReport(record))
    appendJsonl(path.join(projectPath, FACT_PATH), record)
    return {
      dryRun: false,
      record,
      written: {
        facts: FACT_PATH,
        report: projectRelative(projectPath, jsonPath),
        latest: projectRelative(projectPath, path.join(outDir, "latest-market-regime.json")),
      },
    }
  }
  return { dryRun: true, record }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/market-regime.mjs --project <wiki-root> --lookback-days 5 --write")
    return
  }
  const result = run({
    projectPath: args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH,
    lookbackDays: Number(args["lookback-days"] ?? args._[1] ?? 5),
    write: Boolean(args.write || args._.includes("write")),
  })
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(JSON.stringify({
      dryRun: result.dryRun,
      id: result.record.id,
      status: result.record.status,
      tradeDate: result.record.tradeDate,
      mode: result.record.mode,
      riskLevel: result.record.riskLevel,
      profitEffectScore: result.record.profitEffectScore,
      summary: result.record.summary,
      written: result.written ?? null,
    }, null, 2))
  }
}

main()
