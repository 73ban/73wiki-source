#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const HYPOTHESES_PATH = "data/brain/hypotheses.jsonl"
const VALIDATIONS_PATH = "data/brain/validations.jsonl"
const OUTPUT_PATH = "data/training/lora_samples.jsonl"
const REPORT_ROOT = ".llm-wiki/training-lora"

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["write", "json", "help"].includes(key)) {
      args[key] = true
      continue
    }
    const value = argv[index + 1]
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${key}`)
    args[key] = value
    index += 1
  }
  return args
}

function nowLocalTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0")
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

function writeJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8")
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return { rows: [], parseErrors: [] }
  const rows = []
  const parseErrors = []
  for (const [index, line] of fs.readFileSync(filePath, "utf8").split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch (error) {
      parseErrors.push({ line: index + 1, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { rows, parseErrors }
}

function normalizeTradeDate(value) {
  const text = String(value ?? "").trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const match = text.match(/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function toArray(value) {
  return Array.isArray(value) ? value : []
}

function latestValidationsByTarget(validations) {
  const byTarget = new Map()
  for (const row of validations) {
    if (!row?.targetId) continue
    const previous = byTarget.get(row.targetId)
    const previousDate = normalizeTradeDate(previous?.dataHorizonTradeDate ?? previous?.createdAt) ?? ""
    const currentDate = normalizeTradeDate(row?.dataHorizonTradeDate ?? row?.createdAt) ?? ""
    if (!previous || currentDate.localeCompare(previousDate) >= 0) byTarget.set(row.targetId, row)
  }
  return byTarget
}

function compactEvidence(evidence) {
  return toArray(evidence).slice(0, 8).map((item) => ({
    file: item.file ?? null,
    sourceTag: item.sourceTag ?? null,
    excerpt: String(item.excerpt ?? "").replace(/\s+/g, " ").slice(0, 360),
    positiveHits: item.positiveHits ?? [],
    riskHits: item.riskHits ?? [],
    themeHits: item.themeHits ?? [],
  }))
}

function checkpointOutcome(validation) {
  const checkpoints = validation?.checkpoints ?? {}
  const values = Object.entries(checkpoints).map(([key, value]) => ({
    key,
    status: value?.status ?? (value?.available === false ? "data_gap" : null),
    closeGainPct: value?.closeGainPct ?? null,
    maxHighGainPct: value?.maxHighGainPct ?? null,
    sameDayCloseGainPct: value?.sameDayCloseGainPct ?? null,
    sameDayHighGainPct: value?.sameDayHighGainPct ?? null,
  }))
  const gains = values.flatMap((item) => [item.closeGainPct, item.maxHighGainPct]).filter((value) => Number.isFinite(Number(value))).map(Number)
  const bestGain = gains.length ? Math.max(...gains) : null
  const finalGain = values.length ? values[values.length - 1].closeGainPct : null
  return { values, bestGain, finalGain }
}

function resultLabel(hypothesis, validation) {
  if (!validation) return "unvalidated"
  if (validation.result === "data_gap") return "data_gap"
  if (validation.result === "success") return "validated_success"
  const outcome = checkpointOutcome(validation)
  if (Number(outcome.bestGain) >= 8) return "validated_success"
  if (Number(outcome.finalGain) <= -5) return "failed_or_risk"
  return "neutral"
}

function buildSample(hypothesis, validation) {
  const outcome = checkpointOutcome(validation)
  const label = resultLabel(hypothesis, validation)
  const code = hypothesis.code ?? validation?.code ?? null
  const name = hypothesis.name ?? validation?.name ?? null
  const instruction = "根据当时的交易证据、市场假设和风险词，判断该标的是否应进入观察/作战计划，并给出验证口径。"
  const input = {
    tradeDate: normalizeTradeDate(hypothesis.tradeDate),
    code,
    name,
    rank: hypothesis.rank ?? null,
    hypothesis: hypothesis.hypothesis?.hypothesis ?? hypothesis.hypothesis ?? null,
    tradeReason: hypothesis.hypothesis?.tradeReason ?? null,
    validationPlan: hypothesis.hypothesis?.validation ?? null,
    evidence: compactEvidence(hypothesis.evidence),
    sourceRecordId: hypothesis.sourceRecordId ?? null,
  }
  const output = {
    decision: hypothesis.hypothesis?.tradeReason ?? "进入候选观察，必须等待竞价、分时、板块强度和风险复核。",
    reasoning: hypothesis.hypothesis?.hypothesis ?? null,
    riskControl: "不是直接买入建议；必须二次确认，失败样本回填训练集。",
    validationPlan: hypothesis.hypothesis?.validation ?? null,
  }
  return {
    schema: "73wiki-lora-sample-v1",
    id: `lora_${shortHash(`${hypothesis.id}:${validation?.id ?? "none"}`)}`,
    sourceHypothesisId: hypothesis.id ?? null,
    sourceValidationId: validation?.id ?? null,
    instruction,
    input,
    output,
    label: {
      result: label,
      validationResult: validation?.result ?? null,
      dueCheckpoints: validation?.dueCheckpoints ?? [],
      completedCheckpoints: validation?.completedCheckpoints ?? [],
      bestGainPct: outcome.bestGain,
      finalGainPct: outcome.finalGain,
      checkpointOutcomes: outcome.values,
    },
    metadata: {
      createdAt: nowLocalTimestamp(),
      dataHorizonTradeDate: validation?.dataHorizonTradeDate ?? null,
      tags: ["73wiki", "trading-hypothesis", "lora-ready", label],
    },
  }
}

function buildReport(projectPath, samples, diagnostics) {
  const countsByLabel = samples.reduce((acc, sample) => {
    const key = sample.label.result
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  return {
    schema: "73wiki-training-lora-report-v1",
    id: `training_lora_${idTimestamp()}_${shortHash(samples.length)}`,
    status: "active",
    generatedAt: nowLocalTimestamp(),
    projectPath,
    outputPath: OUTPUT_PATH,
    counts: {
      samples: samples.length,
      byLabel: countsByLabel,
      hypothesisParseErrors: diagnostics.hypothesisParseErrors.length,
      validationParseErrors: diagnostics.validationParseErrors.length,
    },
    writePolicy: {
      rawWrite: false,
      wikiWrite: false,
      datasetWrite: true,
    },
  }
}

function buildMarkdown(report) {
  const labels = Object.entries(report.counts.byLabel).map(([key, value]) => `- ${key}: ${value}`).join("\n") || "- 无"
  return `# LoRA-ready Training Dataset\n\n生成时间：${report.generatedAt}\n\n## 输出\n\n- ${report.outputPath}\n\n## 样本\n\n- 总数：${report.counts.samples}\n\n${labels}\n\n## 边界\n\n- 只从已存在账本抽样，不生成新交易建议。\n- 不写 raw/**，不写正式 wiki 页面。\n- 当前是 LoRA-ready 格式，不自动启动训练。\n`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/training-lora.mjs --project C:/wiki/73神话 --write")
    return
  }
  const projectPath = path.resolve(args.project ?? DEFAULT_PROJECT_PATH)
  const hypotheses = readJsonl(path.join(projectPath, HYPOTHESES_PATH))
  const validations = readJsonl(path.join(projectPath, VALIDATIONS_PATH))
  const validationsByTarget = latestValidationsByTarget(validations.rows)
  const samples = hypotheses.rows
    .filter((row) => row?.id && validationsByTarget.has(row.id))
    .map((row) => buildSample(row, validationsByTarget.get(row.id)))
    .sort((a, b) => String(a.input.tradeDate ?? "").localeCompare(String(b.input.tradeDate ?? "")) || a.id.localeCompare(b.id))
  const report = buildReport(projectPath, samples, {
    hypothesisParseErrors: hypotheses.parseErrors,
    validationParseErrors: validations.parseErrors,
  })
  if (args.write) {
    writeJsonl(path.join(projectPath, OUTPUT_PATH), samples)
    const stamp = idTimestamp()
    const outDir = path.join(projectPath, REPORT_ROOT)
    writeJson(path.join(outDir, `${stamp}-training-lora-report.json`), report)
    writeText(path.join(outDir, `${stamp}-training-lora-report.md`), buildMarkdown(report))
    writeJson(path.join(outDir, "latest-training-lora-report.json"), report)
    writeText(path.join(outDir, "latest-training-lora-report.md"), buildMarkdown(report))
  }
  if (args.json || !args.write) console.log(JSON.stringify({ report, samples: samples.slice(0, 5) }, null, 2))
  else console.log(`[training-lora] samples=${samples.length} output=${OUTPUT_PATH}`)
}

main()
