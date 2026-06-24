#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import https from "node:https"
import fs from "node:fs"
import path from "node:path"
import { TextDecoder } from "node:util"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const REPORT_ROOT = ".llm-wiki/market-collect"

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["force", "help"].includes(key)) {
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

function compactDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

function idTimestamp(date = new Date()) {
  return nowLocalTimestamp(date).replace(/[-: ]/g, "")
}

function shortHash(value) {
  let hash = 0
  const text = String(value ?? "")
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  return Math.abs(hash).toString(16).slice(0, 12)
}

function resolveProjectPath(projectPath) {
  return path.resolve(projectPath ?? DEFAULT_PROJECT_PATH)
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function isWeekend(date = new Date()) {
  const day = date.getDay()
  return day === 0 || day === 6
}

function scriptPath(name) {
  return path.join(process.cwd(), "scripts", name)
}

function npmBin() {
  return process.platform === "win32" ? "npm.cmd" : "npm"
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
    maxBuffer: 64 * 1024 * 1024,
  })
  const finishedAt = nowLocalTimestamp()
  const ok = result.status === 0
  const stdoutRaw = String(result.stdout ?? "")
  const stderrRaw = String(result.stderr ?? "")
  const step = {
    name,
    ok,
    status: result.status,
    startedAt,
    finishedAt,
    command: [command, ...args].join(" "),
    stdout: stdoutRaw.slice(-6000),
    stderr: stderrRaw.slice(-6000),
    stdoutRaw,
    error: result.error?.message ?? null,
  }
  if (!ok && !allowFailure) {
    const err = new Error(`${name} failed`)
    err.step = step
    throw err
  }
  return step
}

async function runInlineStep(name, task, { allowFailure = false } = {}) {
  const startedAt = nowLocalTimestamp()
  try {
    const payload = await task()
    return {
      name,
      ok: true,
      status: 0,
      startedAt,
      finishedAt: nowLocalTimestamp(),
      command: `${name} (inline)`,
      stdout: JSON.stringify(payload ?? {}).slice(0, 6000),
      stderr: "",
      error: null,
    }
  } catch (error) {
    const step = {
      name,
      ok: false,
      status: 1,
      startedAt,
      finishedAt: nowLocalTimestamp(),
      command: `${name} (inline)`,
      stdout: "",
      stderr: "",
      error: error?.message ?? String(error),
    }
    if (!allowFailure) {
      const err = new Error(`${name} failed`)
      err.step = step
      throw err
    }
    return step
  }
}

function normalizeCode(value) {
  return String(value ?? "").replace(/^\s*0+/, "").padStart(6, "0").slice(-6)
}

function symbolPrefix(code) {
  const normalized = normalizeCode(code)
  if (/^(6|5|9)/.test(normalized)) return "sh"
  if (/^[03]/.test(normalized)) return "sz"
  if (/^8/.test(normalized)) return "bj"
  return "sh"
}

