#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const MANIFEST_PATH = ".llm-wiki/review-runs/latest-review-manifest.json"
const REPORT_ROOT = ".llm-wiki/review-apply"

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["write", "json", "help", "apply-approved"].includes(key)) {
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

function safeTarget(projectPath, relativePath) {
  const normalized = String(relativePath ?? "").replace(/\\/g, "/")
  if (!normalized.startsWith("wiki/")) throw new Error(`Refuse non-wiki target: ${relativePath}`)
  if (normalized.includes("..")) throw new Error(`Refuse path traversal target: ${relativePath}`)
  const absolute = path.resolve(projectPath, normalized)
  const wikiRoot = path.resolve(projectPath, "wiki")
  if (!absolute.startsWith(wikiRoot)) throw new Error(`Refuse target outside wiki: ${relativePath}`)
  return absolute
}

function operationBlock(operation, manifest) {
  return [
    "",
    `## ${manifest.generatedAt} · ${operation.riskLevel} · ${operation.taskId}`,
    "",
    `- action: ${operation.action}`,
    `- source: ${operation.source}`,
    `- reason: ${String(operation.reason ?? "").replace(/\r?\n/g, " ")}`,
    `- sourceFiles: ${operation.sourceFiles?.join("；") ?? ""}`,
    `- manifest: ${manifest.id}`,
    "",
  ].join("\n")
}

function applyOperation(projectPath, operation, manifest, applyApproved) {
  const target = safeTarget(projectPath, operation.targetPath)
  const block = operationBlock(operation, manifest)
  const alreadyExists = fs.existsSync(target) && fs.readFileSync(target, "utf8").includes(operation.taskId)
  if (!applyApproved) {
    return { ...operation, applied: false, dryRun: true, skipped: alreadyExists, absoluteTarget: target }
  }
  if (alreadyExists) {
    return { ...operation, applied: false, dryRun: false, skipped: true, reasonSkipped: "already-applied", absoluteTarget: target }
  }
  ensureDir(path.dirname(target))
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, `# ${path.basename(target, ".md")}\n\n> 自动审核候选池。只记录候选，不等于正式制度。\n`, "utf8")
  }
  fs.appendFileSync(target, block, "utf8")
  return { ...operation, applied: true, dryRun: false, skipped: false, absoluteTarget: target }
}

function buildMarkdown(report) {
  const rows = report.results.map((item) => `| ${item.applied ? "applied" : item.skipped ? "skipped" : "dry-run"} | ${item.riskLevel} | ${item.targetPath} | ${String(item.reason ?? "").replace(/\|/g, "/").slice(0, 120)} |`).join("\n")
  return `# Review Apply Report\n\n生成时间：${report.generatedAt}\n模式：${report.applyApproved ? "apply-approved" : "dry-run"}\n\n| 状态 | 风险 | 目标 | 原因 |\n|---|---|---|---|\n${rows}\n\n## 边界\n\n- 只追加候选池页面，不覆盖原文。\n- 拒绝写 raw/**。\n- 拒绝写 wiki/ 外路径。\n`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/review-apply.mjs --project C:/wiki/73神话 --write [--apply-approved]")
    return
  }
  const projectPath = path.resolve(args.project ?? DEFAULT_PROJECT_PATH)
  const manifest = readJsonMaybe(path.join(projectPath, MANIFEST_PATH))
  if (!manifest) throw new Error(`Missing manifest: ${MANIFEST_PATH}`)
  const applyApproved = Boolean(args["apply-approved"])
  const results = (manifest.operations ?? []).map((operation) => applyOperation(projectPath, operation, manifest, applyApproved))
  const report = {
    schema: "73wiki-review-apply-report-v1",
    id: `review_apply_${idTimestamp()}_${shortHash(`${manifest.id}:${applyApproved}`)}`,
    status: applyApproved ? "applied" : "dry-run",
    applyApproved,
    generatedAt: nowLocalTimestamp(),
    projectPath,
    manifestId: manifest.id,
    counts: {
      total: results.length,
      applied: results.filter((item) => item.applied).length,
      skipped: results.filter((item) => item.skipped).length,
      dryRun: results.filter((item) => item.dryRun).length,
    },
    results,
    writePolicy: {
      rawWrite: false,
      wikiWrite: applyApproved,
      appendOnly: true,
    },
  }
  if (args.write || applyApproved) {
    const stamp = idTimestamp()
    const outDir = path.join(projectPath, REPORT_ROOT)
    writeJson(path.join(outDir, `${stamp}-review-apply.json`), report)
    writeText(path.join(outDir, `${stamp}-review-apply.md`), buildMarkdown(report))
    writeJson(path.join(outDir, "latest-review-apply.json"), report)
    writeText(path.join(outDir, "latest-review-apply.md"), buildMarkdown(report))
  }
  if (args.json || !args.write) console.log(JSON.stringify(report, null, 2))
  else console.log(`[review-apply] status=${report.status} applied=${report.counts.applied} dryRun=${report.counts.dryRun}`)
}

main()
