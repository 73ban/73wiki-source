#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const REPORT_ROOT = ".llm-wiki/encoding-health"
const HOT_FILES = [
  "wiki/00-总纲/总索引.md",
  "wiki/10-系统配置/2026-06-18-现行制度总目录.md",
  "wiki/10-系统配置/2026-06-18-73交易大脑启动口令.md",
  "wiki/07-作战室/当前作战室工作页.md",
  "wiki/06-持仓与资金管理/当前持仓决策.md",
  "wiki/09-统计与进化/当前学习层分层报告.md",
  ".llm-wiki/warroom-skeleton/latest-warroom-skeleton.json",
  ".llm-wiki/hypothesis-validation/latest-hypothesis-validation.json",
  ".llm-wiki/brain-health/latest-brain-health.json",
  ".llm-wiki/learning-layers/latest-learning-layers.json",
  ".llm-wiki/execution-audit/latest-execution-audit.json",
  ".llm-wiki/execution-brief/latest-execution-brief.json",
  ".llm-wiki/system-health/latest-system-health.json",
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

function projectRelative(projectPath, targetPath) {
  return path.relative(path.resolve(projectPath), path.resolve(targetPath)).replace(/\\/g, "/")
}

function inspectFile(projectPath, relativePath) {
  const absolutePath = path.join(projectPath, relativePath)
  if (!fs.existsSync(absolutePath)) {
    return {
      path: relativePath,
      exists: false,
      ok: false,
      reasons: ["missing"],
    }
  }
  const content = fs.readFileSync(absolutePath, "utf8")
  const reasons = []
  if (content.includes("\uFFFD")) reasons.push("replacement_char")
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(content)) reasons.push("control_char")
  let jsonOk = null
  if (relativePath.endsWith(".json")) {
    try {
      JSON.parse(content)
      jsonOk = true
    } catch {
      jsonOk = false
      reasons.push("json_parse_error")
    }
  }
  return {
    path: relativePath,
    exists: true,
    ok: reasons.length === 0,
    size: Buffer.byteLength(content, "utf8"),
    hasReplacementChar: content.includes("\uFFFD"),
    hasControlChar: /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(content),
    jsonOk,
    reasons,
  }
}

function buildMarkdown(record) {
  const lines = [
    `# ${record.title}`,
    "",
    `生成时间: ${record.generatedAt}`,
    `项目: ${record.projectPath}`,
    `总体状态: ${record.ok ? "ok" : "needs-attention"}`,
    "",
    "## 说明",
    "",
    "本页只检查高频入口文件是否存在明显编码损坏、控制字符和 JSON 结构错误。",
    "",
    "## 高频文件检查",
    "",
    "| File | Exists | Pass | Notes |",
    "|---|---|---|---|",
  ]
  for (const item of record.items) {
    lines.push(`| ${item.path} | ${item.exists ? "yes" : "no"} | ${item.ok ? "yes" : "no"} | ${item.reasons.join(", ") || "-"} |`)
  }
  lines.push("")
  lines.push("## 结论")
  lines.push("")
  lines.push(`- ${record.summary}`)
  lines.push("")
  return `${lines.join("\n")}\n`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const generatedAt = nowLocalTimestamp()
  const items = HOT_FILES.map((relativePath) => inspectFile(projectPath, relativePath))
  const failed = items.filter((item) => !item.ok)
  const record = {
    schema: "73wiki-encoding-health-v2",
    id: `encoding_health_${idTimestamp()}_${shortHash(projectPath)}`,
    status: "active",
    title: "73交易大脑编码健康页",
    generatedAt,
    projectPath,
    ok: failed.length === 0,
    items,
    failedPaths: failed.map((item) => item.path),
    summary: failed.length === 0 ? "高频入口文件未发现明显编码损坏。" : `发现 ${failed.length} 个高频文件存在编码或结构问题。`,
    claim: "编码健康页只检查高频入口，不代表历史全库已经完成编码治理。",
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }

  if (!options.write) return { dryRun: true, record }

  const reportDir = path.join(projectPath, REPORT_ROOT)
  const stamp = idTimestamp()
  const jsonPath = path.join(reportDir, `${stamp}-encoding-health.json`)
  const mdPath = path.join(reportDir, `${stamp}-encoding-health.md`)
  const latestJson = path.join(reportDir, "latest-encoding-health.json")
  const latestMd = path.join(reportDir, "latest-encoding-health.md")
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
  npm run audit:encoding -- --project C:\\wiki\\73神话
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
    write: Boolean(args.write),
  })
  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(JSON.stringify({
    dryRun: result.dryRun,
    ok: result.record.ok,
    failedPaths: result.record.failedPaths,
    written: result.written,
  }, null, 2))
}

main()