function quoteSymbol(code) {
  return `${symbolPrefix(code)}${normalizeCode(code)}`
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function cleanName(value) {
  const name = String(value ?? "").trim()
  if (!name) return ""
  if (/^(图片|截图|image)\s*\d+$/i.test(name)) return ""
  if (/^[*+=_#@!~`^|\\/-]+$/.test(name)) return ""
  return name
}

function nameQuality(value) {
  const name = cleanName(value)
  if (!name) return -Infinity
  let score = 0
  const hasCjk = /[\u4e00-\u9fff]/.test(name)
  const hasAscii = /[A-Za-z]/.test(name)
  const asciiOnly = /^[A-Za-z0-9.]+$/.test(name)
  const garbled = /锟|�/.test(name)
  if (hasCjk) score += 50
  if (hasAscii && hasCjk) score += 8
  if (asciiOnly) score -= 30
  if (name.length <= 2 && !hasCjk) score -= 40
  if (name.length >= 4) score += 4
  if (garbled) score -= 80
  return score
}

function preferBetterName(...values) {
  const names = values.map((value) => cleanName(value)).filter(Boolean)
  if (names.length === 0) return ""
  return names.sort((a, b) => nameQuality(b) - nameQuality(a))[0]
}

function buildNameHints(projectPath, codes = []) {
  const targetCodes = new Set((codes ?? []).map((code) => normalizeCode(code)).filter(Boolean))
  const hints = new Map()
  const add = (code, name) => {
    const normalized = normalizeCode(code)
    if (!normalized || (targetCodes.size > 0 && !targetCodes.has(normalized))) return
    const current = hints.get(normalized) ?? ""
    hints.set(normalized, preferBetterName(current, name))
  }

  const watchlist = readJsonMaybe(path.join(projectPath, ".llm-wiki/market-watchlist/latest-warroom-watchlist.json"))
  for (const section of ["focus", "warroom", "normal"]) {
    for (const item of watchlist?.tiers?.[section] ?? []) add(item.code, item.name)
  }

  const preopen = readJsonMaybe(path.join(projectPath, ".llm-wiki/preopen/latest-preopen-intel.json"))
  for (const item of preopen?.core ?? []) add(item.code, item.name)

  const reasonCards = readJsonMaybe(path.join(projectPath, ".llm-wiki/stock-reason-cards/latest-stock-reason-cards.json"))
  for (const item of reasonCards?.cards ?? []) add(item.code, item.name)

  const limitReasons = readJsonMaybe(path.join(projectPath, ".llm-wiki/limit-up-reasons/latest-limit-up-reasons.json"))
  for (const item of [...(limitReasons?.items ?? []), ...(limitReasons?.reasons ?? [])]) add(item.code, item.name)

  return hints
}

function decodeResponse(buffer, encoding = "utf-8") {
  return new TextDecoder(encoding).decode(buffer)
}

function httpGetText(url, { encoding = "utf-8" } = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "*/*",
        },
      }, (res) => {
        const chunks = []
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        res.on("end", () => resolve(decodeResponse(Buffer.concat(chunks), encoding)))
      })
      .on("error", reject)
  })
}

function httpGetJson(url, { encoding = "utf-8" } = {}) {
  return httpGetText(url, { encoding }).then((text) => {
    const trimmed = String(text ?? "").trim()
    return trimmed ? JSON.parse(trimmed) : null
  })
}

function parseQtQuote(raw, symbol) {
  const match = String(raw ?? "").match(/="([^"]*)"/)
  if (!match) return null
  const fields = match[1].split("~")
  const name = fields[1] ?? ""
  const code = normalizeCode(fields[2] ?? symbol.slice(-6))
  const price = Number(fields[3] ?? NaN)
  const prevClose = Number(fields[4] ?? NaN)
  const open = Number(fields[5] ?? NaN)
  const volume = Number(fields[6] ?? NaN)
  const amount = Number(fields[7] ?? NaN)
  const high = Number(fields[33] ?? NaN)
  const low = Number(fields[34] ?? NaN)
  const time = fields[30] ?? ""
  const changeAmount = Number.isFinite(price) && Number.isFinite(prevClose) ? price - prevClose : NaN
  const changePercent = Number.isFinite(price) && Number.isFinite(prevClose) && prevClose !== 0
    ? ((price - prevClose) / prevClose) * 100
    : NaN
  return {
    symbol,
    code,
    name,
    market: symbol.startsWith("sh") ? "SH" : symbol.startsWith("sz") ? "SZ" : symbol.startsWith("bj") ? "BJ" : "",
    latestPrice: Number.isFinite(price) ? Number(price.toFixed(2)) : null,
    prevClose: Number.isFinite(prevClose) ? Number(prevClose.toFixed(2)) : null,
    openPrice: Number.isFinite(open) ? Number(open.toFixed(2)) : null,
    highPrice: Number.isFinite(high) ? Number(high.toFixed(2)) : null,
    lowPrice: Number.isFinite(low) ? Number(low.toFixed(2)) : null,
    volume: Number.isFinite(volume) ? volume : null,
    amount: Number.isFinite(amount) ? amount : null,
    changeAmount: Number.isFinite(changeAmount) ? Number(changeAmount.toFixed(2)) : null,
    changePercent: Number.isFinite(changePercent) ? Number(changePercent.toFixed(2)) : null,
    time,
    raw: fields,
  }
}

function parseMinuteBars(code, payload) {
  const rows = payload?.data?.[code]?.data?.data ?? []
  return rows.map((row) => {
    const [time, price, cumulativeVolume, cumulativeAmount] = String(row).split(/\s+/)
    return {
      time,
      price: Number(price),
      cumulativeVolume: Number(cumulativeVolume),
      cumulativeAmount: Number(cumulativeAmount),
      raw: row,
    }
  }).filter((row) => row.time)
}

