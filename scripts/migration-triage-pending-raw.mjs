#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const QUEUE_PATH = ".system/codex-raw-watch-queue.jsonl"
const REGISTRY_PATH = ".system/ingest-registry.jsonl"
const SUMMARY_PAGE = "wiki/08-信息来源/2026-06-27-周末资讯分拣.md"
const MIGRATION_PAGE = "wiki/99-迁移/2026-06-27-RAW待摄入分拣与Mac迁移取舍.md"
const REPORT_ROOT = ".llm-wiki/migration-triage"

const HIGH_KEYWORDS = [
  "竞价监控",
  "人形机器人",
  "机器人",
  "AI相关",
  "AI服务器",
  "功率半导体",
  "半导体",
  "芯片",
  "存储",
  "美光",
  "高通",
  "费城半导体",
  "新型能源体系",
  "数据中心",
  "电力",
  "新能源",
  "有色金属",
  "黄金",
  "原油",
  "霍尔木兹",
  "减持",
]

const COLD_KEYWORDS = [
  "港股IPO",
  "递表港交所",
  "上市聆讯",
  "NBA",
  "世界杯",
  "埃博拉",
  "地震",
  "孟加拉国",
  "柴油补贴",
  "车辆",
  "本田",
  "通用汽车",
]

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith("--")) continue
    const key = token.slice(2)
    if (["write", "write-registry", "help"].includes(key)) {
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
  const pad = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function shortHash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 12)
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function writeText(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, value, "utf8")
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function appendJsonl(filePath, rows) {
  if (!rows.length) return
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8")
}

function readJsonl(filePath) {
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

function compact(value, max = 260) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max)
}

function readTextMaybe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
  } catch {
    return ""
  }
}

function titleFromText(text, sourcePath) {
  const match = String(text).match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : path.basename(sourcePath, path.extname(sourcePath))
}

function hitKeywords(text, keywords) {
  return keywords.filter((keyword) => text.includes(keyword))
}

function relative(projectPath, filePath) {
  return path.relative(projectPath, filePath).replace(/\\/g, "/")
}

function classify(item, projectPath) {
  const sourcePath = String(item.source_path ?? "")
  const text = readTextMaybe(sourcePath)
  const title = titleFromText(text, sourcePath)
  const searchable = `${sourcePath}\n${title}\n${text}`
  const highHits = hitKeywords(searchable, HIGH_KEYWORDS)
  const coldHits = hitKeywords(searchable, COLD_KEYWORDS)
  const rel = relative(projectPath, sourcePath)

  if (rel.startsWith("raw/03-每日交易计划/")) {
    return {
      action: "wiki_now",
      migration: "copy_to_mac",
      reason: "交易计划与当前作战室直接相关",
      highHits: ["竞价监控"],
      coldHits,
      title,
      excerpt: compact(text, 360),
    }
  }

  if (highHits.length > 0 && coldHits.length === 0) {
    return {
      action: "wiki_summary",
      migration: "copy_summary_only",
      reason: "对题材、市场状态或风险有交易辅助价值",
      highHits,
      coldHits,
      title,
      excerpt: compact(text, 360),
    }
  }

  if (highHits.length >= 2) {
    return {
      action: "wiki_summary",
      migration: "copy_summary_only",
      reason: "虽含部分冷信息，但命中多个交易相关关键词",
      highHits,
      coldHits,
      title,
      excerpt: compact(text, 360),
    }
  }

  return {
    action: "cold_defer",
    migration: "do_not_copy_to_mac_now",
    reason: coldHits.length > 0 ? "偏冷资料或低交易相关性" : "未命中当前交易链关键词",
    highHits,
    coldHits,
    title,
    excerpt: compact(text, 180),
  }
}

function unresolvedQueue(projectPath) {
  const queue = readJsonl(path.join(projectPath, QUEUE_PATH))
  const registry = readJsonl(path.join(projectPath, REGISTRY_PATH))
  const seen = new Set(registry.map(registryKey).filter(Boolean))
  return queue.filter((record) => {
    if (record.status !== "pending_codex_ingest") return false
    const key = registryKey(record)
    return key && !seen.has(key)
  })
}

function markdownTable(rows) {
  const out = ["| 来源 | 判断 | 迁移动作 | 命中 |", "|---|---|---|---|"]
  for (const row of rows) {
    out.push(`| ${row.relativePath} | ${row.reason} | ${row.migration} | ${row.highHits.join("、") || "-"} |`)
  }
  return out.join("\n")
}

function buildSummaryPage(report) {
  const selected = report.items.filter((item) => item.action === "wiki_now" || item.action === "wiki_summary")
  const byAction = (action) => selected.filter((item) => item.action === action)
  return `# 2026-06-27 周末资讯分拣

- 生成时间：${report.generatedAt}
- 口径：只沉淀对当前交易链、题材判断、风险纠偏有价值的信息；不把低相关新闻流水写入 WIKI。
- 来源：未登记 RAW 队列 ${report.counts.total} 条。

## 直接服务作战室

${markdownTable(byAction("wiki_now"))}

## 需要进入 WIKI 的资讯摘要

${markdownTable(byAction("wiki_summary"))}

## 交易含义

1. \`raw/03-每日交易计划/2026-06-29-竞价监控清单.md\` 必须随 Mac 迁移，因为它直接服务 2026-06-29 作战室。
2. 人形机器人、AI 电源功率、功率半导体、新型能源体系、半导体/存储外盘波动、原油/霍尔木兹、黄金/有色，进入 WIKI 摘要层即可，不需要把对应全部 RAW 原文迁到 Mac。
3. 港股 IPO、普通环球快讯、体育、海外个别公司低相关事件，当前不进入 WIKI，不列入 Mac 首批迁移。

## 证据摘录

${selected.map((item) => `### ${item.title}

- 来源：${item.relativePath}
- 动作：${item.action}
- 迁移：${item.migration}
- 命中：${item.highHits.join("、") || "-"}
- 摘录：${item.excerpt || "-"}
`).join("\n")}
`
}

