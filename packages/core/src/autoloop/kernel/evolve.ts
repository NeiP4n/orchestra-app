export * as AutoloopEvolve from "./evolve.js"

import type { AutoloopFact, ProjectionRow } from "./schema.js"

// Journal + projections (block B2). Pure functions only — no Effect, no I/O,
// so `decide` (block B3) can reuse them and any decision can be replayed.
// The journal is the source of truth; a projection is disposable state that
// `rebuild` recreates from the journal byte-for-byte.

/** Current state, folded from the journal: collection -> key -> row data. */
export type View = Record<string, Record<string, unknown>>

export function emptyView(): View {
  return {}
}

/** ISO timestamp for facts, mirroring agent-autoloop's `iso` helper. */
export function iso(now: Date = new Date()): string {
  return now.toISOString()
}

/**
 * Fold one fact into a view. A fact with `collection` + `key` writes one
 * projection row (`data` upserts, `data: null` deletes it); a fact without
 * them is journal-only and leaves the view untouched. Returns a new view;
 * the input is never mutated.
 */
export function evolve(view: View, fact: AutoloopFact): View {
  if (fact.collection === undefined || fact.key === undefined) return view
  const next = { ...view, [fact.collection]: { ...(view[fact.collection] ?? {}) } }
  if (fact.data === null || fact.data === undefined) {
    delete next[fact.collection]![fact.key]
    if (Object.keys(next[fact.collection]!).length === 0) delete next[fact.collection]
    return next
  }
  next[fact.collection]![fact.key] = fact.data
  return next
}

/** Rebuild the whole view by folding the journal in `seq` order. */
export function rebuild(facts: ReadonlyArray<AutoloopFact>): View {
  return facts.reduce(evolve, emptyView())
}

/** Flatten a view into the rows stored in `autoloop_projections`. */
export function snapshot(view: View): ProjectionRow[] {
  return Object.entries(view).flatMap(([collection, rows]) =>
    Object.entries(rows).map(([key, data]) => ({
      collection,
      key,
      data: data as Record<string, unknown>,
    })),
  )
}

/** All rows of one collection, sorted by key for stable comparisons. */
export function rows(view: View, collection: string): ProjectionRow[] {
  return Object.entries(view[collection] ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, data]) => ({ collection, key, data: data as Record<string, unknown> }))
}

/** Keys changed between two views, as `(collection, key)` pairs. */
export function diff(oldView: View, newView: View): Array<{ collection: string; key: string }> {
  const changed: Array<{ collection: string; key: string }> = []
  const collections = new Set([...Object.keys(oldView), ...Object.keys(newView)])
  for (const collection of collections) {
    const keys = new Set([...Object.keys(oldView[collection] ?? {}), ...Object.keys(newView[collection] ?? {})])
    for (const key of keys) {
      const before = JSON.stringify(oldView[collection]?.[key] ?? null)
      const after = JSON.stringify(newView[collection]?.[key] ?? null)
      if (before !== after) changed.push({ collection, key })
    }
  }
  return changed
}
