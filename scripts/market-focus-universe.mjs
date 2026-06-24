#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { sanitizeList } from "./signal-quality.mjs"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73wiki"
const REPORT_ROOT = ".llm-wiki/market-focus-universe"
const FACT_PATH = "data/facts/market_focus_universe.jsonl"

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["write", "json", "help", "include-stale-tdx"].includes(key)) {
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
  const pad = (value) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function dateOnly(date = new Date()) {
  return nowLocalTimestamp(date).slice(0, 10)
}

function idTimestamp(date = new Date()) {
  return nowLocalTimestamp(date).replace(/[-: ]/g, "")
}

function shortHash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 12)
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function codeBase(value) {
  return String(value ?? "").replace(/\.(SH|SZ|BJ)$/i, "").replace(/\D/g, "").padStart(6, "0").slice(-6)
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean))]
}

function round(value, digits = 2) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  const factor = 10 ** digits
  return Math.round(n * factor) / factor
}

function projectRelative(projectPath, targetPath) {
  return path.relative(path.resolve(projectPath), path.resolve(targetPath)).replace(/\\/g, "/")
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function recordAgeHours(record) {
  const timestamp = record?.generatedAt ?? record?.observedAt ?? null
  if (!timestamp) return null
  const date = new Date(String(timestamp).replace(" ", "T"))
  if (Number.isNaN(date.getTime())) return null
  return Math.round(((Date.now() - date.getTime()) / 3600000) * 10) / 10
}

function isFreshRecord(record, maxAgeHours) {
  if (!record) return false
  const ageHours = recordAgeHours(record)
  if (ageHours == null) return false
  return ageHours <= Number(maxAgeHours)
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function writeText(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, value, "utf8")
}

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
}

function latestArtifacts(projectPath) {
  const llm = path.join(projectPath, ".llm-wiki")
  return {
    marketStrength: readJsonMaybe(path.join(llm, "market-strength-rank", "latest-market-strength-rank.json")),
    thsHotlist: readJsonMaybe(path.join(llm, "ths-hotlist", "latest-ths-hotlist.json")),
    tdxHotlist: readJsonMaybe(path.join(llm, "tdx-hotlist", "latest-tdx-hotlist.json")),
    prediction: readJsonMaybe(path.join(llm, "prediction-candidates", "latest-prediction-candidates.json")),
    emotion: readJsonMaybe(path.join(llm, "akshare-emotion", "latest-shortline-emotion.json")),
    watchlist: readJsonMaybe(path.join(llm, "market-watchlist", "latest-warroom-watchlist.json")),
    marketRegime: readJsonMaybe(path.join(llm, "market-regime", "latest-market-regime.json")),
  }
}

function emptyEntry(code, name = "") {
  return {
    code: codeBase(code),
    name,
    score: 0,
    sources: [],
    sourceRanks: {},
    reasons: [],
    themes: [],
    metrics: {},
  }
}

function addEntry(map, input) {
  const code = codeBase(input.code)
  if (!/^\d{6}$/.test(code) || code === "000000") return
  const current = map.get(code) ?? emptyEntry(code, input.name)
  current.name = current.name || input.name || ""
  current.score += Number(input.score ?? 0)
  current.sources = unique([...current.sources, input.source])
  if (input.source && input.rank != null) current.sourceRanks[input.source] = input.rank
  current.reasons = sanitizeList(unique([...current.reasons, ...(input.reasons ?? [])]), 12)
  current.themes = unique([...current.themes, ...(input.themes ?? [])]).slice(0, 12)
  current.metrics = { ...current.metrics, ...(input.metrics ?? {}) }
  map.set(code, current)
}

function addMarketStrength(map, marketStrength, options) {
  for (const row of marketStrength?.rows ?? []) {
    const dailyRank = Number(row.fullMarketDailyRank ?? 999999)
    const amountRank = Number(row.amountRank ?? 999999)
    const change = Number(row.changePercent ?? 0)
    if (dailyRank <= Number(options.dailyTop ?? 300)) {
      addEntry(map, {
        code: row.code,
        name: row.name,
        source: "full-market-daily-top",
        rank: dailyRank,
        score: Math.max(20, 260 - dailyRank * 0.35),
        reasons: [`全市场D1涨幅第${dailyRank}`],
        metrics: {
          fullMarketDailyRank: dailyRank,
          fullMarketDailyChangePercent: row.changePercent,
          amountRank,
        },
      })
    }
    if (amountRank <= Number(options.amountTop ?? 200)) {
      addEntry(map, {
        code: row.code,
        name: row.name,
        source: "amount-top",
        rank: amountRank,
        score: Math.max(40, 240 - amountRank * 0.55),
        reasons: [`成交额全市场第${amountRank}`],
        metrics: {
          amountRank,
          amount: row.amount,
          fullMarketDailyRank: dailyRank,
          fullMarketDailyChangePercent: row.changePercent,
        },
      })
    }
    if (change >= 5) {
      addEntry(map, {
        code: row.code,
        name: row.name,
        source: "daily-up5",
        rank: dailyRank,
        score: 40 + Math.min(80, change * 4),
        reasons: [`当日涨幅${round(change)}%`],
        metrics: {
          fullMarketDailyRank: dailyRank,
          fullMarketDailyChangePercent: row.changePercent,
        },
      })
    }
  }
}

