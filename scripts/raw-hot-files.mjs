#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const HOT_FILE_PATH = ".system/raw-queue-hot-files.json"

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/")
}

function projectRelative(projectPath, targetPath) {
  return toPosixPath(path.relative(path.resolve(projectPath), path.resolve(targetPath)))
}

export function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export function readHotFiles(projectPath, { allowedExtensions, maxFileBytes }) {
  const hotFilePath = path.join(projectPath, HOT_FILE_PATH)
  const payload = readJsonMaybe(hotFilePath)
  const items = Array.isArray(payload?.items) ? payload.items : []
  const now = Date.now()
  return items
    .filter((item) => {
      const sourcePath = String(item?.sourcePath ?? "")
      if (!sourcePath || !fs.existsSync(sourcePath)) return false
      if (item?.expiresAt && Number.isFinite(Date.parse(item.expiresAt)) && Date.parse(item.expiresAt) < now) return false
      const ext = path.extname(sourcePath).toLowerCase()
      if (allowedExtensions && !allowedExtensions.has(ext)) return false
      const stat = fs.statSync(sourcePath)
      if (!stat.isFile() || stat.size <= 0) return false
      if (Number.isFinite(maxFileBytes) && stat.size > maxFileBytes) return false
      return true
    })
    .map((item) => {
      const filePath = String(item.sourcePath)
      const stat = fs.statSync(filePath)
      return {
        filePath,
        stat,
        relativePath: projectRelative(projectPath, filePath),
        fileDate: String(item.fileDate ?? ""),
        hotQueuedAt: String(item.queuedAt ?? item.firstSeenAt ?? ""),
        rawId: String(item.rawId ?? ""),
      }
    })
}

export function mergeHotFiles(baseItems, hotItems, limit) {
  const merged = new Map()
  for (const item of [...(hotItems ?? []), ...(baseItems ?? [])]) {
    const key = String(item.relativePath ?? item.filePath ?? "")
    if (!key || merged.has(key)) continue
    merged.set(key, item)
  }
  return [...merged.values()]
    .sort((left, right) => {
      const leftHot = Date.parse(left.hotQueuedAt ?? "") || 0
      const rightHot = Date.parse(right.hotQueuedAt ?? "") || 0
      if (leftHot !== rightHot) return rightHot - leftHot
      return Number(right.stat?.mtimeMs ?? 0) - Number(left.stat?.mtimeMs ?? 0)
    })
    .slice(0, Number(limit))
}

export function hotFilePath(projectPath) {
  return path.join(projectPath, HOT_FILE_PATH)
}
