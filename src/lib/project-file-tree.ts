import { listDirectory } from "@/commands/fs"
import { loadWikiSystemConfig } from "@/lib/wiki-config"
import { normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"

function rootNodeName(watchDir: string): string {
  const normalized = normalizePath(watchDir).replace(/\/+$/, "")
  const segments = normalized.split("/").filter(Boolean)
  return segments[segments.length - 1] ?? normalized
}

export async function loadProjectFileTree(projectPath: string): Promise<FileNode[]> {
  const normalizedProjectPath = normalizePath(projectPath)
  const config = await loadWikiSystemConfig(normalizedProjectPath).catch(() => null)
  const watchDirs = config?.fileTree.watchDirs?.length ? config.fileTree.watchDirs : ["raw", "wiki"]
  const results = await Promise.allSettled(
    watchDirs.map(async (watchDir) => {
      const fullPath = normalizePath(`${normalizedProjectPath}/${watchDir}`)
      const children = await listDirectory(fullPath)
      return {
        name: rootNodeName(watchDir),
        path: fullPath,
        is_dir: true,
        children,
      } satisfies FileNode
    }),
  )

  return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
}
