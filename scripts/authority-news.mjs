#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { TextDecoder } from "node:util"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const FACT_PATH = "data/facts/authority_policy_events.jsonl"
const REPORT_ROOT = ".llm-wiki/authority-news"
const CCTV_XWLB_URL = "https://tv.cctv.com/lm/xwlb/"
const USER_AGENT = "Mozilla/5.0 73WIKI authority news collector"

const THEME_KEYWORDS = [
  "人工智能", "AI", "算力", "数据中心", "机器人", "低空经济", "商业航天", "卫星", "军工",
  "半导体", "芯片", "集成电路", "PCB", "新能源", "储能", "光伏", "风电", "核电", "电力",
  "有色", "稀土", "黄金", "铜", "钼", "新材料", "化工", "涨价", "农业", "种业",
  "医药", "创新药", "消费", "汽车", "无人驾驶", "地产", "金融", "证券", "并购重组",
  "国企改革", "一带一路", "西部大开发", "数字经济", "信创", "网络安全",
]

const EVENT_KEYWORDS = [
  "政策", "会议", "国务院", "发改委", "工信部", "财政部", "商务部", "央行", "证监会",
  "印发", "发布", "实施", "推进", "支持", "试点", "规划", "行动方案", "意见",
  "突破", "首个", "首次", "重大", "加快", "高质量发展", "新质生产力",
]

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

function printHelp() {
  console.log(`Usage:
  npm run authority:news -- --project C:\\wiki\\73神话 --source all --write
  npm run authority:news -- C:\\wiki\\73神话 all write

Sources:
  cctv-xwlb      央视网《新闻联播》
  people-daily   人民日报电子版
  all            两者都抓
`)
}

function nowLocalTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function dateOnly(date = new Date()) {
  return nowLocalTimestamp(date).slice(0, 10)
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

function writeText(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, value, "utf8")
}

