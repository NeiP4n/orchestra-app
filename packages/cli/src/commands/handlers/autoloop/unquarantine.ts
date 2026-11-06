import { EOL } from "node:os"
import { Effect } from "effect"
import { Database } from "@orchestra/core/database/database"
import { AutoloopStore } from "@orchestra/core/autoloop/kernel/store"
import { Global } from "@orchestra/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { databasePath } from "../../../database-path"
import { assertServerStopped } from "../server-stopped"

// A3-11: lifts a quarantine — the fact plays again in the projections at
// once. Unquarantining a fact that was never quarantined is a no-op.
export default Runtime.handler(
  Commands.commands.autoloop.commands.unquarantine,
  Effect.fn("cli.autoloop.unquarantine")(function* (input) {
    const global = yield* Global.Service
    const dbFile = databasePath(global.data)
    if (dbFile === ":memory:")
      return yield* Effect.fail(new Error("No file database to unquarantine in: this install uses :memory:"))
    yield* assertServerStopped(global.data, input.force, "unquarantine")
    const result = yield* Effect.scoped(
      AutoloopStore.unquarantine(input.seq).pipe(Effect.provide(Database.layer({ path: dbFile }))),
    )
    process.stdout.write(
      [
        result.changed
          ? `Unquarantined autoloop fact ${input.seq}: its effect is back in the projections.`
          : `Fact ${input.seq} was not quarantined.`,
        ``,
      ].join(EOL),
    )
  }),
)
