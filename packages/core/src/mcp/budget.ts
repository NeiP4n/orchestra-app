export * as McpBudget from "./budget.js"

import { and, asc, eq, gt, gte, lt } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import type { KV } from "../kv.js"
import { KVTable } from "../kv/sql.js"

// ---------------------------------------------------------------------------
// The MCP call budget: the enforcement half of the Orchestrator's per-task
// MCP limits (the distribution half lives in the Orchestra tool plugin,
// which resolves a limit against the role's ceiling and stamps it on the
// worker session's metadata under LIMIT_METADATA_KEY).
//
// A stamped limit is only a promise until something counts calls against
// it. That counting happens here, at the single dispatch point every MCP
// tool call passes through (`MCP.callTool` in ./index.ts — its only
// production caller is the MCP tool wrapper, which asserts permissions
// before dispatch, so permission-denied calls never reach this gate and
// never consume budget).
//
// The invariant: a task never executes more MCP calls than its budget,
// regardless of concurrency, process restarts, or how many service
// instances and processes share the database. That invariant cannot rest
// on in-process synchronization, so a reservation is a database
// transaction, not an in-memory counter:
//
//   reserve = BEGIN IMMEDIATE; read the session's usage row; decide;
//             write the incremented row; COMMIT — then, and only then,
//             dispatch.
//
// SQLite serializes immediate transactions across every connection to the
// file (the database layer runs WAL with a 5s busy timeout), so two
// racing reservations — parallel fibers, two MCP instances, two server
// processes — cannot both take the last slot: the second transaction
// reads the first one's committed count. Reservation and persistence are
// the same event, so there is no crash window between them and no
// snapshot that two reservers could both act on. A store failure fails
// the reservation, and the caller refuses the call: a budget we cannot
// enforce is never silently skipped.
//
// Semantics, chosen so the limit cannot be sidestepped quietly:
//
// - Attempts count, not successes. The reservation commits before
//   dispatch and is never refunded: a call that fails, times out, or is
//   retried by the model has still spent budget. (Transport-level
//   recovery inside one `callTool` — reconnect and retry after a session
//   expiry — is part of that same call and counts once.)
// - A new stamp is a new task. The plugin stamps a fresh `budgetEpoch`
//   with every limit it hands out; usage is stored per epoch, and the
//   first reservation under a new epoch atomically replaces the old
//   epoch's row. Calls already reserved under the old epoch when the
//   stamp changes were within that task's budget and still complete;
//   later calls gate against the new epoch.
// - Corrupted usage fails closed. A usage row that does not parse means
//   the count is unknowable; resetting it to zero would hand back spent
//   budget, so the session's MCP calls are refused until the row is
//   removed (session deletion and the cleanup below do that).
// - No stamp, default budget. Sessions the Orchestrator never stamped
//   (every ordinary session) used to be ungated entirely: a runaway model
//   could call MCP tools without any cap. They now get the default limit —
//   50 calls per session, every server — stamped in code at the gate
//   (`defaultStamp`, epoch "default"), not written to the session. A real
//   stamp still replaces it: the first reservation under a stamped epoch
//   atomically replaces the default row, so a task never inherits the
//   session's earlier ungated usage.
// - The budget counts output tokens too, not just calls: a limit may carry
//   `maxTokens`, and every successful call adds its estimated output tokens
//   to the usage row (`recordOutput`, called by the dispatch point after
//   the result arrives). A call that would start past the token cap is
//   refused at reservation time, the same way an exhausted call cap is.
// - Cleanup is bounded and never touches an active task. When a session's
//   stamp disappears, its usage row is deleted at the next consult; a
//   sweep at service start deletes rows whose session is gone or whose
//   epoch no longer matches the session's current stamp. The row of a
//   session whose stamp still matches is its live counter and stays.
// ---------------------------------------------------------------------------

/** Session metadata key carrying the stamped limit. Kept in step with the Orchestra plugin's MCP_LIMIT_METADATA_KEY. */
export const LIMIT_METADATA_KEY = "orchestra:mcp-limit"

