#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SOURCE_PATH = path.resolve(SCRIPT_DIR, "..")
const DEFAULT_MANAGER_PATH = process.env.FEISHU_73_MANAGER_PATH ?? "C:/Users/Administrator/Desktop/workspace/feishu-73-manager"
const REPORT_ROOT = ".llm-wiki/system-health"

const CORE_ARTIFACTS = [
  { label: "marketCollect", relativePath: ".llm-wiki/market-collect/latest-market-collect.json" },
  { label: "watchlist", relativePath: ".llm-wiki/market-watchlist/latest-warroom-watchlist.json" },
  { label: "executionBrief", relativePath: ".llm-wiki/execution-brief/latest-execution-brief.json" },
  { label: "executionAudit", relativePath: ".llm-wiki/execution-audit/latest-execution-audit.json" },
  { label: "warroomSkeleton", relativePath: ".llm-wiki/warroom-skeleton/latest-warroom-skeleton.json" },
  { label: "encodingHealth", relativePath: ".llm-wiki/encoding-health/latest-encoding-health.json" },
  { label: "hypothesisValidation", relativePath: ".llm-wiki/hypothesis-validation/latest-hypothesis-validation.json" },
  { label: "brainHealth", relativePath: ".llm-wiki/brain-health/latest-brain-health.json" },
  { label: "learningLayers", relativePath: ".llm-wiki/learning-layers/latest-learning-layers.json" },
  { label: "minuteBars", relativePath: ".llm-wiki/minute-bars/latest-minute-bars.json" },
  { label: "correctionAlerts", relativePath: ".llm-wiki/correction-alerts/latest-correction-alerts.json" },
  { label: "evidenceQueue", relativePath: ".llm-wiki/evidence-queue/latest-evidence-queue.json" },
  { label: "reviewManifest", relativePath: ".llm-wiki/review-runs/latest-review-manifest.json" },
  { label: "trainingLora", relativePath: ".llm-wiki/training-lora/latest-training-lora-report.json" },
  { label: "conceptPools", relativePath: ".llm-wiki/concept-pools/latest-concept-pools.json" },
  { label: "preopen", relativePath: ".llm-wiki/preopen/latest-preopen-intel.json" },
  { label: "tencentMarket", relativePath: ".llm-wiki/tencent-market/latest-tencent-market.json" },
  { label: "akshareEmotion", relativePath: ".llm-wiki/akshare-emotion/latest-shortline-emotion.json" },
  { label: "ifindEnhance", relativePath: ".llm-wiki/ifind-enhance/latest-ifind-enhance.json" },
  { label: "thsHotlist", relativePath: ".llm-wiki/ths-hotlist/latest-ths-hotlist.json" },
  { label: "limitUpReasons", relativePath: ".llm-wiki/limit-up-reasons/latest-limit-up-reasons.json" },
]

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

function projectRelative(projectPath, targetPath) {
  return path.relative(path.resolve(projectPath), path.resolve(targetPath)).replace(/\\/g, "/")
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function spawnJson(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  })
  const stdout = String(result.stdout ?? "").trim()
  const stderr = String(result.stderr ?? "").trim()
  let json = null
  if (stdout) {
    try {
      json = JSON.parse(stdout)
    } catch {
      json = null
    }
  }
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout,
    stderr,
    json,
  }
}

function collectArtifacts(projectPath) {
  return CORE_ARTIFACTS.map((item) => {
    const absolutePath = path.join(projectPath, item.relativePath)
    const data = readJsonMaybe(absolutePath)
    return {
      label: item.label,
      path: item.relativePath,
      exists: Boolean(data),
      generatedAt: data?.generatedAt ?? data?.startedAt ?? null,
      tradeDate: normalizeTradeDate(data?.tradeDate),
      planTradeDate: normalizeTradeDate(data?.planTradeDate),
      evidenceTradeDate: normalizeTradeDate(data?.evidenceTradeDate),
      hasDateMismatch: typeof data?.hasDateMismatch === "boolean" ? data.hasDateMismatch : null,
    }
  })
}

function checkDateAudit(projectPath, sourcePath) {
  return spawnJson(process.execPath, [
    path.join(sourcePath, "scripts/date-audit.mjs"),
    "--project",
    projectPath,
    "--json",
  ], { cwd: sourcePath })
}