function addThsHotlist(map, thsHotlist, limit) {
  for (const row of (thsHotlist?.rows ?? []).slice(0, Number(limit ?? 100))) {
    addEntry(map, {
      code: row.code,
      name: row.name,
      source: "ths-hotlist",
      rank: row.rank,
      score: Math.max(40, 260 - Number(row.rank ?? 99) * 1.8),
      reasons: [`同花顺热榜第${row.rank}`],
      metrics: {
        thsRank: row.rank,
        thsChangePercent: row.changePercent,
        thsTurnover: row.turnover,
      },
    })
  }
}

function addTdxHotlist(map, tdxHotlist, limit) {
  for (const row of (tdxHotlist?.rows ?? []).slice(0, Number(limit ?? 100))) {
    const rank = Number(row.POS ?? row.rank ?? 999)
    addEntry(map, {
      code: row.sec_code ?? row.code,
      name: row.sec_name ?? row.name,
      source: "tdx-hotlist",
      rank,
      score: Math.max(40, 250 - rank * 1.7),
      reasons: [`通达信热股榜第${rank}`],
      themes: String(row["所属行业"] ?? "").split("@").filter(Boolean),
      metrics: {
        tdxRank: rank,
        tdxChangePercent: row.chg,
      },
    })
  }
}

function addPrediction(map, prediction, limit) {
  for (const row of (prediction?.candidates ?? []).slice(0, Number(limit ?? 60))) {
    addEntry(map, {
      code: row.code,
      name: row.name,
      source: "raw-prediction-candidate",
      rank: row.rank,
      score: Math.max(50, Number(row.score ?? 0) * 0.22 + Math.max(0, 80 - Number(row.rank ?? 99))),
      reasons: [`RAW/盘前候选第${row.rank}`, ...(row.reasons ?? []).slice(0, 3)],
      themes: row.themes ?? [],
      metrics: {
        predictionRank: row.rank,
        predictionScore: row.score,
        predictionTradeability: row.nextDayTradeability,
      },
    })
  }
}

function addEmotionPools(map, emotion) {
  const pools = emotion?.pools ?? {}
  for (const [poolName, rows] of Object.entries(pools)) {
    if (!Array.isArray(rows)) continue
    const source = `akshare-${poolName}`
    for (const [index, row] of rows.entries()) {
      const code = row["代码"] ?? row.code
      const name = row["名称"] ?? row.name
      const rank = index + 1
      const scoreBase = poolName === "limit_up" ? 260 : poolName === "strong" ? 220 : poolName === "previous_limit_up" ? 180 : poolName === "burst" ? 80 : 60
      addEntry(map, {
        code,
        name,
        source,
        rank,
        score: Math.max(20, scoreBase - rank * 0.8),
        reasons: [`AKShare ${poolName} 第${rank}`, row["涨停统计"] ? `涨停统计${row["涨停统计"]}` : ""],
        themes: [row["所属行业"] ?? row.industry].filter(Boolean),
        metrics: {
          [`${poolName}Rank`]: rank,
          limitUpHeight: row["连板数"] ?? row["昨日连板数"] ?? null,
          firstLimitTime: row["首次封板时间"] ?? "",
          burstCount: row["炸板次数"] ?? "",
        },
      })
    }
  }
}

function addWatchlist(map, watchlist) {
  const tiers = watchlist?.tiers ?? {}
  for (const [tier, rows] of Object.entries(tiers)) {
    if (!Array.isArray(rows)) continue
    for (const [index, row] of rows.entries()) {
      addEntry(map, {
        code: row.code,
        name: row.name,
        source: `warroom-${tier}`,
        rank: row.priorityRank ?? index + 1,
        score: tier === "focus" ? 220 : tier === "warroom" ? 180 : 120,
        reasons: [`作战室${tier}池`],
        themes: row.themes ?? [],
        metrics: {
          warroomTier: tier,
          warroomScore: row.score,
        },
      })
    }
  }
}

