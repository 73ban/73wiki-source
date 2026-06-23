#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const DEFAULT_MANAGER_PATH = process.env.FEISHU_73_MANAGER_PATH ?? "C:/Users/Administrator/Desktop/workspace/feishu-73-manager"

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["dry-run", "help"].includes(key)) {
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

function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function printHelp() {
  console.log(`Usage:
  npm run correction:push -- --project C:\\wiki\\73神话
  npm run correction:push -- --project C:\\wiki\\73神话 --dry-run
`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const projectPath = path.resolve(args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH)
  const managerPath = path.resolve(args["manager-path"] ?? DEFAULT_MANAGER_PATH)
  const reportPath = path.resolve(args["report-path"] ?? path.join(projectPath, ".llm-wiki/correction-alerts/latest-correction-alerts.json"))
  const report = readJsonMaybe(reportPath)
  if (!report) throw new Error(`Missing correction alerts report: ${reportPath}`)

  const pushEligible = Array.isArray(report.items) ? report.items.filter((item) => item?.pushEligible) : []
  if (pushEligible.length === 0) {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: "no-push-eligible-items",
      reportPath,
    }, null, 2))
    return
  }

  const scriptPath = path.join(managerPath, "scripts", "send-correction-alerts.mjs")
  const invokeArgs = [scriptPath, "--report-path", reportPath]
  if (args["chat-id"]) invokeArgs.push("--chat-id", String(args["chat-id"]))
  if (args["dry-run"]) invokeArgs.push("--dry-run")

  const result = spawnSync(process.execPath, invokeArgs, {
    cwd: managerPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  })

  if (result.status !== 0) {
    throw new Error([result.stdout, result.stderr].filter(Boolean).join("\n") || "correction push failed")
  }

  const text = String(result.stdout ?? "").trim()
  console.log(text || JSON.stringify({ ok: true, reportPath }, null, 2))
}

main()
