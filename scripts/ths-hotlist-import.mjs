#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const DEFAULT_CAPTURE_DIR = process.env.THS_HOTLIST_CAPTURE_DIR ?? "C:/Users/Administrator/Desktop/workspace/热榜抓取/同花顺"
const FACT_PATH = "data/facts/ths_hotlist_snapshots.jsonl"
const REPORT_ROOT = ".llm-wiki/ths-hotlist"

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["write", "help"].includes(key)) {
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

function idTimestamp(date = new Date()) {
  return nowLocalTimestamp(date).replace(/[-: ]/g, "")
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12)
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/")
}

function projectRelative(projectPath, targetPath) {
  return toPosixPath(path.relative(path.resolve(projectPath), path.resolve(targetPath)))
}

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function normalizeCode(value) {
  return String(value ?? "").replace(/\D/g, "").padStart(6, "0").slice(-6)
}

function parseNumberLoose(value) {
  const text = String(value ?? "").replace(/,/g, "").trim()
  if (!text || text === "--") return null
  const match = text.match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : null
}

function parseObservedAt(fileName) {
  const match = String(fileName).match(/(20\d{2})-(\d{2})-(\d{2})-(\d{2})(\d{2})/)
  if (!match) return null
  const [, year, month, day, hour, minute] = match
  return `${year}-${month}-${day} ${hour}:${minute}:00`
}

function tradeDateFromFileName(fileName) {
  const observedAt = parseObservedAt(fileName)
  return observedAt ? observedAt.slice(0, 10) : nowLocalTimestamp().slice(0, 10)
}

function expectedRowsFromFileName(fileName) {
  const match = String(fileName).match(/top(\d+)/i)
  return match ? Number(match[1]) : null
}

function latestCaptureFile(captureDir) {
  if (!fs.existsSync(captureDir)) throw new Error(`THS capture dir not found: ${captureDir}`)
  const files = fs.readdirSync(captureDir)
    .filter((name) => /ths-hotlist/i.test(name) && name.toLowerCase().endsWith(".json"))
    .map((name) => {
      const fullPath = path.join(captureDir, name)
      const stat = fs.statSync(fullPath)
      return { name, fullPath, stat }
    })
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)
  if (files.length === 0) throw new Error(`No THS hotlist json found in ${captureDir}`)
  return files[0]
}

function normalizeRows(rows, maxItems) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => {
      const code = normalizeCode(row?.code)
      if (!/^\d{6}$/.test(code)) return null
      return {
        rank: Number(row?.rank ?? index + 1),
        code,
        name: String(row?.name ?? "").trim(),
        latestPrice: parseNumberLoose(row?.price),
        changePercent: parseNumberLoose(row?.changePercent),
        changeAmount: parseNumberLoose(row?.changeAmount),
        speed: parseNumberLoose(row?.speed),
        turnover: parseNumberLoose(row?.turnover),
        volumeRatio: parseNumberLoose(row?.volumeRatio),
        amplitude: parseNumberLoose(row?.amplitude),
        amountText: String(row?.amount ?? "").trim(),
        raw: row?.raw ?? null,
      }
    })
    .filter(Boolean)
    .slice(0, Number(maxItems))
}

function buildRecord({ projectPath, captureDir, maxItems }) {
  const capture = latestCaptureFile(captureDir)
  const payload = JSON.parse(fs.readFileSync(capture.fullPath, "utf8"))
  const rows = normalizeRows(payload?.rows, maxItems)
  const observedAt = parseObservedAt(capture.name) ?? nowLocalTimestamp(capture.stat.mtime)
  const tradeDate = tradeDateFromFileName(capture.name)
  const expectedRows = expectedRowsFromFileName(capture.name)
  const targetRows = Number.isFinite(Number(maxItems)) ? Number(maxItems) : 100
  const generatedAt = nowLocalTimestamp()
  const evidenceTradeDate = normalizeTradeDate(tradeDate) ?? tradeDate
  const summaryLeaders = rows
    .slice(0, 12)
    .map((item) => `${item.name || item.code}#${item.rank}`)
    .join(", ")

  return {
    schema: "73wiki-ths-hotlist-snapshot-v1",
    id: `ths_hotlist_${tradeDate.replace(/-/g, "")}_${idTimestamp()}_${shortHash(capture.name)}`,
    status: "active",
    title: `${tradeDate} THS hotlist snapshot`,
    generatedAt,
    observedAt,
    tradeDate,
    planTradeDate: evidenceTradeDate,
    evidenceTradeDate,
    sourceTradeDates: {
      thsHotlist: evidenceTradeDate,
    },
    hasDateMismatch: false,
    source: "tonghuashun-hotlist-browser-capture",
    sourceTier: "browser_capture",
    sourceUrl: payload?.sourceUrl ?? "https://q.10jqka.com.cn/",
    captureFile: projectRelative(projectPath, capture.fullPath),
    counts: {
      rows: rows.length,
      expectedRows: expectedRows ?? null,
      targetRows,
      complete: rows.length >= Math.min(targetRows, expectedRows ?? targetRows),
    },
    rows,
    summary: summaryLeaders
      ? `THS hotlist rows=${rows.length}; leaders=${summaryLeaders}`
      : "THS hotlist imported with no valid rows.",
    claim: "THS hotlist is crowd-attention evidence only. It must be cross-checked with theme strength, limit-up structure, and next-day tradability.",
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }
}

function printHelp() {
  console.log(`Usage:
  npm run ths:hotlist:import -- --project C:\\wiki\\73神话 --write
  node scripts/ths-hotlist-import.mjs --capture-dir C:\\path\\to\\ths --max-items 100 --write
`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const projectPath = path.resolve(args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH)
  const captureDir = path.resolve(args["capture-dir"] ?? DEFAULT_CAPTURE_DIR)
  const maxItems = Number(args["max-items"] ?? args._[1] ?? 100)
  const record = buildRecord({ projectPath, captureDir, maxItems })
  const reportDir = path.join(projectPath, REPORT_ROOT)
  const reportPath = path.join(reportDir, `${idTimestamp()}-ths-hotlist.json`)
  const latestPath = path.join(reportDir, "latest-ths-hotlist.json")
  const factPath = path.join(projectPath, FACT_PATH)

  const output = {
    dryRun: !args.write,
    record,
    writePaths: {
      facts: FACT_PATH,
      reportRoot: REPORT_ROOT,
    },
  }

  if (args.write) {
    appendJsonl(factPath, record)
    writeJson(reportPath, record)
    writeJson(latestPath, record)
    output.written = {
      facts: projectRelative(projectPath, factPath),
      report: projectRelative(projectPath, reportPath),
      latest: projectRelative(projectPath, latestPath),
    }
  }

  console.log(JSON.stringify(output, null, 2))
}

main()
