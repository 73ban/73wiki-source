#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import https from "node:https"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const SHORTLINE_EMOTION_PATH = "data/facts/shortline_emotion_snapshots.jsonl"
const REPORT_ROOT = ".llm-wiki/akshare-emotion"
const EASTMONEY_UT = "7eea3edcaed734bea9cbfc24409ed989"

const POOLS = {
  limit_up: {
    title: "涨停股池",
    url: "https://push2ex.eastmoney.com/getTopicZTPool",
    params: { pagesize: 10000, sort: "fbt:asc" },
    columns: ["序号", "代码", "_", "名称", "最新价", "涨跌幅", "成交额", "流通市值", "总市值", "换手率", "连板数", "首次封板时间", "最后封板时间", "封板资金", "炸板次数", "所属行业", "涨停统计"],
  },
  burst: {
    title: "炸板股池",
    url: "https://push2ex.eastmoney.com/getTopicZBPool",
    params: { pagesize: 5000, sort: "fbt:asc" },
    columns: ["序号", "代码", "_", "名称", "最新价", "涨停价", "涨跌幅", "成交额", "流通市值", "总市值", "换手率", "首次封板时间", "炸板次数", "振幅", "涨速", "涨停统计", "所属行业"],
  },
  limit_down: {
    title: "跌停股池",
    url: "https://push2ex.eastmoney.com/getTopicDTPool",
    params: { pagesize: 10000, sort: "fund:asc" },
    columns: ["序号", "代码", "_", "名称", "最新价", "涨跌幅", "成交额", "流通市值", "总市值", "动态市盈率", "换手率", "封单资金", "最后封板时间", "板上成交额", "连续跌停", "开板次数", "所属行业"],
  },
  strong: {
    title: "强势股池",
    url: "https://push2ex.eastmoney.com/getTopicQSPool",
    params: { pagesize: 5000, sort: "zdp:desc" },
    columns: ["序号", "代码", "_", "名称", "最新价", "涨停价", "_2", "涨跌幅", "成交额", "流通市值", "总市值", "换手率", "是否新高", "入选理由", "量比", "涨速", "涨停统计", "所属行业"],
  },
  previous_limit_up: {
    title: "昨日涨停股池",
    url: "https://push2ex.eastmoney.com/getYesterdayZTPool",
    params: { pagesize: 5000, sort: "zs:desc" },
    columns: ["序号", "代码", "_", "名称", "最新价", "涨停价", "涨跌幅", "成交额", "流通市值", "总市值", "换手率", "振幅", "涨速", "昨日封板时间", "昨日连板数", "所属行业", "涨停统计"],
  },
}

const KEEP_FIELDS = {
  limit_up: ["序号", "代码", "名称", "涨跌幅", "最新价", "成交额", "换手率", "封板资金", "首次封板时间", "最后封板时间", "炸板次数", "涨停统计", "连板数", "所属行业"],
  burst: ["序号", "代码", "名称", "涨跌幅", "最新价", "涨停价", "成交额", "换手率", "涨速", "首次封板时间", "炸板次数", "涨停统计", "振幅", "所属行业"],
  limit_down: ["序号", "代码", "名称", "涨跌幅", "最新价", "成交额", "换手率", "封单资金", "最后封板时间", "板上成交额", "连续跌停", "开板次数", "所属行业"],
  strong: ["序号", "代码", "名称", "涨跌幅", "最新价", "涨停价", "成交额", "换手率", "涨速", "是否新高", "量比", "涨停统计", "入选理由", "所属行业"],
  previous_limit_up: ["序号", "代码", "名称", "涨跌幅", "最新价", "涨停价", "成交额", "换手率", "涨速", "振幅", "昨日封板时间", "昨日连板数", "涨停统计", "所属行业"],
}

function printHelp() {
  console.log(`Usage:
  npm run akshare:emotion -- snapshot [--project <wiki-root>] [--date YYYYMMDD] [--write]
  npm run akshare:emotion -- snapshot C:\\wiki\\73神话 20260612 write

This is an AKShare-compatible Eastmoney shortline emotion adapter.
It only writes data/facts/shortline_emotion_snapshots.jsonl and .llm-wiki/akshare-emotion reports.
It does not write raw/** or wiki/**.
`)
}

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

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function latestWeekday(date = new Date()) {
  const candidate = new Date(date)
  while (candidate.getDay() === 0 || candidate.getDay() === 6) {
    candidate.setDate(candidate.getDate() - 1)
  }
  return candidate
}

function compactDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