/** KV key prefix for persisted per-session usage: `mcp-usage/<sessionID>`. */
export const USAGE_KEY_PREFIX = "mcp-usage/"

/** The budget the Orchestrator handed one task, as stamped on the session. */
export interface Limit {
  /** MCP server names the worker may call, or "all" when the role sets no boundary. */
  readonly servers: ReadonlyArray<string> | "all"
  /** Total MCP tool calls allowed for the task. */
  readonly maxCalls: number
  /** Per-server call caps, for servers in the effective allowlist. */
  readonly perServer: Readonly<Record<string, number>>
  /** Estimated output tokens allowed for the task, when the Orchestrator set one; absent means calls alone cap it. */
  readonly maxTokens?: number
}

/** Calls counted against one epoch of one session's budget. */
export interface Usage {
  readonly total: number
  readonly perServer: Readonly<Record<string, number>>
  /** Estimated output tokens of successful calls in this epoch. */
  readonly tokens: number
}

/** Default call cap for a session with no stamped limit: 50 calls, every server. */
export const DEFAULT_UNSTAMPED_MAX_CALLS = 50
/** Epoch of the default limit: one per session, not per task, since there is no task to bound it. */
export const DEFAULT_EPOCH = "default"

/** The limit the gate applies to a session with no stamp: the default, stamped in code. */
export function defaultStamp(): Stamp {
  return {
    kind: "limit",
    limit: { servers: "all", maxCalls: DEFAULT_UNSTAMPED_MAX_CALLS, perServer: {} },
    epoch: DEFAULT_EPOCH,
  }
}

