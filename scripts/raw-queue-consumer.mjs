#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { hotFilePath, readJsonMaybe, writeJson } from "./raw-hot-files.mjs"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const REPORT_ROOT = ".llm-wiki/raw-queue-consumer"
const QUEUE_PATH = ".system/codex-raw-watch-queue.jsonl"
const REGISTRY_PATH = ".system/ingest-registry.jsonl"
const STATE_PATH = ".system/raw-queue-consumer-state.json"
const ERROR_LOG_PATH = ".system/raw-queue-consumer-error.log"
const SUPPORTED_EXTENSIONS = new Set([".md", ".txt"])
const MAX_FILE_BYTES = 1_200_000

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["once", "help"].includes(key)) {
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

function printHelp() {
  console.log(`Usage:
  node scripts/raw-queue-consumer.mjs --project C:\\wiki\\73神话 --once
  node scripts/raw-queue-consumer.mjs --project C:\\wiki\\73神话 --seconds 30

This consumer reads .system/codex-raw-watch-queue.jsonl and pushes new RAW files into:
  prediction:candidates -> catalyst:events -> preopen:intel -> market:watchlist -> stock:reasons -> archive:skeletons -> db:import-facts
`)
}

function nowLocalTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function idTimestamp(date = new Date()) {
  return nowLocalTimestamp(date).replace(/[-: ]/g, "")
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
}

function readJsonlMaybe(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function registryKey(record) {
  const rawId = String(record?.raw_id ?? record?.rawId ?? "").trim()
  if (rawId) return `raw:${rawId}`
  const sourcePath = String(record?.source_path ?? record?.sourcePath ?? "").trim()
  const contentHash = String(record?.content_hash ?? record?.contentHash ?? "").trim()
  return sourcePath && contentHash ? `path:${sourcePath}|${contentHash}` : ""
}

function queueRecordStatus(record) {
  const sourcePath = String(record?.source_path ?? "")
  if (!sourcePath || !fs.existsSync(sourcePath)) return { skip: true, reason: "missing_source" }
  const stat = fs.statSync(sourcePath)
  if (!stat.isFile()) return { skip: true, reason: "not_file" }
  const ext = path.extname(sourcePath).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.has(ext)) return { skip: true, reason: `unsupported_extension:${ext || "none"}` }
  if (stat.size <= 0) return { skip: true, reason: "empty_file" }
  if (stat.size > MAX_FILE_BYTES) return { skip: true, reason: `oversize:${stat.size}` }
  return { skip: false, stat }
}

function projectRelative(projectPath, targetPath) {
  return path.relative(path.resolve(projectPath), path.resolve(targetPath)).replace(/\\/g, "/")
}

function loadPendingBatch(projectPath, batchSize) {
  const queuePath = path.join(projectPath, QUEUE_PATH)
  const registryPath = path.join(projectPath, REGISTRY_PATH)
  const queueRecords = readJsonlMaybe(queuePath)
  const registryRecords = readJsonlMaybe(registryPath)
  const seenKeys = new Set(registryRecords.map(registryKey).filter(Boolean))
  const pending = []
  const skipped = []
  for (const record of queueRecords) {
    const key = registryKey(record)
    if (!key || seenKeys.has(key)) continue
    const verdict = queueRecordStatus(record)
    if (verdict.skip) {
      skipped.push({ record, reason: verdict.reason })
      seenKeys.add(key)
      continue
    }
    pending.push({
      record,
      stat: verdict.stat,
      sourcePath: String(record.source_path),
      relativePath: projectRelative(projectPath, String(record.source_path)),
    })
    seenKeys.add(key)
  }
  pending.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  return { pending: pending.slice(0, Number(batchSize)), skipped }
}

function buildHotFilePayload(projectPath, items, ttlHours = 6) {
  const current = readJsonMaybe(hotFilePath(projectPath))
  const currentItems = Array.isArray(current?.items) ? current.items : []
  const expiresAt = new Date(Date.now() + Number(ttlHours) * 60 * 60 * 1000).toISOString()
  const appended = items.map(({ record, relativePath }) => ({
    rawId: String(record.raw_id ?? ""),
    sourcePath: String(record.source_path ?? ""),
    relativePath,
    contentHash: String(record.content_hash ?? ""),
    firstSeenAt: String(record.first_seen_at ?? ""),
    queuedAt: new Date().toISOString(),
    fileDate: extractDateFromText(relativePath),
    expiresAt,
  }))
  const merged = new Map()
  for (const item of [...appended, ...currentItems]) {
    const key = `${item.sourcePath}|${item.contentHash}`
    if (!item.sourcePath || merged.has(key)) continue
    if (item.expiresAt && Date.parse(item.expiresAt) < Date.now()) continue
    merged.set(key, item)
  }
  return {
    updatedAt: nowLocalTimestamp(),
    items: [...merged.values()].slice(0, 300),
  }
}

function extractDateFromText(value) {
  const text = String(value ?? "")
  const match = text.match(/20\d{2}[-./]\d{1,2}[-./]\d{1,2}/)
  if (!match) return ""
  const [y, m, d] = match[0].split(/[-./]/)
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

function runStep(name, command, args, { allowFailure = false } = {}) {
  const startedAt = nowLocalTimestamp()
  const useShell = process.platform === "win32" && /(?:^|\\|\/)npm(?:\.cmd)?$/i.test(command)
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    shell: useShell,
  })
  const finishedAt = nowLocalTimestamp()
  const ok = result.status === 0
  const step = {
    name,
    ok,
    status: result.status,
    startedAt,
    finishedAt,
    command: [command, ...args].join(" "),
    stdout: String(result.stdout ?? "").slice(-5000),
    stderr: String(result.stderr ?? "").slice(-5000),
    error: result.error?.message ?? null,
  }
  if (!ok && !allowFailure) {
    const err = new Error(`${name} failed`)
    err.step = step
    throw err
  }
  return step
}

