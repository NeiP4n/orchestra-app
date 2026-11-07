import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261107101054_busy_orphan",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE INDEX \`session_v2_directory_idx\` ON \`session_v2\` (\`directory\`);`)
    })
  },
}

export default migration