/** What the gate found on a session: no stamp, an unreadable stamp, or a limit with its epoch. */
export type Stamp =
  | { readonly kind: "none" }
  | { readonly kind: "invalid" }
  | { readonly kind: "limit"; readonly limit: Limit; readonly epoch: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0

const parseLimit = (value: unknown): Limit | undefined => {
  if (!isRecord(value)) return undefined
  const servers =
    value.servers === "all"
      ? "all"
      : Array.isArray(value.servers) && value.servers.every((server) => typeof server === "string")
        ? (value.servers as ReadonlyArray<string>)
        : undefined
  if (servers === undefined || !isCount(value.maxCalls)) return undefined
  if (!isRecord(value.perServer) || !Object.values(value.perServer).every(isCount)) return undefined
  if (value.maxTokens !== undefined && !isCount(value.maxTokens)) return undefined
  return {
    servers,
    maxCalls: value.maxCalls,
    perServer: value.perServer as Record<string, number>,
    ...(value.maxTokens === undefined ? {} : { maxTokens: value.maxTokens as number }),
  }
}

/**
 * Read the stamped limit out of a session's metadata. The epoch identifies
 * the task the limit was handed to: the plugin's `budgetEpoch` when present,
 * otherwise a fingerprint of the limit itself (stamps written before epochs
 * existed still gate, they just cannot tell two identical consecutive tasks
 * apart).
 */
export function parseStamp(metadata: Record<string, unknown> | undefined): Stamp {
  const raw = metadata?.[LIMIT_METADATA_KEY]
  if (raw === undefined) return { kind: "none" }
  const limit = parseLimit(raw)
  if (!limit) return { kind: "invalid" }
  const epoch =
    isRecord(raw) && typeof raw.budgetEpoch === "string" && raw.budgetEpoch !== ""
      ? raw.budgetEpoch
      : JSON.stringify(limit)
  return { kind: "limit", limit, epoch }
}

/** The persisted usage record: one KV row per stamped session, tagged with its epoch. */
export interface PersistedUsage extends Usage {
  readonly epoch: string
}

export const parsePersistedUsage = (value: unknown): PersistedUsage | undefined => {
  if (!isRecord(value) || typeof value.epoch !== "string" || !isCount(value.total)) return undefined
  if (!isRecord(value.perServer) || !Object.values(value.perServer).every(isCount)) return undefined
  // Rows written before token accounting carry no `tokens`; they spent none by this measure.
  if (value.tokens !== undefined && !isCount(value.tokens)) return undefined
  return {
    epoch: value.epoch,
    total: value.total,
    perServer: value.perServer as Record<string, number>,
    tokens: (value.tokens as number | undefined) ?? 0,
  }
}

export const invalidStampMessage = `This session's MCP limit (session metadata "${LIMIT_METADATA_KEY}") is malformed, so its MCP calls are refused until the limit is stamped again.`

export const corruptedUsageMessage =
  "This session's MCP usage record is unreadable, so its MCP calls are refused rather than resetting spent budget. The record is removed when the session is deleted or its limit is stamped again."

/** The outcome of checking one prospective call against counted usage. */
export type Decision =
  | { readonly allowed: true; readonly next: Usage }
  | { readonly allowed: false; readonly message: string }

/**
 * Pure check-and-count over already-read usage: allowlist, then the total
 * cap, then the per-server cap, then the output-token cap when the limit
 * sets one. Denials carry no `next` — a refused call consumes nothing.
 * Reserving is `decide` plus the transactional write in `reserve` below;
 * the two are only ever used together.
 */
export function decide(input: { readonly limit: Limit; readonly server: string; readonly usage: Usage }): Decision {
  const { limit, server, usage } = input
  if (limit.servers !== "all" && !limit.servers.includes(server))
    return {
      allowed: false,
      message: `MCP server "${server}" is not in this task's MCP allowlist (${limit.servers.join(", ") || "no servers"}). The Orchestrator set this limit; work within it or report back.`,
    }
  if (usage.total >= limit.maxCalls)
    return {
      allowed: false,
      message: `MCP budget exhausted for this task: ${usage.total} of ${limit.maxCalls} allowed calls used. The Orchestrator set this limit; finish with what you have or report back.`,
    }
  const serverCap = limit.perServer[server]
  const serverUsed = usage.perServer[server] ?? 0
  if (serverCap !== undefined && serverUsed >= serverCap)
    return {
      allowed: false,
      message: `MCP budget exhausted for server "${server}" on this task: ${serverUsed} of ${serverCap} allowed calls used. The Orchestrator set this limit; finish with what you have or report back.`,
    }
  if (limit.maxTokens !== undefined && usage.tokens >= limit.maxTokens)
    return {
      allowed: false,
      message: `MCP output-token budget exhausted for this task: ${usage.tokens} of ${limit.maxTokens} estimated output tokens used. The Orchestrator set this limit; finish with what you have or report back.`,
    }
  return {
    allowed: true,
    next: { total: usage.total + 1, perServer: { ...usage.perServer, [server]: serverUsed + 1 }, tokens: usage.tokens },
  }
}

/** Rough output-token estimate for a call result: ~4 characters per token, text and media alike. */
export function estimateOutputTokens(
  content: ReadonlyArray<{ readonly text?: string; readonly data?: string }>,
): number {
  const chars = content.reduce((sum, part) => sum + (part.text?.length ?? 0) + (part.data?.length ?? 0), 0)
  return Math.ceil(chars / 4)
}

type Db = Database.Interface["db"]

export const usageKey = (sessionID: string) => `${USAGE_KEY_PREFIX}${sessionID}`

/**
 * Reserve one call against the session's stamped budget, atomically: the
 * usage row is read, decided against and incremented inside a single
 * immediate transaction on the shared database (see the header for why
 * this is the atomicity boundary). Returns the refusal message, or
 * undefined when the call is reserved and may dispatch. Database failures
 * die; the caller turns them into a refusal, never into an unbudgeted
 * dispatch.
 */
export function reserve(
  db: Db,
  input: { readonly sessionID: string; readonly server: string; readonly stamp: Stamp },
): Effect.Effect<string | undefined> {
  if (input.stamp.kind === "none") return Effect.succeed(undefined)
  if (input.stamp.kind === "invalid") return Effect.succeed(invalidStampMessage)
  const stamp = input.stamp
  const key = usageKey(input.sessionID)
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
          let usage: Usage = { total: 0, perServer: {}, tokens: 0 }
          if (row) {
            const persisted = parsePersistedUsage(row.value)
            if (!persisted) return corruptedUsageMessage
            if (persisted.epoch === stamp.epoch) usage = persisted
          }
          const decision = decide({ limit: stamp.limit, server: input.server, usage })
          if (!decision.allowed) return decision.message
          const value: KV.Value = {
            epoch: stamp.epoch,
            total: decision.next.total,
            perServer: decision.next.perServer,
            tokens: decision.next.tokens,
          }
          yield* tx
            .insert(KVTable)
            .values({ key, value })
            .onConflictDoUpdate({ target: KVTable.key, set: { value, time_updated: Date.now() } })
            .run()
            .pipe(Effect.orDie)
          return undefined
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
}

/**
 * Add a finished call's estimated output tokens to the session's usage row.
 * The call itself was already reserved (and counted) before dispatch; this
 * is the second half of the token budget. No row means the call was never
 * reserved — nothing to charge — and a failure here never fails the call
 * it accounts for; the caller ignores it.
 */
export function recordOutput(db: Db, sessionID: string, tokens: number): Effect.Effect<void> {
  if (tokens <= 0) return Effect.void
  const key = usageKey(sessionID)
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
          if (!row) return
          const persisted = parsePersistedUsage(row.value)
          if (!persisted) return
          const value: KV.Value = { ...persisted, tokens: persisted.tokens + Math.round(tokens) }
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

/** Read a session's persisted usage row, for cleanup decisions and tests. */
export function readUsage(db: Db, sessionID: string): Effect.Effect<PersistedUsage | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select({ value: KVTable.value })
      .from(KVTable)
      .where(eq(KVTable.key, usageKey(sessionID)))
      .get()
      .pipe(Effect.orDie)
    return row ? parsePersistedUsage(row.value) : undefined
  })
}

