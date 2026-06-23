import { describe, expect, it } from "vitest"

import { classifySellValidation, parseSellRecordsFromMarkdown } from "./post-sell-validation.mjs"

describe("parseSellRecordsFromMarkdown", () => {
  it("extracts completed sell rows from markdown tables", () => {
    const markdown = `# 2026-06-15 交割单

| 时间 | 标的 | 方向 | 成交价 | 数量 | 金额 |
|------|------|------|------|------|------|
| 10:31 | 航天发展 000547 | 卖出 | 19.88 | 2000 | 39760 |
| 14:58 | 大唐发电 601991 | 买入 | 8.50 | 1000 | 8500 |
`
    const records = parseSellRecordsFromMarkdown(markdown, "raw/01-交割单/2026-06-15/交割单.md")
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      code: "000547",
      name: "航天发展",
      side: "sell",
      price: 19.88,
      quantity: 2000,
      time: "10:31:00",
    })
  })
})

describe("classifySellValidation", () => {
  it("marks sold_rewatch when post-sell action keeps overperforming", () => {
    const result = classifySellValidation({
      preSellMissPct: 1.2,
      sameDayAfterHighGainPct: 8.1,
      sameDayAfterCloseGainPct: 5.4,
      d1CloseGainPct: 6.8,
      d5MaxGainPct: 14.2,
      futureLimitUpCount: 1,
    })
    expect(result.verdictType).toBe("sold_rewatch")
    expect(result.rewatch).toBe(true)
  })

  it("marks sold_too_late when pre-sell high was much better and post-sell weakens", () => {
    const result = classifySellValidation({
      preSellMissPct: 6.2,
      sameDayAfterHighGainPct: 0.8,
      sameDayAfterCloseGainPct: -3.6,
      sameDayAfterLowGainPct: -5.1,
      d1CloseGainPct: -4.3,
      d5MaxGainPct: 1.4,
      futureLimitUpCount: 0,
    })
    expect(result.verdictType).toBe("sold_too_late")
  })

  it("marks needs_backfill when there is no post-sell market evidence", () => {
    const result = classifySellValidation({
      futureLimitUpCount: 0,
    })
    expect(result.verdictType).toBe("needs_backfill")
    expect(result.score).toBeNull()
  })
})
