export * as Idempotency from "./idempotency.js"

import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { KV } from "../kv.js"

// Deduplication for external actions (block Б4): the same session doing the
// same thing to the same target twice — a crash between the action and its
// receipt, a resume, or a model that repeats itself — must not do it twice.
// The key is `hash(sessionID + action + target)` in KV under
// `autoloop/idempotency/…`, with a TTL so keys never grow forever. A repeat
// inside the TTL returns the first run's result instead of running again.
//
// Every new external tool must go through here (review check: a call without
// a key is not accepted). The stored record is the proof the action ran;
// an expired record is gone, so the action may run again after the TTL.

/** KV prefix for idempotency records. */
export const PREFIX = "autoloop/idempotency/"

/** How long a record counts as a duplicate: 10 minutes. */
export const DEFAULT_TTL_MS = 10 * 60_000

/** Expired records are swept at most once an hour, on a write. */
export const PRUNE_INTERVAL_MS = 60 * 60_000

const PRUNE_MARKER = `${PREFIX}__pruned_at`

export interface Input {
  /** The session that performs the action. */
  readonly sessionID: string
  /** The action, e.g. `desktop_open`, `zen_browser navigate`, `browser.tabs.open`. */
  readonly action: string
  /** What the action acts on: the URL, app, file, or text. */
  readonly target: string
  /** How long the record counts as a duplicate, milliseconds. Defaults to `DEFAULT_TTL_MS`. */
  readonly ttlMs?: number
}

export interface Record {
  readonly result: string
  readonly at: number
  readonly expiresAt: number
}

/** Normalize the target so the same destination spelled two ways is one key. */
export function normalizeTarget(target: string): string {
  const trimmed = target.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      url.hash = ""
      return url.href.replace(/\/$/, "")
    } catch {
      return trimmed
    }
  }
  return trimmed
}

/** The KV key for one external action: `hash(sessionID + action + target)`. */
export function keyFor(sessionID: string, action: string, target: string): string {
  const digest = createHash("sha256")
    .update(`${sessionID}\n${action}\n${normalizeTarget(target)}`)
    .digest("hex")
  return `${PREFIX}${digest}`
}

const keyOf = (input: Input): string => keyFor(input.sessionID, input.action, input.target)

const decodeRecord = (value: unknown): Record | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record
  if (typeof record.result !== "string" || typeof record.at !== "number" || typeof record.expiresAt !== "number") return undefined
  return record
}

/**
 * The live record for this action, if one exists. An expired record is
 * removed and counts as no record: the action may run again after the TTL.
 */
export const check = (kv: KV.Interface, input: Input, now = Date.now()): Effect.Effect<Record | undefined> =>
  Effect.gen(function* () {
    const record = decodeRecord(yield* kv.get(keyOf(input)))
    if (record === undefined) return undefined
    if (now >= record.expiresAt) {
      yield* kv.remove(keyOf(input))
      return undefined
    }
    return record
  })

/** Store the result of a run, so a repeat inside the TTL returns it instead of running again. */
export const record = (kv: KV.Interface, input: Input, result: string, now = Date.now()): Effect.Effect<void> =>
  Effect.gen(function* () {
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
    yield* kv.set(keyOf(input), { result, at: now, expiresAt: now + ttlMs })
    yield* maybePrune(kv, now).pipe(Effect.ignore)
  })

/**
 * Run the action unless an identical one already ran inside the TTL: then
 * return the first run's result and `duplicate: true`, without running
 * again. A failed run stores nothing, so a later retry may still run.
 */
export const dedup = <E>(
  kv: KV.Interface,
  input: Input,
  run: Effect.Effect<string, E>,
  now = Date.now(),
): Effect.Effect<{ readonly duplicate: boolean; readonly result: string }, E> =>
  Effect.gen(function* () {
    const existing = yield* check(kv, input, now)
    if (existing !== undefined) return { duplicate: true, result: existing.result }
    const result = yield* run
    // The record is bookkeeping: the action already ran, so a failed write
    // must not fail it — a later repeat may simply run again.
    yield* record(kv, input, result, now).pipe(Effect.ignore)
    return { duplicate: false, result }
  })

/** Remove expired records. Returns how many were removed. */
export const prune = (kv: KV.Interface, now = Date.now()): Effect.Effect<number> =>
  Effect.gen(function* () {
    const scanned = yield* kv.scan({ prefix: PREFIX, limit: 1000 })
    let removed = 0
    for (const entry of scanned.entries) {
      if (entry.key === PRUNE_MARKER) continue
      const record = decodeRecord(entry.value)
      if (record === undefined || now >= record.expiresAt) {
        yield* kv.remove(entry.key)
        removed += 1
      }
    }
    return removed
  })

const maybePrune = (kv: KV.Interface, now: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    const marked = yield* kv.get(PRUNE_MARKER)
    if (typeof marked === "number" && now - marked < PRUNE_INTERVAL_MS) return
    yield* prune(kv, now)
    yield* kv.set(PRUNE_MARKER, now)
  })
