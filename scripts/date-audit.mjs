import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = "C:\\wiki\\73神话"
const REQUIRED_FIELDS = ["planTradeDate", "evidenceTradeDate", "sourceTradeDates", "hasDateMismatch"]
const EVIDENCE_ALLOWED_GROUPS = new Set([
  "archive-skeletons",
  "authority-news",
  "catalyst-events",
  "prediction-candidates",
  "preopen",
])

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) {
      args[key] = true
      continue
    }
    args[key] = next
    index += 1
  }
  return args
}

function walkLatestJsonFiles(rootDir) {
  const results = []
  if (!fs.existsSync(rootDir)) return results
  const queue = [rootDir]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(fullPath)
        continue
      }
      if (entry.isFile() && /^latest-.*\.json$/i.test(entry.name)) {
        results.push(fullPath)
      }
    }
  }
  return results.sort()
}

function normalizeTradeDate(value) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d{8}$/.test(trimmed)) {
    return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed
  }
  const match = trimmed.match(/(\d{4})[-/](\d{2})[-/](\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function projectRelative(projectPath, absolutePath) {
  return path.relative(projectPath, absolutePath).replace(/\\/g, "/")
}

function parseJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch (error) {
    return { __parseError: error instanceof Error ? error.message : String(error) }
  }
}

function groupFromLatestPath(relativePath) {
  const parts = relativePath.split("/")
  return parts.length >= 2 ? parts[1] : path.basename(relativePath, ".json")
}

function buildRecordSummary(projectPath, filePath, data) {
  const relativePath = projectRelative(projectPath, filePath)
  const group = groupFromLatestPath(relativePath)
  return {
    file: relativePath,
    group,
    schema: data.schema ?? null,
    tradeDate: normalizeTradeDate(data.tradeDate),
    planTradeDate: normalizeTradeDate(data.planTradeDate),
    evidenceTradeDate: normalizeTradeDate(data.evidenceTradeDate),
    hasDateMismatch: typeof data.hasDateMismatch === "boolean" ? data.hasDateMismatch : null,
  }
}

function loadBaseline(projectPath) {
  const baselinePath = path.join(projectPath, ".llm-wiki", "market-collect", "latest-market-collect.json")
  const data = parseJsonSafe(baselinePath)
  return {
    file: projectRelative(projectPath, baselinePath),
    tradeDate: normalizeTradeDate(data.tradeDate),
    planTradeDate: normalizeTradeDate(data.planTradeDate),
    evidenceTradeDate: normalizeTradeDate(data.evidenceTradeDate ?? data.tradeDate),
  }
}

function auditProject(projectPath) {
  const llmWikiRoot = path.join(projectPath, ".llm-wiki")
  const baseline = loadBaseline(projectPath)
  const latestFiles = walkLatestJsonFiles(llmWikiRoot)
  const parsed = latestFiles.map((filePath) => {
    const data = parseJsonSafe(filePath)
    const summary = buildRecordSummary(projectPath, filePath, data)
    const missingFields = summary.tradeDate
      ? REQUIRED_FIELDS.filter((field) => !(field in data))
      : []
    return { filePath, data, summary, missingFields }
  })

  const parseErrors = parsed
    .filter((item) => item.data.__parseError)
    .map((item) => ({ file: item.summary.file, error: item.data.__parseError }))

  const missingProtocol = parsed
    .filter((item) => item.missingFields.length > 0)
    .map((item) => ({ ...item.summary, missingFields: item.missingFields }))

  const baselineEvidence = baseline.evidenceTradeDate
  const futureEvidence = baselineEvidence
    ? parsed
        .filter((item) => item.summary.evidenceTradeDate && item.summary.evidenceTradeDate > baselineEvidence)
        .map((item) => ({
          ...item.summary,
          baselineEvidenceTradeDate: baselineEvidence,
          allowlisted: EVIDENCE_ALLOWED_GROUPS.has(item.summary.group),
        }))
    : []

  const suspiciousFutureEvidence = futureEvidence.filter((item) => !item.allowlisted)
  const allowlistedFutureEvidence = futureEvidence.filter((item) => item.allowlisted)

  return {
    ok: parseErrors.length === 0 && missingProtocol.length === 0 && suspiciousFutureEvidence.length === 0,
    projectPath,
    baseline,
    fileCount: latestFiles.length,
    parseErrors,
    missingProtocol,
    suspiciousFutureEvidence,
    allowlistedFutureEvidence,
    scanned: parsed.map((item) => item.summary),
  }
}

function formatHuman(result) {
  const lines = [
    `Date audit: ${result.ok ? "ok" : "issues-found"}`,
    `Project: ${result.projectPath}`,
    `Baseline market evidence: ${result.baseline.evidenceTradeDate ?? "n/a"} (${result.baseline.file})`,
    `Latest files scanned: ${result.fileCount}`,
    `Parse errors: ${result.parseErrors.length}`,
    `Missing protocol fields: ${result.missingProtocol.length}`,
    `Suspicious future evidence: ${result.suspiciousFutureEvidence.length}`,
    `Allowlisted future evidence: ${result.allowlistedFutureEvidence.length}`,
  ]

  if (result.missingProtocol.length > 0) {
    lines.push("")
    lines.push("Missing protocol fields:")
    for (const item of result.missingProtocol) {
      lines.push(`- ${item.file} missing ${item.missingFields.join(", ")}`)
    }
  }

  if (result.suspiciousFutureEvidence.length > 0) {
    lines.push("")
    lines.push("Suspicious future evidence:")
    for (const item of result.suspiciousFutureEvidence) {
      lines.push(`- ${item.file} evidence=${item.evidenceTradeDate} baseline=${item.baselineEvidenceTradeDate}`)
    }
  }

  if (result.allowlistedFutureEvidence.length > 0) {
    lines.push("")
    lines.push("Allowlisted future evidence:")
    for (const item of result.allowlistedFutureEvidence) {
      lines.push(`- ${item.file} evidence=${item.evidenceTradeDate} group=${item.group}`)
    }
  }

  return `${lines.join("\n")}\n`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const projectPath = path.resolve(args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH)
  const result = auditProject(projectPath)
  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.ok ? 0 : 1)
  }
  process.stdout.write(formatHuman(result))
  process.exit(result.ok ? 0 : 1)
}

main()
