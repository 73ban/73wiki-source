import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  TEMPORAL_FACTS_PATH,
  ensureEngineDataDirs,
  runDailyLoop,
  runHistoryReplayTemplate,
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
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "73wiki-third-batch-"))
  await ensureEngineDataDirs({ projectPath: tmpRoot })
  await write(
    path.join(tmpRoot, "wiki/07-作战室/2026-06-12-候选票跟踪.md"),
    [
      "# 2026-06-12 候选票跟踪",
      "",
      "| 股票 | 主模式 | D+1 | D+3 | D+5 | D+10 | 结论 |",
      "|---|---|---|---|---|---|---|",
      "| 样本股份 | 出监管模式 | +3.2%，符合预期 | 待填 | 数据缺失 |  | 有效观察 |",
      "| 空白股份 | 绕异动模式 | 待填 | 待填 | 待填 | 待填 | 待观察 |",
      "",
    ].join("\n"),
  )
})

afterEach(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe("third-batch trading loop", () => {
  it("postclose daily-loop writes only filled D+ facts and validation memory", async () => {
    const result = await runDailyLoop({ projectPath: tmpRoot, mode: "postclose", write: true })
    expect(result.writePolicy.buyAdviceAllowed).toBe(false)
    expect(result.writes.validations).toBe(1)
    expect(result.writes.facts).toBe(1)
    expect(result.dplus.facts[0].subject).toBe("样本股份")

    const facts = await read(path.join(tmpRoot, TEMPORAL_FACTS_PATH))
    expect(facts).toContain("DPLUS_VALIDATED")
    expect(facts).toContain("样本股份")
    expect(facts).not.toContain("空白股份")

    const validations = await read(path.join(tmpRoot, "data/brain/validations.jsonl"))
    expect(validations).toContain("盘后验证")
  })

  it("premarket daily-loop writes prediction memory without facts", async () => {
    const result = await runDailyLoop({ projectPath: tmpRoot, mode: "premarket", write: true })
    expect(result.writes.predictions).toBe(1)
    expect(result.writes.facts).toBe(0)

    const predictions = await read(path.join(tmpRoot, "data/brain/predictions.jsonl"))
    expect(predictions).toContain("盘前问题清单")
    expect(predictions).not.toContain("买入建议")
  })

  it("daily-loop write is idempotent for the same D+ facts", async () => {
    await runDailyLoop({ projectPath: tmpRoot, mode: "postclose", write: true })
    const second = await runDailyLoop({ projectPath: tmpRoot, mode: "postclose", write: true })
    expect(second.writes.facts).toBe(0)
    const factLines = (await read(path.join(tmpRoot, TEMPORAL_FACTS_PATH))).trim().split(/\r?\n/)
    expect(factLines).toHaveLength(1)
  })

  it("history replay template writes only .llm-wiki guarded templates", async () => {
    const dryRun = await runHistoryReplayTemplate({
      projectPath: tmpRoot,
      from: "2024-09-24",
      to: "2024-09-26",
    })
    expect(dryRun.dryRun).toBe(true)
    expect(dryRun.count).toBe(3)

    const written = await runHistoryReplayTemplate({
      projectPath: tmpRoot,
      from: "2024-09-24",
      to: "2024-09-26",
      write: true,
    })
    expect(written.outputDir).toBe(".llm-wiki/history-replay/2024-09-24_2024-09-26")
    const template = await read(path.join(tmpRoot, ".llm-wiki/history-replay/2024-09-24_2024-09-26/2024-09-24-复盘模板.md"))
    expect(template).toContain("lookahead_guard: true")
    expect(template).toContain("original_reason: unknown")
    await expect(fs.access(path.join(tmpRoot, "raw"))).rejects.toThrow()
  })

  it("history replay template skips known 2024 National Day market holidays", async () => {
    const result = await runHistoryReplayTemplate({
      projectPath: tmpRoot,
      from: "2024-09-24",
      to: "2024-10-11",
    })
    expect(result.count).toBe(9)
    expect(result.templates.map((item) => item.date)).not.toContain("2024-10-01")
    expect(result.templates.map((item) => item.date)).toContain("2024-10-08")
  })
})
