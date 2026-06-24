#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPORT_ROOT = ".llm-wiki/training-flywheel"

const STEPS = [
  { name: "market-regime", script: "market-regime.mjs" },
  { name: "market-strength-rank", script: "market-strength-rank.mjs" },
  { name: "market-focus-universe", script: "market-focus-universe.mjs" },
  { name: "focus-trend-validation", script: "focus-trend-validation.mjs" },
  { name: "hotlist-health", script: "hotlist-health.mjs" },
  { name: "evidence-queue", script: "evidence-queue.mjs" },
  { name: "review-manifest", script: "review-manifest.mjs" },
  { name: "next-limitup-review", script: "next-limitup-review.mjs" },
  { name: "prediction-outcome-review", script: "prediction-outcome-review.mjs" },
  { name: "score-feedback", script: "score-feedback.mjs" },
  { name: "trading-trajectories", script: "trading-trajectories.mjs" },
  { name: "training-lora", script: "training-lora.mjs" },
  { name: "concept-pools", script: "concept-pools.mjs" },
  { name: "market-signal-dashboard", script: "market-signal-dashboard.mjs" },
  { name: "system-health", script: "system-health.mjs" },
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

function runStep(projectPath, step, write) {
  const args = [path.join(SCRIPT_DIR, step.script), "--project", projectPath]
  if (write) args.push("--write")
  const startedAt = nowLocalTimestamp()
  const result = spawnSync(process.execPath, args, {
    cwd: path.resolve(SCRIPT_DIR, ".."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  })
  return {
    name: step.name,
    script: step.script,
    ok: result.status === 0,
    status: result.status ?? 1,
    startedAt,
    finishedAt: nowLocalTimestamp(),
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
  }
}

function buildMarkdown(report) {
  const rows = report.steps.map((step) => `| ${step.ok ? "ok" : "fail"} | ${step.name} | ${step.status} | ${step.stdout.replace(/\r?\n/g, "<br>").replace(/\|/g, "/").slice(0, 220)} |`).join("\n")
  return `# Training Flywheel Run\n\n生成时间：${report.generatedAt}\n状态：${report.ok ? "ok" : "failed"}\n\n| 状态 | 步骤 | 退出码 | 输出 |\n|---|---|---:|---|\n${rows}\n\n## 边界\n\n- 默认只生成旁路产物和训练数据集。\n- 不写 raw/**。\n- 不自动 apply 正式 WIKI 修改。\n`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/training-flywheel.mjs --project C:/wiki/73神话 --write")
    return
  }
  const projectPath = path.resolve(args.project ?? DEFAULT_PROJECT_PATH)
  const steps = []
  for (const step of STEPS) {
    const result = runStep(projectPath, step, Boolean(args.write))
    steps.push(result)
    if (!result.ok) break
  }
  const report = {
    schema: "73wiki-training-flywheel-run-v1",
    id: `training_flywheel_${idTimestamp()}_${shortHash(steps.map((step) => `${step.name}:${step.status}`).join("|"))}`,
    status: steps.every((step) => step.ok) ? "active" : "failed",
    ok: steps.every((step) => step.ok),
    generatedAt: nowLocalTimestamp(),
    projectPath,
    steps,
    writePolicy: {
      rawWrite: false,
      directWikiWrite: false,
      datasetWrite: true,
    },
  }
  if (args.write) {
    const stamp = idTimestamp()
    const outDir = path.join(projectPath, REPORT_ROOT)
    writeJson(path.join(outDir, `${stamp}-training-flywheel.json`), report)
    writeText(path.join(outDir, `${stamp}-training-flywheel.md`), buildMarkdown(report))
    writeJson(path.join(outDir, "latest-training-flywheel.json"), report)
    writeText(path.join(outDir, "latest-training-flywheel.md"), buildMarkdown(report))
  }
  if (args.json || !args.write) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`[training-flywheel] ok=${report.ok} steps=${report.steps.length}`)
    if (!report.ok) process.exitCode = 1
  }
}

main()
