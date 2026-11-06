export * as ProjectFilesData from "./files-data.js"

import { randomUUID } from "node:crypto"
import { readdir, rm } from "node:fs/promises"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Room } from "@orchestra/schema/room"
import { Database } from "../database/database.js"
import { AutoloopStore } from "../autoloop/kernel/store.js"
import type { AutoloopFact } from "../autoloop/kernel/schema.js"
import { DodKanban } from "../dod-kanban.js"
import { ProjectFilesErrors } from "./errors.js"
import { ProjectFilesFormat } from "./format.js"
import type { Divergence } from "./health.js"
import { ProjectFilesPaths } from "./paths.js"

/**
 * Data files (slice S2): the kanban snapshot, the DoD history, the
 * append-only journals (errors/events/usage) and the quarantine mirror.
 *
 * Where truth lives:
 * - `kanban.yaml` is DERIVED from the DoD board (`Dod` + `Zones`): sync
 *   rewrites it from the live board, `compareKanban` reports when the
 *   file disagrees with the board. The DoD and the zones need NO syncer
 *   here — their files already ARE their stores.
 * - `errors.jsonl`, `events.jsonl`, `usage.jsonl` mirror the autoloop
 *   journal (`autoloop_facts`). The journal is append-only and its `seq`
 *   is assigned by the database, so the files are mirrors too: a sync
 *   appends only rows after the file's last `seq` (the watermark) and
 *   never rewrites history. There is deliberately NO restorer for them:
 *   replaying log lines into the journal would mint new sequences and
 *   duplicate facts. The journal is the truth; the files are its shadow.
 * - `quarantine.jsonl` mirrors the autoloop quarantine TABLE, which is a
 *   set, not a log — so its syncer rewrites the whole file. Its restorer
 *   is the point of the file: after a file-only restore, a poisoned fact
 *   is re-quarantined from the file instead of being replayed.
 * - `dod-history/` holds dated snapshots of `dod.yaml`, one per change.
 *   It is history, not state, so it has a syncer (snapshot when the DoD
 *   changed) and no restorer: an old board is never written back.
 *
 * All of these are runtime data (`git: false`): the kanban board is
 * rewritten on every sync and the logs grow on every run, so versioning
 * them would churn git without ever recording a decision.
 */

export const KANBAN_FILE = "kanban.yaml"
export const DOD_HISTORY_DIR = "dod-history"
/** How many dated DoD snapshots `dod-history/` keeps; older ones are pruned. */
export const DOD_HISTORY_KEEP = 30
export const ERRORS_FILE = "errors.jsonl"
export const EVENTS_FILE = "events.jsonl"
export const USAGE_FILE = "usage.jsonl"
export const QUARANTINE_FILE = "quarantine.jsonl"

/** One journal fact, mirrored into `events.jsonl`. */
export const EventEntry = Schema.Struct({
  seq: Schema.Number,
  /** Journal time in milliseconds since epoch; 0 when the fact carries no time. */
  at: Schema.Number,
  kind: Schema.String,
  id: Schema.String,
  collection: Schema.String.pipe(Schema.optional),
  key: Schema.String.pipe(Schema.optional),
  detail: Schema.Unknown.pipe(Schema.optional),
})
export type EventEntry = typeof EventEntry.Type

/** One failed fact, mirrored into `errors.jsonl`. */
export const ErrorEntry = Schema.Struct({
  seq: Schema.Number,
  at: Schema.Number,
  kind: Schema.String,
  message: Schema.String,
  detail: Schema.Unknown.pipe(Schema.optional),
})
export type ErrorEntry = typeof ErrorEntry.Type

/** One token-usage receipt, mirrored into `usage.jsonl`. */
export const UsageEntry = Schema.Struct({
  seq: Schema.Number,
  at: Schema.Number,
  run: Schema.String,
  session: Schema.String.pipe(Schema.optional),
  tokens: Schema.Record(Schema.String, Schema.Number),
})
export type UsageEntry = typeof UsageEntry.Type

/** One quarantined fact, mirrored into `quarantine.jsonl`. */
export const QuarantineEntry = Schema.Struct({
  seq: Schema.Number,
  reason: Schema.String,
  at: Schema.Number,
})
export type QuarantineEntry = typeof QuarantineEntry.Type

// --- kanban -----------------------------------------------------------------

