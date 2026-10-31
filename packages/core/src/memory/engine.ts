import { Database } from "bun:sqlite"
import { openMemoryDatabase, type MemoryDatabaseOptions } from "./db"
import { hashEmbed } from "./embed"
import { hybridSearch, type SearchOptions, type SearchResult } from "./search"
import { extractTerms, tokenize } from "./text"

export interface RememberInput {
  text: string
  entity?: {
    name: string
    kind?: string
    summary?: string
    metadata?: Record<string, unknown>
  }
  scope?: "user" | "project"
  source?: string
}

export interface RememberResult {
  observationID: string
  entityID: string
  docID: string
}

export interface LinkInput {
  source: string
  target: string
  type: string
  weight?: number
  metadata?: Record<string, unknown>
}

export interface LinkResult {
  id: string
  sourceID: string
  targetID: string
}

export interface RecallOptions {
  limit?: number
  minScore?: number
  scope?: "user" | "project" | string
}

export interface MemoryStats {
  entities: number
  observations: number
  relations: number
  docs: number
  terms: number
}

function generateId(prefix: string): string {
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 12)
  return `${prefix}_${random}`
}

export class MemoryEngine {
  constructor(public readonly db: Database) {}

  static open(options?: MemoryDatabaseOptions | string): MemoryEngine {
    const db = openMemoryDatabase(options)
    return new MemoryEngine(db)
  }