function parseKlineBars(code, payload) {
  const rows = payload?.data?.[code]?.qfqday ?? payload?.data?.[code]?.day ?? []
  return rows.map((row) => {
    const [date, open, close, high, low, volume] = row
    return {
      date,
      open: Number(open),
      close: Number(close),
      high: Number(high),
      low: Number(low),
      volume: Number(volume),
      raw: row,
    }
  }).filter((row) => row.date)
}

function parsePreopenWatchlist(step) {
  try {
    const parsed = JSON.parse(step.stdoutRaw ?? step.stdout ?? "{}")
    const record = parsed.record ?? parsed
    return {
      record,
      symbols: Array.isArray(record.symbols) ? record.symbols : [],
      focus: Array.isArray(record.core) ? record.core : [],
    }
  } catch {
    return { record: null, symbols: [], focus: [] }
  }
}

async function fetchTencentInline(projectPath, tradeDate, requestedSymbols, { write = false } = {}) {
  const symbols = unique(requestedSymbols).slice(0, 10)
  if (symbols.length === 0) return { skipped: true, reason: "no-symbols" }
  const nameHints = buildNameHints(projectPath, symbols)

  const generatedAt = nowLocalTimestamp()
  const indexSymbols = ["s_sh000001", "s_sz399001"]
  const stockSymbols = symbols.map(quoteSymbol)

  const stockQuotes = await Promise.all(stockSymbols.map(async (symbol) => {
    try {
      const text = await httpGetText(`https://qt.gtimg.cn/q=${symbol}`, { encoding: "gb18030" })
      const parsed = parseQtQuote(text, symbol)
      if (!parsed) return null
      return {
        code: normalizeCode(parsed.code),
        name: preferBetterName(nameHints.get(normalizeCode(parsed.code)), parsed.name),
        market: parsed.market ?? "",
        latestPrice: parsed.latestPrice,
        prevClose: parsed.prevClose,
        openPrice: parsed.openPrice,
        highPrice: parsed.highPrice,
        lowPrice: parsed.lowPrice,
        volume: parsed.volume,
        amount: parsed.amount,
        changeAmount: parsed.changeAmount,
        changePercent: parsed.changePercent,
        time: parsed.time ?? generatedAt,
        raw: parsed.raw,
      }
    } catch (error) {
      return {
        code: normalizeCode(symbol.slice(-6)),
        name: nameHints.get(normalizeCode(symbol.slice(-6))) ?? "",
        time: generatedAt,
        error: error?.message ?? String(error),
      }
    }
  })).then((rows) => rows.filter(Boolean))

  const indexQuotes = await Promise.all(indexSymbols.map(async (symbol) => {
    try {
      const text = await httpGetText(`https://qt.gtimg.cn/q=${symbol}`, { encoding: "gb18030" })
      const parsed = parseQtQuote(text, symbol)
      if (!parsed) return null
      return {
        code: parsed.symbol,
        name: parsed.name ?? "",
        market: parsed.market ?? "",
        latestPrice: parsed.latestPrice,
        prevClose: parsed.prevClose,
        openPrice: parsed.openPrice,
        highPrice: parsed.highPrice,
        lowPrice: parsed.lowPrice,
        volume: parsed.volume,
        amount: parsed.amount,
        changeAmount: parsed.changeAmount,
        changePercent: parsed.changePercent,
        time: parsed.time ?? generatedAt,
        raw: parsed.raw,
      }
    } catch (error) {
      return {
        code: symbol,
        name: "",
        time: generatedAt,
        error: error?.message ?? String(error),
      }
    }
  })).then((rows) => rows.filter(Boolean))

  const detailedSymbols = stockSymbols.slice(0, 10)
  const minuteBars = await Promise.all(detailedSymbols.map(async (symbol) => {
    try {
      const minutePayload = await httpGetJson(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}&day=${tradeDate}`)
      return {
        symbol,
        code: normalizeCode(symbol.slice(-6)),
        bars: parseMinuteBars(symbol, minutePayload),
      }
    } catch {
      return {
        symbol,
        code: normalizeCode(symbol.slice(-6)),
        bars: [],
      }
    }
  }))

  const klineBars = await Promise.all(detailedSymbols.map(async (symbol) => {
    try {
      const klinePayload = await httpGetJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,5,qfq`)
      return {
        symbol,
        code: normalizeCode(symbol.slice(-6)),
        bars: parseKlineBars(symbol, klinePayload),
      }
    } catch {
      return {
        symbol,
        code: normalizeCode(symbol.slice(-6)),
        bars: [],
      }
    }
  }))

  const summary = [
    `Tencent行情快照：股票 ${stockQuotes.length} 只，指数 ${indexQuotes.length} 只，分时 ${minuteBars.length} 只，K线 ${klineBars.length} 只。`,
    stockQuotes.length
      ? `波动前列：${stockQuotes.slice(0, 6).map((item) => `${item.name || item.code}(${item.code}) ${item.changePercent ?? 0}%`).join("，")}`
      : "波动前列：无",
  ].join("\n")
  const evidenceTradeDate = normalizeTradeDate(tradeDate) ?? tradeDate

  const record = {
    schema: "73wiki-tencent-market-snapshot-v1",
    id: `tencent_market_${tradeDate}_${idTimestamp()}_${shortHash(summary)}`,
    status: "active",
    title: `${tradeDate} Tencent行情快照`,
    generatedAt,
    tradeDate,
    planTradeDate: evidenceTradeDate,
    evidenceTradeDate,
    sourceTradeDates: {
      tencentMarket: evidenceTradeDate,
    },
    hasDateMismatch: false,
    source: "tencent-open-api-inline",
    sourceTier: "public_api_wrapper",
    symbolsRequested: symbols,
    stockQuotes,
    indexQuotes,
    minuteBars,
    klineBars,
    summary,
    claim: summary,
    tags: ["tencent", "quote", "minute", "kline", "market-snapshot"],
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }

  if (write) {
    const factsPath = path.join(projectPath, "data/facts/tencent_market_snapshots.jsonl")
    const reportDir = path.join(projectPath, ".llm-wiki/tencent-market")
    const reportPath = path.join(reportDir, `${idTimestamp()}-${tradeDate}-tencent-market.json`)
    const latestPath = path.join(reportDir, "latest-tencent-market.json")
    ensureDir(path.dirname(factsPath))
    fs.appendFileSync(factsPath, `${JSON.stringify(record)}\n`, "utf8")
    ensureDir(reportDir)
    fs.writeFileSync(reportPath, `${JSON.stringify(record, null, 2)}\n`, "utf8")
    fs.writeFileSync(latestPath, `${JSON.stringify(record, null, 2)}\n`, "utf8")
  }

  return { record }
}

