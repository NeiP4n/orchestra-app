export * as SelfStore from "./store.js"

// Storage of the self index in one SQLite database under the global data
// directory (`<data>/self/index.db`), written in WAL mode like the codegraph
// store. Two retrieval paths share the table: a trigram FTS index for
// substring search (the same shape as codegraph's `symbols_fts`) and the
// local deterministic hash embedding from the memory subsystem
// (`memory/embed.ts`), so a question phrased nothing like the document can
// still find it. No external model, no network: embeddings are computed in
// process.

import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { bunRuntime } from "../runtime.js"
import { cosineSimilarity, hashEmbed } from "../memory/embed.js"
import type { SelfDoc } from "./sources.js"

export const FILENAME = "index.db"

export const databasePath = (dataDir: string) => path.join(dataDir, "self", FILENAME)

export interface Store {
  readonly db: Database
  readonly file: string
}

export interface Hit {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly snippet: string
  readonly path: string | null
  readonly score: number
}

export const supported = () => bunRuntime()

export function open(dataDir: string): Store {
  const file = databasePath(dataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS docs (
      kind TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      path TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5 (title, body, tokenize = 'trigram');
    CREATE TABLE IF NOT EXISTS embed (rowid INTEGER PRIMARY KEY, vector BLOB NOT NULL);
  `)
  return { db, file }
}

export function readMeta(store: Store, key: string): string | undefined {
  const row = store.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null
  return row?.value
}

export function writeMeta(store: Store, key: string, value: string): void {
  store.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value)
}

/** A rebuild replaces everything in one transaction: a crash mid-build keeps the previous index readable. */
export function replaceAll(store: Store, docs: readonly SelfDoc[]): number {
  const insertDoc = store.db.query("INSERT INTO docs (kind, doc_id, title, body, path) VALUES (?, ?, ?, ?, ?)")
  const insertFts = store.db.query("INSERT INTO docs_fts (rowid, title, body) VALUES (?, ?, ?)")
  const insertEmbed = store.db.query("INSERT INTO embed (rowid, vector) VALUES (?, ?)")
  store.db.transaction(() => {
    store.db.exec("DELETE FROM docs")
    store.db.exec("DELETE FROM docs_fts")
    store.db.exec("DELETE FROM embed")
    for (const doc of docs) {
      const result = insertDoc.run(doc.kind, doc.id, doc.title, doc.body, doc.path ?? null)
      const rowid = Number(result.lastInsertRowid)
      insertFts.run(rowid, doc.title, doc.body)
      insertEmbed.run(rowid, Buffer.from(hashEmbed(`${doc.title}\n${doc.body}`).buffer))
    }
  })()
  return docs.length
}

export function count(store: Store): number {
  const row = store.db.query("SELECT count(*) AS n FROM docs").get() as { n: number }
  return row.n
}

interface Row {
  rowid: number
  kind: string
  doc_id: string
  title: string
  body: string
  path: string | null
}

const SNIPPET = 240

// Question words that carry no signal about which document is wanted. Dropped
// only when at least one content word remains.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "i", "in",
  "is", "it", "its", "me", "my", "of", "on", "or", "own", "the", "to", "we", "what", "when", "where",
  "which", "who", "with", "you",
])

/**
 * Per-term trigram FTS plus a title bonus plus the local hash embedding.
 * Every term queries the index on its own, so the coverage of a document
 * (how many of the question's words it matches) is known and multiplies its
 * score: a document matching all terms beats one matching many repetitions
 * of a single term. Terms under three characters cannot use the trigram
 * index and fall back to a LIKE scan. The embedding pass covers phrasings
 * the words themselves miss, with a high bar so it adds synonyms, not noise.
 */
export function search(store: Store, query: string, limit = 10): Hit[] {
  const raw = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 0)
  const significant = raw.filter((term) => !STOPWORDS.has(term))
  const terms = significant.length > 0 ? significant : raw
  if (terms.length === 0) return []

  const scores = new Map<number, number>()
  const coverage = new Map<number, number>()
  const hit = (rowid: number, points: number) => {
    scores.set(rowid, (scores.get(rowid) ?? 0) + points)
    coverage.set(rowid, (coverage.get(rowid) ?? 0) + 1)
  }

  // No tight LIMIT here: a common term ("default", "model") matches hundreds
  // of documents, and truncating before the coverage multiplier runs would
  // silently drop the short, exact document the question was about.
  const fts = store.db.query("SELECT rowid, rank FROM docs_fts WHERE docs_fts MATCH ? ORDER BY rank LIMIT 1000")
  const like = store.db.query("SELECT rowid FROM docs WHERE lower(title) LIKE ? OR lower(body) LIKE ? LIMIT 200")
  for (const term of terms) {
    if (term.length >= 3) {
      const rows = fts.all(`"${term.replace(/"/g, "")}"`) as { rowid: number; rank: number }[]
      for (const row of rows) hit(row.rowid, 1 / (1 + Math.abs(row.rank)))
    } else {
      for (const row of like.all(`%${term}%`, `%${term}%`) as { rowid: number }[]) hit(row.rowid, 0.3)
    }
  }

  // Terms inside a title are worth more than terms in a body, and a title
  // that IS the term (a config key, an env var, a command) is the strongest
  // signal the index has. Registry documents also outrank prose sections on
  // a near-tie: the doc sections talk about a thing, the registry names it.
  const KIND_WEIGHT: Record<string, number> = {
    command: 0.35,
    config: 0.35,
    env: 0.35,
    tool: 0.35,
    extension: 0.25,
    custom: 0.2,
    doc: 0,
  }
  const meta = store.db.query("SELECT title, kind FROM docs WHERE rowid = ?")
  for (const rowid of scores.keys()) {
    const row = meta.get(rowid) as { title: string; kind: string } | null
    if (!row) continue
    const title = row.title.toLowerCase()
    const normalized = title.replace(/[^\p{L}\p{N}_]+/gu, " ").trim()
    for (const term of terms) {
      if (title.includes(term)) scores.set(rowid, scores.get(rowid)! + 0.5)
      if (normalized === term) scores.set(rowid, scores.get(rowid)! + 0.5)
    }
    scores.set(rowid, scores.get(rowid)! + (KIND_WEIGHT[row.kind] ?? 0))
  }

  const embedding = hashEmbed(query)
  const vectors = store.db.query("SELECT rowid, vector FROM embed").all() as { rowid: number; vector: Uint8Array }[]
  for (const row of vectors) {
    const cosine = cosineSimilarity(new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength), embedding)
    if (cosine > 0.6) scores.set(row.rowid, (scores.get(row.rowid) ?? 0) + 0.3 * cosine)
  }

  const ranked = [...scores.entries()]
    .map(([rowid, score]) => {
      const matched = Math.min(coverage.get(rowid) ?? 0, terms.length)
      return [rowid, score * (0.5 + 0.5 * (matched / terms.length))] as const
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
  if (ranked.length === 0) return []
  const byRowid = store.db.query("SELECT rowid, kind, doc_id, title, body, path FROM docs WHERE rowid = ?")
  const hits: Hit[] = []
  for (const [rowid, score] of ranked) {
    const row = byRowid.get(rowid) as Row | null
    if (!row) continue
    hits.push({
      id: row.doc_id,
      kind: row.kind,
      title: row.title,
      snippet: row.body.length > SNIPPET ? `${row.body.slice(0, SNIPPET)}…` : row.body,
      path: row.path,
      score: Math.round(score * 1000) / 1000,
    })
  }
  return hits
}
