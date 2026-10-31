import { Database } from "bun:sqlite"
import fs from "fs"
import path from "path"

export interface MemoryDatabaseOptions {
  path?: string
  readonly?: boolean
}

export function resolveDefaultMemoryDbPath(): string {
  return path.resolve(process.cwd(), ".orchestra", "memory.db")
}

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

export function openMemoryDatabase(options?: MemoryDatabaseOptions | string): Database {
  const dbPath = typeof options === "string" ? options : (options?.path ?? resolveDefaultMemoryDbPath())
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

  // Тюнинг производительности для мгновенного ассоциативного поиска (<1.5мс)
  if (!isMemory) {
    db.run("PRAGMA journal_mode = WAL;")
    db.run("PRAGMA synchronous = NORMAL;")
    db.run("PRAGMA mmap_size = 268435456;")
  }
  db.run("PRAGMA temp_store = MEMORY;")
  db.run("PRAGMA foreign_keys = ON;")

  initMemorySchema(db)

  return db
}
