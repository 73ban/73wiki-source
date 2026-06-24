#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PROJECT_PATH = process.env.WIKI_PROJECT_PATH ?? "C:/wiki/73神话"
const DEFAULT_FETCH_SCRIPT = process.env.THS_HOTLIST_FETCH_SCRIPT
  ?? "C:/Users/Administrator/.codex/skills/playwright-ths-hotlist/scripts/fetch-ths-hotlist.mjs"
const CAPTURE_ROOT = ".llm-wiki/ths-hotlist/captures"

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith("--")) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (["write", "help"].includes(key)) {
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

function captureFileName(date = new Date(), rows = 100) {
  const pad = (n) => String(n).padStart(2, "0")
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}`
  return `${day}-${time}-ths-hotlist-top${rows}.json`
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function extractJson(stdout) {
  const text = String(stdout ?? "")
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("THS capture stdout did not contain JSON")
  return JSON.parse(text.slice(start, end + 1))
}

function runNode(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  })
}

function scriptPath(name) {
  return path.join(process.cwd(), "scripts", name)
}

function printHelp() {
  console.log(`Usage:
  node scripts/ths-hotlist-capture-import.mjs --project C:\\wiki\\73神话 --write
  node scripts/ths-hotlist-capture-import.mjs --fetch-script C:\\path\\to\\fetch-ths-hotlist.mjs --max-items 100 --write
`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const projectPath = path.resolve(args.project ?? args._[0] ?? DEFAULT_PROJECT_PATH)
  const fetchScript = path.resolve(args["fetch-script"] ?? DEFAULT_FETCH_SCRIPT)
  const maxItems = Number(args["max-items"] ?? 100)
  const write = Boolean(args.write)

  if (!fs.existsSync(fetchScript)) {
    console.log(JSON.stringify({
      ok: false,
      skipped: true,
      reason: "fetch_script_missing",
      fetchScript,
      message: "Set THS_HOTLIST_FETCH_SCRIPT or install the playwright-ths-hotlist skill.",
    }, null, 2))
    process.exitCode = 1
    return
  }

  const capture = runNode(fetchScript, [], { cwd: path.dirname(path.dirname(fetchScript)) })
  if (capture.status !== 0) {
    console.log(JSON.stringify({
      ok: false,
      step: "capture",
      status: capture.status,
      stdout: String(capture.stdout ?? "").slice(-6000),
      stderr: String(capture.stderr ?? "").slice(-6000),
    }, null, 2))
    process.exitCode = capture.status ?? 1
    return
  }

  const payload = extractJson(capture.stdout)
  if (!payload?.ok || !Array.isArray(payload.rows) || payload.rows.length === 0) {
    console.log(JSON.stringify({
      ok: false,
      step: "capture",
      message: "THS capture returned no usable rows.",
      payload,
    }, null, 2))
    process.exitCode = 1
    return
  }

  const captureDir = path.join(projectPath, CAPTURE_ROOT)
  const capturePath = path.join(captureDir, captureFileName(new Date(), Math.min(maxItems, payload.rows.length)))
  writeJson(capturePath, {
    ...payload,
    capturedAt: nowLocalTimestamp(),
    rows: payload.rows.slice(0, maxItems),
  })

  const importArgs = [
    "--project",
    projectPath,
    "--capture-file",
    capturePath,
    "--max-items",
    String(maxItems),
  ]
  if (write) importArgs.push("--write")
  const imported = runNode(scriptPath("ths-hotlist-import.mjs"), importArgs)

  const importedPayload = extractJson(imported.stdout)
  const output = {
    ok: imported.status === 0,
    dryRun: !write,
    capturePath,
    capturedRows: payload.rows.length,
    imported: {
      dryRun: importedPayload.dryRun,
      id: importedPayload.record?.id ?? null,
      rows: importedPayload.record?.counts?.rows ?? null,
      complete: importedPayload.record?.counts?.complete ?? null,
      written: importedPayload.written ?? null,
    },
    stderr: String(imported.stderr ?? "").trim() || null,
  }
  console.log(JSON.stringify(output, null, 2))
  if (imported.status !== 0) process.exitCode = imported.status ?? 1
}

main()
