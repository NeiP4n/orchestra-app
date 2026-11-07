export * as AutoloopRepeat from "./repeat.js"

import { createHash } from "node:crypto"

// Stop-word on a deadlock (idea #2): the same error three times in a row,
// or three times within an hour, stops the run instead of retrying it.
//
// The retry caps in the session runner (Б4/Б5: at most 2 retries per step,
// deterministic errors never retry) bound one step; they cannot see that
// three separate attempts all died on the *same* error. This module is the
// missing piece: a fingerprint that says "same error" even when the raw
// text differs in numbers, paths, ids and timestamps, plus the count that
// decides when the run is stuck. It is pure — no Effect, no I/O — so the
// kernel (`decide.ts`) and the session runner can both use it.

/** Consecutive repeats of one fingerprint that stop the run. */
export const REPEAT_STOP_CONSECUTIVE = 3

/** Repeats of one fingerprint inside this window that stop the run, even when not consecutive. */
export const REPEAT_STOP_WINDOW = 3

/** The window for the non-consecutive rule, milliseconds (1 hour). */
export const REPEAT_WINDOW_MS = 60 * 60 * 1000

/** How many past occurrences the run row keeps (oldest dropped first). */
export const REPEAT_HISTORY_KEPT = 10

/** One past occurrence of an error: its fingerprint and when it happened. */
export interface ErrorOccurrence {
  readonly fp: string
  readonly at: number
}

/**
 * Normalise error text so the same failure compares equal across attempts:
 * lowercased, numbers / hex / UUIDs / timestamps / quoted strings / paths
 * replaced by placeholders, whitespace collapsed, capped. Two errors that
 * differ only in a port, a pid, a temp path or a timestamp normalise to the
 * same text; two genuinely different errors do not.
 */
export function normalizeError(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b[0-9a-f]{32,}\b/g, "<hex>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(z|[+-]\d{2}:?\d{2})?\b/g, "<time>")
    .replace(/\b\d+:\d{2}(:\d{2})?\b/g, "<time>")
    .replace(/(["'`])[^"'`\n]{1,80}\1/g, "<quoted>")
    .replace(/([/~][\w.~-]+){2,}/g, "<path>")
    .replace(/\b\d+(\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
}

/** Short stable fingerprint of an error: sha256 of its normalised text, first 16 hex chars. */
export function fingerprintError(text: string): string {
  return createHash("sha256").update(normalizeError(text)).digest("hex").slice(0, 16)
}

/** Parse the run row's stored history (`error_history`, a JSON string); garbage reads as empty. */
export function parseHistory(stored: string | null | undefined): ErrorOccurrence[] {
  if (stored === undefined || stored === null || stored === "") return []
  try {
    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is ErrorOccurrence =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { fp?: unknown }).fp === "string" &&
        typeof (entry as { at?: unknown }).at === "number",
    )
  } catch {
    return []
  }
}

/** What recording one more occurrence does to the history. */
export interface RepeatStatus {
  /** History with the new occurrence appended (capped at `REPEAT_HISTORY_KEPT`). */
  readonly history: ErrorOccurrence[]
  /** How many times this fingerprint occurred in a row, counting the new one. */
  readonly consecutive: number
  /** How many times this fingerprint occurred inside the last hour, counting the new one. */
  readonly inWindow: number
  /** True when the run is stuck: 3 in a row, or 3 inside an hour. */
  readonly stuck: boolean
}

/** Record one occurrence of an error (by its fingerprint) at `now` and say whether the run is stuck.
 * The stop thresholds come from the autoloop limits (`failureRepeatStop`, default 3) when given,
 * so the operator tunes the number in config, not in a prompt. */
export function recordRepeat(
  stored: string | null | undefined,
  fingerprint: string,
  now: number,
  thresholds: { readonly consecutive?: number; readonly window?: number } = {},
): RepeatStatus {
  const consecutiveStop = Math.max(1, thresholds.consecutive ?? REPEAT_STOP_CONSECUTIVE)
  const windowStop = Math.max(1, thresholds.window ?? REPEAT_STOP_WINDOW)
  const history = [...parseHistory(stored), { fp: fingerprint, at: now }].slice(-REPEAT_HISTORY_KEPT)
  let consecutive = 0
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index]!.fp !== fingerprint) break
    consecutive++
  }
  const inWindow = history.filter((entry) => entry.fp === fingerprint && entry.at > now - REPEAT_WINDOW_MS).length
  return {
    history,
    consecutive,
    inWindow,
    stuck: consecutive >= consecutiveStop || inWindow >= windowStop,
  }
}
