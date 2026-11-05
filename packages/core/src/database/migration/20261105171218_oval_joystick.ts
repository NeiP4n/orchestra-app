import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261105171218_oval_joystick",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`autoloop_facts\` (
          \`seq\` integer PRIMARY KEY AUTOINCREMENT,
          \`fact\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`autoloop_projection_meta\` (
          \`key\` text PRIMARY KEY,
          \`value\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`autoloop_projection_refs\` (
          \`collection\` text NOT NULL,
          \`key\` text NOT NULL,
          \`ref_collection\` text NOT NULL,
          \`ref_key\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`autoloop_projections\` (
          \`collection\` text NOT NULL,
          \`key\` text NOT NULL,
          \`data\` text NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`autoloop_facts_seq_idx\` ON \`autoloop_facts\` (\`seq\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`autoloop_projection_refs_pk_idx\` ON \`autoloop_projection_refs\` (\`collection\`,\`key\`,\`ref_collection\`,\`ref_key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`autoloop_projection_refs_ref_idx\` ON \`autoloop_projection_refs\` (\`ref_collection\`,\`ref_key\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`autoloop_projections_collection_key_idx\` ON \`autoloop_projections\` (\`collection\`,\`key\`);`,
      )
    })
  },
}

export default migration