const liveBoard = (directory: string): Effect.Effect<Room.DodBoard, ProjectFilesErrors.ProjectFileError> =>
  // The host view, without a room: there is no liveness source here, so a
  // claim with no lease reads stale, exactly as `Dod` documents for a bare
  // directory. A room server passes its own `live()` and may show fewer
  // stale cards; the file is the directory-local view, not the room view.
  DodKanban.board({ directory, viewer: { type: "host" } }).pipe(
    Effect.catchTag("Dod.Error", (error) =>
      Effect.fail(ProjectFilesErrors.corrupt("dod.yaml", error.message))
    ),
    Effect.catchTag("Zones.Error", (error) =>
      Effect.fail(ProjectFilesErrors.corrupt("zones.yaml", error.message))
    ),
  )

/** Writes the live board (host view) into `kanban.yaml`. */
export const syncKanban = (directory: string): Effect.Effect<void, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const board = yield* liveBoard(directory)
    yield* ProjectFilesFormat.writeYaml(ProjectFilesPaths.writePath(directory, KANBAN_FILE), board)
  })

/** Reads `kanban.yaml`. A corrupt file fails loudly, never as an empty board. */
export const readKanban = (directory: string): Effect.Effect<Room.DodBoard, ProjectFilesErrors.ProjectFileError> =>
  ProjectFilesFormat.readYaml(ProjectFilesPaths.readPath(directory, KANBAN_FILE), Room.DodBoard)

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  }
  return false
}

const describeBoardDiff = (live: Room.DodBoard, stored: Room.DodBoard): string => {
  const statesOf = (board: Room.DodBoard): Map<string, string> =>
    new Map(board.columns.flatMap((column) => column.cards.map((card) => [card.id, card.state] as const)))
  const liveStates = statesOf(live)
  const storedStates = statesOf(stored)
  const differing: Array<string> = []
  for (const [id, state] of liveStates) {
    const other = storedStates.get(id)
    if (other === undefined) differing.push(`${id}: live ${state}, file has no such card`)
    else if (other !== state) differing.push(`${id}: live ${state}, file ${other}`)
  }
  for (const id of storedStates.keys()) {
    if (!liveStates.has(id)) differing.push(`${id}: file has it, live board does not`)
  }
  const shown = differing.slice(0, 5)
  const more = differing.length - shown.length
  return [
    `live board has ${live.counts.total} cards (${live.counts.done} done), file has ${stored.counts.total} (${stored.counts.done} done)`,
    shown.length > 0 ? `differing cards: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}` : "",
  ]
    .filter((part) => part !== "")
    .join("; ")
}

/**
 * Compares `kanban.yaml` with the live board and returns the divergence
 * (empty when they agree) for `checkHealth`: a stale board shows up in
 * `health.json` instead of drifting silently. A missing file is not a
 * divergence — health already reports it as missing. A corrupt file fails
 * loudly instead of comparing as "different".
 */
export const compareKanban = (
  directory: string,
  live?: Room.DodBoard,
): Effect.Effect<ReadonlyArray<Divergence>, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const file = ProjectFilesPaths.readPath(directory, KANBAN_FILE)
    const exists = yield* ProjectFilesFormat.exists(file)
    if (!exists) return []
    const stored = yield* ProjectFilesFormat.readYaml(file, Room.DodBoard)
    const board = live ?? (yield* liveBoard(directory))
    if (deepEqual(board, stored)) return []
    return [{ path: KANBAN_FILE, detail: describeBoardDiff(board, stored) }]
  })

// --- dod-history ------------------------------------------------------------

const isNotFound = (error: unknown): boolean =>
  error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"

/** Dated snapshot names in `dod-history/`, oldest first (names sort by time). */
export const listDodHistory = (directory: string): Effect.Effect<ReadonlyArray<string>, ProjectFilesErrors.ProjectFileError> =>
  Effect.tryPromise({
    try: () =>
      readdir(ProjectFilesPaths.writePath(directory, DOD_HISTORY_DIR)).then((names) =>
        names.filter((name) => name.endsWith(".yaml")).sort(),
      ),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      isNotFound(error)
        ? Effect.succeed([] as ReadonlyArray<string>)
        : Effect.fail(
            ProjectFilesErrors.writeFailed(
              DOD_HISTORY_DIR,
              `cannot list ${DOD_HISTORY_DIR}: ${String(error)}`,
            ),
          )
    ),
  )

