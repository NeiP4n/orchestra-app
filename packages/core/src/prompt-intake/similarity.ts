export * as PromptIntakeSimilarity from "./similarity.js"

import { keywordStems } from "./normalize.js"

/** |A ∩ B| / |A ∪ B| over content keyword stems. */
export function jaccard(a: string, b: string): number {
  const aKeys = new Set(keywordStems(a))
  const bKeys = new Set(keywordStems(b))
  if (aKeys.size === 0 || bKeys.size === 0) return 0
  let intersection = 0
  for (const key of aKeys) if (bKeys.has(key)) intersection++
  return intersection / (aKeys.size + bKeys.size - intersection)
}

/** |A ∩ B| / |A|: 1 when every keyword stem of A appears in B (A is a subset of B). */
export function containment(a: string, b: string): number {
  const aKeys = new Set(keywordStems(a))
  const bKeys = new Set(keywordStems(b))
  if (aKeys.size === 0) return 0
  let intersection = 0
  for (const key of aKeys) if (bKeys.has(key)) intersection++
  return intersection / aKeys.size
}

/**
 * One number for "do these two texts talk about the same work".
 * Jaccard catches same-topic rewordings; containment catches a prompt that
 * is a subset of a bigger task (or the other way round).
 */
export function similarity(a: string, b: string): number {
  return 0.5 * jaccard(a, b) + 0.5 * Math.max(containment(a, b), containment(b, a))
}
