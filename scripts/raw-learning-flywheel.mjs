#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const REPORT_ROOT = ".llm-wiki/raw-learning-flywheel"
const SAMPLES_PATH = "data/training/raw_learning_samples.jsonl"
const ERRORS_PATH = "data/training/raw_learning_errors.jsonl"
const ERROR_WIKI_ROOT = "wiki/05-错误库/RAW学习错误库"

const POSITIVE_TERMS = ["涨停", "连板", "突破", "核心", "主线", "催化", "新高", "回封", "强势", "赚钱效应", "验证通过", "买点", "趋势", "放量", "共振"]
const RISK_TERMS = ["跌停", "炸板", "亏损", "风险", "补跌", "兑现", "杀跌", "监管", "退潮", "背离", "高位", "分歧", "违约", "大面", "低于预期"]

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["write", "help", "json"].includes(key)) {
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

function shortHash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 12)
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function writeText(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, value, "utf8")
}

function appendJsonl(filePath, rows) {
  if (!rows.length) return
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8")
}

function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function readTextMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return fs.readFileSync(filePath, "utf8")
  } catch {
    return null
  }
}

function walkFiles(dirPath, limit = 500) {
  if (!fs.existsSync(dirPath)) return []
  const stack = [dirPath]
  const out = []
  while (stack.length && out.length < limit) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) out.push(full)
      if (out.length >= limit) break
    }
  }
  return out
}

function compactText(value, max = 420) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max)
}

function extractCodes(text) {
  return [...new Set(String(text ?? "").match(/\b(?:00|30|60|68|83|87|92)\d{4}\b/g) ?? [])]
}

function countTerms(text, terms) {
  const clean = String(text ?? "")
  return terms.reduce((sum, term) => sum + (clean.includes(term) ? 1 : 0), 0)
}