/** Drop a session's usage row (its stamp is gone, or the session is). */
export function removeUsage(db: Db, sessionID: string): Effect.Effect<void> {
  return db.delete(KVTable).where(eq(KVTable.key, usageKey(sessionID))).run().pipe(Effect.orDie)
}

const prefixEnd = (prefix: string) => {
  const end = prefix.replace(/[\u{0}-\u{10FFFF}]+$/u, "")
  if (end === "") return undefined
  const code = end.codePointAt(end.length - 1)!
  return end.slice(0, end.length - 1) + String.fromCodePoint(code + 1)
}

/** Every persisted usage row, paged like KV.scan. For the startup sweep. */
export function listUsage(
  db: Db,
): Effect.Effect<ReadonlyArray<{ sessionID: string; usage: PersistedUsage | undefined }>> {
  return Effect.gen(function* () {
    const entries: { sessionID: string; usage: PersistedUsage | undefined }[] = []
    const end = prefixEnd(USAGE_KEY_PREFIX)
    let after: string | undefined
    for (;;) {
      const rows = yield* db
        .select({ key: KVTable.key, value: KVTable.value })
        .from(KVTable)
        .where(
          and(
            gte(KVTable.key, USAGE_KEY_PREFIX),
            end === undefined ? undefined : lt(KVTable.key, end),
            after === undefined ? undefined : gt(KVTable.key, after),
          ),
        )
        .orderBy(asc(KVTable.key))
        .limit(1001)
        .all()
        .pipe(Effect.orDie)
      for (const row of rows.slice(0, 1000))
        entries.push({ sessionID: row.key.slice(USAGE_KEY_PREFIX.length), usage: parsePersistedUsage(row.value) })
      if (rows.length <= 1000) return entries
      after = rows[999].key
    }
  })
}
