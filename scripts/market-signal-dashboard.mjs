#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73wiki"
const REPORT_ROOT = ".llm-wiki/market-signal-dashboard"
const WIKI_PATH = "wiki/09-统计与进化/市场信号验证面板.md"

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

function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function writeText(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, value, "utf8")
}

function projectRelative(projectPath, targetPath) {
  return path.relative(path.resolve(projectPath), path.resolve(targetPath)).replace(/\\/g, "/")
}

function buildRecord(projectPath) {
  const llm = path.join(projectPath, ".llm-wiki")
  const focus = readJsonMaybe(path.join(llm, "market-focus-universe", "latest-market-focus-universe.json"))
  const trend = readJsonMaybe(path.join(llm, "focus-trend-validation", "latest-focus-trend-validation.json"))
  const outcome = readJsonMaybe(path.join(llm, "prediction-outcome-review", "latest-prediction-outcome-review.json"))
  const feedback = readJsonMaybe(path.join(llm, "score-feedback", "latest-score-feedback.json"))
  const hotlist = readJsonMaybe(path.join(llm, "hotlist-health", "latest-hotlist-health.json"))
  const generatedAt = nowLocalTimestamp()
  return {
    schema: "73wiki-market-signal-dashboard-v1",
    id: `market_signal_dashboard_${idTimestamp()}_${shortHash([focus?.id, trend?.id, outcome?.id, feedback?.id, hotlist?.id].join("|"))}`,
    status: "active",
    generatedAt,
    projectPath,
    focus,
    trend,
    outcome,
    feedback,
    hotlist,
    writePolicy: { rawWrite: false, wikiWrite: true, buyAdvice: false },
  }
}

function markdown(record) {
  const focus = record.focus
  const trend = record.trend
  const outcome = record.outcome
  const feedback = record.feedback
  const hotlist = record.hotlist
  const lines = [
    "# 市场信号验证面板",
    "",
    `更新时间：${record.generatedAt}`,
    "",
    "## 当前结论",
    "",
    `- 关注池：${focus?.counts?.items ?? 0} 只；趋势核心 ${focus?.counts?.trendCore ?? 0}，连板候选 ${focus?.counts?.limitBoard ?? 0}，热榜套利 ${focus?.counts?.hotlistArbitrage ?? 0}。`,
    `- 趋势验证：可验证 ${trend?.counts?.evaluable ?? 0} 只；大趋势赢家 ${trend?.counts?.trendBigWin ?? 0}，趋势赢家 ${trend?.counts?.trendWin ?? 0}，可交易结果 ${trend?.counts?.tradable ?? 0}。`,
    `- 预测验证：样本 ${outcome?.counts?.candidates ?? 0}，可验证 ${outcome?.counts?.evaluable ?? 0}，赚钱命中率 ${outcome?.counts?.moneyHitRate ?? "-"}。`,
    `- 评分反馈：规则 ${feedback?.counts?.rules ?? 0} 条；上调 ${feedback?.counts?.raises ?? 0}，下调 ${feedback?.counts?.cuts ?? 0}。`,
    `- 热榜健康：${hotlist?.ok ? "正常" : "需检查"}；警告 ${hotlist?.warnings?.length ?? 0} 条。`,
    "",
    "## 关注池 Top",
    "",
  ]
  for (const item of focus?.items?.slice(0, 30) ?? []) {
    lines.push(`- ${item.focusRank}. ${item.name || item.code}(${item.code}) score=${item.score} role=${item.role} sources=${(item.sources ?? []).join("/")}`)
  }
  lines.push("", "## 趋势区间赢家", "")
  for (const item of trend?.leaders?.slice(0, 30) ?? []) {
    lines.push(`- ${item.intervalStrengthRank}. ${item.name || item.code}(${item.code}) focusRank=${item.focusRank ?? "-"} D3max=${item.metrics?.checkpoints?.D3?.maxGainPct ?? "-"}% D5max=${item.metrics?.checkpoints?.D5?.maxGainPct ?? "-"}% label=${item.label}`)
  }
  lines.push("", "## 方法反馈", "")
  for (const rule of feedback?.rules?.slice(0, 25) ?? []) {
    lines.push(`- ${rule.type}:${rule.key} ${rule.action} delta=${rule.scoreDelta} hitRate=${rule.hitRate ?? "-"} samples=${rule.evaluable}`)
  }
  lines.push("", "## 边界", "", "- 这是信号验证与训练面板，不是自动买入建议。", "- 所有 AI 写入仍走旁路和审核队列。", "- 趋势行情看 D3/D5 区间强度，连板行情看 D1/涨停结构。")
  return `${lines.join("\n").trim()}\n`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const record = buildRecord(projectPath)
  if (options.write) {
    const stamp = idTimestamp()
    const outDir = path.join(projectPath, REPORT_ROOT)
    const latestJson = path.join(outDir, "latest-market-signal-dashboard.json")
    const latestMd = path.join(outDir, "latest-market-signal-dashboard.md")
    const wikiPath = path.join(projectPath, WIKI_PATH)
    writeJson(path.join(outDir, `${stamp}-market-signal-dashboard.json`), record)
    writeJson(latestJson, record)
    writeText(path.join(outDir, `${stamp}-market-signal-dashboard.md`), markdown(record))
    writeText(latestMd, markdown(record))
    writeText(wikiPath, markdown(record))
    return { dryRun: false, record, written: { latest: projectRelative(projectPath, latestJson), markdown: projectRelative(projectPath, latestMd), wiki: projectRelative(projectPath, wikiPath) } }
  }
  return { dryRun: true, record }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/market-signal-dashboard.mjs --project <wiki-root> --write")
    return
  }
  const result = run({ projectPath: args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH, write: Boolean(args.write || args._.includes("write")) })
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else console.log(JSON.stringify({ dryRun: result.dryRun, id: result.record.id, written: result.written ?? null }, null, 2))
}

main()