function buildMigrationPage(report) {
  const grouped = Object.groupBy(report.items, (item) => item.action)
  const rows = report.items
    .map((item) => `| ${item.relativePath} | ${item.action} | ${item.migration} | ${item.reason} |`)
    .join("\n")
  return `# 2026-06-27 RAW待摄入分拣与Mac迁移取舍

- 生成时间：${report.generatedAt}
- 未登记待处理：${report.counts.total}
- 需要写入/摘要进 WIKI：${report.counts.wiki}
- 当前不拷到 Mac：${report.counts.cold}

## 迁移结论

1. 首批 Mac 迁移必须带：\`wiki/\`、关键 \`.system\`、\`.llm-wiki\` 最新产物、\`raw/03-每日交易计划/2026-06-29-竞价监控清单.md\`。
2. \`raw/05-研报新闻\` 本轮只带 WIKI 摘要，不搬对应原始新闻流。
3. 本页列为 \`cold_defer\` 的 RAW 继续留服务器冷存，不进入 Mac 首批迁移。

## 分类统计

| 分类 | 数量 |
|---|---:|
| wiki_now | ${(grouped.wiki_now ?? []).length} |
| wiki_summary | ${(grouped.wiki_summary ?? []).length} |
| cold_defer | ${(grouped.cold_defer ?? []).length} |

## 明细

| 来源 | 分类 | 迁移动作 | 原因 |
|---|---|---|---|
${rows}
`
}

function registryRows(report) {
  const at = `${report.generatedAt} +08:00`
  return report.items.map((item) => ({
    raw_id: item.rawId,
    source_path: item.sourcePath,
    source_agent: item.sourceAgent,
    preferred_ingestor: "codex",
    status: item.action === "cold_defer" ? "migration_deferred_cold_raw" : "migration_triaged_to_wiki",
    ingested_by: "codex-migration-triage",
    deepseek_action: "skip",
    truth_grade: item.truthGrade,
    fate: item.action === "cold_defer" ? "C" : "B",
    content_hash: item.contentHash,
    first_seen_at: item.firstSeenAt,
    ingested_at: at,
    target_pages: item.action === "cold_defer" ? [MIGRATION_PAGE] : [SUMMARY_PAGE, MIGRATION_PAGE],
    notes: item.reason,
  }))
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/migration-triage-pending-raw.mjs --project C:/wiki/73神话 --write --write-registry")
    return
  }
  const projectPath = path.resolve(args.project ?? DEFAULT_PROJECT_PATH)
  const records = unresolvedQueue(projectPath)
  const items = records.map((record) => {
    const sourcePath = String(record.source_path ?? "")
    const verdict = classify(record, projectPath)
    return {
      rawId: String(record.raw_id ?? ""),
      sourcePath,
      relativePath: relative(projectPath, sourcePath),
      sourceAgent: String(record.source_agent ?? "unknown"),
      truthGrade: String(record.truth_grade ?? "S3"),
      contentHash: String(record.content_hash ?? ""),
      firstSeenAt: String(record.first_seen_at ?? ""),
      size: Number(record.size ?? 0),
      mtime: String(record.mtime ?? ""),
      ...verdict,
    }
  }).sort((a, b) => {
    const actionRank = { wiki_now: 0, wiki_summary: 1, cold_defer: 2 }
    return (actionRank[a.action] ?? 9) - (actionRank[b.action] ?? 9) || a.relativePath.localeCompare(b.relativePath, "zh-Hans-CN")
  })

  const report = {
    schema: "73wiki-migration-triage-pending-raw-v1",
    id: `migration_triage_${nowLocalTimestamp().replace(/[-: ]/g, "")}_${shortHash(items.length)}`,
    generatedAt: nowLocalTimestamp(),
    projectPath,
    counts: {
      total: items.length,
      wiki: items.filter((item) => item.action === "wiki_now" || item.action === "wiki_summary").length,
      cold: items.filter((item) => item.action === "cold_defer").length,
    },
    pages: {
      summary: SUMMARY_PAGE,
      migration: MIGRATION_PAGE,
    },
    items,
  }

  if (args.write) {
    writeText(path.join(projectPath, SUMMARY_PAGE), buildSummaryPage(report))
    writeText(path.join(projectPath, MIGRATION_PAGE), buildMigrationPage(report))
    const reportDir = path.join(projectPath, REPORT_ROOT)
    writeJson(path.join(reportDir, `${report.id}.json`), report)
    writeJson(path.join(reportDir, "latest-migration-triage.json"), report)
  }
  if (args["write-registry"] && items.length > 0) {
    appendJsonl(path.join(projectPath, REGISTRY_PATH), registryRows(report))
  }
  console.log(JSON.stringify({
    dryRun: !args.write,
    registryWrite: Boolean(args["write-registry"]),
    counts: report.counts,
    pages: report.pages,
  }, null, 2))
}

main()
