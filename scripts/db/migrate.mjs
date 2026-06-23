#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PSQL = "C:/Program Files/PostgreSQL/16/bin/psql.exe"
const PSQL = process.env.WIKI73_PSQL_PATH || DEFAULT_PSQL
const HOST = process.env.WIKI73_PGHOST || "127.0.0.1"
const PORT = process.env.WIKI73_PGPORT || "55432"
const USER = process.env.WIKI73_PGUSER || "wiki73"
const DATABASE = process.env.WIKI73_PGDATABASE || "wiki73_trading"
const MAINTENANCE_DB = process.env.WIKI73_PGMAINTENANCE_DB || "postgres"

function runPsql(args, { input } = {}) {
  const result = spawnSync(PSQL, args, {
    input,
    encoding: "utf8",
    stdio: input == null ? "pipe" : ["pipe", "pipe", "pipe"],
  })
  if (result.status !== 0) {
    throw new Error([
      `psql failed: ${PSQL} ${args.join(" ")}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"))
  }
  return result.stdout
}

function baseArgs(database) {
  return ["-h", HOST, "-p", PORT, "-U", USER, "-d", database, "-v", "ON_ERROR_STOP=1"]
}

function ensureDatabase() {
  const sql = `select 1 from pg_database where datname = '${DATABASE.replace(/'/g, "''")}'`
  const exists = runPsql([...baseArgs(MAINTENANCE_DB), "-tAc", sql]).trim() === "1"
  if (exists) return false
  runPsql([...baseArgs(MAINTENANCE_DB), "-c", `create database ${DATABASE}`])
  return true
}

function applySchema() {
  const schemaPath = path.join(__dirname, "schema.sql")
  if (!fs.existsSync(schemaPath)) throw new Error(`Missing schema file: ${schemaPath}`)
  runPsql([...baseArgs(DATABASE), "-f", schemaPath])
}

function main() {
  const created = ensureDatabase()
  applySchema()
  const tableCount = runPsql([
    ...baseArgs(DATABASE),
    "-tAc",
    "select count(*) from information_schema.tables where table_schema = 'trading'",
  ]).trim()
  console.log(JSON.stringify({
    ok: true,
    host: HOST,
    port: PORT,
    user: USER,
    database: DATABASE,
    createdDatabase: created,
    tradingTableCount: Number(tableCount),
  }, null, 2))
}

main()