const pruneDodHistory = (directory: string): Effect.Effect<void, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const names = yield* listDodHistory(directory)
    const extra = names.slice(0, Math.max(0, names.length - DOD_HISTORY_KEEP))
    for (const name of extra) {
      yield* Effect.tryPromise({
        try: () => rm(path.join(ProjectFilesPaths.writePath(directory, DOD_HISTORY_DIR), name)),
        catch: (error) =>
          ProjectFilesErrors.writeFailed(
            `${DOD_HISTORY_DIR}/${name}`,
            `cannot prune ${DOD_HISTORY_DIR}/${name}: ${String(error)}`,
          ),
      })
    }
  })

/**
 * Writes a dated snapshot of the current `dod.yaml` into `dod-history/`
 * and prunes older ones past the cap. The name carries the time plus a
 * short random suffix, so two snapshots in the same millisecond never
 * collide (the arch3 №32 lesson: a bare timestamp is not unique).
 */
export const snapshotDod = (
  directory: string,
  options?: { at?: Date },
): Effect.Effect<{ name: string }, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const text = yield* ProjectFilesFormat.readText(ProjectFilesPaths.readPath(directory, "dod.yaml"))
    const dir = ProjectFilesPaths.writePath(directory, DOD_HISTORY_DIR)
    yield* ProjectFilesFormat.ensureDir(dir)
    const name = snapshotName(options?.at ?? new Date())
    yield* ProjectFilesFormat.writeText(path.join(dir, name), text)
    yield* pruneDodHistory(directory)
    return { name }
  })

// Snapshots in the same millisecond must still sort by creation order: a
// bare timestamp is not unique (the arch3 №32 lesson), so the name carries
// a per-process sequence after the stamp, then a random suffix so two
// processes snapshotting in the same millisecond never collide.
let lastStamp = ""
let stampSequence = 0
const snapshotName = (at: Date): string => {
  const stamp = at.toISOString().replace(/[:.]/g, "-")
  stampSequence = stamp === lastStamp ? stampSequence + 1 : 0
  lastStamp = stamp
  return `${stamp}-${String(stampSequence).padStart(4, "0")}-${randomUUID().slice(0, 8)}.yaml`
}

/**
 * Snapshots the DoD only when it changed since the latest snapshot: the
 * history records changes, not every sync run. A missing `dod.yaml` fails
 * loudly — a history of nothing is not a snapshot.
 */
export const snapshotDodIfChanged = (
  directory: string,
): Effect.Effect<{ changed: boolean; name: string | null }, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const text = yield* ProjectFilesFormat.readText(ProjectFilesPaths.readPath(directory, "dod.yaml"))
    const names = yield* listDodHistory(directory)
    const latest = names.at(-1)
    if (latest !== undefined) {
      const previous = yield* ProjectFilesFormat.readText(
        path.join(ProjectFilesPaths.writePath(directory, DOD_HISTORY_DIR), latest),
      )
      if (previous === text) return { changed: false, name: null }
    }
    const created = yield* snapshotDod(directory)
    return { changed: true, name: created.name }
  })

// --- journal mirrors (errors/events/usage) ----------------------------------

interface JournalRow {
  readonly seq: number
  readonly fact: AutoloopFact
}

const journalRows = (file: string): Effect.Effect<ReadonlyArray<JournalRow>, ProjectFilesErrors.ProjectFileError, Database.Service> =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .all<{ seq: number; fact: string }>(sql`SELECT seq, fact FROM autoloop_facts ORDER BY seq ASC`)
      .pipe(
        Effect.mapError((error) =>
          ProjectFilesErrors.writeFailed(file, `cannot read the autoloop journal: ${String(error)}`)
        ),
      )
    const parsed: Array<JournalRow> = []
    for (const row of rows) {
      const fact = yield* Effect.try({
        try: () => JSON.parse(row.fact) as AutoloopFact,
        catch: (error) =>
          ProjectFilesErrors.corrupt(file, `autoloop journal row ${row.seq} is not valid JSON: ${String(error)}`),
      })
      parsed.push({ seq: row.seq, fact })
    }
    return parsed
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A fact counts as an error when its type says so, or its receipt failed. */
const isErrorFact = (fact: AutoloopFact): boolean => {
  if (/fail|error/i.test(fact.type)) return true
  const data = fact.data
  if (!isRecord(data)) return false
  return data["outcome"] === "failed" || data["state"] === "failed"
}

const errorMessage = (fact: AutoloopFact): string => {
  const data = fact.data
  if (isRecord(data)) {
    for (const key of ["summary", "detail", "message"]) {
      const value = data[key]
      if (typeof value === "string" && value !== "") return value
    }
  }
  return fact.id
}

