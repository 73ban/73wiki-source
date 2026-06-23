#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_PG_BIN = "C:/Program Files/PostgreSQL/16/bin"
const PG_BIN = process.env.WIKI73_PG_BIN || DEFAULT_PG_BIN
const DATA_DIR = process.env.WIKI73_PGDATA || "C:/wiki/73神话/.system/postgres-data"
const LOG_FILE = process.env.WIKI73_PGLOG || "C:/wiki/73神话/.system/postgres-logs/pg_ctl.log"
const HOST = process.env.WIKI73_PGHOST || "127.0.0.1"
const PORT = process.env.WIKI73_PGPORT || "55432"
const USER = process.env.WIKI73_PGUSER || "wiki73"
const DATABASE = process.env.WIKI73_PGDATABASE || "wiki73_trading"

function exe(name) {
  return path.join(PG_BIN, `${name}.exe`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  })
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error([`Command failed: ${command} ${args.join(" ")}`, result.stdout, result.stderr].filter(Boolean).join("\n"))
  }
  return result
}

function isReady() {
  const result = run(exe("pg_isready"), ["-h", HOST, "-p", PORT, "-U", USER, "-d", DATABASE], { allowFailure: true })
  return {
    ready: result.status === 0,
    output: `${result.stdout}${result.stderr}`.trim(),
  }
}

function start() {
  const ready = isReady()
  if (ready.ready) return { action: "start", status: "already_running", ready }
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
  run(exe("pg_ctl"), ["-D", DATA_DIR, "-l", LOG_FILE, "start"])
  return { action: "start", status: "started", ready: isReady() }
}

function stop() {
  const ready = isReady()
  if (!ready.ready) return { action: "stop", status: "already_stopped", ready }
  run(exe("pg_ctl"), ["-D", DATA_DIR, "stop", "-m", "fast"])
  return { action: "stop", status: "stopped", ready: isReady() }
}

function status() {
  const ready = isReady()
  let sql = null
  if (ready.ready) {
    const result = run(exe("psql"), [
      "-h", HOST,
      "-p", PORT,
      "-U", USER,
      "-d", DATABASE,
      "-tAc",
      "select count(*) from information_schema.tables where table_schema='trading'",
    ])
    sql = { tradingTableCount: Number(result.stdout.trim()) }
  }
  return {
    action: "status",
    host: HOST,
    port: PORT,
    user: USER,
    database: DATABASE,
    dataDir: DATA_DIR,
    ready,
    sql,
  }
}

function main() {
  const command = process.argv[2] || "status"
  const result = command === "start" ? start()
    : command === "stop" ? stop()
      : command === "status" ? status()
        : null
  if (!result) throw new Error(`Unknown command: ${command}`)
  console.log(JSON.stringify(result, null, 2))
}

main()