  private resolveOrCreateEntity(
    nameOrId: string,
    kind = "concept",
    summary?: string,
    metadata?: Record<string, unknown>,
  ): string {
    const trimmed = nameOrId.trim()
    const existing = this.db
      .query(`SELECT id FROM entities WHERE id = ? OR name = ? COLLATE NOCASE LIMIT 1`)
      .get(trimmed, trimmed) as { id: string } | null

    const now = Date.now()
    if (existing) {
      this.db.run(`UPDATE entities SET updated_at = ? WHERE id = ?`, [now, existing.id])
      return existing.id
    }

    const id = generateId("ent")
    this.db.run(
      `INSERT INTO entities (id, name, kind, summary, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, trimmed, kind, summary ?? null, metadata ? JSON.stringify(metadata) : null, now, now],
    )
    return id
  }

  remember(input: RememberInput): RememberResult {
    const text = input.text.trim()
    if (!text) {
      throw new Error("MemoryEngine.remember: text cannot be empty")
    }

    const scope = input.scope ?? "project"
    const entityName = input.entity?.name ?? (scope === "user" ? "human" : "project")
    const entityKind = input.entity?.kind ?? (scope === "user" ? "person" : "concept")

    const insertTransaction = this.db.transaction(() => {
      const entityID = this.resolveOrCreateEntity(
        entityName,
        entityKind,
        input.entity?.summary,
        input.entity?.metadata,
      )

      const obsID = generateId("obs")
      const now = Date.now()

      // 1. Observations
      this.db.run(
        `INSERT INTO observations (id, entity_id, content, scope, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [obsID, entityID, text, scope, input.source ?? null, now, now],
      )

      // 2. Docs
      const tokenCount = tokenize(text).length
      this.db.run(
        `INSERT INTO docs (id, title, content, tokens_count, entity_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [obsID, entityName, text, tokenCount, entityID, now],
      )

      // 3. Terms
      const termMap = extractTerms(text)
      for (const [term, tf] of termMap.entries()) {
        this.db.run(
          `INSERT OR REPLACE INTO terms (term, doc_id, tf) VALUES (?, ?, ?)`,
          [term, obsID, tf],
        )
      }

      // 4. FTS Trigram
      try {
        this.db.run(`INSERT INTO fts_obs (id, content) VALUES (?, ?)`, [obsID, text])
      } catch {
        // Игнорируем ошибки виртуальной таблицы при нештатных символах
      }

      // 5. Vectors
      const vec = hashEmbed(text)
      this.db.run(
        `INSERT INTO vectors (id, vector, norm) VALUES (?, ?, ?)`,
        [obsID, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength), 1.0],
      )

      return {
        observationID: obsID,
        entityID,
        docID: obsID,
      }
    })

    return insertTransaction()
  }

  link(input: LinkInput): LinkResult {
    const sourceID = this.resolveOrCreateEntity(input.source)
    const targetID = this.resolveOrCreateEntity(input.target)
    const relID = generateId("rel")
    const now = Date.now()

    this.db.run(
      `INSERT INTO relations (id, source_id, target_id, type, weight, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        relID,
        sourceID,
        targetID,
        input.type.trim(),
        input.weight ?? 1.0,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
      ],
    )

    return {
      id: relID,
      sourceID,
      targetID,
    }
  }

  search(query: string, options?: SearchOptions): SearchResult[] {
    return hybridSearch(this.db, query, options)
  }

  recall(query: string, options?: RecallOptions): string {
    const limit = options?.limit ?? 5
    const minScore = options?.minScore ?? 0.15
    const results = this.search(query, {
      limit,
      minScore,
      scope: options?.scope,
    })

    if (results.length === 0) {
      return ""
    }

    const lines = ["### Relevant Memory:"]
    for (const r of results) {
      const tag = r.entityName ? `[${r.entityName}]` : `[${r.scope ?? "fact"}]`
      lines.push(`- ${tag} ${r.content}`)
    }
    return lines.join("\n")
  }

  forget(target: { id?: string; observationID?: string; entityID?: string; docID?: string }): { deleted: number } {
    const targetID = target.id ?? target.observationID ?? target.docID
    let count = 0

    const deleteTransaction = this.db.transaction(() => {
      if (targetID) {
        const obsDel = this.db.run(`DELETE FROM observations WHERE id = ?`, [targetID]).changes
        this.db.run(`DELETE FROM docs WHERE id = ?`, [targetID])
        this.db.run(`DELETE FROM terms WHERE doc_id = ?`, [targetID])
        try {
          this.db.run(`DELETE FROM fts_obs WHERE id = ?`, [targetID])
        } catch {
          // fts cleanup
        }
        this.db.run(`DELETE FROM vectors WHERE id = ?`, [targetID])
        count += obsDel
      }

      if (target.entityID) {
        // Каскадно находим все наблюдения сущности
        const obsRows = this.db.query(`SELECT id FROM observations WHERE entity_id = ?`).all(target.entityID) as { id: string }[]
        for (const row of obsRows) {
          this.db.run(`DELETE FROM observations WHERE id = ?`, [row.id])
          this.db.run(`DELETE FROM docs WHERE id = ?`, [row.id])
          this.db.run(`DELETE FROM terms WHERE doc_id = ?`, [row.id])
          try {
            this.db.run(`DELETE FROM fts_obs WHERE id = ?`, [row.id])
          } catch {
            // fts cleanup
          }
          this.db.run(`DELETE FROM vectors WHERE id = ?`, [row.id])
          count++
        }
        this.db.run(`DELETE FROM relations WHERE source_id = ? OR target_id = ?`, [target.entityID, target.entityID])
        const entDel = this.db.run(`DELETE FROM entities WHERE id = ?`, [target.entityID]).changes
        count += entDel
      }
    })

    deleteTransaction()
    return { deleted: count }
  }

  stats(): MemoryStats {
    const entities = (this.db.query(`SELECT count(*) as count FROM entities`).get() as { count: number }).count
    const observations = (this.db.query(`SELECT count(*) as count FROM observations`).get() as { count: number }).count
    const relations = (this.db.query(`SELECT count(*) as count FROM relations`).get() as { count: number }).count
    const docs = (this.db.query(`SELECT count(*) as count FROM docs`).get() as { count: number }).count
    const terms = (this.db.query(`SELECT count(*) as count FROM terms`).get() as { count: number }).count

    return {
      entities,
      observations,
      relations,
      docs,
      terms,
    }
  }

  close(): void {
    this.db.close()
  }
}

let defaultEngineInstance: MemoryEngine | null = null

export function getMemoryEngine(dbPath?: string): MemoryEngine {
  if (dbPath) {
    return MemoryEngine.open(dbPath)
  }
  if (!defaultEngineInstance) {
    defaultEngineInstance = MemoryEngine.open()
  }
  return defaultEngineInstance
}
