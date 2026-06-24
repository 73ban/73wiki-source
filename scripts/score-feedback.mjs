#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73wiki"
const REPORT_ROOT = ".llm-wiki/score-feedback"
const FACT_PATH = "data/facts/score_feedback.jsonl"

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

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter(Boolean)
}

function projectRelative(projectPath, targetPath) {
  return path.relative(path.resolve(projectPath), path.resolve(targetPath)).replace(/\\/g, "/")
}

function avg(values) {
  const nums = values.map(Number).filter(Number.isFinite)
  return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null
}

function aggregate(rows, keyFn) {
  const map = new Map()
  for (const row of rows) {
    const keys = keyFn(row).filter(Boolean)
    for (const key of keys) {
      const bucket = map.get(key) ?? []
      bucket.push(row)
      map.set(key, bucket)
    }
  }
  return [...map.entries()].map(([key, items]) => {
    const evaluable = items.filter((item) => item.outcome?.label !== "data_gap")
    const wins = evaluable.filter((item) => item.outcome?.correct)
    const bestMax = avg(evaluable.map((item) => item.bestMaxGainPct))
    const hitRate = evaluable.length ? Math.round((wins.length / evaluable.length) * 10000) / 10000 : null
    return { key, samples: items.length, evaluable: evaluable.length, wins: wins.length, hitRate, avgBestMaxGainPct: bestMax }
  }).sort((a, b) => Number(b.hitRate ?? -1) - Number(a.hitRate ?? -1) || Number(b.avgBestMaxGainPct ?? -999) - Number(a.avgBestMaxGainPct ?? -999))
}

function adjustmentFor(stat) {
  if (stat.evaluable < 5) return { action: "observe", scoreDelta: 0, confidence: "low" }
  if (Number(stat.hitRate) >= 0.65 && Number(stat.avgBestMaxGainPct) >= 8) return { action: "raise", scoreDelta: 12, confidence: "medium" }
  if (Number(stat.hitRate) >= 0.55) return { action: "raise_small", scoreDelta: 5, confidence: "medium" }
  if (Number(stat.hitRate) <= 0.35 && Number(stat.avgBestMaxGainPct) < 5) return { action: "cut", scoreDelta: -12, confidence: "medium" }
  return { action: "hold", scoreDelta: 0, confidence: "medium" }
}

function buildRecord(projectPath, options = {}) {
  const rows = readJsonl(path.join(projectPath, "data/facts/prediction_outcome_reviews.jsonl"))
    .filter((record) => record.schema === "73wiki-prediction-outcome-review-v1")
    .slice(-Number(options.records ?? 30))
    .flatMap((record) => (record.items ?? []).map((item) => ({ ...item, predictionTradeDate: record.predictionTradeDate })))
  const bySourceTag = aggregate(rows, (item) => item.sourceTags ?? [])
  const byRole = aggregate(rows, (item) => [item.focusUniverse?.role, item.playbook?.label])
  const byTheme = aggregate(rows, (item) => (item.themes ?? []).slice(0, 8))
  const rules = [
    ...bySourceTag.map((stat) => ({ type: "sourceTag", ...stat, ...adjustmentFor(stat) })),
    ...byRole.map((stat) => ({ type: "roleOrPlaybook", ...stat, ...adjustmentFor(stat) })),
    ...byTheme.map((stat) => ({ type: "theme", ...stat, ...adjustmentFor(stat) })),
  ].filter((rule) => rule.action !== "observe").slice(0, Number(options.maxRules ?? 80))
  const generatedAt = nowLocalTimestamp()
  return {
    schema: "73wiki-score-feedback-v1",
    id: `score_feedback_${idTimestamp()}_${shortHash(rules.map((rule) => `${rule.type}:${rule.key}:${rule.scoreDelta}`).join("|"))}`,
    status: "active",
    generatedAt,
    projectPath,
    sourceRecords: Math.min(rows.length, Number(options.records ?? 30)),
    counts: {
      outcomeItems: rows.length,
      rules: rules.length,
      raises: rules.filter((rule) => rule.scoreDelta > 0).length,
      cuts: rules.filter((rule) => rule.scoreDelta < 0).length,
    },
    rules,
    note: "This is a dry-run scoring feedback layer. Prediction scripts can read it, but it does not overwrite trading rules or raw evidence.",
    writePolicy: { rawWrite: false, wikiWrite: false, buyAdvice: false, directWeightMutation: false },
  }
}

function markdown(record) {
  const lines = [
    "# Score Feedback",
    "",
    `Generated: ${record.generatedAt}`,
    `Outcome items: ${record.counts.outcomeItems}`,
    `Rules: ${record.counts.rules}`,
    "",
    "## Top Adjustments",
    "",
  ]
  for (const rule of record.rules.slice(0, 40)) {
    lines.push(`- ${rule.type}:${rule.key} action=${rule.action} delta=${rule.scoreDelta} hitRate=${rule.hitRate ?? "-"} avgBest=${rule.avgBestMaxGainPct ?? "-"} samples=${rule.evaluable}`)
  }
  lines.push("", "Dry-run only. It is not buy advice.")
  return `${lines.join("\n").trim()}\n`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const record = buildRecord(projectPath, options)
  if (options.write) {
    const stamp = idTimestamp()
    const outDir = path.join(projectPath, REPORT_ROOT)
    const latestJson = path.join(outDir, "latest-score-feedback.json")
    const latestMd = path.join(outDir, "latest-score-feedback.md")
    writeJson(path.join(outDir, `${stamp}-score-feedback.json`), record)
    writeJson(latestJson, record)
    writeText(path.join(outDir, `${stamp}-score-feedback.md`), markdown(record))
    writeText(latestMd, markdown(record))
    appendJsonl(path.join(projectPath, FACT_PATH), record)
    return { dryRun: false, record, written: { facts: FACT_PATH, latest: projectRelative(projectPath, latestJson), markdown: projectRelative(projectPath, latestMd) } }
  }
  return { dryRun: true, record }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/score-feedback.mjs --project <wiki-root> --write")
    return
  }
  const result = run({
    projectPath: args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH,
    records: Number(args.records ?? 30),
    maxRules: Number(args["max-rules"] ?? 80),
    write: Boolean(args.write || args._.includes("write")),
  })
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else console.log(JSON.stringify({ dryRun: result.dryRun, id: result.record.id, counts: result.record.counts, written: result.written ?? null }, null, 2))
}

main()
