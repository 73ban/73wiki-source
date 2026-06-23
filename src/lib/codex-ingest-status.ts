import { listDirectory, readFile } from "@/commands/fs"
import { getRelativePath, normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"

export interface JsonlStats {
  path: string
  count: number
  invalid: number
  exists: boolean
}

export interface BrainFileStatus extends JsonlStats {
  name: string
}

export interface CodexReportSummary {
  id: string
  path: string
  createdAt?: string
  sourceRelativePath?: string
  writes: number
  factWrites: number
  hasReview: boolean
}

export interface DailyLoopSummary {
  path: string
  generatedAt?: string
  mode?: string
  dryRun?: boolean
  candidatesScanned?: number
  factsReady?: number
  factsWritten?: number
  validationsWritten?: number
  predictionsWritten?: number
}

export interface HistoryReplaySummary {
  path: string
  from?: string
  to?: string
  count?: number
  dryRun?: boolean
}

export interface CodexEngineStatus {
  temporalFacts: JsonlStats
  temporalIndexExists: boolean
  brain: BrainFileStatus[]
  reports: CodexReportSummary[]
  dailyLoops: DailyLoopSummary[]
  historyReplays: HistoryReplaySummary[]
}

const BRAIN_FILES = [
  "corrections.jsonl",
  "active_threads.jsonl",
  "preferences.jsonl",
  "guardrails.jsonl",
  "predictions.jsonl",
  "validations.jsonl",
]

export function summarizeJsonl(content: string): Pick<JsonlStats, "count" | "invalid"> {
  let count = 0
  let invalid = 0
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    count += 1
    try {
      JSON.parse(trimmed)
    } catch {
      invalid += 1
    }
  }
  return { count, invalid }
}

export async function loadCodexEngineStatus(projectPath: string): Promise<CodexEngineStatus> {
  const pp = normalizePath(projectPath)
  const [temporalFacts, temporalIndexExists, brain, reports, dailyLoops, historyReplays] = await Promise.all([
    readJsonlStats(`${pp}/data/facts/temporal_edges.jsonl`),
    fileExists(`${pp}/data/facts/temporal_edges.index.json`),
    loadBrainStatus(pp),
    loadCodexReports(pp),
    loadDailyLoopReports(pp),
    loadHistoryReplayReports(pp),
  ])

  return {
    temporalFacts,
    temporalIndexExists,
    brain,
    reports,
    dailyLoops,
    historyReplays,
  }
}

async function loadBrainStatus(projectPath: string): Promise<BrainFileStatus[]> {
  return Promise.all(
    BRAIN_FILES.map(async (name) => {
      const stats = await readJsonlStats(`${projectPath}/data/brain/${name}`)
      return { ...stats, name }
    }),
  )
}

async function loadCodexReports(projectPath: string): Promise<CodexReportSummary[]> {
  const root = `${projectPath}/.llm-wiki/codex-ingest`
  const dirs = await listSafe(root)
  const reports = await Promise.all(
    dirs
      .filter((node) => node.is_dir)
      .map(async (node) => {
        const id = node.name
        const changesPath = `${normalizePath(node.path)}/changes.json`
        const reviewPath = `${normalizePath(node.path)}/wiki-change-review.md`
        const parsed = await readJsonSafe(changesPath)
        return {
          id,
          path: getRelativePath(normalizePath(node.path), projectPath),
          createdAt: stringField(parsed, "createdAt"),
          sourceRelativePath: stringField(parsed, "sourceRelativePath"),
          writes: Array.isArray(parsed?.writes) ? parsed.writes.length : 0,
          factWrites: Array.isArray(parsed?.factWrites) ? parsed.factWrites.length : 0,
          hasReview: await fileExists(reviewPath),
        }
      }),
  )
  return reports.sort((a, b) => (b.createdAt ?? b.id).localeCompare(a.createdAt ?? a.id)).slice(0, 12)
}

async function loadDailyLoopReports(projectPath: string): Promise<DailyLoopSummary[]> {
  const root = `${projectPath}/.llm-wiki/daily-loop`
  const files = await listSafe(root)
  const reports = await Promise.all(
    files
      .filter((node) => !node.is_dir && node.name.endsWith(".json"))
      .map(async (node) => {
        const parsed = await readJsonSafe(normalizePath(node.path))
        return {
          path: getRelativePath(normalizePath(node.path), projectPath),
          generatedAt: stringField(parsed, "generatedAt"),
          mode: stringField(parsed, "mode"),
          dryRun: booleanField(parsed, "dryRun"),
          candidatesScanned: numberField(parsed?.dplus, "candidatesScanned"),
          factsReady: numberField(parsed?.dplus, "factsReady"),
          factsWritten: numberField(parsed?.writes, "facts"),
          validationsWritten: numberField(parsed?.writes, "validations"),
          predictionsWritten: numberField(parsed?.writes, "predictions"),
        }
      }),
  )
  return reports.sort((a, b) => (b.generatedAt ?? b.path).localeCompare(a.generatedAt ?? a.path)).slice(0, 8)
}

async function loadHistoryReplayReports(projectPath: string): Promise<HistoryReplaySummary[]> {
  const root = `${projectPath}/.llm-wiki/history-replay`
  const dirs = await listSafe(root)
  const reports = await Promise.all(
    dirs
      .filter((node) => node.is_dir)
      .map(async (node) => {
        const summaryPath = `${normalizePath(node.path)}/run-summary.json`
        const parsed = await readJsonSafe(summaryPath)
        return {
          path: getRelativePath(normalizePath(node.path), projectPath),
          from: stringField(parsed, "from"),
          to: stringField(parsed, "to"),
          count: numberField(parsed, "count"),
          dryRun: booleanField(parsed, "dryRun"),
        }
      }),
  )
  return reports.sort((a, b) => b.path.localeCompare(a.path)).slice(0, 8)
}

async function readJsonlStats(path: string): Promise<JsonlStats> {
  try {
    const content = await readFile(path)
    return { path, exists: true, ...summarizeJsonl(content) }
  } catch {
    return { path, exists: false, count: 0, invalid: 0 }
  }
}

async function readJsonSafe(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path)
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function listSafe(path: string): Promise<FileNode[]> {
  try {
    return await listDirectory(path)
  } catch {
    return []
  }
}

function stringField(value: Record<string, unknown> | null | undefined, field: string): string | undefined {
  const fieldValue = value?.[field]
  return typeof fieldValue === "string" ? fieldValue : undefined
}

function numberField(value: Record<string, unknown> | null | undefined, field: string): number | undefined {
  const fieldValue = value?.[field]
  return typeof fieldValue === "number" ? fieldValue : undefined
}

function booleanField(value: Record<string, unknown> | null | undefined, field: string): boolean | undefined {
  const fieldValue = value?.[field]
  return typeof fieldValue === "boolean" ? fieldValue : undefined
}
