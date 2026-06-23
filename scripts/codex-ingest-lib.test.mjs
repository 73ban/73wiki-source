import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  MANIFEST_SCHEMA,
  TEMPORAL_FACTS_INDEX_PATH,
  TEMPORAL_FACTS_PATH,
  WIKI_DIRS,
  applyManifest,
  askWiki,
  ensureEngineDataDirs,
  getBrainStatus,
  prepareIngest,
  rememberBrainMemory,
  runDailyLoop,
  runTemporalFactsAudit,
} from "./codex-ingest-lib.mjs"

let tmpRoot

async function write(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, "utf8")
}

async function read(filePath) {
  return fs.readFile(filePath, "utf8")
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "73wiki-codex-ingest-"))
  await write(
    path.join(tmpRoot, "wiki/04-L4交易模式与执行/出监管模式.md"),
    "# 出监管模式\n\n出监管后需要观察成交量、竞价承接和 D+3 验证。相关 [[风险锚减仓规则]]。",
  )
  await write(
    path.join(tmpRoot, "wiki/10-系统配置/风险锚减仓规则.md"),
    "# 风险锚减仓规则\n\n没有行情快照时写：数据缺失，无法判断。",
  )
  await write(
    path.join(tmpRoot, "wiki/09-统计与进化/模式验证闭环规则.md"),
    "# 模式验证闭环规则\n\n候选票 D+1/D+3/D+5/D+10 必须跟踪。",
  )
  await write(
    path.join(tmpRoot, "raw/08-信息来源/2026-06-13-样本.md"),
    "# 样本\n\n某个出监管模式资料，包含订单传闻和澄清风险，必须待验证。",
  )
})