function idTimestamp(date = new Date()) {
  return nowLocalTimestamp(date).replace(/[-: ]/g, "")
}

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12)
}

function resolveProjectPath(projectPath) {
  return path.resolve(projectPath ?? DEFAULT_PROJECT_PATH)
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/")
}

function projectRelative(projectPath, targetPath) {
  return toPosixPath(path.relative(path.resolve(projectPath), path.resolve(targetPath)))
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function getJson(url, params) {
  const requestUrl = new URL(url)
  for (const [key, value] of Object.entries(params)) requestUrl.searchParams.set(key, String(value))
  return new Promise((resolve, reject) => {
    https.get(requestUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json,text/plain,*/*",
      },
    }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => {
        body += chunk
      })
      res.on("end", () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(body) })
        } catch {
          resolve({ statusCode: res.statusCode, data: body })
        }
      })
    }).on("error", reject)
  })
}

function zfillTime(value) {
  if (value == null || value === "" || Number(value) <= 0) return ""
  return String(value).padStart(6, "0").replace(/^(\d{2})(\d{2})(\d{2})$/, "$1:$2:$3")
}

function scalePrice(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return value
  return num > 1000 ? num / 1000 : num
}

function normalizeValue(field, value) {
  if (field.includes("时间")) return zfillTime(value)
  if (field === "最新价" || field === "涨停价") return scalePrice(value)
  if (field === "涨停统计" && value && typeof value === "object") return `${value.days ?? 0}/${value.ct ?? 0}`
  if (field === "是否新高") return value === 1 ? "是" : value === 0 ? "否" : value
  if (field === "入选理由") {
    return ({ 1: "60日新高", 2: "近期多次涨停", 3: "60日新高且近期多次涨停" })[value] ?? value
  }
  return value
}

function normalizePoolRows(poolKey, pool) {
  const definition = POOLS[poolKey]
  const keep = KEEP_FIELDS[poolKey]
  return pool.map((item, index) => {
    const rawValues = Object.values(item)
    const row = { 序号: index + 1 }
    definition.columns.forEach((field, fieldIndex) => {
      if (field === "序号") return
      if (field === "_")
        return
      row[field] = normalizeValue(field, rawValues[fieldIndex - 1])
    })
    return Object.fromEntries(keep.map((field) => [field, row[field] ?? ""]))
  })
}

async function fetchPool(poolKey, date) {
  const definition = POOLS[poolKey]
  const response = await getJson(definition.url, {
    ut: EASTMONEY_UT,
    dpt: "wz.ztzt",
    Pageindex: 0,
    date,
    ...definition.params,
  })
  const pool = response.data?.data?.pool ?? []
  return {
    statusCode: response.statusCode,
    title: definition.title,
    rows: normalizePoolRows(poolKey, Array.isArray(pool) ? pool : []),
    rawCount: Array.isArray(pool) ? pool.length : 0,
  }
}

async function fetchAllPools(date) {
  const out = {}
  for (const poolKey of Object.keys(POOLS)) {
    out[poolKey] = await fetchPool(poolKey, date)
  }
  return out
}

async function fetchLatestPools(requestedDate) {
  const start = latestWeekday(requestedDate ? parseCompactDate(requestedDate) : new Date())
  for (let offset = 0; offset < 10; offset += 1) {
    const candidate = new Date(start)
    candidate.setDate(candidate.getDate() - offset)
    const date = compactDate(candidate)
    const pools = await fetchAllPools(date)
    const total = Object.values(pools).reduce((sum, pool) => sum + pool.rows.length, 0)
    if (total > 0) return { date, pools, fallbackDays: offset }
  }
  const date = requestedDate ?? compactDate(start)
  return { date, pools: await fetchAllPools(date), fallbackDays: null }
}

function parseCompactDate(value) {
  const text = String(value)
  if (!/^\d{8}$/.test(text)) throw new Error(`Invalid date, expected YYYYMMDD: ${value}`)
  return new Date(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)))
}

function topRows(rows, field, limit = 10) {
  return [...rows]
    .sort((a, b) => Number(b[field] ?? -Infinity) - Number(a[field] ?? -Infinity))
    .slice(0, limit)
}

function countBy(rows, field) {
  const counts = new Map()
  for (const row of rows) {
    const key = row[field] || "未分类"
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

function buildSummary({ date, pools, fallbackDays }) {
  const limitUp = pools.limit_up.rows
  const burst = pools.burst.rows
  const limitDown = pools.limit_down.rows
  const maxHeight = Math.max(0, ...limitUp.map((row) => Number(row["连板数"] ?? 0)))
  const ladder = topRows(limitUp, "连板数", 12)
  const industries = countBy(limitUp, "所属行业").slice(0, 8)
  const earlyLimit = [...limitUp]
    .sort((a, b) => String(a["首次封板时间"]).localeCompare(String(b["首次封板时间"])))
    .slice(0, 10)
  const burstTop = topRows(burst, "炸板次数", 10)

  const summary = [
    `AKShare/东方财富短线情绪快照：${date} 涨停 ${limitUp.length} 只，炸板 ${burst.length} 只，跌停 ${limitDown.length} 只，最高连板 ${maxHeight} 板。`,
    fallbackDays ? `请求日无数据，已向前回退 ${fallbackDays} 天。` : "使用请求日数据。",
    ladder.length ? `连板天梯前列：${ladder.map((row) => `${row["名称"]}(${row["代码"]}) ${row["连板数"]}板`).join("；")}。` : "连板天梯为空。",
    industries.length ? `涨停行业集中：${industries.map((item) => `${item.name}${item.count}只`).join("；")}。` : "行业集中度为空。",
    earlyLimit.length ? `竞价/早盘最早封板：${earlyLimit.map((row) => `${row["名称"]} ${row["首次封板时间"]}`).join("；")}。` : "首次封板时间为空。",
    burstTop.length ? `炸板高风险：${burstTop.map((row) => `${row["名称"]} 炸${row["炸板次数"]}次`).join("；")}。` : "炸板池为空。",
  ]

  return {
    text: summary.join("\n"),
    maxHeight,
    industries,
    ladder,
    earlyLimit,
    burstTop,
  }
}

async function runSnapshot(options = {}) {
  const projectPath = resolveProjectPath(options.projectPath)
  const generatedAt = nowLocalTimestamp()
  const { date, pools, fallbackDays } = await fetchLatestPools(options.date)
  const summary = buildSummary({ date, pools, fallbackDays })
  const evidenceTradeDate = normalizeTradeDate(date) ?? date
  const record = {
    schema: "73wiki-akshare-shortline-emotion-v1",
    id: `akemotion_${date}_${idTimestamp()}_${shortHash(summary.text)}`,
    status: "active",
    title: `${date} AKShare/东方财富短线情绪快照`,
    generatedAt,
    tradeDate: date,
    planTradeDate: evidenceTradeDate,
    evidenceTradeDate,
    sourceTradeDates: {
      akshareEmotion: evidenceTradeDate,
    },
    hasDateMismatch: false,
    source: "akshare-compatible-eastmoney",
    sourceTier: "public_api_wrapper",
    fallbackDays,
    counts: Object.fromEntries(Object.entries(pools).map(([key, pool]) => [key, pool.rows.length])),
    maxLimitUpHeight: summary.maxHeight,
    limitUpLadder: summary.ladder,
    limitUpIndustries: summary.industries,
    earlyLimitUps: summary.earlyLimit,
    burstRiskTop: summary.burstTop,
    pools: Object.fromEntries(Object.entries(pools).map(([key, pool]) => [key, pool.rows])),
    summary: summary.text,
    claim: summary.text,
    tags: ["akshare", "eastmoney", "shortline-emotion", "limit-up", "连板天梯", "炸板"],
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }

  const out = {
    dryRun: !options.write,
    record,
    writePaths: {
      facts: SHORTLINE_EMOTION_PATH,
      reportRoot: REPORT_ROOT,
    },
  }

  if (options.write) {
    const factsPath = path.join(projectPath, SHORTLINE_EMOTION_PATH)
    const reportDir = path.join(projectPath, REPORT_ROOT)
    const reportPath = path.join(reportDir, `${idTimestamp()}-${date}-shortline-emotion.json`)
    const latestPath = path.join(reportDir, "latest-shortline-emotion.json")
    appendJsonl(factsPath, record)
    writeJson(reportPath, record)
    writeJson(latestPath, record)
    out.written = {
      facts: projectRelative(projectPath, factsPath),
      report: projectRelative(projectPath, reportPath),
      latest: projectRelative(projectPath, latestPath),
    }
  }
  return out
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  if (!command || command === "help" || args.help) {
    printHelp()
    return
  }
  if (command === "snapshot") {
    const result = await runSnapshot({
      projectPath: args.project ?? args._[1],
      date: args.date ?? args._[2],
      write: Boolean(args.write) || args._.includes("write"),
    })
    printJson(result)
    return
  }
  throw new Error(`Unknown command: ${command}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
