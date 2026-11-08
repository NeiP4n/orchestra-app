// Storage of the graph in a project-local SQLite database.
//
// One file at `.orchestra/codegraph.db`, written in WAL mode so a reader never blocks the indexer. The
// schema keeps the three facts the queries need: which files were seen (with the fingerprint that says
// they are still current), which symbols each file declares, and which calls and imports leave it.
// `symbols_fts` is a trigram index over names and paths, so substring search costs an index seek.

import { bunRuntime } from "../runtime.js"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import type { Edge, Fingerprint, Symbol, SymbolKind } from "./types.js"

export const FOLDER = ".orchestra"
export const FILENAME = "codegraph.db"

export const databasePath = (root: string) => path.join(root, FOLDER, FILENAME)

export interface Graph {
  readonly db: Database
  readonly root: string
  readonly file: string
}

export interface FileRecord {
  readonly path: string
  readonly mtimeMs: number
  readonly size: number
  readonly hash: string
}

export interface SymbolRow {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly path: string
  readonly line: number
  readonly col: number
  readonly end_line: number
  readonly container: string | null
  readonly exported: number
}

/** The column list that matches {@link SymbolRow}. */
export const SYMBOL_COLUMNS = "id, name, kind, path, line, col, end_line, container, exported"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  container TEXT,
  exported INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols (name);
CREATE INDEX IF NOT EXISTS symbols_path ON symbols (path);
CREATE TABLE IF NOT EXISTS edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS edges_dst ON edges (kind, dst);
CREATE INDEX IF NOT EXISTS edges_src ON edges (kind, src);
CREATE INDEX IF NOT EXISTS edges_path ON edges (path);
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5 (name, path, tokenize = 'trigram');
`

/**
 * The graph lives in bun:sqlite, so only a Bun runtime can open it; the node
 * artifact bundles a shim whose Database throws on construction. Callers must
 * check this first and refuse honestly, before any mkdir or write.
 */
export const supported = (): boolean => bunRuntime()

export function open(root: string): Graph {
  const file = databasePath(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(SCHEMA)
  return { db, root, file }
}

export const toSymbol = (row: SymbolRow): Symbol => ({
  id: row.id,
  name: row.name,
  kind: row.kind as SymbolKind,
  path: row.path,
  line: row.line,
  column: row.col,
  endLine: row.end_line,
  ...(row.container === null ? {} : { container: row.container }),
  exported: row.exported === 1,
})

export function fingerprints(graph: Graph): Map<string, Fingerprint> {
  const rows = graph.db
    .query<
      { path: string; mtime_ms: number; size: number; hash: string },
      []
    >("SELECT path, mtime_ms, size, hash FROM files")
    .all()
  return new Map(
    rows.map((row) => [row.path, { path: row.path, mtimeMs: row.mtime_ms, size: row.size, hash: row.hash }]),
  )
}

/** Replaces everything one file contributed. The caller decides the transaction. */
export function replaceFile(graph: Graph, file: FileRecord, symbols: readonly Symbol[], edges: readonly Edge[]) {
  dropFile(graph, file.path)
  graph.db
    .query(
      `INSERT INTO files (path, mtime_ms, size, hash, indexed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size, hash = excluded.hash, indexed_at = excluded.indexed_at`,
    )
    .run(file.path, file.mtimeMs, file.size, file.hash, Date.now())

  const insert = graph.db.query<
    { rowid: number },
    [string, string, string, string, number, number, number, string | null, number]
  >(
    "INSERT INTO symbols (id, name, kind, path, line, col, end_line, container, exported) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING rowid",
  )
  const index = graph.db.query("INSERT INTO symbols_fts (rowid, name, path) VALUES (?, ?, ?)")
  for (const symbol of symbols) {
    const row = insert.get(
      symbol.id,
      symbol.name,
      symbol.kind,
      symbol.path,
      symbol.line,
      symbol.column,
      symbol.endLine,
      symbol.container ?? null,
      symbol.exported ? 1 : 0,
    )
    if (row) index.run(row.rowid, symbol.name, symbol.path)
  }

  const insertEdge = graph.db.query("INSERT INTO edges (src, dst, kind, path, line) VALUES (?, ?, ?, ?, ?)")
  for (const edge of edges) insertEdge.run(edge.src, edge.dst, edge.kind, edge.path, edge.line)
}

/** Forgets one file and everything it contributed. */
export function deleteFile(graph: Graph, file: string) {
  dropFile(graph, file)
  graph.db.query("DELETE FROM files WHERE path = ?").run(file)
}

/** The content did not change, so only the fingerprint is refreshed. */
export function touchFile(graph: Graph, file: FileRecord) {
  graph.db
    .query("UPDATE files SET mtime_ms = ?, size = ?, hash = ?, indexed_at = ? WHERE path = ?")
    .run(file.mtimeMs, file.size, file.hash, Date.now(), file.path)
}

function dropFile(graph: Graph, file: string) {
  graph.db.query("DELETE FROM symbols_fts WHERE rowid IN (SELECT rowid FROM symbols WHERE path = ?)").run(file)
  graph.db.query("DELETE FROM symbols WHERE path = ?").run(file)
  graph.db.query("DELETE FROM edges WHERE path = ?").run(file)
}

export function counts(graph: Graph) {
  const row = graph.db
    .query<
      { files: number; symbols: number; edges: number },
      []
    >("SELECT (SELECT COUNT(*) FROM files) AS files, (SELECT COUNT(*) FROM symbols) AS symbols, (SELECT COUNT(*) FROM edges) AS edges")
    .get()
  return row ?? { files: 0, symbols: 0, edges: 0 }
}

export function readMeta(graph: Graph, key: string): string | undefined {
  const row = graph.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)
  return row?.value
}

export function writeMeta(graph: Graph, key: string, value: string) {
  graph.db
    .query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value)
}
