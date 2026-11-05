export * as ForgeJournal from "./forge-journal.js"

import { Cause, Effect, Option } from "effect"
import { Database } from "../../database/database.js"
import { AutoloopStore } from "../../autoloop/kernel/store.js"
import type { AutoloopFact } from "../../autoloop/kernel/schema.js"

// A tool the forge generates does not become trusted by being generated: it is only
// a config entry the model wrote. Every registration therefore leaves a record in the
// autoloop journal — who generated it, what it is, and what it replaced — so the
// operator can see it later and roll it back. The record is journal-only (no
// projection): it is audit history, not cycle state.
//
// No permission is asked: autonomy is the default, and the journal write is silent.
// The write is best-effort on purpose — a runtime without a database (or without the
// autoloop tables) still registers the tool; losing the record must never break the
// registration itself. In production the database and the tables exist, so the record
// lands.

export type ForgeAction = "registered" | "removed" | "enabled" | "disabled"

export interface ForgeRecord {
  readonly kind: "mcp" | "plugin"
  readonly action: ForgeAction
  /** Server name (mcp) or plugin specifier (plugin). */
  readonly name: string
  /** Where the server came from: tools, openapi, cli, server. */
  readonly source?: string
  /** Session that generated it. */
  readonly by?: string
  /** What was registered before, or null when the name was new. Rollback restores this. */
  readonly previous?: unknown
  readonly detail?: Record<string, unknown>
}

/** The journal fact for a forge registration. Pure: test the record without a database. */
export function forgeFact(input: ForgeRecord, now = Date.now()): AutoloopFact {
  return {
    id: `evt:forge:${input.kind}:${input.name}:${now}`,
    type: `forge.${input.action}`,
    time: now,
    data: {
      kind: input.kind,
      action: input.action,
      name: input.name,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.by !== undefined ? { by: input.by } : {}),
      previous: input.previous ?? null,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    },
  }
}

/** Append the record to the autoloop journal when a database is available; never fails. */
export const recordForge = (input: ForgeRecord) =>
  Effect.gen(function* () {
    const database = yield* Effect.serviceOption(Database.Service)
    if (Option.isNone(database)) return
    yield* AutoloopStore.commitLatest([forgeFact(input)]).pipe(
      Effect.provideService(Database.Service, database.value),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not record a forged tool in the autoloop journal; the registration still stands", {
          error: Cause.pretty(cause),
        }),
      ),
    )
  })