/** The token receipt a run-finish fact carries, if any. */
const usageOf = (fact: AutoloopFact): Record<string, number> | undefined => {
  const data = fact.data
  if (!isRecord(data)) return undefined
  const usage = data["usage"]
  if (!isRecord(usage)) return undefined
  if (Object.values(usage).some((value) => typeof value !== "number")) return undefined
  return usage as Record<string, number>
}

const toEventEntry = (row: JournalRow): EventEntry => ({
  seq: row.seq,
  at: row.fact.time ?? 0,
  kind: row.fact.type,
  id: row.fact.id,
  ...(row.fact.collection !== undefined ? { collection: row.fact.collection } : {}),
  ...(row.fact.key !== undefined ? { key: row.fact.key } : {}),
  ...(row.fact.data !== undefined ? { detail: row.fact.data } : {}),
})

const toErrorEntry = (row: JournalRow): ErrorEntry => ({
  seq: row.seq,
  at: row.fact.time ?? 0,
  kind: row.fact.type,
  message: errorMessage(row.fact),
  ...(row.fact.data !== undefined ? { detail: row.fact.data } : {}),
})

const toUsageEntry = (row: JournalRow, tokens: Record<string, number>): UsageEntry => ({
  seq: row.seq,
  at: row.fact.time ?? 0,
  run: row.fact.key ?? row.fact.id,
  ...(isRecord(row.fact.data) && typeof row.fact.data["session"] === "string"
    ? { session: row.fact.data["session"] }
    : {}),
  tokens,
})

/**
 * Highest `seq` already in the log, across the live file and its rotated
 * copy (`.jsonl.1`): after rotation the old rows live in the copy, and a
 * watermark read from the live file alone would re-append them.
 * A corrupt line fails loudly instead of letting the sync guess a mark.
 */
const watermark = (
  directory: string,
  rel: string,
  schema: Schema.Codec<{ readonly seq: number }, unknown, never>,
): Effect.Effect<number, ProjectFilesErrors.ProjectFileError> =>
  Effect.gen(function* () {
    const main = yield* ProjectFilesFormat.readJsonl(ProjectFilesPaths.readPath(directory, rel), schema)
    const rotated = yield* ProjectFilesFormat.readJsonl(ProjectFilesPaths.readPath(directory, `${rel}.1`), schema)
    return [...main, ...rotated].reduce((max, entry) => Math.max(max, entry.seq), 0)
  })

/**
 * Appends only the journal rows after the watermark. Best-effort by the
 * log's own rule (`appendJsonl` never throws): a failed append leaves the
 * watermark where it was, so the next sync retries the same rows instead
 * of losing them silently.
 */
const syncLog = (
  directory: string,
  rel: string,
  schema: Schema.Codec<{ readonly seq: number }, unknown, never>,
  pick: (row: JournalRow) => unknown,
): Effect.Effect<void, ProjectFilesErrors.ProjectFileError, Database.Service> =>
  Effect.gen(function* () {
    const mark = yield* watermark(directory, rel, schema)
    const rows = yield* journalRows(rel)
    const file = ProjectFilesPaths.writePath(directory, rel)
    for (const row of rows) {
      if (row.seq <= mark) continue
      const entry = pick(row)
      if (entry === undefined) continue
      yield* ProjectFilesFormat.appendJsonl(file, entry)
    }
  })

/** Mirrors every journal fact into `events.jsonl`. */
export const syncEvents = (directory: string): Effect.Effect<void, ProjectFilesErrors.ProjectFileError, Database.Service> =>
  syncLog(directory, EVENTS_FILE, EventEntry, toEventEntry)

/** Mirrors failed journal facts into `errors.jsonl`. */
export const syncErrors = (directory: string): Effect.Effect<void, ProjectFilesErrors.ProjectFileError, Database.Service> =>
  syncLog(directory, ERRORS_FILE, ErrorEntry, (row) => (isErrorFact(row.fact) ? toErrorEntry(row) : undefined))

/** Mirrors token receipts from journal facts into `usage.jsonl`. */
export const syncUsage = (directory: string): Effect.Effect<void, ProjectFilesErrors.ProjectFileError, Database.Service> =>
  syncLog(directory, USAGE_FILE, UsageEntry, (row) => {
    const tokens = usageOf(row.fact)
    return tokens === undefined ? undefined : toUsageEntry(row, tokens)
  })