function parseTitle(text, filePath) {
  const firstHeading = String(text ?? "").match(/^#\s+(.+)$/m)
  if (firstHeading) return firstHeading[1].trim()
  return path.basename(filePath, path.extname(filePath))
}

function extractExcerpts(text, terms, limit = 3) {
  const lines = String(text ?? "").split(/\r?\n/)
  const matches = []
  for (const line of lines) {
    if (!terms.some((term) => line.includes(term))) continue
    const excerpt = compactText(line, 220)
    if (excerpt) matches.push(excerpt)
    if (matches.length >= limit) break
  }
  return matches
}

function buildSample({ filePath, text, recentDays, focusHits }) {
  const title = parseTitle(text, filePath)
  const codes = extractCodes(text)
  const positiveHits = countTerms(text, POSITIVE_TERMS)
  const riskHits = countTerms(text, RISK_TERMS)
  const evidence = extractExcerpts(text, [...POSITIVE_TERMS, ...RISK_TERMS], 4)
  const instruction = "根据RAW原文和当时市场环境，判断这是连板、趋势、套利、观察还是风险样本，并给出可复用的标注规则。"
  const outputLabel = riskHits > positiveHits ? "risk_pattern" : positiveHits >= 3 ? "opportunity_pattern" : "observe_pattern"
  return {
    schema: "73wiki-raw-learning-sample-v1",
    id: `raw_learning_${shortHash(`${filePath}:${title}`)}`,
    sourceFile: path.basename(filePath),
    sourcePath: filePath,
    title,
    instruction,
    input: {
      recentDays,
      title,
      codes,
      focusHits,
      evidence,
      rawText: compactText(text, 900),
    },
    output: {
      label: outputLabel,
      reasoning: positiveHits >= riskHits
        ? "原文偏向可交易信号，适合作为机会样本。"
        : "原文更偏风险提示，应进入错误库或风险样本。",
      lesson: outputLabel === "risk_pattern"
        ? "后续需要在同主题重复出现前先降低权重并要求盘中确认。"
        : "后续同类证据可继续累积，但必须和盘中强度一起验证。",
    },
    label: {
      result: outputLabel,
      positiveHits,
      riskHits,
      codeCount: codes.length,
    },
    metadata: {
      createdAt: nowLocalTimestamp(),
      tags: ["73wiki", "raw", "learning-flywheel", outputLabel],
    },
  }
}

function buildErrorItem(sample) {
  return {
    schema: "73wiki-raw-learning-error-v1",
    id: `raw_error_${shortHash(sample.id)}`,
    title: sample.title,
    sourcePath: sample.sourcePath,
    label: sample.label.result,
    positiveHits: sample.label.positiveHits,
    riskHits: sample.label.riskHits,
    lesson: sample.output.lesson,
    excerpt: sample.input.evidence.join(" / "),
    generatedAt: nowLocalTimestamp(),
  }
}

function buildWikiPage(item) {
  return `# ${item.title}

- 来源：${item.sourcePath}
- 标签：${item.label}
- 正向词命中：${item.positiveHits}
- 风险词命中：${item.riskHits}

## 结论

${item.lesson}

## 证据

${item.excerpt || "-"}
`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/raw-learning-flywheel.mjs --project <wiki-root> --write")
    return
  }

  const projectPath = path.resolve(args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH)
  const sinceDays = Number(args["since-days"] ?? 10)
  const limit = Number(args.limit ?? 200)
  const rawRoot = path.join(projectPath, "raw")
  const focusUniverse = readJsonMaybe(path.join(projectPath, ".llm-wiki/market-focus-universe/latest-market-focus-universe.json"))
  const focusCodes = new Set((focusUniverse?.items ?? []).slice(0, 120).map((item) => String(item.code ?? "")))
  const files = walkFiles(rawRoot, 800)
    .filter((filePath) => {
      const stat = fs.statSync(filePath)
      const ageDays = (Date.now() - stat.mtimeMs) / 86400000
      return ageDays <= sinceDays
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, limit)

  const samples = []
  const errors = []
  for (const filePath of files) {
    const text = readTextMaybe(filePath)
    if (!text) continue
    const sample = buildSample({
      filePath,
      text,
      recentDays: sinceDays,
      focusHits: extractCodes(text).filter((code) => focusCodes.has(code)).slice(0, 12),
    })
    samples.push(sample)
    if (sample.label.result === "risk_pattern") errors.push(buildErrorItem(sample))
  }

  const report = {
    schema: "73wiki-raw-learning-flywheel-v1",
    id: `raw_learning_flywheel_${idTimestamp()}_${shortHash(`${samples.length}:${errors.length}`)}`,
    status: "active",
    generatedAt: nowLocalTimestamp(),
    projectPath,
    recentDays: sinceDays,
    counts: {
      files: files.length,
      samples: samples.length,
      errors: errors.length,
      opportunity: samples.filter((item) => item.label.result === "opportunity_pattern").length,
      observe: samples.filter((item) => item.label.result === "observe_pattern").length,
      risk: samples.filter((item) => item.label.result === "risk_pattern").length,
    },
    writePolicy: {
      rawWrite: false,
      wikiWrite: true,
      datasetWrite: true,
    },
  }

  if (args.write) {
    appendJsonl(path.join(projectPath, SAMPLES_PATH), samples)
    appendJsonl(path.join(projectPath, ERRORS_PATH), errors)
    const errorWikiDir = path.join(projectPath, ERROR_WIKI_ROOT)
    ensureDir(errorWikiDir)
    for (const item of errors.slice(0, 25)) {
      writeText(path.join(errorWikiDir, `${item.id}.md`), buildWikiPage(item))
    }
    const stamp = idTimestamp()
    const outDir = path.join(projectPath, REPORT_ROOT)
    writeJson(path.join(outDir, `${stamp}-raw-learning-flywheel.json`), report)
    writeText(path.join(outDir, `${stamp}-raw-learning-flywheel.md`), JSON.stringify(report, null, 2))
    writeJson(path.join(outDir, "latest-raw-learning-flywheel.json"), report)
    writeText(path.join(outDir, "latest-raw-learning-flywheel.md"), JSON.stringify(report, null, 2))
  }

  const output = {
    dryRun: !args.write,
    report,
    samplePreview: samples.slice(0, 5).map((item) => ({
      id: item.id,
      label: item.label.result,
      title: item.title,
      codes: item.input.codes,
    })),
  }
  console.log(JSON.stringify(output, null, 2))
}

main()
