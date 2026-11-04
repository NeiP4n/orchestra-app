export * as McpBudget from "./budget.js"

// ---------------------------------------------------------------------------
// The MCP call budget gate: the enforcement half of the Orchestrator's
// per-task MCP limits (the distribution half lives in the Orchestra tool
// plugin, which resolves a limit against the role's ceiling and stamps it on
// the worker session's metadata under LIMIT_METADATA_KEY).
//
// A stamped limit is only a promise until something counts calls against it.
// That counting happens here, at the single dispatch point every MCP tool
// call passes through (`MCP.callTool` in ./index.ts):
//
//   call -> read the session's stamp -> check allowlist -> check the total
//   cap -> check the per-server cap -> reserve (count) -> dispatch.
//
// Semantics, chosen so the limit cannot be sidestepped quietly:
//
// - Attempts count, not successes. The reservation is taken before dispatch
//   and is never refunded: a call that fails, times out, or is retried by
//   the model has still spent budget. (Transport-level recovery inside one
//   `callTool` — reconnect and retry after a session expiry — is part of
//   that same call and counts once.) A worker therefore cannot burn past
//   its cap by retrying errors.
// - Reserve is synchronous. Parallel calls from one session interleave only
//   at awaits; the check-and-increment below contains no await, so it is
//   atomic on the event loop and two racing calls cannot both take the
//   last slot. Counters live in this process, shared by every MCP service
//   instance in it — never per tool or per connection.
// - A new stamp is a new task. The plugin stamps a fresh `budgetEpoch` with
//   every limit it hands out; when the gate sees an epoch it has not counted
//   against, the session's counters restart at zero.
// - Restarts resume, they do not reset. Usage is written through to KV
//   under USAGE_KEY_PREFIX after every reservation, tagged with the epoch
//   it belongs to. After a restart the gate rehydrates from that record
//   when the epoch still matches the session's stamp, so a restart does
//   not hand the worker a fresh budget. A crash between reservation and
//   the KV write can lose the in-flight call's count — that is the one
//   documented gap, bounded at the calls in flight at the crash.
// - No stamp, no budget. Sessions the Orchestrator never stamped (every
//   ordinary session) are not gated at all. A stamp that is present but
//   malformed fails closed: the session's MCP calls are refused until the
//   stamp is fixed, because a limit we cannot read is not a limit we may
//   silently drop.
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
}

/** Calls counted against one epoch of one session's budget. */
export interface Usage {
  readonly total: number
  readonly perServer: Readonly<Record<string, number>>
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
  return { servers, maxCalls: value.maxCalls, perServer: value.perServer as Record<string, number> }
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

/** The persisted usage record the gate rehydrates from after a restart. */
export interface PersistedUsage extends Usage {
  readonly epoch: string
}

export const parsePersistedUsage = (value: unknown): PersistedUsage | undefined => {
  if (!isRecord(value) || typeof value.epoch !== "string" || !isCount(value.total)) return undefined
  if (!isRecord(value.perServer) || !Object.values(value.perServer).every(isCount)) return undefined
  return { epoch: value.epoch, total: value.total, perServer: value.perServer as Record<string, number> }
}

interface Entry {
  epoch: string
  total: number
  perServer: Map<string, number>
}

export interface Gate {
  /**
   * Check one prospective call against the session's stamp and, when it may
   * proceed, count it. Returns the refusal message, or undefined when the
   * call is reserved. Synchronous by design (see the header): callers must
   * not await between reading the stamp and reserving.
   */
  readonly reserve: (input: {
    readonly sessionID: string
    readonly server: string
    readonly stamp: Stamp
    readonly persisted?: PersistedUsage
  }) => string | undefined
  /** Current counters for a session, for write-through persistence. */
  readonly usage: (sessionID: string) => { readonly epoch: string; readonly usage: Usage } | undefined
  /** Forget a session's counters (its stamp is gone). */
  readonly clear: (sessionID: string) => void
}

export function createGate(): Gate {
  const entries = new Map<string, Entry>()
  return {
    reserve: ({ sessionID, server, stamp, persisted }) => {
      if (stamp.kind === "none") {
        entries.delete(sessionID)
        return undefined
      }
      if (stamp.kind === "invalid")
        return `This session's MCP limit (session metadata "${LIMIT_METADATA_KEY}") is malformed, so its MCP calls are refused until the limit is stamped again.`
      let entry = entries.get(sessionID)
      if (!entry || entry.epoch !== stamp.epoch) {
        entry = {
          epoch: stamp.epoch,
          total: persisted && persisted.epoch === stamp.epoch ? persisted.total : 0,
          perServer: new Map(
            persisted && persisted.epoch === stamp.epoch ? Object.entries(persisted.perServer) : [],
          ),
        }
        entries.set(sessionID, entry)
      }
      const { limit } = stamp
      if (limit.servers !== "all" && !limit.servers.includes(server))
        return `MCP server "${server}" is not in this task's MCP allowlist (${limit.servers.join(", ") || "no servers"}). The Orchestrator set this limit; work within it or report back.`
      if (entry.total >= limit.maxCalls)
        return `MCP budget exhausted for this task: ${entry.total} of ${limit.maxCalls} allowed calls used. The Orchestrator set this limit; finish with what you have or report back.`
      const serverCap = limit.perServer[server]
      const serverUsed = entry.perServer.get(server) ?? 0
      if (serverCap !== undefined && serverUsed >= serverCap)
        return `MCP budget exhausted for server "${server}" on this task: ${serverUsed} of ${serverCap} allowed calls used. The Orchestrator set this limit; finish with what you have or report back.`
      entry.total += 1
      entry.perServer.set(server, serverUsed + 1)
      return undefined
    },
    usage: (sessionID) => {
      const entry = entries.get(sessionID)
      if (!entry) return undefined
      return { epoch: entry.epoch, usage: { total: entry.total, perServer: Object.fromEntries(entry.perServer) } }
    },
    clear: (sessionID) => {
      entries.delete(sessionID)
    },
  }
}