async function runCollector({ projectPath, label, profile, maxSymbols, force }) {
  const startedAt = nowLocalTimestamp()
  const runDate = nowLocalTimestamp().slice(0, 10)
  const tradeDate = runDate.replace(/-/g, "")
  if (isWeekend() && !force) {
    return {
      ok: true,
      skipped: true,
      reason: "weekend",
      startedAt,
      finishedAt: nowLocalTimestamp(),
      label,
      profile,
    }
  }

  const steps = []
  steps.push(runStep("db:start", npmBin(), ["run", "db:start"]))
  if (profile === "emotion" || profile === "full") {
    steps.push(runStep("akshare:emotion", npmBin(), [
      "run",
      "akshare:emotion",
      "--",
      "snapshot",
      "--project",
      projectPath,
      "--write",
    ], { allowFailure: true }))
    steps.push(runStep("limitup:reasons", npmBin(), [
      "run",
      "limitup:reasons",
      "--",
      projectPath,
      "100",
      "write",
    ], { allowFailure: true }))
    steps.push(runStep("next-limitup:review", process.execPath, [
      scriptPath("next-limitup-review.mjs"),
      "--project",
      projectPath,
      "--write",
    ], { allowFailure: true }))
    steps.push(runStep("market:regime", process.execPath, [
      scriptPath("market-regime.mjs"),
      "--project",
      projectPath,
      "--write",
    ], { allowFailure: true }))
  }
  steps.push(runStep("ths:hotlist:import", process.execPath, [
    scriptPath("ths-hotlist-import.mjs"),
    "--project",
    projectPath,
    "--max-items",
    "100",
    "--write",
  ], { allowFailure: true }))
  steps.push(runStep("prediction:candidates", process.execPath, [
    scriptPath("prediction-candidates.mjs"),
    "--project",
    projectPath,
    "--since-days",
    "3",
    "--source-limit",
    "600",
    "--candidate-limit",
    "30",
    "--write",
  ], { allowFailure: true }))
  steps.push(runStep("catalyst:events", process.execPath, [
    scriptPath("catalyst-events.mjs"),
    "--project",
    projectPath,
    "--since-days",
    "3",
    "--source-limit",
    "700",
    "--max-events",
    "160",
    "--write",
  ], { allowFailure: true }))

  const preopenStep = runStep("preopen:intel", process.execPath, [
    scriptPath("preopen-intel.mjs"),
    "--project",
    projectPath,
    "--since-days",
    "3",
    "--source-limit",
    "500",
    "--core-limit",
    "10",
    "--write",
  ], { allowFailure: true })
  steps.push(preopenStep)

  if (profile === "full") {
    steps.push(runStep("ifind:enhance", process.execPath, [
      scriptPath("ifind-lowfreq-enhance.mjs"),
      "--project",
      projectPath,
      "--max-symbols",
      "8",
      "--news-limit",
      "3",
      "--days-back",
      "5",
      "--write",
    ], { allowFailure: true }))
  }

  const watchlistStep = runStep("market:watchlist", process.execPath, [
    scriptPath("market-watchlist.mjs"),
    "--project",
    projectPath,
    "--max-symbols",
    String(maxSymbols),
    "--write",
  ])
  steps.push(watchlistStep)

  const watchlist = JSON.parse(watchlistStep.stdoutRaw || watchlistStep.stdout || "{}").record ?? {}
  const symbols = watchlist.symbols ?? watchlist.tiers?.warroom?.map((item) => item.code) ?? []
  if (symbols.length === 0) throw new Error("market:watchlist produced no symbols")
  const symbolsText = symbols.slice(0, Number(maxSymbols)).join(",")
  const preopenRecord = parsePreopenWatchlist(preopenStep).record ?? {}
  const planTradeDate = normalizeTradeDate(
    preopenRecord.tradeDate
    ?? watchlist.planTradeDate
    ?? watchlist.tradeDate
    ?? tradeDate,
  ) ?? normalizeTradeDate(tradeDate)
  const evidenceTradeDate = normalizeTradeDate(
    watchlist.evidenceTradeDate
    ?? tradeDate,
  ) ?? normalizeTradeDate(tradeDate)
  const sourceTradeDates = {
    collectorRunDate: normalizeTradeDate(runDate),
    preopen: normalizeTradeDate(preopenRecord.tradeDate),
    marketWatchlistPlan: normalizeTradeDate(watchlist.planTradeDate ?? watchlist.tradeDate),
    marketWatchlistEvidence: normalizeTradeDate(watchlist.evidenceTradeDate),
  }
  const distinctTradeDates = [...new Set(Object.values(sourceTradeDates).filter(Boolean))]

  steps.push(await runInlineStep("tencent:market", async () => {
    const result = await fetchTencentInline(
      projectPath,
      evidenceTradeDate.replace(/-/g, ""),
      symbols.slice(0, Math.min(10, Number(maxSymbols))),
      { write: true },
    )
    return {
      tradeDate: evidenceTradeDate,
      symbols: symbols.slice(0, Math.min(10, Number(maxSymbols))),
      summary: result?.record?.summary ?? "",
    }
  }, { allowFailure: true }))

  steps.push(runStep("minute:bars", process.execPath, [
    scriptPath("minute-bars.mjs"),
    "sync",
    "--project",
    projectPath,
    "--trade-date",
    evidenceTradeDate,
    "--symbols",
    symbolsText,
    "--write",
  ], { allowFailure: true }))

  steps.push(runStep("stock:reasons", process.execPath, [
    scriptPath("stock-reason-cards.mjs"),
    "--project",
    projectPath,
    "--max-cards",
    "10",
    "--write",
  ], { allowFailure: true }))

  if (profile === "full") {
    steps.push(runStep("correction:alerts", process.execPath, [
      scriptPath("correction-alerts.mjs"),
      "--project",
      projectPath,
      "--write",
    ], { allowFailure: true }))
    steps.push(runStep("correction:push", process.execPath, [
      scriptPath("correction-push.mjs"),
      "--project",
      projectPath,
    ], { allowFailure: true }))
  }

  steps.push(runStep("archive:skeletons", process.execPath, [
    scriptPath("archive-skeletons.mjs"),
    "--project",
    projectPath,
    "--max-stocks",
    "120",
    "--max-themes",
    "80",
    "--write",
  ], { allowFailure: true }))

  steps.push(runStep("db:import-facts", npmBin(), [
    "run",
    "db:import-facts",
    "--",
    projectPath,
  ], { allowFailure: true }))

  steps.push(runStep("market:validate", process.execPath, [
    scriptPath("market-validate.mjs"),
    "--project",
    projectPath,
    "--trade-date",
    evidenceTradeDate,
    "--symbols",
    symbolsText,
    "--write",
  ], { allowFailure: true }))

  steps.push(runStep("postsell:validate", process.execPath, [
    scriptPath("post-sell-validation.mjs"),
    "--project",
    projectPath,
    "--trade-date",
    evidenceTradeDate,
    "--write",
  ], { allowFailure: true }))

  steps.push(runStep("db:import-validation", npmBin(), [
    "run",
    "db:import-facts",
    "--",
    projectPath,
  ], { allowFailure: true }))

  const hardFailures = steps.filter((step) => !step.ok && ["db:start", "market:watchlist"].includes(step.name))
  const softFailures = steps.filter((step) => !step.ok && !["db:start", "market:watchlist"].includes(step.name))
  const reportSteps = steps.map(({ stdoutRaw, ...step }) => step)
  return {
    ok: hardFailures.length === 0,
    skipped: false,
    startedAt,
    finishedAt: nowLocalTimestamp(),
    tradeDate: evidenceTradeDate,
    planTradeDate,
    evidenceTradeDate,
    sourceTradeDates,
    hasDateMismatch: distinctTradeDates.length > 1,
    label,
    profile,
    projectPath,
    focusSymbols: unique((parsePreopenWatchlist(preopenStep).focus ?? []).map((item) => ({
      code: item.code,
      name: item.name,
      score: item.score,
      role: item.role,
    }))).slice(0, 20),
    symbolCount: symbols.length,
    softFailureCount: softFailures.length,
    steps: reportSteps,
    summary: `label=${label} profile=${profile} symbols=${symbols.length} softFailures=${softFailures.length}`,
    postChecks: [
      `npm run audit:dates -- --project ${projectPath}`,
      `npm run execution:audit -- --project ${projectPath} --write`,
      `npm run execution:brief -- --project ${projectPath} --write`,
      `npm run system:health -- --project ${projectPath} --write`,
    ],
  }
}

