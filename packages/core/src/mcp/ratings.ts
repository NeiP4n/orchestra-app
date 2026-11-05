export * as McpRatings from "./ratings.js"

import { and, asc, eq, gt, gte, lt } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import type { KV } from "../kv.js"
import { KVTable } from "../kv/sql.js"

// Persistent per-server ratings: what the fleet learned about each MCP
// server — calls, successes, failures, latency, output size — stored in the
// same KV table as the budget usage, so a new Orchestrator does not start
// from zero: the previous session's dead server is still demoted, and the
// fast reliable one is still preferred. The selection ranking (./select.ts)
// reads these through `adjustment`; the MCP service records every call
// outcome (./index.ts) right after dispatch, best-effort — a rating write
// failure never fails the call it describes.
//
// A rating is a plain record, never a score frozen at write time: the score
// is derived on read, so a better formula applies to old evidence too.

/** KV key prefix for persisted per-server ratings: `mcp-rating/<server>`. */
export const RATING_KEY_PREFIX = "mcp-rating/"

export interface Rating {
  /** Tool calls dispatched to the server. */
  readonly calls: number
  /** Calls that returned a result (including a result marked isError by the server). */
  readonly successes: number
  /** Calls that failed in transport or dispatch (never reached the server or never returned). */
  readonly failures: number
  /** Total wall-clock milliseconds of successful calls. */
  readonly totalLatencyMs: number
  /** Total estimated output tokens of successful calls. */
  readonly totalOutputTokens: number
}

export const emptyRating: Rating = { calls: 0, successes: 0, failures: 0, totalLatencyMs: 0, totalOutputTokens: 0 }

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Parse a stored rating; undefined when the row is not a rating (old or corrupt rows are ignored, never trusted). */
export function parseRating(value: unknown): Rating | undefined {
  if (!isRecord(value)) return undefined
  const fields = ["calls", "successes", "failures", "totalLatencyMs", "totalOutputTokens"] as const
  if (!fields.every((field) => isCount(value[field]))) return undefined
  return {
    calls: value.calls as number,
    successes: value.successes as number,
    failures: value.failures as number,
    totalLatencyMs: value.totalLatencyMs as number,
    totalOutputTokens: value.totalOutputTokens as number,
  }
}

export const ratingKey = (server: string) => `${RATING_KEY_PREFIX}${server}`

/** Success rate with a weak prior: a server with 1 call is not yet "100% reliable". */
export function successRate(rating: Rating): number {
  return (rating.successes + 1) / (rating.calls + 2)
}

/** Mean latency of successful calls, in milliseconds; undefined when nothing succeeded yet. */
export function avgLatencyMs(rating: Rating): number | undefined {
  if (rating.successes === 0) return undefined
  return rating.totalLatencyMs / rating.successes
}

/**
 * Ranking adjustment from a rating, in the same units as the selection
 * score: a proven server gains up to +1, a failing one loses up to −1.
 * Fewer than 3 calls is no evidence yet, so no adjustment either way.
 * A slow server (over 5s mean latency) loses half a point on top, so a
 * fast 90% server outranks a slow 95% one for interactive work.
 */
export function adjustment(rating: Rating | undefined): number {
  if (!rating || rating.calls < 3) return 0
  const rate = successRate(rating)
  let value = (rate - 0.5) * 2
  const latency = avgLatencyMs(rating)
  if (latency !== undefined && latency > 5_000) value -= 0.5
  return Math.max(-1, Math.min(1, value))
}

type Db = Database.Interface["db"]

export interface Outcome {
  readonly ok: boolean
  /** Wall-clock milliseconds of the call. */
  readonly latencyMs: number
  /** Estimated output tokens, for successful calls. */
  readonly outputTokens?: number
}

/** Record one call outcome against a server's rating, atomically (read + write in one immediate transaction). */
export function record(db: Db, server: string, outcome: Outcome): Effect.Effect<void> {
  const key = ratingKey(server)
  return db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const row = yield* tx
            .select({ value: KVTable.value })
            .from(KVTable)
            .where(eq(KVTable.key, key))
            .get()
            .pipe(Effect.orDie)
          const previous = row ? (parseRating(row.value) ?? emptyRating) : emptyRating
          const next: Rating = {
            calls: previous.calls + 1,
            successes: previous.successes + (outcome.ok ? 1 : 0),
            failures: previous.failures + (outcome.ok ? 0 : 1),
            totalLatencyMs: previous.totalLatencyMs + (outcome.ok ? Math.max(0, Math.round(outcome.latencyMs)) : 0),
            totalOutputTokens:
              previous.totalOutputTokens + (outcome.ok ? Math.max(0, Math.round(outcome.outputTokens ?? 0)) : 0),
          }
          const value: KV.Value = { ...next }
          yield* tx
            .insert(KVTable)
            .values({ key, value })
            .onConflictDoUpdate({ target: KVTable.key, set: { value, time_updated: Date.now() } })
            .run()
            .pipe(Effect.orDie)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
}

/** Read one server's rating; undefined when the server has no recorded calls. */
export function readRating(db: Db, server: string): Effect.Effect<Rating | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select({ value: KVTable.value })
      .from(KVTable)
      .where(eq(KVTable.key, ratingKey(server)))
      .get()
      .pipe(Effect.orDie)
    return row ? parseRating(row.value) : undefined
  })
}

const prefixEnd = (prefix: string) => {
  const end = prefix.replace(/[\u{0}-\u{10FFFF}]+$/u, "")
  if (end === "") return undefined
  const code = end.codePointAt(end.length - 1)!
  return end.slice(0, end.length - 1) + String.fromCodePoint(code + 1)
}

/** Every persisted rating, keyed by server id. */
export function readAll(db: Db): Effect.Effect<ReadonlyMap<string, Rating>> {
  return Effect.gen(function* () {
    const ratings = new Map<string, Rating>()
    const end = prefixEnd(RATING_KEY_PREFIX)
    let after: string | undefined
    for (;;) {
      const rows = yield* db
        .select({ key: KVTable.key, value: KVTable.value })
        .from(KVTable)
        .where(
          and(
            gte(KVTable.key, RATING_KEY_PREFIX),
            end === undefined ? undefined : lt(KVTable.key, end),
            after === undefined ? undefined : gt(KVTable.key, after),
          ),
        )
        .orderBy(asc(KVTable.key))
        .limit(1001)
        .all()
        .pipe(Effect.orDie)
      for (const row of rows.slice(0, 1000)) {
        const rating = parseRating(row.value)
        if (rating) ratings.set(row.key.slice(RATING_KEY_PREFIX.length), rating)
      }
      if (rows.length <= 1000) return ratings
      after = rows[999].key
    }
  })
}
