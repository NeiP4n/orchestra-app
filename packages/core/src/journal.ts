export * as Journal from "./journal.js"

import { randomUUID } from "node:crypto"
import { Cause, Effect, Option, Schema } from "effect"
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
 * the journal tables do not exist yet) the record is dropped — but the drop
 * is logged with the error itself, never silent (arch3 №24).
 *
 * `hasUnfinishedRun` is the read-only half of resume-on-start (block B8):
 * it answers whether a session has an unfinished autoloop run. Restart
 * recovery (block B4) does NOT call it today — `session/execution/restart.ts`
 * resumes by its own rules — and `readErrors` has no reader outside tests.
 * The journal is written and rarely read; that gap is open (arch3 №23).
 * This module only answers; it never restarts anything itself.
 */

export const ERROR_TYPE = "error.recorded"
export const DISPLAY_EVENT_TYPE = "desktop.display"

export interface DisplayEvent {
  /** The virtual display, e.g. `:99`. */
  readonly display: string
  readonly state: "started" | "alive" | "died"
  readonly sessionID?: string
  readonly detail?: Record<string, unknown>
  readonly time?: number
}

export interface StoredDisplayEvent {
  readonly id: string
  readonly time?: number
  readonly display: string
  readonly state: "started" | "alive" | "died"
  readonly sessionID?: string
  readonly detail?: Record<string, unknown>
}

/**
 * Virtual-display state (block B7) is a journal fact, like errors: which
 * display, whose session it serves, and whether it started or died. A dead
 * display is an event in the journal, never silence. Best-effort, same as
 * recordError: no database in scope means the record is dropped with a
 * log line, never a second failure.
 */
export const recordDisplayEvent = (input: DisplayEvent): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const db = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
    if (db === undefined) {
      yield* Effect.logWarning("error journal unavailable; dropping a recorded display event", {
        display: input.display,
        state: input.state,
      })
      return
    }
    const fact: AutoloopFact = {
      id: `desktop:${input.display}:${input.state}:${randomUUID()}`,
      type: DISPLAY_EVENT_TYPE,
      time: input.time ?? Date.now(),
      data: {
        display: input.display,
        state: input.state,
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
        ...(input.detail ? { detail: input.detail } : {}),
      },
    }
    yield* AutoloopStore.commitLatest([fact]).pipe(
      Effect.provideService(Database.Service, db),
      Effect.catchCause((cause) =>
        Effect.logWarning("error journal write failed; dropping a recorded display event", {
          display: input.display,
          state: input.state,
          cause: Cause.pretty(cause),
        }),
      ),
    )
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("error journal failed unexpectedly", { cause: Cause.pretty(cause) })))

const DisplayData = Schema.Struct({
  display: Schema.String,
  state: Schema.Literals(["started", "alive", "died"]),
  sessionID: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
const decodeDisplayData = Schema.decodeUnknownOption(DisplayData)

/** Every recorded virtual-display event, in journal order. */
export const readDisplayEvents = (): Effect.Effect<ReadonlyArray<StoredDisplayEvent>, unknown, Database.Service> =>
  Effect.gen(function* () {
    const facts = yield* AutoloopStore.readLog()
    return facts.flatMap((fact): Array<StoredDisplayEvent> => {
      if (fact.type !== DISPLAY_EVENT_TYPE) return []
      const data = Option.getOrUndefined(decodeDisplayData(fact.data))
      if (!data) return []
      return [
        {
          id: fact.id,
          time: fact.time,
          display: data.display,
          state: data.state,
          ...(data.sessionID ? { sessionID: data.sessionID } : {}),
          ...(data.detail ? { detail: data.detail } : {}),
        },
      ]
    })
  })

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
    if (db === undefined) {
      // arch3 №24: the old code returned silently — the error it was asked
      // to record vanished without a trace. Log it: the record is lost,
      // but the loss itself is visible.
      yield* Effect.logWarning("error journal unavailable; dropping a recorded error", {
        source: input.source,
        kind: input.kind,
        message: input.message,
      })
      return
    }
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
      Effect.catchCause((cause) =>
        Effect.logWarning("error journal write failed; dropping a recorded error", {
          source: input.source,
          kind: input.kind,
          message: input.message,
          cause: Cause.pretty(cause),
        }),
      ),
    )
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("error journal failed unexpectedly", { cause: Cause.pretty(cause) })))

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
