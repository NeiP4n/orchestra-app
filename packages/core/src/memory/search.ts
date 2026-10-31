import { Database } from "bun:sqlite"
import { cosineSimilarity, hashEmbed } from "./embed"
import { extractTerms, tokenize } from "./text"

export interface SearchOptions {
  limit?: number
  minScore?: number
  scope?: "user" | "project" | string
  entityID?: string
}

export interface SearchResult {
  id: string
  content: string
  title?: string
  score: number
  bm25Score: number
  cosScore: number
  ftsScore: number
  entityID?: string
  entityName?: string
  entityKind?: string
  scope?: string
  createdAt: number
}

interface CandidateAccumulator {
  id: string
  bm25: number
  fts: number
  cos: number
}

export function hybridSearch(db: Database, query: string, options?: SearchOptions): SearchResult[] {
  const limit = options?.limit ?? 10
  const minScore = options?.minScore ?? 0.05
  const scopeFilter = options?.scope
  const entityFilter = options?.entityID

  const trimmed = query.trim()
  if (!trimmed) {
    return []
  }

  // 1. Проверяем общее количество документов
  const statsRow = db.query("SELECT count(*) as total, avg(tokens_count) as avgdl FROM docs").get() as {
    total: number
    avgdl: number | null
  } | null

  const totalDocs = statsRow?.total ?? 0
  const avgdl = statsRow?.avgdl ?? 10
  if (totalDocs === 0) {
    return []
  }

  const candidates = new Map<string, CandidateAccumulator>()

  const getCandidate = (id: string): CandidateAccumulator => {
    let cand = candidates.get(id)
    if (!cand) {
      cand = { id, bm25: 0, fts: 0, cos: 0 }
      candidates.set(id, cand)
    }
    return cand
  }

  // 2. BM25 поиск по терминам
  const queryTerms = extractTerms(trimmed)
  if (queryTerms.size > 0) {
    const k1 = 1.2
    const b = 0.75

    for (const [term, queryTf] of queryTerms.entries()) {
      const termRows = db
        .query(
          `SELECT t.doc_id, t.tf, d.tokens_count 
           FROM terms t 
           JOIN docs d ON d.id = t.doc_id 
           WHERE t.term = ?`,
        )
        .all(term) as { doc_id: string; tf: number; tokens_count: number }[]

      const df = termRows.length
      if (df === 0) continue

      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5))

      for (const row of termRows) {
        const docLen = row.tokens_count || avgdl
        const tfScore = (row.tf * (k1 + 1)) / (row.tf + k1 * (1 - b + b * (docLen / avgdl)))
        const cand = getCandidate(row.doc_id)
        cand.bm25 += idf * tfScore * Math.min(queryTf, 2)
      }
    }
  }

  // 3. FTS5 Trigram поиск
  const tokens = tokenize(trimmed)
  const trigramTerms = tokens.filter((t) => t.length >= 3)
  if (trigramTerms.length > 0) {
    try {
      // Формируем безопасный MATCH-запрос, оборачивая каждый токен в кавычки
      const matchExpr = trigramTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ")
      const ftsRows = db
        .query(`SELECT id, rank FROM fts_obs WHERE fts_obs MATCH ? ORDER BY rank LIMIT 50`)
        .all(matchExpr) as { id: string; rank: number }[]

      for (const row of ftsRows) {
        const cand = getCandidate(row.id)
        const score = 1.0 / (1.0 + Math.abs(row.rank))
        if (score > cand.fts) {
          cand.fts = score
        }
      }
    } catch {
      // Игнорируем синтаксические особенности MATCH при спецсимволах
    }
  }

  // 4. Cosine similarity по векторам
  const queryVec = hashEmbed(trimmed)
  const candidateIds = Array.from(candidates.keys())

  if (candidateIds.length > 0) {
    // Вычисляем косинусное сходство для найденных кандидатов
    const placeholders = candidateIds.map(() => "?").join(",")
    const vectorRows = db
      .query(`SELECT id, vector FROM vectors WHERE id IN (${placeholders})`)
      .all(...candidateIds) as { id: string; vector: Uint8Array }[]

    for (const row of vectorRows) {
      const cand = candidates.get(row.id)
      if (cand) {
        const docVec = new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength)
        cand.cos = cosineSimilarity(queryVec, docVec)
      }
    }
  } else {
    // Если по точным терминам ничего не найдено, сканируем вектора напрямую (до 100 ближайших)
    const vectorRows = db.query(`SELECT id, vector FROM vectors LIMIT 100`).all() as {
      id: string
      vector: Uint8Array
    }[]

    for (const row of vectorRows) {
      const docVec = new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength)
      const cos = cosineSimilarity(queryVec, docVec)
      if (cos >= minScore) {
        const cand = getCandidate(row.id)
        cand.cos = cos
      }
    }
  }

  // 5. Загружаем полные метаданные и фильтруем
  const matchedIds = Array.from(candidates.keys())
  if (matchedIds.length === 0) {
    return []
  }

  const placeholders = matchedIds.map(() => "?").join(",")
  const docRows = db
    .query(
      `SELECT d.id, d.title, d.content, d.entity_id, d.created_at,
              e.name as entity_name, e.kind as entity_kind,
              o.scope
       FROM docs d
       LEFT JOIN entities e ON e.id = d.entity_id
       LEFT JOIN observations o ON o.id = d.id
       WHERE d.id IN (${placeholders})`,
    )
    .all(...matchedIds) as {
    id: string
    title: string | null
    content: string
    entity_id: string | null
    created_at: number
    entity_name: string | null
    entity_kind: string | null
    scope: string | null
  }[]

  const docMap = new Map(docRows.map((r) => [r.id, r]))
  const results: SearchResult[] = []

  for (const cand of candidates.values()) {
    const doc = docMap.get(cand.id)
    if (!doc) continue

    // Фильтрация по scope и entityID
    if (scopeFilter && doc.scope && doc.scope !== scopeFilter) {
      continue
    }
    if (entityFilter && doc.entity_id !== entityFilter) {
      continue
    }

    // Взвешенный комбинированный скор
    const normBm25 = cand.bm25 > 0 ? Math.min(1, cand.bm25 / 10) : 0
    const finalScore = 0.45 * normBm25 + 0.35 * cand.cos + 0.2 * cand.fts

    if (finalScore >= minScore) {
      results.push({
        id: doc.id,
        content: doc.content,
        title: doc.title ?? undefined,
        score: Math.round(finalScore * 1000) / 1000,
        bm25Score: Math.round(cand.bm25 * 1000) / 1000,
        cosScore: Math.round(cand.cos * 1000) / 1000,
        ftsScore: Math.round(cand.fts * 1000) / 1000,
        entityID: doc.entity_id ?? undefined,
        entityName: doc.entity_name ?? undefined,
        entityKind: doc.entity_kind ?? undefined,
        scope: doc.scope ?? undefined,
        createdAt: doc.created_at,
      })
    }
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}
