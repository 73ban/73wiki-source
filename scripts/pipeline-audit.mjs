#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const REPORT_ROOT = ".llm-wiki/pipeline-audit"

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

function readJsonlMaybe(filePath, limit = 200000) {
  if (!fs.existsSync(filePath)) return []
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean)
  return lines.slice(-limit).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter(Boolean)
}

function statInfo(filePath) {
  try {
    const stat = fs.statSync(filePath)
    return {
      exists: true,
      path: filePath,
      mtime: nowLocalTimestamp(stat.mtime),
      ageHours: Math.round(((Date.now() - stat.mtimeMs) / 3_600_000) * 10) / 10,
      size: stat.size,
    }
  } catch {
    return { exists: false, path: filePath, mtime: null, ageHours: null, size: null }
  }
}

function walkFiles(rootPath, predicate, max = 100000) {
  const out = []
  if (!fs.existsSync(rootPath)) return out
  const stack = [rootPath]
  while (stack.length > 0 && out.length < max) {
    const current = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (![".git", ".llm-wiki", ".system", "node_modules", "__pycache__"].includes(entry.name)) stack.push(fullPath)
      } else if (!predicate || predicate(fullPath, entry.name)) {
        out.push(fullPath)
      }
    }
  }
  return out
}

function newestFile(rootPath, predicate) {
  let newest = null
  for (const filePath of walkFiles(rootPath, predicate)) {
    let stat = null
    try {
      stat = fs.statSync(filePath)
    } catch {
      continue
    }
    if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { path: filePath, mtimeMs: stat.mtimeMs, mtime: nowLocalTimestamp(stat.mtime), size: stat.size }
  }
  return newest
}

function groupCount(items, keyFn) {
  const counts = new Map()
  for (const item of items) {
    const key = keyFn(item) || "(empty)"
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }))
}

function registryKey(record) {
  const rawId = record?.raw_id ?? record?.rawId
  if (rawId) return `raw:${rawId}`
  const sourcePath = record?.source_path ?? record?.sourcePath
  const contentHash = record?.content_hash ?? record?.contentHash
  if (sourcePath && contentHash) return `path:${sourcePath}|${contentHash}`
  return null
}

function runPowerShellJson(command) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  const stdout = String(result.stdout ?? "").trim()
  let json = null
  if (stdout) {
    try {
      json = JSON.parse(stdout)
    } catch {
      json = null
    }
  }
  return { ok: result.status === 0, status: result.status, json, stdout, stderr: String(result.stderr ?? "").trim() }
}

function scheduledTasks() {
  const ps = `
    Get-ScheduledTask |
      Where-Object { $_.TaskName -match '73WIKI|Codex|WeRSS|werss|youzi|raw|cailian|财联社|Authority|THS' } |
      ForEach-Object {
        $info = Get-ScheduledTaskInfo -TaskName $_.TaskName
        [PSCustomObject]@{
          TaskName = $_.TaskName
          State = [string]$_.State
          LastRunTime = [string]$info.LastRunTime
          LastTaskResult = $info.LastTaskResult
          NextRunTime = [string]$info.NextRunTime
          Action = (($_.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }) -join ' || ')
        }
      } | ConvertTo-Json -Compress -Depth 4
  `
  const result = runPowerShellJson(ps)
  if (!result.json) return []
  return Array.isArray(result.json) ? result.json : [result.json]
}

