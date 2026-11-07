export * as AutoloopStore from "./store.js"

import { sql } from "drizzle-orm"
import { Effect, Schema, Stream } from "effect"
import { Database } from "../../database/database.js"
import type { EffectDrizzleSqlite } from "../../database/drizzle.js"
import { diff, evolve, rebuild, snapshot } from "./evolve.js"
import type { View } from "./evolve.js"
import { FORMAT, META_FORMAT, META_LAST_SEQ } from "./schema.js"
import type { AutoloopFact } from "./schema.js"

type Transaction = Parameters<Parameters<EffectDrizzleSqlite.EffectSQLiteDatabase["transaction"]>[0]>[0]

// The ONLY module that appends facts to the journal (block B2). Every write
// goes through `commit` / `commitLatest`, which insert the facts and update
// the projections in a single transaction — a failed commit leaves neither a
// half-written fact nor a stale projection behind. Reads go through
// `readLog` / `openView`; `decide` (block B3) stays a pure function over the
// view and never touches the database itself.
//
// Storage is the existing `orchestra-local.db` via EffectDrizzleSqlite
// (the SqlClient-backed database behind `Database.Service`); there is no
// separate `hub.db` and no `node:sqlite` DatabaseSync anywhere here.

export class StaleSeqError extends Schema.TaggedError<StaleSeqError>()("Autoloop.StaleSeq", {
  expected: Schema.Number,
  actual: Schema.Number,
}) {}

/** A journal read or write failed: the store is unavailable; the operation says where. */
export class StoreError extends Schema.TaggedError<StoreError>()("Autoloop.StoreError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/** Maps an untyped database failure to a StoreError, keeping typed failures intact. */
const storeError =
  (operation: string) =>
  (cause: unknown): StoreError | StaleSeqError =>
    cause instanceof StoreError || cause instanceof StaleSeqError
      ? cause
      : new StoreError({ operation, message: cause instanceof Error ? cause.message : String(cause) })

export interface CommitResult {
  /** Sequences assigned to the committed facts, in commit order. */
  seqs: number[]
  /** Latest sequence in the journal after the commit. */
  lastSeq: number
  /** View after folding the committed facts. */
  view: View
}

export interface OpenedView {
  view: View
  lastSeq: number
  /** Kernel format that built the stored projections, or null before the first commit. */
  format: string | null
}

function viewFromRows(rows: ReadonlyArray<{ collection: string; key: string; data: string }>): View {
  const view: View = {}
  for (const row of rows) {
    view[row.collection] ??= {}
    view[row.collection]![row.key] = JSON.parse(row.data) as Record<string, unknown>
  }
  return view
}

/** All facts in journal order, with their sequences. */
function readLogWithSeqs() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db.all<{ seq: number; fact: string }>(
      sql`SELECT seq, fact FROM autoloop_facts ORDER BY seq ASC`,
    )
    return rows.map((row) => ({ seq: row.seq, fact: JSON.parse(row.fact) as AutoloopFact }))
  })
}

/** All facts in journal order. */
export function readLog() {
  return Effect.map(readLogWithSeqs(), (rows) => rows.map((row) => row.fact)).pipe(
    Effect.mapError(storeError("readLog")),
  )
}

/** A quarantined fact: kept in the journal as evidence, never folded into the view. */
export interface QuarantineEntry {
  seq: number
  reason: string
  /** When the fact was quarantined, as a unix timestamp in milliseconds. */
  at: number
}

/** Every quarantined fact, in `seq` order. */
export function listQuarantine() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.all<QuarantineEntry>(sql`SELECT seq, reason, at FROM autoloop_quarantine ORDER BY seq ASC`)
  }).pipe(Effect.mapError(storeError("listQuarantine")))
}

function readQuarantinedSeqs() {
  return Effect.map(listQuarantine(), (entries) => new Set(entries.map((entry) => entry.seq)))
}

