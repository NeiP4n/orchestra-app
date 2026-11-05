export * as AutoloopStore from "./store.js"

import { sql } from "drizzle-orm"
import { Effect, Schema, Stream } from "effect"
import { Database } from "../../database/database.js"
import { diff, evolve } from "./evolve.js"
import type { View } from "./evolve.js"
import { FORMAT, META_FORMAT, META_LAST_SEQ } from "./schema.js"
import type { AutoloopFact } from "./schema.js"

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

/** All facts in journal order. */
export function readLog() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db.all<{ seq: number; fact: string }>(
      sql`SELECT seq, fact FROM autoloop_facts ORDER BY seq ASC`,
    )
    return rows.map((row) => JSON.parse(row.fact) as AutoloopFact)
  })
}

/** The journal as a stream, in `seq` order. */
export function iterateLog() {
  return Stream.unwrap(Effect.map(readLog(), (facts) => Stream.fromIterable(facts)))
}

/** Stored projections plus journal metadata, without replaying the journal. */
export function openView(): Effect.Effect<OpenedView, unknown, Database.Service> {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const projectionRows = yield* db.all<{ collection: string; key: string; data: string }>(
      sql`SELECT collection, key, data FROM autoloop_projections`,
    )
    const metaRows = yield* db.all<{ key: string; value: string }>(
      sql`SELECT key, value FROM autoloop_projection_meta`,
    )
    const lastSeqRow = yield* db.get<{ seq: number | null }>(sql`SELECT MAX(seq) AS seq FROM autoloop_facts`)
    const meta = new Map(metaRows.map((row) => [row.key, row.value]))
    const storedSeq = meta.get(META_LAST_SEQ)
    return {
      view: viewFromRows(projectionRows),
      lastSeq: storedSeq === undefined ? (lastSeqRow?.seq ?? 0) : Number(storedSeq),
      format: meta.get(META_FORMAT) ?? null,
    }
  })
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
          yield* tx.run(
            sql`INSERT INTO autoloop_facts (seq, fact) VALUES (${seqs[index]}, ${JSON.stringify(fact)})`,
          )
        }
        const projectionRows = yield* tx.all<{ collection: string; key: string; data: string }>(
          sql`SELECT collection, key, data FROM autoloop_projections`,
        )
        const oldView = viewFromRows(projectionRows)
        const newView = facts.reduce((view, fact) => evolve(view, fact), oldView)
        for (const { collection, key } of diff(oldView, newView)) {
          const data = newView[collection]?.[key]
          if (data === undefined) {
            yield* tx.run(
              sql`DELETE FROM autoloop_projections WHERE collection = ${collection} AND key = ${key}`,
            )
            yield* tx.run(
              sql`DELETE FROM autoloop_projection_refs WHERE collection = ${collection} AND key = ${key}`,
            )
            continue
          }
          yield* tx.run(sql`
            INSERT INTO autoloop_projections (collection, key, data)
            VALUES (${collection}, ${key}, ${JSON.stringify(data)})
            ON CONFLICT(collection, key) DO UPDATE SET data = excluded.data
          `)
          yield* tx.run(
            sql`DELETE FROM autoloop_projection_refs WHERE collection = ${collection} AND key = ${key}`,
          )
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
  })
}

/** `commit` without an expected sequence: reads the latest sequence inside the same transaction. */
export function commitLatest(facts: ReadonlyArray<AutoloopFact>) {
  return commit(facts)
}