function checkCorrectionPush(projectPath, sourcePath, managerPath) {
  return spawnJson(process.execPath, [
    path.join(sourcePath, "scripts/correction-push.mjs"),
    "--project",
    projectPath,
    "--manager-path",
    managerPath,
    "--dry-run",
  ], { cwd: sourcePath })
}

function checkBrainPush(projectPath, sourcePath, managerPath) {
  return spawnJson(process.execPath, [
    path.join(sourcePath, "scripts/brain-push.mjs"),
    "--project",
    projectPath,
    "--manager-path",
    managerPath,
    "--dry-run",
  ], { cwd: sourcePath })
}

function checkScheduledTasks() {
  return spawnJson("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Get-ScheduledTask -TaskName '73WIKI-Market-*' -ErrorAction SilentlyContinue | Select-Object TaskName,State | ConvertTo-Json -Compress",
  ])
}

function buildSummary(missingArtifacts, dateAudit, correctionPush, brainPush, scheduledTaskItems) {
  const problems = []
  if (missingArtifacts.length > 0) problems.push(`missing artifacts: ${missingArtifacts.join(", ")}`)
  if (!dateAudit.ok) problems.push("date audit failed")
  if (!correctionPush.ok) problems.push("correction push dry-run failed")
  if (!brainPush.ok) problems.push("brain push dry-run failed")
  if (scheduledTaskItems.length === 0) problems.push("no scheduled tasks found")
  return problems.length > 0
    ? problems.join("; ")
    : "core artifacts ready; date audit passed; Feishu bridge dry-runs passed."
}