function scriptPath(name) {
  return path.join(process.cwd(), "scripts", name)
}

function npmBin() {
  return process.platform === "win32" ? "npm.cmd" : "npm"
}

function runPipeline(projectPath) {
  const steps = []
  steps.push(runStep("prediction:candidates", process.execPath, [
    scriptPath("prediction-candidates.mjs"),
    "--project", projectPath,
    "--since-days", "3",
    "--source-limit", "600",
    "--candidate-limit", "30",
    "--write",
  ], { allowFailure: true }))
  steps.push(runStep("catalyst:events", process.execPath, [
    scriptPath("catalyst-events.mjs"),
    "--project", projectPath,
    "--since-days", "3",
    "--source-limit", "700",
    "--max-events", "160",
    "--write",
  ], { allowFailure: true }))
  steps.push(runStep("preopen:intel", process.execPath, [
    scriptPath("preopen-intel.mjs"),
    "--project", projectPath,
    "--since-days", "3",
    "--source-limit", "500",
    "--core-limit", "10",
    "--write",
  ], { allowFailure: true }))
  steps.push(runStep("market:watchlist", process.execPath, [
    scriptPath("market-watchlist.mjs"),
    "--project", projectPath,
    "--max-symbols", "20",
    "--write",
  ]))
  steps.push(runStep("stock:reasons", process.execPath, [
    scriptPath("stock-reason-cards.mjs"),
    "--project", projectPath,
    "--max-cards", "10",
    "--write",
  ], { allowFailure: true }))
  steps.push(runStep("archive:skeletons", process.execPath, [
    scriptPath("archive-skeletons.mjs"),
    "--project", projectPath,
    "--max-stocks", "120",
    "--max-themes", "80",
    "--write",
  ], { allowFailure: true }))
  steps.push(runStep("db:import-facts", npmBin(), [
    "run", "db:import-facts", "--", projectPath,
  ], { allowFailure: true }))
  return steps
}

