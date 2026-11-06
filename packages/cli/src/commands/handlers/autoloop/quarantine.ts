import { EOL } from "node:os"
import { Effect } from "effect"
import { Database } from "@orchestra/core/database/database"
import { AutoloopStore } from "@orchestra/core/autoloop/kernel/store"
import { Global } from "@orchestra/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { databasePath } from "../../../database-path"
import { assertServerStopped } from "../server-stopped"

// A3-11: the operator entry point for quarantine. A poisoned fact is never
// deleted — the journal is the evidence — but once quarantined it no longer
// folds into the projections, at rebuild or at all. The server must be
// stopped: the quarantine rewrites the projections in the same transaction
// as the mark, and a live server would keep working from the old view.
export default Runtime.handler(
  Commands.commands.autoloop.commands.quarantine,
  Effect.fn("cli.autoloop.quarantine")(function* (input) {
    const global = yield* Global.Service
    const dbFile = databasePath(global.data)
    if (dbFile === ":memory:")
      return yield* Effect.fail(new Error("No file database to quarantine in: this install uses :memory:"))
    yield* assertServerStopped(global.data, input.force, "quarantine")
    const result = yield* Effect.scoped(
      AutoloopStore.quarantine(input.seq, input.reason).pipe(Effect.provide(Database.layer({ path: dbFile }))),
    )
    process.stdout.write(
      [
        result.changed
          ? `Quarantined autoloop fact ${input.seq}: ${input.reason}`
          : `Fact ${input.seq} was already quarantined.`,
        `The fact stays in the journal as evidence; the projections were rebuilt without it.`,
        ``,
      ].join(EOL),
    )
  }),
)