function preferredPlaybooks(regime) {
  const mode = regime?.mode ?? "unknown"
  if (mode === "attack") return ["limit_board", "overnight_arbitrage", "trend_leader"]
  if (mode === "mixed") return ["trend_leader", "limit_board", "overnight_arbitrage"]
  if (mode === "selective") return ["trend_leader", "swing_profit"]
  if (mode === "defensive") return ["swing_profit", "trend_leader"]
  return ["trend_leader", "limit_board", "overnight_arbitrage", "swing_profit"]
}

function inferRole(item, regime) {
  const sources = new Set(item.sources)
  if (sources.has("akshare-limit_up") || sources.has("akshare-previous_limit_up")) return "limit-board-candidate"
  if (sources.has("amount-top") && (sources.has("ths-hotlist") || sources.has("tdx-hotlist") || sources.has("raw-prediction-candidate"))) return "trend-core-candidate"
  if (Number(item.metrics.amountRank ?? 999999) <= 200 && Number(item.metrics.fullMarketDailyRank ?? 999999) <= 600) return "trend-core-candidate"
  if (sources.has("ths-hotlist") || sources.has("tdx-hotlist")) return "hotlist-arbitrage-candidate"
  if (sources.has("raw-prediction-candidate")) return "raw-catalyst-candidate"
  if (regime?.mode === "defensive" && Number(item.metrics.amountRank ?? 999999) <= 100) return "liquidity-shelter"
  return "observe"
}

function buildUniverse(projectPath, options = {}) {
  const artifacts = latestArtifacts(projectPath)
  const tdxHotlist = options.includeStaleTdx
    ? artifacts.tdxHotlist
    : isFreshRecord(artifacts.tdxHotlist, options.maxTdxAgeHours ?? 48) ? artifacts.tdxHotlist : null
  const map = new Map()
  addMarketStrength(map, artifacts.marketStrength, options)
  addThsHotlist(map, artifacts.thsHotlist, options.hotlistLimit ?? 100)
  addTdxHotlist(map, tdxHotlist, options.hotlistLimit ?? 100)
  addPrediction(map, artifacts.prediction, options.predictionLimit ?? 80)
  addEmotionPools(map, artifacts.emotion)
  addWatchlist(map, artifacts.watchlist)

  const regime = artifacts.marketRegime?.status === "active" ? artifacts.marketRegime : null
  const preferred = preferredPlaybooks(regime)
  const items = [...map.values()]
    .map((item) => {
      const sourceCount = item.sources.length
      const role = inferRole(item, regime)
      const roleBonus = role === "trend-core-candidate" ? 80 : role === "limit-board-candidate" ? 70 : role === "hotlist-arbitrage-candidate" ? 45 : role === "raw-catalyst-candidate" ? 35 : 0
      return {
        ...item,
        score: round(item.score + sourceCount * 18 + roleBonus),
        sourceCount,
        role,
        preferredPlaybooks: preferred,
      }
    })
    .sort((a, b) => b.score - a.score || b.sourceCount - a.sourceCount || Number(a.metrics.amountRank ?? 999999) - Number(b.metrics.amountRank ?? 999999) || a.code.localeCompare(b.code))
    .slice(0, Number(options.limit ?? 500))
    .map((item, index) => ({ ...item, focusRank: index + 1 }))

  const generatedAt = nowLocalTimestamp()
  const evidenceTradeDate = normalizeTradeDate(artifacts.marketStrength?.evidenceTradeDate ?? artifacts.prediction?.evidenceTradeDate ?? artifacts.thsHotlist?.evidenceTradeDate) ?? dateOnly()
  return {
    schema: "73wiki-market-focus-universe-v1",
    id: `market_focus_${evidenceTradeDate.replace(/-/g, "")}_${idTimestamp()}_${shortHash(items.map((item) => `${item.code}:${item.score}`).join("|"))}`,
    status: "active",
    generatedAt,
    projectPath,
    evidenceTradeDate,
    marketRegime: regime ? {
      id: regime.id,
      mode: regime.mode,
      riskLevel: regime.riskLevel,
      profitEffectScore: regime.profitEffectScore,
      preferredPlaybooks: preferred,
    } : null,
    counts: {
      items: items.length,
      trendCore: items.filter((item) => item.role === "trend-core-candidate").length,
      limitBoard: items.filter((item) => item.role === "limit-board-candidate").length,
      hotlistArbitrage: items.filter((item) => item.role === "hotlist-arbitrage-candidate").length,
      rawCatalyst: items.filter((item) => item.role === "raw-catalyst-candidate").length,
    },
    sources: {
      marketStrength: artifacts.marketStrength?.id ?? null,
      thsHotlist: artifacts.thsHotlist?.id ?? null,
      tdxHotlist: tdxHotlist?.id ?? null,
      tdxHotlistSkipped: artifacts.tdxHotlist && !tdxHotlist ? {
        id: artifacts.tdxHotlist.id ?? null,
        reason: "stale_or_missing_timestamp",
        ageHours: recordAgeHours(artifacts.tdxHotlist),
      } : null,
      prediction: artifacts.prediction?.id ?? null,
      emotion: artifacts.emotion?.id ?? null,
      watchlist: artifacts.watchlist?.id ?? null,
    },
    items,
    summary: `focus universe items=${items.length}, regime=${regime?.mode ?? "unknown"}, trendCore=${items.filter((item) => item.role === "trend-core-candidate").length}, limitBoard=${items.filter((item) => item.role === "limit-board-candidate").length}`,
    claim: "Focus universe merges hotlists, RAW signals, turnover leaders, daily strength, limit-up pools, and warroom pools. It is not buy advice.",
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      buyAdvice: false,
    },
  }
}

