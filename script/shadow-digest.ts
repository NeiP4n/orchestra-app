#!/usr/bin/env bun
// Оркестратор-дублёр: ежедневный триггер (идея #8 из лучших 25 общего подхода).
//
// У сервера нет планировщика произвольных скриптов, поэтому триггер —
// этот скрипт плюс строчка в системном cron (см. docs/shadow-orchestrator.md).
// Скрипт только готовит механику: читает журнал решений оркестратора
// (только чтение базы, никогда запись) и пишет шаблон сессии теневого
// оркестратора в каталог общества; дайджест пишет сессия, а этот же
// скрипт с --finalize собирает его в файл.
//
// Usage:
//   bun script/shadow-digest.ts --prepare [--date YYYY-MM-DD] [--db <path>] [--society-dir <dir>]
//   bun script/shadow-digest.ts --finalize --session-text <file> [--date YYYY-MM-DD] [--db <path>] [--society-dir <dir>]
//   # ежедневно в 09:00: 0 9 * * * cd /path/to/orchestra-app && bun script/shadow-digest.ts --prepare
import { Database } from "bun:sqlite"
import { exists, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { rebuild } from "../packages/core/src/autoloop/kernel/evolve.js"
import {
  collectDecisions,
  countUnansweredCards,
  summarizeDecisions,
  writeDigest,
  writeSessionPrompt,
} from "../packages/core/src/autoloop/shadow.js"
import type { AutoloopFact } from "../packages/core/src/autoloop/kernel/schema.js"

const dataDir = (): string =>
  process.env.ORCHESTRA_DATA_DIR ?? process.env.OPENCODE_DATA_DIR ?? path.join(os.homedir(), ".local", "share", "orchestra")

const dbPath = (flag: string | undefined): string =>
  flag ?? process.env.ORCHESTRA_DB ?? path.join(dataDir(), "orchestra-local.db")

const societyDir = (flag: string | undefined): string => flag ?? path.join(dataDir(), "society")

const dayBounds = (date: Date): { sinceMs: number; untilMs: number } => {
  const day = date.toISOString().slice(0, 10)
  return { sinceMs: Date.parse(`${day}T00:00:00.000Z`), untilMs: Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000 }
}

async function readView(db: string) {
  if (!(await exists(db))) throw new Error(`база журнала не найдена: ${db}`)
  const conn = new Database(db, { readonly: true })
  try {
    const rows = conn.query("SELECT fact FROM autoloop_facts ORDER BY seq ASC").all() as Array<{ fact: string }>
    return rebuild(rows.map((row) => JSON.parse(row.fact) as AutoloopFact))
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such table")) return rebuild([])
    throw error
  } finally {
    conn.close()
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name)
    return at === -1 ? undefined : args[at + 1]
  }
  const prepare = args.includes("--prepare")
  const finalize = args.includes("--finalize")
  if (args.includes("--help") || args.includes("-h") || (prepare === finalize)) {
    console.log("usage: bun script/shadow-digest.ts --prepare [--date YYYY-MM-DD] [--db <path>] [--society-dir <dir>]")
    console.log("       bun script/shadow-digest.ts --finalize --session-text <file> [--date YYYY-MM-DD] [--db <path>] [--society-dir <dir>]")
    return prepare === finalize ? 2 : 0
  }
  const dateText = flag("--date")
  const date = dateText === undefined ? new Date() : new Date(`${dateText}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) {
    console.error(`shadow-digest: неверная дата ${dateText} — нужна YYYY-MM-DD`)
    return 2
  }
  const db = dbPath(flag("--db"))
  const society = societyDir(flag("--society-dir"))
  const { sinceMs, untilMs } = dayBounds(date)
  const view = await readView(db)
  const decisions = collectDecisions(view, sinceMs, untilMs)
  const summary = { ...summarizeDecisions(decisions), unansweredCards: countUnansweredCards(view) }

  if (prepare) {
    const file = await writeSessionPrompt(society, date, decisions, summary)
    console.log(`shadow-digest: решений за сутки: ${summary.total} (провалов: ${summary.failed.length})`)
    console.log(`shadow-digest: шаблон сессии — ${file}`)
    return 0
  }

  const sessionTextPath = flag("--session-text")
  if (sessionTextPath === undefined) {
    console.error("shadow-digest: --finalize требует --session-text <file> с текстом теневого оркестратора")
    return 2
  }
  const sessionText = await readFile(path.resolve(sessionTextPath), "utf8")
  const file = await writeDigest(society, date, summary, sessionText)
  console.log(`shadow-digest: дайджест за ${date.toISOString().slice(0, 10)} — ${file}`)
  return 0
}

if (import.meta.main) {
  process.exitCode = await main()
}
