export * as ReviewedIndex from "./reviewed-index.js"

import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs"
import path from "node:path"
import { cosineSimilarity, hashEmbed } from "./embed.js"
import { countSecrets } from "./scrub.js"

export const VERSION = "hash-trigram-64-v1"
export const MAX_CARDS = 1_000
export const MAX_CARD_BYTES = 4_096
export type Kind = "lesson" | "plan" | "tool-card"
/** Caller-reviewed cards only, not an automatic file or page ingester. */
export interface Card {
  id: string
  kind: Kind
  source: string
  title: string
  text: string
  reviewed: true
}
export interface Hit {
  id: string
  kind: Kind
  source: string
  title: string
  excerpt: string
  score: number
}
const validID = (id: string) => typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id) && countSecrets(id) === 0
const validSource = (kind: Kind, source: string) =>
  kind === "lesson"
    ? source === "lessons.md"
    : kind === "plan"
      ? /^plans\/[a-z0-9_-]{1,60}\.md$/.test(source)
      : kind === "tool-card" && /^tool-cards\/[a-z0-9_-]{1,60}\.json$/.test(source)
const cleanText = (value: string) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  countSecrets(value) === 0 &&
  !/[?&](?:api[-_]?key|access_token|token|secret|password)=[^&#\s]+/i.test(value)
const terms = (text: string) => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [])].slice(0, 32)

/** Offline prototype. No downloads, provider calls, automatic extraction or tool grants.
 * A vector is private derived data, not anonymization or proof of semantic understanding.
 * File-owned cards remain truth; replace() atomically rebuilds the entire derived index. */
export function open(directory: string, projectID: string) {
  if (!validID(projectID) || !path.isAbsolute(directory)) throw Error("Exact project binding required")
  const root = realpathSync(directory)
  const folder = path.join(root, ".orchestra")
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  if (lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory() || realpathSync(folder) !== folder)
    throw Error("Reviewed index requires a real project directory")
  const file = path.join(folder, "reviewed-index.db")
  try {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile()) throw Error("Reviewed index must be a regular file")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const db = new Database(file)
  chmodSync(file, 0o600)
  db.exec(
    "PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY,kind TEXT NOT NULL,source TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,vector BLOB NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(id UNINDEXED,title,body);",
  )
  const meta = (key: string) =>
    (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value
  const setMeta = (key: string, value: string) => db.run("INSERT OR REPLACE INTO meta VALUES (?,?)", [key, value])
  const owner = meta("projectID")
  if (owner && owner !== projectID) {
    db.close()
    throw Error("Reviewed index belongs to a different project")
  }
  if (!owner) setMeta("projectID", projectID)
  let ready = meta("version") === VERSION
  return {
    /** Caller must supply explicitly reviewed, source-allowlisted cards. No model may auto-promote raw text. */
    replace(cards: readonly Card[]) {
      if (cards.length > MAX_CARDS) throw Error("Reviewed index card limit exceeded")
      const seen = new Set<string>()
      const rows = cards.map((card) => {
        if (
          card.reviewed !== true ||
          !validID(card.id) ||
          seen.has(card.id) ||
          !validSource(card.kind, card.source) ||
          !cleanText(card.title) ||
          !cleanText(card.text) ||
          card.title.length > 160 ||
          Buffer.byteLength(card.text) > MAX_CARD_BYTES
        )
          throw Error("Invalid reviewed card; nothing was indexed")
        seen.add(card.id)
        return {
          card,
          hash: createHash("sha256")
            .update(JSON.stringify([card.kind, card.source, card.title, card.text]))
            .digest("hex"),
          vector: hashEmbed(`${card.title}\n${card.text}`),
        }
      })
      db.transaction(() => {
        db.exec("DELETE FROM cards;DELETE FROM cards_fts")
        for (const { card, hash, vector } of rows) {
          db.run("INSERT INTO cards VALUES (?,?,?,?,?,?,?)", [
            card.id,
            card.kind,
            card.source,
            card.title,
            card.text,
            hash,
            vector,
          ])
          db.run("INSERT INTO cards_fts VALUES (?,?,?)", [card.id, card.title, card.text])
        }
        setMeta("version", VERSION)
      })()
      ready = true
      return rows.length
    },
    search(query: string, limit = 5): Hit[] {
      if (!ready) throw Error("Reviewed index requires rebuild for the current embedding version")
      if (!cleanText(query) || query.length > 500 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20)
        throw Error("Invalid reviewed search")
      const words = terms(query)
      if (!words.length) return []
      const lexical = new Set<string>(
        (
          db
            .query("SELECT id FROM cards_fts WHERE cards_fts MATCH ? LIMIT 1000")
            .all(words.map((word) => '"' + word.replaceAll('"', '""') + '"').join(" OR ")) as { id: string }[]
        ).map((row) => row.id),
      )
      const vector = hashEmbed(query)
      const rows = db.query("SELECT id,kind,source,title,body,vector FROM cards LIMIT 1000").all() as {
        id: string
        kind: Kind
        source: string
        title: string
        body: string
        vector: Uint8Array
      }[]
      // Scan every bounded card, not an arbitrary first100. Lexical hits lead;
      // hash cosine only provides an approximate spelling-based secondary score.
      return rows
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          source: row.source,
          title: row.title,
          excerpt: row.body.slice(0, 500),
          score:
            (lexical.has(row.id)
              ? (2 * words.filter((word) => `${row.title} ${row.body}`.toLowerCase().includes(word)).length) /
                words.length
              : 0) +
            cosineSimilarity(new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength), vector),
        }))
        .filter((row) => row.score >= 0.25)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, limit)
    },
    close() {
      db.close()
    },
  }
}
