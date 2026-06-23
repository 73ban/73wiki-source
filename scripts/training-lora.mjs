#!/usr/bin/env node
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const HYPOTHESES_PATH = "data/brain/hypotheses.jsonl"
const VALIDATIONS_PATH = "data/brain/validations.jsonl"
const TRAJECTORIES_PATH = "data/training/trading_trajectories.jsonl"
const OUTPUT_PATH = "data/training/lora_samples.jsonl"
const CANDIDATES_OUTPUT_PATH = "data/training/lora_candidates.jsonl"
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

function buildTrajectorySample(trajectory) {
  const instructionByType = {
    hypothesis: "根据完整交易轨迹，复盘当时的预判是否有效，并输出可复用的交易判断规则。",
    correction: "根据纠偏轨迹，判断该风险信号是否需要升级为用户提醒，并说明证据强度。",
    "execution-audit": "根据执行审计轨迹，识别是否存在计划外交易或纪律风险，并输出改进规则。",
  }
  const codeText = trajectory.code ? `${trajectory.name ?? ""}(${trajectory.code})` : trajectory.name ?? "组合/系统"
  return {
    schema: "73wiki-lora-sample-v1",
    id: `lora_traj_${shortHash(trajectory.id)}`,
    sourceTrajectoryId: trajectory.id,
    sourceHypothesisId: trajectory.sourceIds?.hypothesisId ?? null,
    sourceValidationId: trajectory.sourceIds?.validationId ?? null,
    instruction: instructionByType[trajectory.type] ?? "根据交易轨迹做复盘判断。",
    input: {
      type: trajectory.type,
      tradeDate: trajectory.tradeDate,
      target: codeText,
      before: trajectory.before,
      during: trajectory.during,
      after: trajectory.after,
    },
    output: {
      decision: trajectory.before?.tradeReason ?? "进入复核流程，不直接形成买卖建议。",
      reasoning: trajectory.before?.hypothesis ?? null,
      riskControl: trajectory.type === "correction"
        ? "强证据风险优先提醒；弱证据只记录观察。"
        : trajectory.type === "execution-audit"
          ? "计划外交易默认高风险，复盘后沉淀纪律约束。"
          : "候选必须经过竞价、分时、板块和后续 D1/D3/D5 验证。",
      lesson: labelLesson(trajectory.label),
    },
    label: {
      result: trajectory.label,
      validationResult: trajectory.after?.validationResult ?? null,
      bestGainPct: trajectory.after?.bestGainPct ?? null,
      finalGainPct: trajectory.after?.finalGainPct ?? null,
      checkpointOutcomes: trajectory.after?.checkpoints ?? [],
    },
    metadata: {
      createdAt: nowLocalTimestamp(),
      dataHorizonTradeDate: trajectory.after?.dataHorizonTradeDate ?? null,
      tags: ["73wiki", "trading-trajectory", "lora-ready", trajectory.type, trajectory.label],
    },
  }
}

function labelLesson(label) {
  if (label === "success") return "该预判链条通过阶段验证，可作为相似场景召回样本。"
  if (label === "failure") return "该预判链条失败，应回看证据质量、买点和风险词。"
  if (label === "data_gap") return "验证数据不足，不能作为强规则，只能补证或降权。"
  if (label === "risk_high") return "强风险信号需要优先复核并准备提醒用户。"
  if (label === "discipline_risk") return "计划外交易需要进入错误库或纪律约束候选。"
  return "中性样本保留用于边界条件学习。"
}

function buildReport(projectPath, samples, candidates, diagnostics, sourceMode) {
  const countsByLabel = samples.reduce((acc, sample) => {
    const key = sample.label.result
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  const candidatesByLabel = candidates.reduce((acc, sample) => {
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
    candidatesOutputPath: CANDIDATES_OUTPUT_PATH,
    counts: {
      samples: samples.length,
      byLabel: countsByLabel,
      candidates: candidates.length,
      candidatesByLabel,
      sourceMode,
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
  const candidateLabels = Object.entries(report.counts.candidatesByLabel).map(([key, value]) => `- ${key}: ${value}`).join("\n") || "- 无"
  return `# LoRA-ready Training Dataset\n\n生成时间：${report.generatedAt}\n\n## 输出\n\n- 可训练样本：${report.outputPath}\n- 全量候选样本：${report.candidatesOutputPath}\n\n## 可训练样本\n\n- 总数：${report.counts.samples}\n\n${labels}\n\n## 全量候选\n\n- 总数：${report.counts.candidates}\n\n${candidateLabels}\n\n## 边界\n\n- pending 未验证轨迹只进入候选集，不进入正式训练样本。\n- 只从已存在账本抽样，不生成新交易建议。\n- 不写 raw/**，不写正式 wiki 页面。\n- 当前是 LoRA-ready 格式，不自动启动训练。\n`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("Usage: node scripts/training-lora.mjs --project C:/wiki/73神话 --write")
    return
  }
  const projectPath = path.resolve(args.project ?? DEFAULT_PROJECT_PATH)
  const trajectories = readJsonl(path.join(projectPath, TRAJECTORIES_PATH))
  const hypotheses = readJsonl(path.join(projectPath, HYPOTHESES_PATH))
  const validations = readJsonl(path.join(projectPath, VALIDATIONS_PATH))
  const validationsByTarget = latestValidationsByTarget(validations.rows)
  const sourceMode = trajectories.rows.length > 0 ? "trajectories" : "hypothesis-validations"
  const candidates = (trajectories.rows.length > 0
    ? trajectories.rows.map(buildTrajectorySample)
    : hypotheses.rows
      .filter((row) => row?.id && validationsByTarget.has(row.id))
      .map((row) => buildSample(row, validationsByTarget.get(row.id))))
    .sort((a, b) => String(a.input.tradeDate ?? "").localeCompare(String(b.input.tradeDate ?? "")) || a.id.localeCompare(b.id))
  const samples = candidates.filter((sample) => sample.label.result !== "pending")
  const report = buildReport(projectPath, samples, candidates, {
    hypothesisParseErrors: hypotheses.parseErrors,
    validationParseErrors: validations.parseErrors,
  }, sourceMode)
  if (args.write) {
    writeJsonl(path.join(projectPath, OUTPUT_PATH), samples)
    writeJsonl(path.join(projectPath, CANDIDATES_OUTPUT_PATH), candidates)
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
