import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261106144629_unknown_major_mapleleaf",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`autoloop_quarantine\` (
          \`seq\` integer PRIMARY KEY,
          \`reason\` text NOT NULL,
          \`at\` integer NOT NULL
        );
      `)
    })
  },
}

export default migration
