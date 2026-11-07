import { Database } from "bun:sqlite"
import fs from "fs"
import path from "path"

export interface MemoryDatabaseOptions {
  path?: string
  readonly?: boolean
  /**
   * Project folder the memory belongs to: the database lives at
   * `<projectDir>/.orchestra/memory.db`. When omitted, the path resolves
   * against the process working directory (legacy behaviour, kept for
   * callers that pass an explicit `path` or run without a project).
   * Production callers must pass the project folder — see B18 №38.
   */
  projectDir?: string
}

export function resolveDefaultMemoryDbPath(projectDir?: string): string {
  return path.resolve(projectDir ?? process.cwd(), ".orchestra", "memory.db")
}

/** Current schema version of `memory.db` (B18 №39). Bump when adding a migration. */
export const CURRENT_MEMORY_SCHEMA_VERSION = 1

interface Migration {
  readonly version: number
  readonly up: (db: Database) => void
}

/**
 * Versioned migrations, applied in order by `applyMemoryMigrations`.
 * v1 is the original schema from `initMemorySchema`, kept as-is so a
 * database created before migrations existed upgrades by a no-op DDL pass
 * (every statement is `IF NOT EXISTS`) and then records version 1.
 */
const MIGRATIONS: ReadonlyArray<Migration> = [{ version: 1, up: initMemorySchema }]

export function initMemorySchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'concept',
      summary TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'project',
      source TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_obs_entity ON observations(entity_id);
    CREATE INDEX IF NOT EXISTS idx_obs_scope ON observations(scope);

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rel_source ON relations(source_id);
    CREATE INDEX IF NOT EXISTS idx_rel_target ON relations(target_id);
    CREATE INDEX IF NOT EXISTS idx_rel_type ON relations(type);

    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      title TEXT,
      content TEXT NOT NULL,
      tokens_count INTEGER NOT NULL,
      entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_docs_entity ON docs(entity_id);

    CREATE TABLE IF NOT EXISTS terms (
      term TEXT NOT NULL,
      doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      tf INTEGER NOT NULL,
      PRIMARY KEY (term, doc_id)
    );
    CREATE INDEX IF NOT EXISTS idx_terms_term ON terms(term);

    CREATE VIRTUAL TABLE IF NOT EXISTS fts_obs USING fts5(
      id UNINDEXED,
      content,
      tokenize='trigram'
    );

    CREATE TABLE IF NOT EXISTS vectors (
      id TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
      vector BLOB NOT NULL,
      norm REAL NOT NULL
    );
  `)
}

/**
 * Bring a `memory.db` handle to the current schema and record the version.
 * Safe on a database created before migrations existed: v1 is idempotent,
 * so the upgrade is a no-op DDL pass plus one bookkeeping row. Returns the
 * schema version the database now carries.
 */
export function applyMemoryMigrations(db: Database): number {
  db.run(`
    CREATE TABLE IF NOT EXISTS memory_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)
  const row = db.query(`SELECT MAX(version) as version FROM memory_migrations`).get() as {
    version: number | null
  } | null
  const applied = row?.version ?? 0
  for (const migration of MIGRATIONS) {
    if (migration.version <= applied) continue
    migration.up(db)
    db.run(`INSERT INTO memory_migrations (version, applied_at) VALUES (?, ?)`, [migration.version, Date.now()])
  }
  const current = db.query(`SELECT MAX(version) as version FROM memory_migrations`).get() as {
    version: number | null
  } | null
  return current?.version ?? 0
}

export function openMemoryDatabase(options?: MemoryDatabaseOptions | string): Database {
  const dbPath =
    typeof options === "string" ? options : (options?.path ?? resolveDefaultMemoryDbPath(options?.projectDir))
  const isMemory = dbPath === ":memory:" || dbPath.startsWith("file::memory:")

  if (!isMemory) {
    const dir = path.dirname(dbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  const db = new Database(dbPath, {
    create: true,
    readonly: typeof options === "object" ? (options?.readonly ?? false) : false,
  })

  // B18 №37: synchronous = FULL, like the main database — a confirmed
  // memory write must survive a power failure, not just a clean shutdown.
  // WAL stays on (concurrent readers while the server writes); mmap is
  // capped at 64 MB per project (B18 №41: 256 MB per open project).
  if (!isMemory) {
    db.run("PRAGMA journal_mode = WAL;")
    db.run("PRAGMA synchronous = FULL;")
    db.run("PRAGMA mmap_size = 67108864;")
  }
  db.run("PRAGMA temp_store = MEMORY;")
  db.run("PRAGMA foreign_keys = ON;")

  applyMemoryMigrations(db)

  return db
}

export interface MemoryBackupResult {
  readonly path: string
  readonly sizeBytes: number
}

// VACUUM INTO takes the destination as a string literal, never a bound
// parameter: escape embedded quotes and reject NUL bytes instead of trusting
// the caller with raw SQL (same rule as `database/backup.ts`).
const literal = (value: string) => {
  if (value.includes("\0")) throw new Error("Memory backup path must not contain NUL")
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Consistent snapshot of a `memory.db` file (B18 №40, minimum). `VACUUM INTO`
 * reads the live database including its WAL, so the backup never catches the
 * file mid-write; the copy is verified (`PRAGMA quick_check`) before this
 * returns, and a corrupt copy is deleted on the spot instead of kept.
 *
 * This is the helper the backup cycle needs — it is NOT yet wired into the
 * server's automatic backup cycle (`packages/server/src/database-backup.ts`
 * snapshots the single `orchestra-local.db` only, and a memory.db is
 * per-project, so wiring it in means enumerating projects first). Until
 * that wiring lands, call this before destructive work on a project.
 */
export function backupMemoryDatabase(dbPath: string, destination: string): MemoryBackupResult {
  const source = path.resolve(dbPath)
  const file = path.resolve(destination)
  if (source === file) throw new Error("Memory backup destination must differ from the live database")
  if (!fs.existsSync(source)) throw new Error(`Memory database not found: ${source}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file)) fs.rmSync(file)

  const db = new Database(source)
  try {
    db.run(`VACUUM INTO ${literal(file)}`)
  } finally {
    db.close()
  }

  const check = new Database(file, { readonly: true })
  try {
    const row = check.query(`PRAGMA quick_check`).get() as { quick_check: string } | null
    if (row?.quick_check !== "ok") {
      fs.rmSync(file)
      throw new Error(`Memory backup at ${file} failed verification after writing and was deleted`)
    }
  } finally {
    check.close()
  }

  return { path: file, sizeBytes: fs.statSync(file).size }
}