/** Facts in journal order, without the quarantined ones. The journal itself keeps everything. */
function readActiveFacts() {
  return Effect.gen(function* () {
    const rows = yield* readLogWithSeqs()
    const quarantined = yield* readQuarantinedSeqs()
    return rows.filter((row) => !quarantined.has(row.seq)).map((row) => row.fact)
  })
}

/** Rewrites the stored projections from the given facts, inside the caller's transaction. */
function rewriteProjectionsInTx(tx: Transaction, facts: readonly AutoloopFact[]) {
  return Effect.gen(function* () {
    const view = rebuild(facts)
    const lastRefs = new Map<string, Array<{ collection: string; key: string }>>()
    for (const fact of facts) {
      if (fact.collection !== undefined && fact.key !== undefined) {
        lastRefs.set(`${fact.collection}:${fact.key}`, fact.refs ?? [])
      }
    }
    const lastSeqRow = yield* tx.get<{ seq: number | null }>(sql`SELECT MAX(seq) AS seq FROM autoloop_facts`)
    yield* tx.run(sql`DELETE FROM autoloop_projections`)
    yield* tx.run(sql`DELETE FROM autoloop_projection_refs`)
    yield* tx.run(sql`DELETE FROM autoloop_projection_meta`)
    for (const { collection, key, data } of snapshot(view)) {
      yield* tx.run(sql`
        INSERT INTO autoloop_projections (collection, key, data)
        VALUES (${collection}, ${key}, ${JSON.stringify(data)})
      `)
      for (const ref of lastRefs.get(`${collection}:${key}`) ?? []) {
        yield* tx.run(sql`
          INSERT OR IGNORE INTO autoloop_projection_refs (collection, key, ref_collection, ref_key)
          VALUES (${collection}, ${key}, ${ref.collection}, ${ref.key})
        `)
      }
    }
    const lastSeq = lastSeqRow?.seq ?? 0
    yield* tx.run(sql`
      INSERT INTO autoloop_projection_meta (key, value) VALUES (${META_LAST_SEQ}, ${String(lastSeq)})
    `)
    yield* tx.run(sql`
      INSERT INTO autoloop_projection_meta (key, value) VALUES (${META_FORMAT}, ${FORMAT})
    `)
    return { view, lastSeq }
  })
}

/** The journal as a stream, in `seq` order. */
export function iterateLog() {
  return Stream.unwrap(Effect.map(readLog(), (facts) => Stream.fromIterable(facts)))
}

/** Stored projections plus journal metadata, without replaying the journal. */
export function openView(): Effect.Effect<OpenedView, StoreError, Database.Service> {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const projectionRows = yield* db.all<{ collection: string; key: string; data: string }>(
      sql`SELECT collection, key, data FROM autoloop_projections`,
    )
    const metaRows = yield* db.all<{ key: string; value: string }>(sql`SELECT key, value FROM autoloop_projection_meta`)
    const lastSeqRow = yield* db.get<{ seq: number | null }>(sql`SELECT MAX(seq) AS seq FROM autoloop_facts`)
    const meta = new Map(metaRows.map((row) => [row.key, row.value]))
    const storedSeq = meta.get(META_LAST_SEQ)
    const parsedSeq = storedSeq === undefined ? undefined : Number(storedSeq)
    // №51: the stored sequence is a string, and a damaged one parses to
    // NaN — which then poisoned every caller that compared against lastSeq.
    // A damaged value falls back to the journal's real latest sequence.
    const lastSeq = parsedSeq !== undefined && Number.isInteger(parsedSeq) ? parsedSeq : (lastSeqRow?.seq ?? 0)
    return {
      view: viewFromRows(projectionRows),
      lastSeq,
      format: meta.get(META_FORMAT) ?? null,
    }
  }).pipe(Effect.mapError(storeError("openView")))
}

/**
 * Append facts and update projections in one transaction. When `expectedSeq`
 * is given, the commit only proceeds if it equals the journal's current
 * latest sequence — otherwise it fails with `StaleSeqError` and writes
 * nothing, instead of silently overwriting concurrent work.
 */