function buildAudit(projectPath) {
  const generatedAt = nowLocalTimestamp()
  const rawRoot = path.join(projectPath, "raw")
  const wikiRoot = path.join(projectPath, "wiki")
  const systemRoot = path.join(projectPath, ".system")
  const llmRoot = path.join(projectPath, ".llm-wiki")
  const today = generatedAt.slice(0, 10)

  const latestRawTrade = newestFile(path.join(rawRoot, "01-交割单"), (filePath, name) => /\.(md|csv|xlsx?)$/i.test(name))
  const latestRawReviewA = newestFile(path.join(rawRoot, "02-每日复盘"), (filePath, name) => /\.(md|txt)$/i.test(name))
  const latestRawReviewB = newestFile(path.join(rawRoot, "每日复盘"), (filePath, name) => /\.(md|txt)$/i.test(name))
  const latestRawReview = [latestRawReviewA, latestRawReviewB].filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null
  const latestYouziRaw = newestFile(path.join(rawRoot, "05-研报新闻", "公众号", "游资号"), (filePath, name) => /\.(md|txt|html)$/i.test(name))

  const keyWikiFiles = [
    path.join(wikiRoot, "07-作战室", "当前作战室工作页.md"),
    path.join(wikiRoot, "06-持仓与资金管理", "当前持仓决策.md"),
    path.join(wikiRoot, "09-统计与进化", "当前学习层分层报告.md"),
  ].map(statInfo)

  const artifacts = {
    systemHealth: statInfo(path.join(llmRoot, "system-health", "latest-system-health.json")),
    evidenceQueue: statInfo(path.join(llmRoot, "evidence-queue", "latest-evidence-queue.json")),
    reviewManifest: statInfo(path.join(llmRoot, "review-runs", "latest-review-manifest.json")),
    trainingFlywheel: statInfo(path.join(llmRoot, "training-flywheel", "latest-training-flywheel.json")),
    authorityNews: statInfo(path.join(llmRoot, "authority-news", "latest-authority-news.json")),
    rawQueueConsumer: statInfo(path.join(llmRoot, "raw-queue-consumer", "latest-raw-queue-consumer.json")),
    marketRegime: statInfo(path.join(llmRoot, "market-regime", "latest-market-regime.json")),
    marketStrengthRank: statInfo(path.join(llmRoot, "market-strength-rank", "latest-market-strength-rank.json")),
    predictionOutcomeReview: statInfo(path.join(llmRoot, "prediction-outcome-review", "latest-prediction-outcome-review.json")),
    marketCollect: statInfo(path.join(llmRoot, "market-collect", "latest-market-collect.json")),
    thsHotlist: statInfo(path.join(llmRoot, "ths-hotlist", "latest-ths-hotlist.json")),
  }

  const queuePath = path.join(systemRoot, "codex-raw-watch-queue.jsonl")
  const registryPath = path.join(systemRoot, "ingest-registry.jsonl")
  const queueItems = readJsonlMaybe(queuePath)
  const registryItems = readJsonlMaybe(registryPath)
  const registryKeys = new Set(registryItems.map(registryKey).filter(Boolean))
  const pendingQueue = queueItems.filter((item) => String(item.status ?? "") === "pending_codex_ingest")
  const unresolvedPendingQueue = pendingQueue.filter((item) => {
    const key = registryKey(item)
    return !key || !registryKeys.has(key)
  })
  const latestQueueSeen = queueItems.map((item) => item.first_seen_at).filter(Boolean).sort().at(-1) ?? null
  const queuedTodayFiles = queueItems.filter((item) => String(item.source_path ?? "").includes(today))

  const logs = {
    cailian: statInfo(path.join(systemRoot, "logs", "cs-cailian-watch.log")),
    werssIngest: statInfo(path.join(systemRoot, "logs", "werss-api-ingest.log")),
    werssSupervisor: statInfo(path.join(systemRoot, "logs", "werss-supervisor.log")),
    youziLearning: statInfo(path.join(systemRoot, "logs", "youzi-learning.log")),
    rawConsumer: statInfo(path.join(systemRoot, "logs", "raw-queue-consumer.log")),
  }

  const tasks = scheduledTasks()
  const wrongProjectPathTasks = tasks.filter((task) => String(task.Action ?? "").includes("73绁炶瘽"))
  const rawWatchTask = tasks.find((task) => task.TaskName === "Codex RAW Watch 73WIKI") ?? null
  const rawConsumerTask = tasks.find((task) => task.TaskName === "Codex RAW Consume 73WIKI") ?? null
  const marketTasks = tasks.filter((task) => String(task.TaskName).startsWith("73WIKI-Market-"))
  const authorityTasks = tasks.filter((task) => String(task.TaskName).startsWith("73WIKI-Authority-"))
  const werssTasks = tasks.filter((task) => /werss|youzi/i.test(String(task.TaskName + task.Action)))

  const siblingMojibakeProject = "C:/wiki/73绁炶瘽"
  const siblingLatestAuthority = statInfo(path.join(siblingMojibakeProject, ".llm-wiki", "authority-news", "latest-authority-news.json"))

  const issues = []
  const warnings = []
  if (wrongProjectPathTasks.length > 0) issues.push(`${wrongProjectPathTasks.length} scheduled task(s) still write to mojibake project path`)
  if (!rawWatchTask?.NextRunTime) issues.push("RAW watcher has no next run time")
  if (!rawConsumerTask?.NextRunTime) issues.push("RAW consumer has no next run time")
  if (unresolvedPendingQueue.length > 0) issues.push(`${unresolvedPendingQueue.length} unresolved RAW queue item(s) are still pending_codex_ingest`)
  if (queuedTodayFiles.length === 0 && (latestRawTrade?.path?.includes(today) || latestRawReview?.path?.includes(today))) issues.push("today RAW files exist but are not in RAW watch queue")
  if (latestRawTrade && keyWikiFiles.every((item) => !item.exists || Date.parse(item.mtime) < latestRawTrade.mtimeMs)) issues.push("latest trade ticket is newer than core wiki pages")
  if (latestRawReview && keyWikiFiles.every((item) => !item.exists || Date.parse(item.mtime) < latestRawReview.mtimeMs)) issues.push("latest daily review is newer than core wiki pages")
  if (logs.cailian.ageHours == null || logs.cailian.ageHours > 24) issues.push("Cailian watcher log is stale")
  if (logs.werssSupervisor.ageHours == null || logs.werssSupervisor.ageHours > 24) warnings.push("WeRSS supervisor is not fresh")
  if (logs.youziLearning.ageHours == null || logs.youziLearning.ageHours > 24) warnings.push("youzi learning is not fresh")
  if (artifacts.authorityNews.ageHours != null && siblingLatestAuthority.ageHours != null && artifacts.authorityNews.ageHours > siblingLatestAuthority.ageHours) {
    issues.push("authority-news is fresher in mojibake sibling project than in main project")
  }
  if (werssTasks.length === 0) warnings.push("no WeRSS/youzi scheduled task found")
  if (!artifacts.trainingFlywheel.exists) warnings.push("training flywheel report is missing")
  if (!artifacts.marketRegime.exists) warnings.push("market regime report is missing")
  if (!artifacts.marketStrengthRank.exists) warnings.push("market strength rank report is missing")
  if (!artifacts.predictionOutcomeReview.exists) warnings.push("prediction outcome review is missing")

  return {
    schema: "73wiki-pipeline-audit-v1",
    generatedAt,
    ok: issues.length === 0,
    projectPath,
    siblingMojibakeProject,
    summary: issues.length === 0 ? "pipeline audit passed" : issues.join("; "),
    issues,
    warnings,
    latestRaw: {
      trade: latestRawTrade,
      review: latestRawReview,
      youzi: latestYouziRaw,
    },
    keyWikiFiles,
    artifacts,
    rawQueue: {
      path: queuePath,
      registryPath,
      total: queueItems.length,
      registryRecords: registryItems.length,
      pendingCodexIngestRaw: pendingQueue.length,
      pendingCodexIngest: unresolvedPendingQueue.length,
      latestFirstSeenAt: latestQueueSeen,
      queuedTodayFiles: queuedTodayFiles.length,
      statusCounts: groupCount(queueItems, (item) => item.status),
      sourceBucketCounts: groupCount(queueItems, (item) => {
        const sourcePath = String(item.source_path ?? "")
        return sourcePath ? path.basename(path.dirname(sourcePath)) : ""
      }).slice(0, 20),
    },
    logs,
    scheduledTasks: {
      total: tasks.length,
      marketTasks: marketTasks.length,
      authorityTasks: authorityTasks.length,
      werssTasks: werssTasks.length,
      rawWatchTask,
      rawConsumerTask,
      wrongProjectPathTasks: wrongProjectPathTasks.map((task) => ({
        taskName: task.TaskName,
        lastRunTime: task.LastRunTime,
        nextRunTime: task.NextRunTime,
      })),
    },
    siblingMojibake: {
      exists: fs.existsSync(siblingMojibakeProject),
      latestAuthorityNews: siblingLatestAuthority,
    },
  }
}

