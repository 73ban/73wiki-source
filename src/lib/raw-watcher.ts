import { listDirectory, readFile } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { autoIngest } from "@/lib/ingest"
import { loadWikiSystemConfig, type WikiSystemConfig } from "@/lib/wiki-config"
import { findCompletedIngest, upsertIngestLog } from "@/lib/ingest-log"
import { sha256Content } from "@/lib/ingest-cache"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { loadProjectFileTree } from "@/lib/project-file-tree"

let timerId: ReturnType<typeof setTimeout> | null = null
let currentProjectPath: string | null = null
let knownFiles = new Set<string>()
let pendingFiles = new Map<string, number>()
let isPolling = false
let stopped = true

export function startRawWatcher() {
  if (timerId) return
  stopped = false
  scheduleNext(0)
}

export function stopRawWatcher() {
  stopped = true
  if (timerId) {
    clearTimeout(timerId)
    timerId = null
  }
  resetWatcherState(null)
}

async function pollRawOnce(): Promise<number> {
  if (isPolling) return 1000
  isPolling = true

  try {
    const store = useWikiStore.getState()
    const project = store.project
    if (!project) {
      resetWatcherState(null)
      return 4000
    }

    const projectPath = normalizePath(project.path)
    const config = await loadWikiSystemConfig(projectPath)
    const rawConfig = config.rawIngest
    const pollInterval = Math.max(1000, rawConfig.pollIntervalMs || 4000)

    if (!rawConfig.enabled) {
      if (projectPath !== currentProjectPath) {
        await seedKnownFiles(projectPath, config)
      }
      return pollInterval
    }

    if (projectPath !== currentProjectPath) {
      await seedKnownFiles(projectPath, config)
    }

    const rawFiles = await listWatchedRawFiles(projectPath, config)
    const normalizedRawFiles = rawFiles
      .map((node) => normalizePath(node.path))
      .filter((path) => shouldWatchFile(path, config))

    const nextKnown = new Set(knownFiles)
    const stablePolls = Math.max(1, rawConfig.stablePolls || 2)

    for (const filePath of normalizedRawFiles) {
      if (knownFiles.has(filePath)) continue

      const sourceContent = await readFile(filePath).catch(() => "")
      const sourceHash = sourceContent ? await sha256Content(sourceContent) : ""
      if (sourceHash) {
        const completed = await findCompletedIngest(projectPath, filePath, sourceHash).catch(() => null)
        if (completed) {
          nextKnown.add(filePath)
          pendingFiles.delete(filePath)
          await upsertIngestLog(projectPath, {
            sourcePath: filePath,
            status: "completed",
            sourceHash,
            actor: completed.actor ?? "registry",
            writtenFiles: completed.writtenFiles,
            reason: "Skipped by ingest registry: same RAW path and content hash already completed.",
          }).catch(() => {})
          continue
        }
      }

      const seenCount = (pendingFiles.get(filePath) ?? 0) + 1
      pendingFiles.set(filePath, seenCount)
      await upsertIngestLog(projectPath, {
        sourcePath: filePath,
        status: seenCount < stablePolls ? "waiting" : "discovered",
        sourceHash: sourceHash || undefined,
        actor: "raw-watcher",
        reason: seenCount < stablePolls ? `waiting for stable poll ${seenCount}/${stablePolls}` : undefined,
      }).catch(() => {})
      refreshFileTree(projectPath).catch(() => {})
      if (seenCount < stablePolls) continue

      nextKnown.add(filePath)
      pendingFiles.delete(filePath)

      const llmConfig = store.llmConfig
      if (!llmConfig.model) {
        await upsertIngestLog(projectPath, {
          sourcePath: filePath,
          status: "skipped",
          sourceHash: sourceHash || undefined,
          actor: "raw-watcher",
          reason: "LLM model not configured",
        }).catch(() => {})
        continue
      }

      await upsertIngestLog(projectPath, {
        sourcePath: filePath,
        status: "processing",
        sourceHash: sourceHash || undefined,
        actor: "raw-watcher",
      }).catch(() => {})
      autoIngest(projectPath, filePath, llmConfig, undefined, undefined, {
        publishToChat: rawConfig.publishToChat,
        conversationTitle: rawConfig.conversationTitle,
      })
        .then((writtenFiles) => {
          upsertIngestLog(projectPath, {
            sourcePath: filePath,
            status: "completed",
            sourceHash: sourceHash || undefined,
            actor: "deepseek",
            writtenFiles,
          }).catch(() => {})
          refreshFileTree(projectPath).catch(() => {})
        })
        .catch((err) => {
          console.error("[RawWatcher] Auto-ingest failed:", err)
          upsertIngestLog(projectPath, {
            sourcePath: filePath,
            status: "failed",
            sourceHash: sourceHash || undefined,
            actor: "deepseek",
            error: err instanceof Error ? err.message : String(err),
          }).catch(() => {})
        })
    }

    for (const filePath of Array.from(pendingFiles.keys())) {
      if (!normalizedRawFiles.includes(filePath)) {
        pendingFiles.delete(filePath)
      }
    }

    knownFiles = nextKnown
    return pollInterval
  } catch (err) {
    console.warn("[RawWatcher] Poll error:", err)
    return 4000
  } finally {
    isPolling = false
  }
}