function appendRegistryEntries(projectPath, items, status, notes, targetPages = []) {
  const registryPath = path.join(projectPath, REGISTRY_PATH)
  const ingestedAt = `${nowLocalTimestamp()} +08:00`
  for (const item of items) {
    appendJsonl(registryPath, {
      raw_id: String(item.record.raw_id ?? ""),
      source_path: String(item.record.source_path ?? ""),
      source_agent: String(item.record.source_agent ?? "unknown"),
      preferred_ingestor: "codex",
      status,
      ingested_by: "codex-raw-queue-consumer",
      deepseek_action: "skip",
      truth_grade: String(item.record.truth_grade ?? "S3"),
      fate: "B",
      content_hash: String(item.record.content_hash ?? ""),
      first_seen_at: String(item.record.first_seen_at ?? ""),
      ingested_at: ingestedAt,
      target_pages: targetPages,
      notes,
    })
  }
}

function writeState(projectPath, payload) {
  writeJson(path.join(projectPath, STATE_PATH), payload)
}

function reportPaths(projectPath) {
  const reportDir = path.join(projectPath, REPORT_ROOT)
  const id = idTimestamp()
  return {
    reportDir,
    reportPath: path.join(reportDir, `${id}-raw-queue-consumer.json`),
    latestPath: path.join(reportDir, "latest-raw-queue-consumer.json"),
  }
}

function consumeOnce({ projectPath, batchSize }) {
  const startedAt = nowLocalTimestamp()
  const { pending, skipped } = loadPendingBatch(projectPath, batchSize)
  if (skipped.length > 0) {
    appendRegistryEntries(projectPath, skipped.map((item) => ({ record: item.record })), "skipped_pipeline", "Unsupported RAW file for text pipeline.")
  }
  if (pending.length === 0) {
    const report = {
      ok: true,
      startedAt,
      finishedAt: nowLocalTimestamp(),
      projectPath,
      pendingCount: 0,
      skippedCount: skipped.length,
      message: "No pending supported RAW files.",
    }
    writeState(projectPath, report)
    const paths = reportPaths(projectPath)
    writeJson(paths.reportPath, report)
    writeJson(paths.latestPath, report)
    return report
  }

  const hotPayload = buildHotFilePayload(projectPath, pending)
  writeJson(hotFilePath(projectPath), hotPayload)

  let steps = []
  let ok = true
  let failedStep = null
  try {
    steps = runPipeline(projectPath)
  } catch (error) {
    ok = false
    failedStep = error?.step ?? { name: "unknown", error: error?.message ?? String(error) }
  }

  const targetPages = [
    ".llm-wiki/prediction-candidates/latest-prediction-candidates.json",
    ".llm-wiki/catalyst-events/latest-catalyst-events.json",
    ".llm-wiki/preopen/latest-preopen-intel.json",
    ".llm-wiki/market-watchlist/latest-warroom-watchlist.json",
    ".llm-wiki/archive-skeletons/latest-archive-skeletons.json",
  ]
  if (ok) {
    appendRegistryEntries(projectPath, pending, "indexed_to_pipeline", "RAW queue consumer pushed this file into prediction/catalyst/preopen/watchlist/archive pipeline.", targetPages)
  }

  const report = {
    ok,
    startedAt,
    finishedAt: nowLocalTimestamp(),
    projectPath,
    pendingCount: pending.length,
    skippedCount: skipped.length,
    processedFiles: pending.map((item) => item.relativePath),
    steps,
    failedStep,
  }
  writeState(projectPath, report)
  const paths = reportPaths(projectPath)
  writeJson(paths.reportPath, report)
  writeJson(paths.latestPath, report)
  if (!ok) throw new Error(failedStep?.error ?? failedStep?.name ?? "raw queue pipeline failed")
  return report
}

function logError(projectPath, error) {
  const errorPath = path.join(projectPath, ERROR_LOG_PATH)
  ensureDir(path.dirname(errorPath))
  fs.appendFileSync(errorPath, `[${nowLocalTimestamp()}] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`, "utf8")
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  const projectPath = path.resolve(args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH)
  const batchSize = Number(args["batch-size"] ?? args._[1] ?? 24)
  const seconds = Math.max(10, Number(args.seconds ?? args._[2] ?? 30))
  if (args.once) {
    const report = consumeOnce({ projectPath, batchSize })
    console.log(JSON.stringify(report, null, 2))
    return
  }
  while (true) {
    try {
      consumeOnce({ projectPath, batchSize })
    } catch (error) {
      logError(projectPath, error)
    }
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
