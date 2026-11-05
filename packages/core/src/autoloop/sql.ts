import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { AutoloopFact } from "./kernel/schema.js"

// Drizzle source of truth for the autoloop journal tables. The migration for
// these tables is generated from here (`bun run migration` in packages/core);
// the runtime journal itself lives in kernel/store.ts and kernel/evolve.ts.

export const AutoloopFactTable = sqliteTable(
  "autoloop_facts",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    fact: text({ mode: "json" }).$type<AutoloopFact>().notNull(),
  },
  (table) => [uniqueIndex("autoloop_facts_seq_idx").on(table.seq)],
)

export const AutoloopProjectionTable = sqliteTable(
  "autoloop_projections",
  {
    collection: text().notNull(),
    key: text().notNull(),
    data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (table) => [uniqueIndex("autoloop_projections_collection_key_idx").on(table.collection, table.key)],
)

export const AutoloopProjectionMetaTable = sqliteTable("autoloop_projection_meta", {
  key: text().primaryKey(),
  value: text().notNull(),
})

export const AutoloopProjectionRefTable = sqliteTable(
  "autoloop_projection_refs",
  {
    collection: text().notNull(),
    key: text().notNull(),
    ref_collection: text().notNull(),
    ref_key: text().notNull(),
  },
  (table) => [
    uniqueIndex("autoloop_projection_refs_pk_idx").on(
      table.collection,
      table.key,
      table.ref_collection,
      table.ref_key,
    ),
    index("autoloop_projection_refs_ref_idx").on(table.ref_collection, table.ref_key),
  ],
)