function buildMarkdown(record) {
  const lines = [
    "# 73WIKI 全链路体检",
    "",
    `生成时间: ${record.generatedAt}`,
    `项目: ${record.projectPath}`,
    `状态: ${record.ok ? "ok" : "needs-attention"}`,
    "",
    "## 结论",
    "",
    record.issues.length > 0 ? record.issues.map((item) => `- ${item}`).join("\n") : "- 未发现阻断性问题。",
  ]
  if (record.warnings.length > 0) {
    lines.push("", "## 警告", "", ...record.warnings.map((item) => `- ${item}`))
  }
  lines.push(
    "",
    "## RAW 与 WIKI",
    "",
    `- 最新交割单: ${record.latestRaw.trade?.path ?? "-"} (${record.latestRaw.trade?.mtime ?? "-"})`,
    `- 最新复盘: ${record.latestRaw.review?.path ?? "-"} (${record.latestRaw.review?.mtime ?? "-"})`,
    `- 最新游资 RAW: ${record.latestRaw.youzi?.path ?? "-"} (${record.latestRaw.youzi?.mtime ?? "-"})`,
    "",
    "| WIKI 文件 | 更新时间 |",
    "|---|---|",
  )
  for (const item of record.keyWikiFiles) lines.push(`| ${item.path} | ${item.mtime ?? "-"} |`)
  lines.push(
    "",
    "## 队列",
    "",
    `- RAW 队列总数: ${record.rawQueue.total}`,
    `- pending_codex_ingest(raw): ${record.rawQueue.pendingCodexIngestRaw}`,
    `- pending_codex_ingest(unresolved): ${record.rawQueue.pendingCodexIngest}`,
    `- ingest registry records: ${record.rawQueue.registryRecords}`,
    `- 最新 first_seen_at: ${record.rawQueue.latestFirstSeenAt ?? "-"}`,
    `- 今日 RAW 入队数: ${record.rawQueue.queuedTodayFiles}`,
    "",
    "## 任务",
    "",
    `- 市场任务数: ${record.scheduledTasks.marketTasks}`,
    `- 权威新闻任务数: ${record.scheduledTasks.authorityTasks}`,
    `- WeRSS/游资任务数: ${record.scheduledTasks.werssTasks}`,
    `- RAW Watch 下次运行: ${record.scheduledTasks.rawWatchTask?.NextRunTime || "-"}`,
    `- 写错目录任务数: ${record.scheduledTasks.wrongProjectPathTasks.length}`,
    "",
    "## 日志新鲜度",
    "",
    "| 模块 | 更新时间 | 年龄小时 |",
    "|---|---:|---:|",
  )
  for (const [name, item] of Object.entries(record.logs)) lines.push(`| ${name} | ${item.mtime ?? "-"} | ${item.ageHours ?? "-"} |`)
  lines.push("")
  return `${lines.join("\n")}\n`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/pipeline-audit.mjs --project C:/wiki/73神话 --write")
    return
  }
  const projectPath = path.resolve(args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH)
  const record = buildAudit(projectPath)
  if (args.write) {
    const reportDir = path.join(projectPath, REPORT_ROOT)
    const id = idTimestamp()
    writeJson(path.join(reportDir, `${id}-pipeline-audit.json`), record)
    writeJson(path.join(reportDir, "latest-pipeline-audit.json"), record)
    writeText(path.join(reportDir, `${id}-pipeline-audit.md`), buildMarkdown(record))
    writeText(path.join(reportDir, "latest-pipeline-audit.md"), buildMarkdown(record))
  }
  if (args.json) console.log(JSON.stringify(record, null, 2))
  else console.log(`[pipeline-audit] ok=${record.ok} issues=${record.issues.length} warnings=${record.warnings.length}`)
  if (!record.ok) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
