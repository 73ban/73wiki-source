#!/usr/bin/env node
import path from "node:path"
import {
  DEFAULT_PROJECT_PATH,
  applyManifest,
  askWiki,
  ensureEngineDataDirs,
  apiRunIngest,
  finalizeStagedIngest,
  getBrainStatus,
  prepareIngest,
  rememberBrainMemory,
  resolveBrainMemory,
  runAskEval,
  runDailyLoop,
  runHygiene,
  runHistoryReplayTemplate,
  runTemporalFactsAudit,
} from "./codex-ingest-lib.mjs"

function printHelp() {
  console.log(`Usage:
  npm run codex:ingest -- init [--project <wiki-root>]
  npm run codex:ingest -- ask --query "..." [--project <wiki-root>] [--show-sources] [--include-invalidated]
  npm run codex:ingest -- ask eval [--query "..."] [--expect-paths a,b] [--project <wiki-root>] [--write]
  npm run codex:ingest -- prepare --source <raw-or-wiki-file> [--project <wiki-root>]
  npm run codex:ingest -- api-run --source <raw-or-wiki-file> [--project <wiki-root>] [--report-id <id>]
  npm run codex:ingest -- finalize --report <codex-ingest-report-dir> [--project <wiki-root>]
  npm run codex:ingest -- apply --manifest <changes.json> [--project <wiki-root>] [--write]
  npm run codex:ingest -- brain remember --type correction|thread|preference|guardrail|prediction|validation --text "..." [--project <wiki-root>]
  npm run codex:ingest -- brain status [--project <wiki-root>]
  npm run codex:ingest -- brain resolve --id <id> --result success|failure|uncertain [--note "..."] [--project <wiki-root>]
  npm run codex:ingest -- temporal-facts audit [--project <wiki-root>] [--top-n 50] [--write]
  npm run codex:ingest -- daily-loop --mode premarket|postclose|full [--project <wiki-root>] [--write]
  npm run codex:ingest -- history-template [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--project <wiki-root>] [--write]
  npm run codex:ingest -- hygiene audit [--project <wiki-root>]

Defaults:
  --project ${DEFAULT_PROJECT_PATH}

Hard rules:
  - This CLI never writes raw/**.
  - It keeps the 73神话 L1-L10 schema; it refuses wiki/股票, wiki/概念, wiki/策略, wiki/模式 writes.
  - apply is dry-run unless --write is present.
  - daily-loop cannot output buy advice or write formal WIKI pages in this first-batch engine.
  - history-template writes only .llm-wiki/history-replay templates.
`)
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["write", "show-sources", "show-context", "include-invalidated", "help"].includes(key)) {
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

function requireArg(args, name) {
  const value = args[name]
  if (!value) throw new Error(`Missing required --${name}`)
  return value
}

function argOrPos(args, name, index) {
  return args[name] ?? args._[index]
}

function requireArgOrPos(args, name, index) {
  const value = argOrPos(args, name, index)
  if (!value) throw new Error(`Missing required --${name}`)
  return value
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  if (!command || args.help || command === "help") {
    printHelp()
    return
  }

  if (command === "init") {
    const result = await ensureEngineDataDirs({ projectPath: args.project })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === "prepare") {
    const result = await prepareIngest({
      projectPath: argOrPos(args, "project", 1),
      sourcePath: requireArgOrPos(args, "source", 2),
      reportId: argOrPos(args, "report-id", 3),
      topWiki: args["top-wiki"],
      topRaw: args["top-raw"],
    })
    console.log(`Prepared ingest context for ${result.sourceRelativePath}`)
    console.log(`Source hash: ${result.sourceHash}`)
    console.log(`Report: ${result.reportDir}`)
    console.log(`Review: ${path.join(result.reportDir, "wiki-change-review.md")}`)
    return
  }

  if (command === "api-run") {
    const result = await apiRunIngest({
      projectPath: argOrPos(args, "project", 1),
      sourcePath: requireArgOrPos(args, "source", 2),
      reportId: argOrPos(args, "report-id", 3),
      topWiki: args["top-wiki"],
      topRaw: args["top-raw"],
    })
    console.log("Generated staged ingest artifacts:")
    console.log(`Analysis: ${result.analysisPath}`)
    console.log(`Plan: ${result.planPath}`)
    console.log(`Files: ${result.filesDir}`)
    console.log(`Manifest: ${result.manifestPath}`)
    console.log(`Dry-run report: ${result.dryRunReport.reportPath}`)
    console.log(`Review: ${result.dryRunReport.reviewPath}`)
    return
  }

  if (command === "finalize") {
    const result = await finalizeStagedIngest({
      projectPath: argOrPos(args, "project", 2),
      reportDir: requireArgOrPos(args, "report", 1),
    })
    console.log("Finalized staged ingest artifacts:")
    console.log(`Files: ${result.filesDir}`)
    console.log(`Manifest: ${result.manifestPath}`)
    console.log(`Dry-run report: ${result.dryRunReport.reportPath}`)
    console.log(`Review: ${result.dryRunReport.reviewPath}`)
    return
  }

  if (command === "apply") {
    const result = await applyManifest({
      projectPath: argOrPos(args, "project", 2),
      manifestPath: requireArgOrPos(args, "manifest", 1),
      write: Boolean(args.write),
    })
    console.log(result.dryRun ? "Dry-run complete." : "Write complete.")
    console.log(`Report: ${result.reportPath}`)
    console.log(`Review: ${result.reviewPath}`)
    console.log(`Files ${result.dryRun ? "planned" : "written"}: ${result.diffs.map((item) => item.path).join(", ") || "(none)"}`)
    if (result.fatalIssues.length > 0) {
      console.log(`Fatal issues: ${result.fatalIssues.length}`)
      for (const issue of result.fatalIssues.slice(0, 10)) console.log(`- ${issue.path}: ${issue.message}`)
    }
    return
  }

  if (command === "ask" || command === "query") {
    if (args._[1] === "eval") {
      const result = await runAskEval({
        projectPath: argOrPos(args, "project", 3),
        query: args.query ?? args._[2] ?? "",
        expectedPaths: args["expect-paths"] ?? args.expect,
        write: Boolean(args.write),
      })
      console.log(JSON.stringify(result, null, 2))
      return
    }
    const result = await askWiki({
      projectPath: argOrPos(args, "project", 2),
      query: requireArgOrPos(args, "query", 1),
      includeInvalidated: Boolean(args["include-invalidated"]),
      topWiki: args["top-wiki"],
      topRaw: args["top-raw"],
      topFacts: args["top-facts"],
      topBrain: args["top-brain"],
      topStats: args["top-stats"],
    })
    if (args["show-sources"] || args["show-context"]) {
      console.log(JSON.stringify({
        query: result.query,
        generatedAt: result.generatedAt,
        counts: result.counts,
        wikiResults: result.wikiResults,
        rawResults: result.rawResults,
        graphResults: result.graphResults,
        factsResults: result.factsResults,
        brainResults: result.brainResults,
        statsResults: result.statsResults,
      }, null, 2))
      return
    }
    console.log(result.answer)
    return
  }

  if (command === "brain") {
    const subcommand = args._[1]
    if (subcommand === "remember") {
      const result = await rememberBrainMemory({
        projectPath: argOrPos(args, "project", 4),
        type: requireArgOrPos(args, "type", 2),
        text: requireArgOrPos(args, "text", 3),
        title: args.title,
        status: args.status,
        source: args.source,
        tags: args.tags,
        related: args.related,
      })
      console.log(`Remembered brain memory: ${result.record.id}`)
      console.log(`File: ${result.relativePath}`)
      return
    }
    if (subcommand === "status") {
      console.log(JSON.stringify(await getBrainStatus({ projectPath: argOrPos(args, "project", 2) }), null, 2))
      return
    }
    if (subcommand === "resolve") {
      const result = await resolveBrainMemory({
        projectPath: argOrPos(args, "project", 4),
        id: requireArgOrPos(args, "id", 2),
        result: requireArgOrPos(args, "result", 3),
        note: args.note,
      })
      console.log(`Resolved brain memory: ${result.record.targetId} -> ${result.record.result}`)
      console.log(`File: ${result.relativePath}`)
      return
    }
    throw new Error("Unknown brain command. Use remember, status, or resolve.")
  }

  if (command === "temporal-facts") {
    const subcommand = args._[1] ?? "audit"
    if (subcommand !== "audit") throw new Error("Unknown temporal-facts command. Use audit.")
    const result = await runTemporalFactsAudit({
      projectPath: argOrPos(args, "project", 2),
      topN: argOrPos(args, "top-n", 3),
      write: Boolean(args.write),
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === "daily-loop") {
    const result = await runDailyLoop({
      projectPath: argOrPos(args, "project", 1),
      mode: argOrPos(args, "mode", 2),
      write: Boolean(args.write),
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === "history-template" || command === "history-replay") {
    const result = await runHistoryReplayTemplate({
      projectPath: argOrPos(args, "project", 1),
      from: argOrPos(args, "from", 2),
      to: argOrPos(args, "to", 3),
      write: Boolean(args.write),
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === "hygiene") {
    const result = await runHygiene({
      projectPath: argOrPos(args, "project", 2),
      action: args._[1] ?? "audit",
      write: Boolean(args.write),
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
