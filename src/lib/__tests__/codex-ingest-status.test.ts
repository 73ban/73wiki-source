import { describe, expect, it } from "vitest"
import { DEFAULT_WIKI_SYSTEM_CONFIG } from "@/lib/wiki-config"
import { summarizeJsonl } from "@/lib/codex-ingest-status"

describe("codex ingest status helpers", () => {
  it("counts valid jsonl rows and invalid rows", () => {
    expect(summarizeJsonl('{"id":1}\n\nnot-json\n{"id":2}\n')).toEqual({
      count: 3,
      invalid: 1,
    })
  })

  it("ignores blank jsonl lines", () => {
    expect(summarizeJsonl("\n  \r\n\t\n")).toEqual({
      count: 0,
      invalid: 0,
    })
  })

  it("keeps RAW auto-ingest disabled by default", () => {
    expect(DEFAULT_WIKI_SYSTEM_CONFIG.rawIngest.enabled).toBe(false)
  })
})