function buildMarkdown(record) {
  const lines = [
    `# ${record.title}`,
    "",
    `生成时间: ${record.generatedAt}`,
    `项目: ${record.projectPath}`,
    `总体状态: ${record.ok ? "ok" : "needs-attention"}`,
    "",
    "## 核心摘要",
    "",
    record.summary,
    "",
    "## 主链产物",
    "",
    "| Artifact | Exists | GeneratedAt | TradeDate | PlanTradeDate | EvidenceTradeDate |",
    "|---|---|---|---|---|---|",
  ]

  for (const item of record.artifacts) {
    lines.push(`| ${item.label} | ${item.exists ? "yes" : "no"} | ${item.generatedAt ?? "-"} | ${item.tradeDate ?? "-"} | ${item.planTradeDate ?? "-"} | ${item.evidenceTradeDate ?? "-"} |`)
  }

  lines.push("")
  lines.push("## 日期审计")
  lines.push("")
  if (record.dateAudit?.json) {
    lines.push(`- 状态: ${record.dateAudit.ok ? "passed" : "failed"}`)
    lines.push(`- Missing protocol fields: ${record.dateAudit.json.missingProtocol?.length ?? 0}`)
    lines.push(`- Suspicious future evidence: ${record.dateAudit.json.suspiciousFutureEvidence?.length ?? 0}`)
    lines.push(`- Allowlisted future evidence: ${record.dateAudit.json.allowlistedFutureEvidence?.length ?? 0}`)
  } else {
    lines.push(`- No valid JSON returned: ${record.dateAudit.stderr || record.dateAudit.stdout || "unknown error"}`)
  }

  lines.push("")
  lines.push("## 飞书桥")
  lines.push("")
  lines.push(`- managerPathExists: ${record.feishu.managerPathExists}`)
  lines.push(`- bridgeScriptDetected: ${record.feishu.bridgeScriptDetected}`)
  lines.push(`- correctionPushDryRun: ${record.feishu.correctionDryRun.ok ? "ok" : "failed"}`)
  lines.push(`- brainPushDryRun: ${record.feishu.brainDryRun.ok ? "ok" : "failed"}`)
  if (record.feishu.correctionDryRun.json) {
    lines.push(`- correctionDryRunSummary: ${JSON.stringify(record.feishu.correctionDryRun.json)}`)
  }
  if (record.feishu.brainDryRun.json) {
    lines.push(`- brainDryRunSummary: ${JSON.stringify(record.feishu.brainDryRun.json)}`)
  }

  lines.push("")
  lines.push("## 定时任务")
  lines.push("")
  if (Array.isArray(record.scheduledTasks.tasks) && record.scheduledTasks.tasks.length > 0) {
    for (const task of record.scheduledTasks.tasks) {
      lines.push(`- ${task.TaskName}: ${task.State}`)
    }
  } else {
    lines.push(`- 未读取到定时任务: ${record.scheduledTasks.error ?? "empty"}`)
  }

  lines.push("")
  lines.push("## 说明")
  lines.push("")
  lines.push("- 系统健康页只做链路状态、产物存在性和 dry-run 审计，不生成交易建议。")
  lines.push("")
  return `${lines.join("\n")}\n`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const sourcePath = path.resolve(options.sourcePath ?? DEFAULT_SOURCE_PATH)
  const managerPath = path.resolve(options.managerPath ?? DEFAULT_MANAGER_PATH)
  const generatedAt = nowLocalTimestamp()
  const artifacts = collectArtifacts(projectPath)
  const missingArtifacts = artifacts.filter((item) => !item.exists).map((item) => item.label)
  const dateAudit = checkDateAudit(projectPath, sourcePath)
  const correctionPush = checkCorrectionPush(projectPath, sourcePath, managerPath)
  const brainPush = checkBrainPush(projectPath, sourcePath, managerPath)
  const scheduledTasks = checkScheduledTasks()
  const scheduledTaskItems = Array.isArray(scheduledTasks.json)
    ? scheduledTasks.json
    : scheduledTasks.json
      ? [scheduledTasks.json]
      : []
  const summary = buildSummary(missingArtifacts, dateAudit, correctionPush, brainPush, scheduledTaskItems)
  const bridgeCandidates = [
    path.join(managerPath, "scripts/send-correction-alerts.mjs"),
    path.join(managerPath, "scripts/send-brain-alerts.mjs"),
    path.join(managerPath, "scripts/send-intraday-report.mjs"),
    path.join(managerPath, "scripts/start-feishu-73-manager.ps1"),
  ]
  const record = {
    schema: "73wiki-system-health-v2",
    id: `system_health_${idTimestamp()}_${shortHash(summary)}`,
    status: "active",
    title: "73交易大脑系统健康页",
    generatedAt,
    ok: missingArtifacts.length === 0 && dateAudit.ok && correctionPush.ok && brainPush.ok && scheduledTaskItems.length > 0,
    projectPath,
    sourcePath,
    artifacts,
    missingArtifacts,
    dateAudit,
    feishu: {
      managerPath,
      managerPathExists: fs.existsSync(managerPath),
      bridgeScriptDetected: bridgeCandidates.some((candidate) => fs.existsSync(candidate)),
      correctionDryRun: correctionPush,
      brainDryRun: brainPush,
    },
    scheduledTasks: {
      ok: scheduledTaskItems.length > 0,
      tasks: scheduledTaskItems,
      error: scheduledTaskItems.length === 0 ? (scheduledTasks.stderr || scheduledTasks.stdout || "empty") : null,
    },
    summary,
    claim: "系统健康页只做链路状态和审计结果汇总，不生成交易建议。",
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }

  if (!options.write) return { dryRun: true, record }

  const reportDir = path.join(projectPath, REPORT_ROOT)
  const stamp = idTimestamp()
  const jsonPath = path.join(reportDir, `${stamp}-system-health.json`)
  const mdPath = path.join(reportDir, `${stamp}-system-health.md`)
  const latestJson = path.join(reportDir, "latest-system-health.json")
  const latestMd = path.join(reportDir, "latest-system-health.md")
  const markdown = buildMarkdown(record)
  writeJson(jsonPath, record)
  writeJson(latestJson, record)
  writeText(mdPath, markdown)
  writeText(latestMd, markdown)
  return {
    dryRun: false,
    record,
    written: {
      report: projectRelative(projectPath, jsonPath),
      markdown: projectRelative(projectPath, mdPath),
      latest: projectRelative(projectPath, latestJson),
    },
  }
}

function printHelp() {
  console.log(`Usage:
  npm run system:health -- --project C:\\wiki\\73神话 --write
`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  const result = run({
    projectPath: args.project ?? args._[0],
    sourcePath: args["source-path"] ?? args._[1],
    managerPath: args["manager-path"] ?? args._[2],
    write: Boolean(args.write),
  })
  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(JSON.stringify({
    dryRun: result.dryRun,
    ok: result.record.ok,
    summary: result.record.summary,
    missingArtifacts: result.record.missingArtifacts,
    written: result.written,
  }, null, 2))
}

main()