afterEach(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe("73wiki codex ingest engine", () => {
  it("creates data/facts and data/brain without touching raw", async () => {
    const result = await ensureEngineDataDirs({ projectPath: tmpRoot })
    expect(result.facts).toBe(TEMPORAL_FACTS_PATH)
    await expect(fs.access(path.join(tmpRoot, TEMPORAL_FACTS_PATH))).resolves.toBeUndefined()
    await expect(fs.access(path.join(tmpRoot, TEMPORAL_FACTS_INDEX_PATH))).resolves.toBeUndefined()

    const status = await getBrainStatus({ projectPath: tmpRoot })
    expect(status.totals.records).toBe(0)
    await expect(fs.access(path.join(tmpRoot, "raw/08-信息来源/2026-06-13-样本.md"))).resolves.toBeUndefined()
  })

  it("returns W/R/G/S evidence refs for ask", async () => {
    await ensureEngineDataDirs({ projectPath: tmpRoot })
    const result = await askWiki({ projectPath: tmpRoot, query: "出监管模式 D+3 风险锚" })

    expect(result.wikiResults[0].ref).toBe("W1")
    expect(result.rawResults[0].ref).toBe("R1")
    expect(result.graphResults[0].ref).toBe("G1")
    expect(result.statsResults[0].ref).toBe("S1")
    expect(result.answer).toContain("W=WIKI")
  })

  it("writes brain memory as constraints instead of market facts", async () => {
    await ensureEngineDataDirs({ projectPath: tmpRoot })
    const remembered = await rememberBrainMemory({
      projectPath: tmpRoot,
      type: "guardrail",
      text: "没有行情快照时必须写数据缺失，无法判断。",
      tags: "行情,D+",
    })
    expect(remembered.relativePath).toBe("data/brain/guardrails.jsonl")

    const status = await getBrainStatus({ projectPath: tmpRoot })
    expect(status.files["data/brain/guardrails.jsonl"].records).toBe(1)

    const asked = await askWiki({ projectPath: tmpRoot, query: "没有行情快照怎么办" })
    expect(asked.brainResults[0].ref).toBe("M1")
  })

  it("prepares an ingest report with 73 schema adapter and no writes", async () => {
    const result = await prepareIngest({
      projectPath: tmpRoot,
      sourcePath: path.join(tmpRoot, "raw/08-信息来源/2026-06-13-样本.md"),
      reportId: "prepare-test",
    })
    const template = JSON.parse(await read(path.join(result.reportDir, "changes.template.json")))
    expect(template.schema).toBe(MANIFEST_SCHEMA)
    expect(template.schemaAdapter.l4).toBe(WIKI_DIRS.l4)
    expect(template.writePolicy.rawWritesAllowed).toBe(false)
    expect(template.writes).toEqual([])
    expect(await read(path.join(result.reportDir, "context.md"))).toContain("raw/** must never be written")
  })

  it("dry-runs manifest writes and refuses raw or Yang-style wiki directories", async () => {
    const manifestPath = path.join(tmpRoot, ".llm-wiki/codex-ingest/apply-test/changes.json")
    await write(
      manifestPath,
      JSON.stringify({
        schema: MANIFEST_SCHEMA,
        projectPath: tmpRoot,
        writes: [
          {
            action: "append",
            path: "wiki/04-L4交易模式与执行/出监管模式.md",
            content: "## 审核补充\n\n只允许 dry-run 后 apply。",
          },
        ],
        factWrites: [
          {
            subject: "出监管模式",
            predicate: "PATTERN_VALIDATED",
            object: "D+3验证",
            claim: "出监管模式需要 D+3 验证后才可提高权重。",
            status: "active",
            evidenceLevel: "B",
            sourceKind: "manual_review",
            sourcePath: "wiki/09-统计与进化/模式验证闭环规则.md",
          },
        ],
      }),
    )

    const dryRun = await applyManifest({ manifestPath })
    expect(dryRun.dryRun).toBe(true)
    expect(dryRun.diffs[0].changed).toBe(true)
    expect(dryRun.plannedFactWrites[0].predicate).toBe("PATTERN_VALIDATED")
    expect(await read(path.join(tmpRoot, "wiki/04-L4交易模式与执行/出监管模式.md"))).not.toContain("审核补充")

    const rawManifest = path.join(tmpRoot, ".llm-wiki/codex-ingest/raw-test/changes.json")
    await write(rawManifest, JSON.stringify({ schema: MANIFEST_SCHEMA, projectPath: tmpRoot, writes: [{ path: "raw/x.md", content: "bad" }] }))
    await expect(applyManifest({ manifestPath: rawManifest })).rejects.toThrow(/Refusing to write raw/)

    const yangManifest = path.join(tmpRoot, ".llm-wiki/codex-ingest/yang-test/changes.json")
    await write(yangManifest, JSON.stringify({ schema: MANIFEST_SCHEMA, projectPath: tmpRoot, writes: [{ path: "wiki/股票/样本.md", content: "bad" }] }))
    await expect(applyManifest({ manifestPath: yangManifest })).rejects.toThrow(/Yang-style/)
  })

  it("applies explicit writes and indexes temporal facts", async () => {
    const manifestPath = path.join(tmpRoot, ".llm-wiki/codex-ingest/write-test/changes.json")
    await write(
      manifestPath,
      JSON.stringify({
        schema: MANIFEST_SCHEMA,
        projectPath: tmpRoot,
        writes: [],
        factWrites: [
          {
            subject: "候选票样本",
            predicate: "DPLUS_VALIDATED",
            object: "D+3",
            claim: "候选票样本 D+3 验证失败，后续只作为错误样本观察。",
            status: "active",
            evidenceLevel: "A",
            sourceKind: "manual_review",
          },
        ],
      }),
    )

    const result = await applyManifest({ manifestPath, write: true })
    expect(result.factsWritten).toHaveLength(1)
    expect(await read(path.join(tmpRoot, TEMPORAL_FACTS_PATH))).toContain("DPLUS_VALIDATED")
    const index = JSON.parse(await read(path.join(tmpRoot, TEMPORAL_FACTS_INDEX_PATH)))
    expect(index.byPredicate.DPLUS_VALIDATED).toBe(1)
  })

  it("audits temporal fact candidates and keeps daily-loop non-advisory", async () => {
    const audit = await runTemporalFactsAudit({ projectPath: tmpRoot, topN: 10 })
    expect(audit.counts.candidates).toBeGreaterThan(0)

    const daily = await runDailyLoop({ projectPath: tmpRoot, mode: "premarket" })
    expect(daily.writePolicy.buyAdviceAllowed).toBe(false)
    expect(daily.outputs.forbidden).toContain("自动生成买入建议")
  })
})