function printHelp() {
  console.log(`Usage:
  npm run market:collect -- --project C:\\wiki\\73神话 --label 09:25 --profile full
  npm run market:collect -- --project C:\\wiki\\73神话 --label 09:31 --profile watchlist

Profiles:
  watchlist = watchlist + import
  emotion   = limit-up emotion + import
  full      = watchlist + emotion + import
`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  const projectPath = resolveProjectPath(args.project ?? args._[0])
  const label = args.label ?? args._[1] ?? "manual"
  const profile = args.profile ?? args._[2] ?? "watchlist"
  if (!["watchlist", "emotion", "full"].includes(profile)) throw new Error(`Unknown profile: ${profile}`)
  if (args._.includes("force")) args.force = true
  const maxSymbols = Number(args["max-symbols"] ?? args._[3] ?? 50)

  let report
  try {
    report = await runCollector({ projectPath, label, profile, maxSymbols, force: args.force })
  } catch (err) {
    report = {
      ok: false,
      skipped: false,
      startedAt: nowLocalTimestamp(),
      finishedAt: nowLocalTimestamp(),
      label,
      profile,
      projectPath,
      error: err?.message ?? String(err),
      failedStep: err?.step ?? null,
    }
  }

  const reportDir = path.join(projectPath, REPORT_ROOT)
  const reportPath = path.join(reportDir, `${idTimestamp()}-${label.replace(/[^0-9A-Za-z_-]/g, "") || "manual"}-${profile}.json`)
  const latestPath = path.join(reportDir, "latest-market-collect.json")
  writeJson(reportPath, report)
  writeJson(latestPath, report)
  console.log(JSON.stringify({
    ...report,
    reportPath,
    latestPath,
  }, null, 2))
  if (!report.ok) process.exit(1)
}

main()
