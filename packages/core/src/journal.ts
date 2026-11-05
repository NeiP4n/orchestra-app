export * as Journal from "./journal.js"

import { randomUUID } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { AutoloopStore } from "./autoloop/kernel/store.js"
import type { AutoloopFact } from "./autoloop/kernel/schema.js"
import { Database } from "./database/database.js"

/**
 * The error journal (block B8) is a thin writer/reader over the autoloop
 * journal (block B2): errors are journal-only facts — recorded durably in
 * `orchestra-local.db`, but they change no projection, so decide() never sees
 * them. There is no separate error database to lose, back up, or reconcile.
 *
 * Recording is best-effort by design: a journal write must never turn the
 * failure it reports into a second failure. When no database is in scope (or
 * the journal tables do not exist yet) the record is silently skipped.
 *
 * `hasUnfinishedRun` is the read-only half of resume-on-start (block B8):
 * restart recovery (block B4) asks it whether a session has an unfinished
 * autoloop run and resumes only then, instead of resuming every session it
 * finds. This module only answers; it never restarts anything itself.
 */

export const ERROR_TYPE = "error.recorded"

export interface ErrorRecord {
  readonly source: string
  readonly kind: string
  readonly message: string
  readonly sessionID?: string
  readonly detail?: Record<string, unknown>
  readonly time?: number
}

export interface StoredError {
  readonly id: string
  readonly time?: number
  readonly source: string
  readonly kind: string
  readonly message: string
  readonly sessionID?: string
  readonly detail?: Record<string, unknown>
}

const ErrorData = Schema.Struct({
  source: Schema.String,
  kind: Schema.String,
  message: Schema.String,
  sessionID: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
const decodeErrorData = Schema.decodeUnknownOption(ErrorData)

export const recordError = (input: ErrorRecord): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const db = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
    if (db === undefined) return
    const fact: AutoloopFact = {
      id: `err:${input.source}:${randomUUID()}`,
      type: ERROR_TYPE,
      time: input.time ?? Date.now(),
      data: {
        source: input.source,
        kind: input.kind,
        message: input.message,
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
        ...(input.detail ? { detail: input.detail } : {}),
      },
    }
    yield* AutoloopStore.commitLatest([fact]).pipe(
      Effect.provideService(Database.Service, db),
      Effect.ignore,
    )
  }).pipe(Effect.catchCause(() => Effect.void))

/** Every recorded error, in journal order. */
export const readErrors = (): Effect.Effect<ReadonlyArray<StoredError>, unknown, Database.Service> =>
  Effect.gen(function* () {
    const facts = yield* AutoloopStore.readLog()
    return facts.flatMap((fact): Array<StoredError> => {
      if (fact.type !== ERROR_TYPE) return []
      const data = Option.getOrUndefined(decodeErrorData(fact.data))
      if (!data) return []
      return [
        {
          id: fact.id,
          time: fact.time,
          source: data.source,
          kind: data.kind,
          message: data.message,
          ...(data.sessionID ? { sessionID: data.sessionID } : {}),
          ...(data.detail ? { detail: data.detail } : {}),
        },
      ]
    })
  })

const UNFINISHED_RUN_STATES = new Set(["queued", "claimed", "unknown"])

const isRow = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/** Whether the session has an autoloop run that never reached a terminal state. */
export const hasUnfinishedRun = (sessionID: string): Effect.Effect<boolean, unknown, Database.Service> =>
  Effect.gen(function* () {
    const { view } = yield* AutoloopStore.openView()
    const runs = view["runs"] ?? {}
    return Object.values(runs).some(
      (row) => isRow(row) && row["session"] === sessionID && UNFINISHED_RUN_STATES.has(String(row["state"])),
    )
  })