export function commit(facts: ReadonlyArray<AutoloopFact>, expectedSeq?: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    if (facts.length === 0) {
      const opened = yield* openView()
      return { seqs: [], lastSeq: opened.lastSeq, view: opened.view } satisfies CommitResult
    }
    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const current = yield* tx.get<{ seq: number | null }>(sql`SELECT MAX(seq) AS seq FROM autoloop_facts`)
        const lastSeq = current?.seq ?? 0
        if (expectedSeq !== undefined && expectedSeq !== lastSeq) {
          return yield* Effect.fail(new StaleSeqError({ expected: expectedSeq, actual: lastSeq }))
        }
        const seqs = facts.map((_, index) => lastSeq + index + 1)
        for (const [index, fact] of facts.entries()) {
          yield* tx.run(sql`INSERT INTO autoloop_facts (seq, fact) VALUES (${seqs[index]}, ${JSON.stringify(fact)})`)
        }
        const projectionRows = yield* tx.all<{ collection: string; key: string; data: string }>(
          sql`SELECT collection, key, data FROM autoloop_projections`,
        )
        const oldView = viewFromRows(projectionRows)
        const newView = facts.reduce((view, fact) => evolve(view, fact), oldView)
        for (const { collection, key } of diff(oldView, newView)) {
          const data = newView[collection]?.[key]
          if (data === undefined) {
            yield* tx.run(sql`DELETE FROM autoloop_projections WHERE collection = ${collection} AND key = ${key}`)
            yield* tx.run(sql`DELETE FROM autoloop_projection_refs WHERE collection = ${collection} AND key = ${key}`)
            continue
          }
          yield* tx.run(sql`
            INSERT INTO autoloop_projections (collection, key, data)
            VALUES (${collection}, ${key}, ${JSON.stringify(data)})
            ON CONFLICT(collection, key) DO UPDATE SET data = excluded.data
          `)
          yield* tx.run(sql`DELETE FROM autoloop_projection_refs WHERE collection = ${collection} AND key = ${key}`)
          const refs = facts.filter((fact) => fact.collection === collection && fact.key === key).at(-1)?.refs ?? []
          for (const ref of refs) {
            yield* tx.run(sql`
              INSERT OR IGNORE INTO autoloop_projection_refs (collection, key, ref_collection, ref_key)
              VALUES (${collection}, ${key}, ${ref.collection}, ${ref.key})
            `)
          }
        }
        const newLastSeq = seqs.at(-1)!
        yield* tx.run(sql`
          INSERT INTO autoloop_projection_meta (key, value) VALUES (${META_LAST_SEQ}, ${String(newLastSeq)})
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `)
        yield* tx.run(sql`
          INSERT INTO autoloop_projection_meta (key, value) VALUES (${META_FORMAT}, ${FORMAT})
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `)
        return { seqs, lastSeq: newLastSeq, view: newView } satisfies CommitResult
      }),
    )
  }).pipe(Effect.mapError(storeError("commit")))
}

/** `commit` without an expected sequence: reads the latest sequence inside the same transaction. */
export function commitLatest(facts: ReadonlyArray<AutoloopFact>) {
  return commit(facts)
}

/**
 * Rewrite the stored projections from the journal in one transaction. The
 * service runs this at start when the stored kernel format no longer
 * matches `FORMAT`: the journal is the source of truth and the projections
 * are disposable, so a format change rebuilds them instead of trusting rows
 * folded by older kernel code. Quarantined facts are skipped (A3-11) and
 * the skip is logged with the count, so a rebuild never silently drops
 * evidence. Returns the rebuilt view and latest sequence.
 */
export function rebuildProjections() {
  return Effect.gen(function* () {
    const quarantined = yield* readQuarantinedSeqs()
    const facts = yield* readActiveFacts()
    if (quarantined.size > 0)
      yield* Effect.logInfo(
        `autoloop rebuild skipped ${quarantined.size} quarantined fact(s); the journal keeps them`,
        { quarantined: [...quarantined].sort((a, b) => a - b) },
      )
    const { db } = yield* Database.Service
    return yield* db.transaction((tx) => rewriteProjectionsInTx(tx, facts))
  }).pipe(Effect.mapError(storeError("rebuildProjections")))
}

