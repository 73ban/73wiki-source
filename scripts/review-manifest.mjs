#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const EVIDENCE_QUEUE_PATH = ".llm-wiki/evidence-queue/latest-evidence-queue.json"
const REPORT_ROOT = ".llm-wiki/review-runs"

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

function targetPathForTask(task) {
  if (task.type === "correction-alert") return "wiki/09-统计与进化/自动纠偏候选池.md"
  if (task.type === "execution-audit") return "wiki/09-统计与进化/执行纪律审计候选池.md"
  if (task.type === "hypothesis-validation") return "data/brain/validations.jsonl"
  if (task.type === "post-sell-validation") return "wiki/09-统计与进化/卖出后验证候选池.md"
  if (task.type === "stock-reason-card") return "wiki/03-L3个股档案/原因卡候选池.md"
  return "wiki/07-作战室/证据队列候选池.md"
}

function operationForTask(task) {
  return {
    schema: "73wiki-review-operation-v1",
    id: `op_${shortHash(task.id)}`,
    taskId: task.id,
    action: "stage_candidate",
    mode: "dry-run",
    targetPath: targetPathForTask(task),
    reason: task.summary,
    source: task.source,
    sourceFiles: task.sourceFiles ?? [],
    riskLevel: task.priority >= 80 ? "high" : task.priority >= 55 ? "medium" : "low",
    requiresUserApproval: true,
    rawWrite: false,
    wikiWrite: false,
  }
}

function buildManifest(projectPath) {
  const queue = readJsonMaybe(path.join(projectPath, EVIDENCE_QUEUE_PATH))
  const tasks = (queue?.tasks ?? []).filter((task) => task.reviewRequired || Number(task.priority ?? 0) >= 70)
  const operations = tasks.map(operationForTask)
  const now = new Date()
  return {
    schema: "73wiki-review-manifest-v1",
    id: `review_manifest_${idTimestamp(now)}_${shortHash(operations.map((item) => item.id).join("|"))}`,
    status: "review",
    generatedAt: nowLocalTimestamp(now),
    projectPath,
    sourceQueue: EVIDENCE_QUEUE_PATH,
    counts: {
      tasks: tasks.length,
      operations: operations.length,
      highRisk: operations.filter((item) => item.riskLevel === "high").length,
      mediumRisk: operations.filter((item) => item.riskLevel === "medium").length,
      lowRisk: operations.filter((item) => item.riskLevel === "low").length,
    },
    operations,
    applyPolicy: {
      defaultMode: "dry-run",
      rawWrite: false,
      directWikiWrite: false,
      requireExplicitUserApproval: true,
      note: "This manifest stages candidates only. It does not apply file mutations.",
    },
  }
}

function buildMarkdown(manifest) {
  const lines = [
    `# Wiki Change Review`,
    ``,
    `生成时间：${manifest.generatedAt}`,
    `状态：${manifest.status}`,
    ``,
    `## 摘要`,
    ``,
    `- 待复核任务：${manifest.counts.tasks}`,
    `- 候选操作：${manifest.counts.operations}`,
    `- 高风险：${manifest.counts.highRisk}`,
    `- 中风险：${manifest.counts.mediumRisk}`,
    ``,
    `## 候选操作`,
    ``,
    `| 风险 | 动作 | 目标 | 原因 |`,
    `|---|---|---|---|`,
  ]
  for (const op of manifest.operations.slice(0, 120)) {
    lines.push(`| ${op.riskLevel} | ${op.action} | ${op.targetPath} | ${String(op.reason ?? "").replace(/\|/g, "/").slice(0, 160)} |`)
  }
  lines.push(``, `## 结论`, ``, `本轮只生成审核清单，不写 raw/**，不直接写正式 wiki。`, ``)
  return `${lines.join("\n")}\n`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/review-manifest.mjs --project C:/wiki/73神话 --write")
    return
  }
  const projectPath = path.resolve(args.project ?? DEFAULT_PROJECT_PATH)
  const manifest = buildManifest(projectPath)
  if (args.write) {
    const runId = manifest.id
    const outDir = path.join(projectPath, REPORT_ROOT, runId)
    writeJson(path.join(outDir, "changes.json"), manifest)
    writeText(path.join(outDir, "wiki-change-review.md"), buildMarkdown(manifest))
    writeJson(path.join(projectPath, REPORT_ROOT, "latest-review-manifest.json"), manifest)
    writeText(path.join(projectPath, REPORT_ROOT, "latest-wiki-change-review.md"), buildMarkdown(manifest))
  }
  if (args.json || !args.write) console.log(JSON.stringify(manifest, null, 2))
  else console.log(`[review-manifest] operations=${manifest.counts.operations} highRisk=${manifest.counts.highRisk}`)
}

main()
