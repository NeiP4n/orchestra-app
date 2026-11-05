export * as AutoloopSchema from "./schema.js"

// Table and fact definitions for the native autoloop journal (block B2).
// The journal is the single source of truth for cycle state: every fact is
// appended to `autoloop_facts` and never edited in place. Projections in
// `autoloop_projections` are disposable — they are rebuilt from the journal
// by kernel/evolve.ts `rebuild`. Only kernel/store.ts writes facts.

export const FACTS_TABLE = "autoloop_facts"
export const PROJECTIONS_TABLE = "autoloop_projections"
export const PROJECTION_META_TABLE = "autoloop_projection_meta"
export const PROJECTION_REFS_TABLE = "autoloop_projection_refs"

/** Projection collections carried over from agent-autoloop's kernel/evolve.ts. */
export const COLLECTIONS = [
  "events",
  "runs",
  "run_events",
  "cards",
  "deliveries",
  "timers",
  "schedules",
  "seen",
  "keys",
  "config",
  "due",
] as const
export type ProjectionCollection = (typeof COLLECTIONS)[number]

/**
 * One journal entry. A fact that carries `collection` + `key` writes one
 * projection row: `data` upserts it, `data: null` deletes it. A fact without
 * `collection`/`key` is journal-only (recorded, but changes no projection).
 * `refs` lists the projection rows the written row points at; they are kept
 * in `autoloop_projection_refs` so a later rebuild can find dependents.
 */
export interface AutoloopFact {
  /** Unique fact id, e.g. `evt:<source>:<key>`; dedup key for decide (block B3). */
  id: string
  /** Fact type, e.g. `event.recorded`, `run.queued`. */
  type: string
  collection?: string
  key?: string
  data?: Record<string, unknown> | null
  refs?: Array<{ collection: string; key: string }>
  /** Milliseconds since epoch; defaults to commit time when omitted. */
  time?: number
}

export interface ProjectionRow {
  collection: string
  key: string
  data: Record<string, unknown>
}

export interface ProjectionRef {
  collection: string
  key: string
  ref_collection: string
  ref_key: string
}

/** Hash of the kernel code that built the projections; a change forces `rebuild`. */
export const FORMAT = "autoloop-kernel-v1"

export const META_LAST_SEQ = "last_seq"
export const META_FORMAT = "format"

/** CREATE TABLE statements for the journal, mirroring the generated migration. */
export const CREATE_TABLE_STATEMENTS = [
  `CREATE TABLE \`autoloop_facts\` (
    \`seq\` integer PRIMARY KEY AUTOINCREMENT,
    \`fact\` text NOT NULL
  )`,
  `CREATE TABLE \`autoloop_projection_meta\` (
    \`key\` text PRIMARY KEY,
    \`value\` text NOT NULL
  )`,
  `CREATE TABLE \`autoloop_projection_refs\` (
    \`collection\` text NOT NULL,
    \`key\` text NOT NULL,
    \`ref_collection\` text NOT NULL,
    \`ref_key\` text NOT NULL
  )`,
  `CREATE TABLE \`autoloop_projections\` (
    \`collection\` text NOT NULL,
    \`key\` text NOT NULL,
    \`data\` text NOT NULL
  )`,
  "CREATE UNIQUE INDEX `autoloop_facts_seq_idx` ON `autoloop_facts` (`seq`)",
  "CREATE UNIQUE INDEX `autoloop_projection_refs_pk_idx` ON `autoloop_projection_refs` (`collection`,`key`,`ref_collection`,`ref_key`)",
  "CREATE INDEX `autoloop_projection_refs_ref_idx` ON `autoloop_projection_refs` (`ref_collection`,`ref_key`)",
  "CREATE UNIQUE INDEX `autoloop_projections_collection_key_idx` ON `autoloop_projections` (`collection`,`key`)",
]
