// Reading the graph.
//
// `search` finds declarations by name, `explore` answers "what is this and who touches it" in one call,
// and `impact` walks the call edges backwards to size the blast radius of a change. Every entry point
// indexes the project first when no database exists yet, so a fresh checkout answers on first use.

import fs from "node:fs"
import { counts, databasePath, open, readMeta, SYMBOL_COLUMNS, toSymbol, type Graph, type SymbolRow } from "./db.js"
import { indexProject, listFiles, type IndexOptions } from "./indexer.js"
import type {
  CallerRef,
  ExploreResult,
  GraphStatus,
  ImpactResult,
  ImpactRing,
  IndexReport,
  SearchHit,
  Symbol,
} from "./types.js"

const TEST_PATH = /(^|\/)(test|tests|__tests__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/

export function status(root: string): GraphStatus {
  const exists = fs.existsSync(databasePath(root))
  if (!exists) return { root, database: databasePath(root), indexed: false, files: 0, symbols: 0, edges: 0 }
  const graph = open(root)
  try {
    const totals = counts(graph)
    const indexedAt = readMeta(graph, "indexed_at")
    return {
      root,
      database: graph.file,
      indexed: totals.files > 0,
      files: totals.files,
      symbols: totals.symbols,
      edges: totals.edges,
      ...(indexedAt === undefined ? {} : { indexedAt: Number(indexedAt) }),
    }
  } finally {
    graph.db.close()
  }
}

export function search(root: string, name: string, limit = 20): SearchHit[] {
  const term = name.trim()
  if (!term) return []
  ensureIndexed(root)
  const graph = open(root)
  try {
    return searchGraph(graph, term, limit)
  } finally {
    graph.db.close()
  }
}

export function pick(root: string, name: string): Symbol | undefined {
  return search(root, name, 1)[0]?.symbol
}

export function explore(root: string, name: string): ExploreResult | undefined {
  ensureIndexed(root)
  const graph = open(root)
  try {
    const symbol = pickGraph(graph, name)
    if (!symbol) return undefined

    const callers = graph.db
      .query<{ name: string | null; kind: string | null; path: string; line: number }, [string, string]>(
        `SELECT s.name AS name, s.kind AS kind, e.path AS path, MIN(e.line) AS line
         FROM edges e LEFT JOIN symbols s ON s.id = e.src
         WHERE e.kind = 'call' AND e.dst = ? AND (s.id IS NULL OR s.id <> ?)
         GROUP BY e.src, e.path
         ORDER BY e.path, line
         LIMIT 40`,
      )
      .all(symbol.name, symbol.id)
      .map(toCaller)

    const callees = graph.db
      .query<{ name: string; path: string; line: number; calls: number }, [string]>(
        `SELECT e.dst AS name, MIN(e.path) AS path, MIN(e.line) AS line, COUNT(*) AS calls
         FROM edges e WHERE e.kind = 'call' AND e.src = ?
         GROUP BY e.dst ORDER BY calls DESC, e.dst LIMIT 40`,
      )
      .all(symbol.id)

    const importers = graph.db
      .query<{ path: string }, [string]>(
        "SELECT DISTINCT path FROM edges WHERE kind = 'import' AND dst = ? ORDER BY path LIMIT 40",
      )
      .all(symbol.path)
      .map((row) => row.path)

    return { symbol, callers, callees, importers }
  } finally {
    graph.db.close()
  }
}

export function impact(root: string, name: string, depth = 3, limit = 200): ImpactResult | undefined {
  ensureIndexed(root)
  const graph = open(root)
  try {
    const target = pickGraph(graph, name)
    if (!target) return undefined

    const seen = new Set([target.name])
    const seenSources = new Set<string>()
    const ambiguous = new Set<string>()
    const rings: ImpactRing[] = []
    let frontier = [target.name]
    let total = 0
    let truncated = false

    for (let level = 1; level <= Math.max(1, depth) && frontier.length > 0; level++) {
      // A name declared in many places cannot say which declaration the next ring belongs to, so the
      // walk stops there instead of reporting every unrelated symbol that shares the name.
      const placeholders = frontier.map(() => "?").join(", ")
      const shared = graph.db
        .query<{ name: string }, (string | number)[]>(
          `SELECT name FROM symbols WHERE name IN (${placeholders}) GROUP BY name HAVING COUNT(*) > 3`,
        )
        .all(...frontier)
        .map((row) => row.name)
      for (const sharedName of shared) ambiguous.add(sharedName)
      frontier = frontier.filter((name) => !ambiguous.has(name))
      if (frontier.length === 0) break

      const callers = frontier.map(() => "?").join(", ")
      const rows = graph.db
        .query<
          { src: string; name: string | null; kind: string | null; path: string; line: number },
          (string | number)[]
        >(
          `SELECT e.src AS src, s.name AS name, s.kind AS kind, COALESCE(s.path, e.path) AS path, MIN(e.line) AS line
           FROM edges e LEFT JOIN symbols s ON s.id = e.src
           WHERE e.kind = 'call' AND e.dst IN (${callers})
           GROUP BY e.src, e.path ORDER BY path LIMIT ?`,
        )
        .all(...frontier, limit)

      const fresh = rows.filter((row) => !seenSources.has(row.src) && (row.name === null || !seen.has(row.name)))
      if (fresh.length === 0) break
      for (const row of fresh) {
        seenSources.add(row.src)
        if (row.name !== null) seen.add(row.name)
      }
      total += fresh.length
      if (total >= limit) {
        truncated = true
        rings.push({ depth: level, callers: fresh.slice(0, Math.max(0, limit - (total - fresh.length))).map(toCaller) })
        break
      }
      rings.push({ depth: level, callers: fresh.map(toCaller) })
      // A file-level caller has no name to follow, so it appears in its ring and stops there.
      frontier = fresh.flatMap((row) => (row.name === null ? [] : [row.name]))
    }

    const importers = graph.db
      .query<{ path: string }, [string]>("SELECT DISTINCT path FROM edges WHERE kind = 'import' AND dst = ?")
      .all(target.path)
      .map((row) => row.path)
    const files = [
      ...new Set([target.path, ...rings.flatMap((ring) => ring.callers.map((caller) => caller.path)), ...importers]),
    ]

    return { target, rings, files, total, truncated, ambiguous: [...ambiguous] }
  } finally {
    graph.db.close()
  }
}

export function index(root: string, options: IndexOptions = {}): IndexReport {
  return indexProject(root, options)
}

/** Projects above this size are indexed on request only: building their graph takes long enough to stall a request. */
const AUTO_INDEX_LIMIT = 400

/** Makes sure a graph exists, indexing a small project implicitly. False when the project needs the index action. */
export function ensureIndexed(root: string): boolean {
  if (fs.existsSync(databasePath(root))) return true
  const files = listFiles(root)
  if (files.length > AUTO_INDEX_LIMIT) return false
  indexProject(root, { files })
  return true
}

function searchGraph(graph: Graph, term: string, limit: number): SearchHit[] {
  const rows = graph.db
    .query<SymbolRow, [string]>(`SELECT ${SYMBOL_COLUMNS} FROM symbols WHERE name = ? COLLATE NOCASE LIMIT 200`)
    .all(term)

  const found = new Map<string, Symbol>()
  for (const row of rows) found.set(row.id, toSymbol(row))

  // The trigram index only answers terms of three characters or more; shorter ones scan the name index.
  const matches =
    term.length >= 3
      ? graph.db
          .query<SymbolRow, [string]>(
            `SELECT ${SYMBOL_COLUMNS.split(", ")
              .map((column) => `s.${column}`)
              .join(", ")}
             FROM symbols_fts f JOIN symbols s ON s.rowid = f.rowid
             WHERE symbols_fts MATCH ? LIMIT 200`,
          )
          .all(`"${term.replaceAll('"', '""')}"`)
      : graph.db
          .query<SymbolRow, [string]>(`SELECT ${SYMBOL_COLUMNS} FROM symbols WHERE name LIKE ? LIMIT 200`)
          .all(`%${term}%`)
  for (const row of matches) found.set(row.id, toSymbol(row))

  return [...found.values()]
    .map((symbol) => ({ symbol, score: score(symbol, term) }))
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score || left.symbol.path.length - right.symbol.path.length)
    .slice(0, limit)
}

function pickGraph(graph: Graph, name: string): Symbol | undefined {
  const term = name.trim()
  if (!term) return undefined
  return searchGraph(graph, term, 1)[0]?.symbol
}

function score(symbol: Symbol, term: string) {
  const name = symbol.name.toLowerCase()
  const wanted = term.toLowerCase()
  const match = name === wanted ? 100 : name.startsWith(wanted) ? 70 : name.includes(wanted) ? 50 : 0
  const kind =
    symbol.kind === "function" || symbol.kind === "class"
      ? 8
      : symbol.kind === "method" || symbol.kind === "interface"
        ? 4
        : 0
  const test = TEST_PATH.test(symbol.path) ? -25 : 0
  return match + (symbol.exported ? 6 : 0) + kind + test - symbol.path.split("/").length
}

function toCaller(row: { name: string | null; kind: string | null; path: string; line: number }): CallerRef {
  return {
    name: row.name ?? row.path,
    kind: (row.kind as CallerRef["kind"] | null) ?? "module",
    path: row.path,
    line: row.line,
  }
}