function scheduleNext(delayMs: number) {
  if (stopped) return
  timerId = setTimeout(async () => {
    timerId = null
    const nextDelay = await pollRawOnce()
    scheduleNext(nextDelay)
  }, delayMs)
}

async function seedKnownFiles(projectPath: string, config: WikiSystemConfig) {
  currentProjectPath = projectPath
  pendingFiles = new Map()
  try {
    const rawTree = await listWatchedRawFiles(projectPath, config)
    knownFiles = new Set(
      rawTree
        .map((node) => normalizePath(node.path))
        .filter((path) => shouldWatchFile(path, config)),
    )
  } catch {
    knownFiles = new Set()
  }
}

function resetWatcherState(projectPath: string | null) {
  currentProjectPath = projectPath
  knownFiles = new Set()
  pendingFiles = new Map()
}

function flattenFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenFiles(node.children))
      continue
    }
    if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}

async function listWatchedRawFiles(projectPath: string, config: WikiSystemConfig): Promise<FileNode[]> {
  const monitorDirs = config.rawIngest.monitorDirs?.length ? config.rawIngest.monitorDirs : ["raw"]
  const files: FileNode[] = []
  const seen = new Set<string>()

  for (const dir of monitorDirs) {
    const fullPath = normalizePath(`${projectPath}/${dir}`)
    try {
      for (const node of flattenFiles(await listDirectory(fullPath))) {
        const normalized = normalizePath(node.path)
        if (seen.has(normalized)) continue
        seen.add(normalized)
        files.push(node)
      }
    } catch {
      // A configured monitor directory can be absent.
    }
  }

  return files
}

function shouldWatchFile(path: string, config: WikiSystemConfig): boolean {
  const rawConfig = config.rawIngest
  for (const ignored of rawConfig.ignoredPathIncludes) {
    if (ignored && path.includes(ignored)) return false
  }

  const lower = path.toLowerCase()
  const dotIndex = lower.lastIndexOf(".")
  if (dotIndex === -1) return false
  const extension = lower.slice(dotIndex)
  const extensions = new Set(rawConfig.extensions.map((item) => item.toLowerCase()))
  if (!extensions.has(extension)) return false

  if (rawConfig.fileNamePattern) {
    try {
      const fileName = path.split("/").pop() ?? path
      if (!new RegExp(rawConfig.fileNamePattern).test(fileName)) return false
    } catch {
      // Invalid user regex should not stop ingestion.
    }
  }

  return true
}

async function refreshFileTree(projectPath: string): Promise<void> {
  const tree = await loadProjectFileTree(projectPath)
  useWikiStore.getState().setFileTree(tree)
  useWikiStore.getState().bumpDataVersion()
}