/** Reads `events.jsonl`. A missing file is an empty log; a bad line is corrupt. */
export const readEvents = (directory: string): Effect.Effect<ReadonlyArray<EventEntry>, ProjectFilesErrors.ProjectFileError> =>
  ProjectFilesFormat.readJsonl(ProjectFilesPaths.readPath(directory, EVENTS_FILE), EventEntry)

/** Reads `errors.jsonl`. A missing file is an empty log; a bad line is corrupt. */
export const readErrors = (directory: string): Effect.Effect<ReadonlyArray<ErrorEntry>, ProjectFilesErrors.ProjectFileError> =>
  ProjectFilesFormat.readJsonl(ProjectFilesPaths.readPath(directory, ERRORS_FILE), ErrorEntry)

/** Reads `usage.jsonl`. A missing file is an empty log; a bad line is corrupt. */
export const readUsage = (directory: string): Effect.Effect<ReadonlyArray<UsageEntry>, ProjectFilesErrors.ProjectFileError> =>
  ProjectFilesFormat.readJsonl(ProjectFilesPaths.readPath(directory, USAGE_FILE), UsageEntry)

// --- quarantine -------------------------------------------------------------

/**
 * Rewrites `quarantine.jsonl` from the quarantine table. The table is a
 * set, not a log, so a full rewrite is the sync — an unquarantined fact
 * leaves the file instead of lingering as a stale line.
 */
export const syncQuarantine = (
  directory: string,
): Effect.Effect<void, ProjectFilesErrors.ProjectFileError, Database.Service> =>
  Effect.gen(function* () {
    const entries = yield* AutoloopStore.listQuarantine().pipe(
      Effect.mapError((error) =>
        ProjectFilesErrors.writeFailed(
          QUARANTINE_FILE,
          `cannot read the autoloop quarantine table: ${String(error)}`,
        )
      ),
    )
    const text = entries
      .map((entry) => JSON.stringify({ seq: entry.seq, reason: entry.reason, at: entry.at }))
      .join("\n")
    yield* ProjectFilesFormat.writeText(
      ProjectFilesPaths.writePath(directory, QUARANTINE_FILE),
      text === "" ? "" : `${text}\n`,
    )
  })

/** Reads `quarantine.jsonl`. A missing file is an empty quarantine; a bad line is corrupt. */
export const readQuarantine = (
  directory: string,
): Effect.Effect<ReadonlyArray<QuarantineEntry>, ProjectFilesErrors.ProjectFileError> =>
  ProjectFilesFormat.readJsonl(ProjectFilesPaths.readPath(directory, QUARANTINE_FILE), QuarantineEntry)

/**
 * Re-quarantines every fact listed in `quarantine.jsonl`. This is the
 * point of the mirror: after a file-only restore the journal still holds
 * the poisoned fact, and without this step the next rebuild would replay
 * it. Entries already quarantined are kept, not duplicated; a fact the
 * journal no longer has fails the restore loudly instead of being
 * dropped silently. A missing file is a skip — no quarantine to restore.
 */
export const restoreQuarantine = (
  directory: string,
): Effect.Effect<
  { readonly file: string; readonly status: "restored" | "skipped" | "failed"; readonly count?: number },
  ProjectFilesErrors.ProjectFileError,
  Database.Service
> =>
  Effect.gen(function* () {
    const file = ProjectFilesPaths.readPath(directory, QUARANTINE_FILE)
    const exists = yield* ProjectFilesFormat.exists(file)
    if (!exists) return { file: QUARANTINE_FILE, status: "skipped" as const }
    const entries = yield* ProjectFilesFormat.readJsonl(file, QuarantineEntry)
    let restored = 0
    const failed: Array<number> = []
    for (const entry of entries) {
      const result = yield* AutoloopStore.quarantine(entry.seq, entry.reason).pipe(
        Effect.map((outcome) => ({ ok: true as const, changed: outcome.changed })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error: String(error) })),
      )
      if (result.ok) {
        if (result.changed) restored++
      } else {
        failed.push(entry.seq)
      }
    }
    if (failed.length > 0) {
      return yield* Effect.fail(
        ProjectFilesErrors.restoreFailed(
          QUARANTINE_FILE,
          `could not re-quarantine seq(s) ${failed.join(", ")}: the journal has no such fact(s)`,
        ),
      )
    }
    return { file: QUARANTINE_FILE, status: "restored" as const, count: restored }
  })