function htmlDecode(value) {
  return String(value ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
}

function stripHtml(value) {
  return htmlDecode(String(value ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/li>|<\/h\d>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim())
}

function uniq(values) {
  return [...new Set((values ?? []).filter(Boolean).map((item) => String(item)))]
}

function keywordHits(text, keywords) {
  return keywords.filter((word) => text.includes(word))
}

function scoreEvent(text, source) {
  let score = source === "cctv-xwlb" ? 82 : 78
  const eventHits = keywordHits(text, EVENT_KEYWORDS)
  const themeHits = keywordHits(text, THEME_KEYWORDS)
  score += Math.min(eventHits.length * 5, 25)
  score += Math.min(themeHits.length * 4, 24)
  if (/头版|头条|新闻联播|央视网消息/.test(text)) score += 8
  if (/社论|评论员文章|重要讲话|中央/.test(text)) score += 10
  return Math.min(100, score)
}

function classifyItem({ title, text, source, url }) {
  const body = `${title}\n${text}`
  const themes = keywordHits(body, THEME_KEYWORDS)
  const eventWords = keywordHits(body, EVENT_KEYWORDS)
  return {
    id: `auth_${source}_${shortHash(`${url}|${title}|${body.slice(0, 1000)}`)}`,
    source,
    sourceName: source === "cctv-xwlb" ? "央视网新闻联播" : "人民日报电子版",
    sourceUrl: url,
    title,
    themes,
    eventWords,
    signalLevel: scoreEvent(body, source) >= 92 ? "A" : scoreEvent(body, source) >= 84 ? "B" : "C",
    catalystScore: scoreEvent(body, source),
    summary: stripHtml(text).slice(0, 500),
  }
}

function absoluteUrl(baseUrl, href) {
  try {
    return new URL(href, baseUrl).toString()
  } catch {
    return href
  }
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const charset = response.headers.get("content-type")?.match(/charset=([^;\s]+)/i)?.[1]?.toLowerCase()
  const candidates = charset ? [charset, "utf-8", "gb18030"] : ["utf-8", "gb18030"]
  for (const encoding of candidates) {
    try {
      return new TextDecoder(encoding).decode(buffer)
    } catch {
      // Try the next decoder.
    }
  }
  return buffer.toString("utf8")
}

function parseCctvList(html) {
  const items = []
  const linkRegex = /<a[^>]+href=["']([^"']+VIDE[^"']+\.shtml)["'][^>]*>([\s\S]*?)<\/a>/gi
  for (const match of html.matchAll(linkRegex)) {
    const url = absoluteUrl(CCTV_XWLB_URL, match[1])
    const title = stripHtml(match[2]).replace(/^完整版\s*/, "").trim()
    if (!title || items.some((item) => item.url === url)) continue
    items.push({ title, url })
  }
  return items.slice(0, 30)
}

function parseCctvArticle(html) {
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
    .replace(/_CCTV节目官网-CCTV-13_央视网.*/, "")
    .trim()
  const updatedAt = stripHtml(html.match(/更新时间[:：]\s*([0-9年月日:\s]+)/)?.[1] ?? "")
  const main = html.match(/主要内容([\s\S]*?)编辑[:：]/)?.[1]
    ?? html.match(/视频简介([\s\S]*?)主要内容/)?.[1]
    ?? html
  const text = stripHtml(main)
  return { title, updatedAt, text }
}

function peopleDailyIndexUrl(tradeDate) {
  const [year, month, day] = tradeDate.split("-")
  return `http://paper.people.com.cn/rmrb/html/${year}-${month}/${day}/nbs.D110000renmrb_01.htm`
}

function parsePeopleLinks(html, baseUrl) {
  const links = []
  const regex = /<a[^>]+href=["']([^"']*nw\.D110000renmrb_[^"']+\.htm)["'][^>]*>([\s\S]*?)<\/a>/gi
  for (const match of html.matchAll(regex)) {
    const title = stripHtml(match[2])
    const url = absoluteUrl(baseUrl, match[1])
    if (!title || links.some((item) => item.url === url)) continue
    links.push({ title, url })
  }
  return links.slice(0, 80)
}

function parsePeopleArticle(html) {
  const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?? "")
    .replace(/--人民日报.*/, "")
    .trim()
  const textBlock = html.match(/<div[^>]+id=["']ozoom["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
    ?? html.match(/<div[^>]+class=["'][^"']*article[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
    ?? html
  const text = stripHtml(textBlock)
  return { title, text }
}

async function collectCctv({ maxItems }) {
  const listHtml = await fetchText(CCTV_XWLB_URL)
  const listItems = parseCctvList(listHtml).slice(0, Number(maxItems))
  const items = []
  for (const item of listItems) {
    try {
      const html = await fetchText(item.url)
      const article = parseCctvArticle(html)
      items.push({
        ...classifyItem({
          title: article.title || item.title,
          text: article.text,
          source: "cctv-xwlb",
          url: item.url,
        }),
        updatedAt: article.updatedAt,
        fullText: article.text,
      })
    } catch (err) {
      items.push({
        id: `auth_cctv-xwlb_error_${shortHash(item.url)}`,
        source: "cctv-xwlb",
        sourceName: "央视网新闻联播",
        sourceUrl: item.url,
        title: item.title,
        themes: [],
        eventWords: [],
        signalLevel: "C",
        catalystScore: 0,
        summary: "",
        error: err?.message ?? String(err),
      })
    }
  }
  return items
}

async function collectPeopleDaily({ tradeDate, maxItems }) {
  const indexUrl = peopleDailyIndexUrl(tradeDate)
  let indexHtml
  try {
    indexHtml = await fetchText(indexUrl)
  } catch (err) {
    return [{
      id: `auth_people-daily_index_error_${tradeDate.replace(/-/g, "")}`,
      source: "people-daily",
      sourceName: "人民日报电子版",
      sourceUrl: indexUrl,
      title: `${tradeDate} 人民日报电子版暂未抓到`,
      themes: [],
      eventWords: [],
      signalLevel: "C",
      catalystScore: 0,
      summary: "",
      error: err?.message ?? String(err),
    }]
  }
  const links = parsePeopleLinks(indexHtml, indexUrl).slice(0, Number(maxItems))
  const items = []
  for (const item of links) {
    try {
      const html = await fetchText(item.url)
      const article = parsePeopleArticle(html)
      items.push({
        ...classifyItem({
          title: article.title || item.title,
          text: article.text,
          source: "people-daily",
          url: item.url,
        }),
        fullText: article.text,
      })
    } catch (err) {
      items.push({
        id: `auth_people-daily_error_${shortHash(item.url)}`,
        source: "people-daily",
        sourceName: "人民日报电子版",
        sourceUrl: item.url,
        title: item.title,
        themes: [],
        eventWords: [],
        signalLevel: "C",
        catalystScore: 0,
        summary: "",
        error: err?.message ?? String(err),
      })
    }
  }
  return items
}

function markdownForSource({ title, generatedAt, sourceName, items }) {
  const lines = [
    `# ${title}`,
    "",
    `- 来源：${sourceName}`,
    `- 采集时间：${generatedAt}`,
    `- 事件数：${items.length}`,
    "- sourceTag：authority-policy",
    "",
    "## 高价值政策/题材信号",
    "",
  ]
  for (const item of items.sort((a, b) => b.catalystScore - a.catalystScore)) {
    lines.push(`### ${item.title}`)
    lines.push("")
    lines.push(`- 信号等级：${item.signalLevel}`)
    lines.push(`- 催化分：${item.catalystScore}`)
    lines.push(`- 题材词：${item.themes.join("、") || "未识别"}`)
    lines.push(`- 事件词：${item.eventWords.join("、") || "未识别"}`)
    lines.push(`- 原文：${item.sourceUrl}`)
    lines.push("")
    lines.push(item.fullText || item.summary || "")
    lines.push("")
  }
  return `${lines.join("\n").trim()}\n`
}

function buildRecord({ projectPath, tradeDate, generatedAt, source, items }) {
  const activeItems = items.filter((item) => !item.error)
  const topItems = activeItems
    .sort((a, b) => b.catalystScore - a.catalystScore)
    .slice(0, 12)
  const themes = uniq(activeItems.flatMap((item) => item.themes))
  const evidenceTradeDate = normalizeTradeDate(tradeDate)
  return {
    schema: "73wiki-authority-policy-events-v1",
    id: `authority_${source}_${tradeDate.replace(/-/g, "")}_${idTimestamp()}_${shortHash(items.map((item) => item.id).join(","))}`,
    status: "active",
    title: `${tradeDate} 央媒政策信号`,
    generatedAt,
    tradeDate,
    planTradeDate: evidenceTradeDate,
    evidenceTradeDate,
    sourceTradeDates: {
      authorityNews: evidenceTradeDate,
    },
    hasDateMismatch: false,
    source: "73wiki-authority-news",
    sourceTier: "authority_policy",
    sourceScope: source,
    items: activeItems.map(({ fullText, ...item }) => item),
    counts: {
      items: activeItems.length,
      errors: items.length - activeItems.length,
      signalA: activeItems.filter((item) => item.signalLevel === "A").length,
      signalB: activeItems.filter((item) => item.signalLevel === "B").length,
    },
    themes,
    summary: `央媒政策信号 ${activeItems.length} 条；A 级 ${activeItems.filter((item) => item.signalLevel === "A").length} 条；主题：${themes.slice(0, 12).join("、") || "未识别"}。`,
    claim: "新闻联播/人民日报用于盘前政策与权威叙事预判，不直接生成买入建议；需结合热榜、竞价、板块和个股强度验证。",
    tags: ["authority-policy", "新闻联播", "人民日报", "政策催化", "盘前预判"],
    projectPath: projectPath ? projectRelative(projectPath, projectPath) || "." : undefined,
    topItems: topItems.map((item) => ({
      title: item.title,
      sourceName: item.sourceName,
      signalLevel: item.signalLevel,
      catalystScore: item.catalystScore,
      themes: item.themes,
      sourceUrl: item.sourceUrl,
    })),
  }
}

async function runCollector({ projectPath, source, tradeDate, maxItems }) {
  const generatedAt = nowLocalTimestamp()
  const items = []
  if (source === "all" || source === "cctv-xwlb") {
    items.push(...await collectCctv({ maxItems }))
  }
  if (source === "all" || source === "people-daily") {
    items.push(...await collectPeopleDaily({ tradeDate, maxItems }))
  }
  return buildRecord({ projectPath, tradeDate, generatedAt, source, items })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (args._.includes("write")) args.write = true
  const projectPath = resolveProjectPath(args.project ?? args._[0])
  const source = args.source ?? args._[1] ?? "all"
  if (!["all", "cctv-xwlb", "people-daily"].includes(source)) throw new Error(`Unknown source: ${source}`)
  const tradeDate = args.date ?? dateOnly()
  const maxItems = Number(args["max-items"] ?? args._[2] ?? 20)
  const record = await runCollector({ projectPath, source, tradeDate, maxItems })

  const reportDir = path.join(projectPath, REPORT_ROOT)
  const reportPath = path.join(reportDir, `${idTimestamp()}-${source}.json`)
  const latestPath = path.join(reportDir, "latest-authority-news.json")
  const factPath = path.join(projectPath, FACT_PATH)

  const rawRoot = path.join(projectPath, "raw", "05-研报新闻", "央媒")
  const grouped = new Map()
  for (const item of record.items) {
    const key = item.source === "cctv-xwlb" ? "新闻联播" : "人民日报"
    const old = grouped.get(key) ?? []
    old.push(item)
    grouped.set(key, old)
  }

  const output = {
    dryRun: !args.write,
    record,
    writePaths: {
      facts: FACT_PATH,
      reportRoot: REPORT_ROOT,
      rawRoot: "raw/05-研报新闻/央媒",
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
      raw: [],
    }
    for (const [name, groupItems] of grouped) {
      const rawPath = path.join(rawRoot, name, tradeDate, `${tradeDate}-${name}-政策信号.md`)
      writeText(rawPath, markdownForSource({
        title: `${tradeDate} ${name}政策信号`,
        generatedAt: record.generatedAt,
        sourceName: name,
        items: groupItems,
      }))
      output.written.raw.push(projectRelative(projectPath, rawPath))
    }
  }

  console.log(JSON.stringify(output, null, 2))
}

main().catch((err) => {
  console.error(err?.stack ?? err?.message ?? String(err))
  process.exit(1)
})
