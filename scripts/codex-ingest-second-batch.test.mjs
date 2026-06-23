import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  MANIFEST_SCHEMA,
  apiRunIngest,
  applyManifest,
  finalizeStagedIngest,
  parseFileBlocks,
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
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "73wiki-second-batch-"))
  await write(path.join(tmpRoot, "wiki/08-信息来源/索引.md"), "# 信息来源索引\n\n订单、澄清、D+验证都需要事实账本。")
  await write(path.join(tmpRoot, "wiki/09-统计与进化/模式验证闭环规则.md"), "# 模式验证闭环规则\n\n候选票 D+3 验证必须记录。")
  await write(path.join(tmpRoot, "raw/source.md"), "# Source\n\n出监管模式出现订单传闻和澄清风险，D+3 需要验证。")
})

afterEach(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe("second-batch staged write governance", () => {
  it("api-run creates staged artifacts, manifest, review, and dry-run report", async () => {
    const result = await apiRunIngest({
      projectPath: tmpRoot,
      sourcePath: "raw/source.md",
      reportId: "api-run-test",
    })

    await expect(fs.access(result.analysisPath)).resolves.toBeUndefined()
    await expect(fs.access(result.planPath)).resolves.toBeUndefined()
    await expect(fs.access(result.manifestPath)).resolves.toBeUndefined()
    await expect(fs.access(path.join(result.reportDir, "wiki-change-review.md"))).resolves.toBeUndefined()

    const manifest = JSON.parse(await read(result.manifestPath))
    expect(manifest.schema).toBe(MANIFEST_SCHEMA)
    expect(manifest.writes).toHaveLength(1)
    expect(manifest.writes[0].path).toMatch(/^wiki\/08-信息来源\/CLI摄入候选\//)
    expect(manifest.factWrites.length).toBeGreaterThan(0)
    expect(result.dryRunReport.dryRun).toBe(true)
    expect(await read(path.join(tmpRoot, "raw/source.md"))).toContain("订单传闻")
  })

  it("finalize rebuilds manifest from edited FILE blocks", async () => {
    const run = await apiRunIngest({ projectPath: tmpRoot, sourcePath: "raw/source.md", reportId: "finalize-test" })
    const files = await fs.readdir(run.filesDir)
    const firstFile = path.join(run.filesDir, files[0])
    const raw = await read(firstFile)
    const [block] = parseFileBlocks(raw)
    expect(block.path).toMatch(/^wiki\/08-信息来源\/CLI摄入候选\//)

    await write(
      firstFile,
      `----FILE: ${block.path}----\n${block.content}\n\n## Manual Edit\n\nfinalize should keep this staged edit.\n----END FILE----\n`,
    )

    const finalized = await finalizeStagedIngest({ reportDir: run.reportDir, projectPath: tmpRoot })
    const manifest = JSON.parse(await read(finalized.manifestPath))
    expect(manifest.writes[0].content).toContain("Manual Edit")
    expect(finalized.dryRunReport.diffs[0].diff.join("\n")).toContain("Manual Edit")
  })

  it("apply --write only writes staged wiki/facts, never raw", async () => {
    const run = await apiRunIngest({ projectPath: tmpRoot, sourcePath: "raw/source.md", reportId: "write-test" })
    const result = await applyManifest({ manifestPath: run.manifestPath, projectPath: tmpRoot, write: true })

    expect(result.written[0]).toMatch(/^wiki\/08-信息来源\/CLI摄入候选\//)
    expect(result.factsWritten.length).toBeGreaterThan(0)
    expect(await read(path.join(tmpRoot, "raw/source.md"))).toBe("# Source\n\n出监管模式出现订单传闻和澄清风险，D+3 需要验证。")
  })
})
