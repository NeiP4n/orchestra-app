import { EOL } from "node:os"
import { Effect } from "effect"
import { Database } from "@orchestra/core/database/database"
import { AutoloopStore } from "@orchestra/core/autoloop/kernel/store"
import { Global } from "@orchestra/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { databasePath } from "../../../database-path"

// A3-11: lists quarantined journal facts — the mark, the reason, and when
// it was set. Read-only: no live-server check, the journal keeps the facts
// themselves either way.
export default Runtime.handler(
  Commands.commands.autoloop.commands["quarantine-list"],
  Effect.fn("cli.autoloop.quarantine-list")(function* () {
    const global = yield* Global.Service
    const dbFile = databasePath(global.data)
    if (dbFile === ":memory:")
      return yield* Effect.fail(new Error("No file database to list from: this install uses :memory:"))
    const entries = yield* Effect.scoped(
      AutoloopStore.listQuarantine().pipe(Effect.provide(Database.layer({ path: dbFile }))),
    )
    if (entries.length === 0) {
      process.stdout.write(`No quarantined autoloop facts.${EOL}`)
      return
    }
    process.stdout.write(
      [
        ...entries.map(
          (entry) => `${entry.seq}\t${new Date(entry.at).toISOString()}\t${entry.reason}`,
        ),
        ``,
      ].join(EOL),
    )
  }),
)
