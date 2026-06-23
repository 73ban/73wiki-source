import { createDirectory, listDirectory, readFile, writeFile } from "@/commands/fs"
import { getRelativePath, normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"

export type IngestLogStatus = "discovered" | "waiting" | "queued" | "processing" | "completed" | "failed" | "skipped"

export interface IngestLogEntry {
  id: string
  sourcePath: string
  relativePath: string
  sourceHash?: string
  actor?: string
  status: IngestLogStatus
  discoveredAt: number
  updatedAt: number
  completedAt?: number
  error?: string
  writtenFiles?: string[]
  reason?: string
}

export interface IngestCoverage {
  entries: IngestLogEntry[]
  rawFiles: string[]
  uningestedFiles: string[]
}

const MAX_LOG_ENTRIES = 1000

export function ingestLogPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.73wiki/ingest-log.json`
}

export async function loadIngestLog(projectPath: string): Promise<IngestLogEntry[]> {
  try {
    const raw = await readFile(ingestLogPath(projectPath))
    const parsed = JSON.parse(raw) as IngestLogEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function saveIngestLog(projectPath: string, entries: IngestLogEntry[]): Promise<void> {
  const pp = normalizePath(projectPath)
  await createDirectory(`${pp}/.73wiki`).catch(() => {})
  const trimmed = [...entries].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_LOG_ENTRIES)
  await writeFile(ingestLogPath(pp), `${JSON.stringify(trimmed, null, 2)}\n`)
}

export async function upsertIngestLog(
  projectPath: string,
  patch: {
    sourcePath: string
    status: IngestLogStatus
    error?: string
    writtenFiles?: string[]
    reason?: string
    sourceHash?: string
    actor?: string
  },
): Promise<void> {
  const pp = normalizePath(projectPath)
  const sourcePath = normalizePath(patch.sourcePath)
  const entries = await loadIngestLog(pp)
  const now = Date.now()
  const existing = entries.find((entry) => normalizePath(entry.sourcePath) === sourcePath)

  if (existing) {
    existing.status = patch.status
    existing.updatedAt = now
    existing.error = patch.error
    existing.reason = patch.reason
    if (patch.sourceHash) existing.sourceHash = patch.sourceHash
    if (patch.actor) existing.actor = patch.actor
    if (patch.writtenFiles) existing.writtenFiles = patch.writtenFiles
    if (patch.status === "completed") existing.completedAt = now
  } else {
    entries.push({
      id: `ingest-log-${now}-${Math.random().toString(36).slice(2, 8)}`,
      sourcePath,
      relativePath: getRelativePath(sourcePath, pp),
      sourceHash: patch.sourceHash,
      actor: patch.actor,
      status: patch.status,
      discoveredAt: now,
      updatedAt: now,
      completedAt: patch.status === "completed" ? now : undefined,
      error: patch.error,
      reason: patch.reason,
      writtenFiles: patch.writtenFiles,
    })
  }

  await saveIngestLog(pp, entries)
}

export async function findCompletedIngest(
  projectPath: string,
  sourcePath: string,
  sourceHash: string,
): Promise<IngestLogEntry | null> {
  const normalizedSourcePath = normalizePath(sourcePath)
  const entries = await loadIngestLog(projectPath)
  return entries.find((entry) =>
    entry.status === "completed" &&
    normalizePath(entry.sourcePath) === normalizedSourcePath &&
    entry.sourceHash === sourceHash
  ) ?? null
}

export async function getIngestCoverage(projectPath: string, rawRoot = "raw"): Promise<IngestCoverage> {
  const pp = normalizePath(projectPath)
  const entries = await loadIngestLog(pp)
  let rawFiles: string[] = []
  try {
    const tree = await listDirectory(`${pp}/${rawRoot}`)
    rawFiles = flattenFiles(tree).map((node) => normalizePath(node.path))
  } catch {
    rawFiles = []
  }

  const completedOrSkipped = new Set(
    entries
      .filter((entry) => entry.status === "completed" || entry.status === "skipped")
      .map((entry) => normalizePath(entry.sourcePath)),
  )
  const uningestedFiles = rawFiles.filter((file) => !completedOrSkipped.has(file))

  return { entries, rawFiles, uningestedFiles }
}

function flattenFiles(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      result.push(...flattenFiles(node.children))
    } else if (!node.is_dir) {
      result.push(node)
    }
  }
  return result
}