function markdown(record) {
  const lines = [
    "# Market Focus Universe",
    "",
    `Generated: ${record.generatedAt}`,
    `Evidence trade date: ${record.evidenceTradeDate}`,
    `Regime: ${record.marketRegime?.mode ?? "unknown"}`,
    `Preferred playbooks: ${(record.marketRegime?.preferredPlaybooks ?? []).join(", ") || "unknown"}`,
    `Items: ${record.counts.items}`,
    "",
    "## Top Focus",
    "",
  ]
  for (const item of record.items.slice(0, 80)) {
    lines.push(`- ${item.focusRank}. ${item.name || item.code}(${item.code}) score=${item.score} role=${item.role} sources=${item.sources.join("/")}; amountRank=${item.metrics.amountRank ?? "-"} d1Rank=${item.metrics.fullMarketDailyRank ?? "-"} reasons=${item.reasons.slice(0, 3).join(" / ")}`)
  }
  lines.push("", "This is a tracking universe, not buy advice.")
  return `${lines.join("\n").trim()}\n`
}

function run(options = {}) {
  const projectPath = path.resolve(options.projectPath ?? DEFAULT_PROJECT_PATH)
  const record = buildUniverse(projectPath, options)
  if (options.write) {
    const stamp = idTimestamp()
    const outDir = path.join(projectPath, REPORT_ROOT)
    const latestJson = path.join(outDir, "latest-market-focus-universe.json")
    const latestMd = path.join(outDir, "latest-market-focus-universe.md")
    writeJson(path.join(outDir, `${stamp}-market-focus-universe.json`), record)
    writeJson(latestJson, record)
    writeText(path.join(outDir, `${stamp}-market-focus-universe.md`), markdown(record))
    writeText(latestMd, markdown(record))
    appendJsonl(path.join(projectPath, FACT_PATH), record)
    return {
      dryRun: false,
      record,
      written: {
        facts: FACT_PATH,
        latest: projectRelative(projectPath, latestJson),
        markdown: projectRelative(projectPath, latestMd),
      },
    }
  }
  return { dryRun: true, record }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/market-focus-universe.mjs --project <wiki-root> --limit 500 --write [--include-stale-tdx]")
    return
  }
  const result = run({
    projectPath: args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH,
    limit: Number(args.limit ?? 500),
    dailyTop: Number(args["daily-top"] ?? 300),
    amountTop: Number(args["amount-top"] ?? 200),
    hotlistLimit: Number(args["hotlist-limit"] ?? 100),
    predictionLimit: Number(args["prediction-limit"] ?? 80),
    maxTdxAgeHours: Number(args["max-tdx-age-hours"] ?? 48),
    includeStaleTdx: Boolean(args["include-stale-tdx"]),
    write: Boolean(args.write || args._.includes("write")),
  })
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(JSON.stringify({
      dryRun: result.dryRun,
      id: result.record.id,
      evidenceTradeDate: result.record.evidenceTradeDate,
      counts: result.record.counts,
      top: result.record.items.slice(0, 15).map((item) => ({
        rank: item.focusRank,
        code: item.code,
        name: item.name,
        score: item.score,
        role: item.role,
        sources: item.sources,
      })),
      written: result.written ?? null,
    }, null, 2))
  }
}

main()