export interface QuarantineResult {
  /** The quarantined (or unquarantined) sequence. */
  seq: number
  /** True when this call changed the mark; false when it was already in that state. */
  changed: boolean
  /** View after the rebuild that follows the mark change. */
  view: View
  lastSeq: number
}

/**
 * Quarantines one fact (A3-11): the fact stays in the journal as evidence,
 * but the stored projections are rebuilt in the same transaction without
 * it, so the poisoned fact stops affecting decisions at once — and no later
 * rebuild replays it. Fails when no fact has that sequence.
 */
export function quarantine(seq: number, reason: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const found = yield* db.get<{ seq: number }>(sql`SELECT seq FROM autoloop_facts WHERE seq = ${seq}`)
    if (found === undefined) return yield* Effect.fail(new Error(`No autoloop fact with seq ${seq} to quarantine`))
    const at = Date.now()
    const rebuilt = yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const already = yield* tx.get<{ seq: number }>(sql`SELECT seq FROM autoloop_quarantine WHERE seq = ${seq}`)
        if (already === undefined)
          yield* tx.run(sql`INSERT INTO autoloop_quarantine (seq, reason, at) VALUES (${seq}, ${reason}, ${at})`)
        const rows = yield* tx.all<{ seq: number; fact: string }>(
          sql`SELECT seq, fact FROM autoloop_facts ORDER BY seq ASC`,
        )
        const blocked = new Set(
          (yield* tx.all<{ seq: number }>(sql`SELECT seq FROM autoloop_quarantine`)).map((row) => row.seq),
        )
        const facts = rows.filter((row) => !blocked.has(row.seq)).map((row) => JSON.parse(row.fact) as AutoloopFact)
        const rewritten = yield* rewriteProjectionsInTx(tx, facts)
        return { changed: already === undefined, view: rewritten.view, lastSeq: rewritten.lastSeq }
      }),
    )
    yield* Effect.logWarning(`autoloop fact ${seq} quarantined; its effect left the projections`, {
      seq,
      reason,
      alreadyQuarantined: !rebuilt.changed,
    })
    return { seq, changed: rebuilt.changed, view: rebuilt.view, lastSeq: rebuilt.lastSeq } satisfies QuarantineResult
  }).pipe(Effect.mapError(storeError("quarantine")))
}

/**
 * Lifts a quarantine: the fact plays again at the next rebuild, which
 * happens in the same transaction, so the projections reflect it at once.
 * Unquarantining a fact that was never quarantined is a no-op.
 */
export function unquarantine(seq: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rebuilt = yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const marked = yield* tx.get<{ seq: number }>(sql`SELECT seq FROM autoloop_quarantine WHERE seq = ${seq}`)
        if (marked !== undefined) yield* tx.run(sql`DELETE FROM autoloop_quarantine WHERE seq = ${seq}`)
        const rows = yield* tx.all<{ seq: number; fact: string }>(
          sql`SELECT seq, fact FROM autoloop_facts ORDER BY seq ASC`,
        )
        const blocked = new Set(
          (yield* tx.all<{ seq: number }>(sql`SELECT seq FROM autoloop_quarantine`)).map((row) => row.seq),
        )
        const facts = rows.filter((row) => !blocked.has(row.seq)).map((row) => JSON.parse(row.fact) as AutoloopFact)
        const rewritten = yield* rewriteProjectionsInTx(tx, facts)
        return { changed: marked !== undefined, view: rewritten.view, lastSeq: rewritten.lastSeq }
      }),
    )
    yield* Effect.logInfo(`autoloop fact ${seq} unquarantined; its effect is back in the projections`, { seq })
    return { seq, changed: rebuilt.changed, view: rebuilt.view, lastSeq: rebuilt.lastSeq } satisfies QuarantineResult
  }).pipe(Effect.mapError(storeError("unquarantine")))
}
