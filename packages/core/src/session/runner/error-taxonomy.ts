export * as SessionErrorTaxonomy from "./error-taxonomy.js"

import { AIError } from "@orchestra/ai"
import { ToolFailure } from "@orchestra/ai"

/**
 * Error taxonomy (block Б5, from audit №4: 10 families A–J).
 *
 * Every known error type gets one explicit handler — retry, full retry,
 * switch model, pause, escalate, or fail fast — and a hard retry cap, so no
 * error type can silently become a defect, an infinite retry loop, or a dead
 * process. A new error found in production first gets a row here plus a
 * regression test, and only then a fix (master plan §8.5).
 *
 * Deterministic errors (409, quota, auth, unknown-model, content policy)
 * never retry: repeating the same request cannot clear them. A request whose
 * delivery is unknown is never re-sent (see `retry.ts`): repeating it could
 * execute an external action twice.
 */
export type TaxonomyAction = "retry" | "full-retry" | "switch-model" | "pause" | "escalate" | "fail-fast"

export interface TaxonomyEntry {
  readonly code: string
  readonly family: string
  readonly title: string
  readonly action: TaxonomyAction
  /** Hard cap on attempts for this type, on top of the 1–2 policy in `retry.ts`. */
  readonly maxRetries: number
}

type Row = readonly [code: string, family: string, title: string, action: TaxonomyAction, maxRetries: number]

const ROWS: ReadonlyArray<Row> = [
  // A — provider / model answers (HTTP + provider failures).
  ["A1", "provider", "429 rate limit / throttle", "pause", 2],
  ["A2", "provider", "quota / account cap exhausted", "escalate", 0],
  ["A3", "provider", "401/403 authentication rejected", "escalate", 0],
  ["A4", "provider", "404 model not found / unknown model", "switch-model", 0],
  ["A5", "provider", "500 provider internal error", "retry", 2],
  ["A6", "provider", "502/503/504 bad gateway / unavailable", "retry", 2],
  ["A7", "provider", "408 request timeout", "retry", 2],
  ["A8", "provider", "409 conflict with request state", "fail-fast", 0],
  ["A9", "provider", "transport timeout before any output", "retry", 2],
  ["A10", "provider", "stream cut off after first tokens (incomplete stream)", "full-retry", 1],
  ["A11", "provider", "broken JSON in tool-call arguments", "retry", 1],
  ["A12", "provider", "context overflow after compaction", "escalate", 0],
  ["A13", "provider", "content policy refusal", "fail-fast", 0],
  ["A14", "provider", "payload too large (413)", "fail-fast", 0],
  ["A15", "provider", "invalid request rejected by provider (400/422)", "fail-fast", 0],
  ["A16", "provider", "unsupported operation for this route/model", "switch-model", 0],
  ["A17", "provider", "no route for this model", "switch-model", 0],
  ["A18", "provider", "free-tier address cap spent (per-address 429)", "switch-model", 0],
  ["A19", "provider", "unknown provider failure (unclassified shape)", "retry", 1],
  // B — transport / streaming / WebSocket.
  ["B1", "transport", "connection refused / DNS / TLS failure", "retry", 2],
  ["B2", "transport", "connection lost while reading the response", "full-retry", 1],
  ["B3", "transport", "WebSocket idle 30 min (idle-timeout)", "retry", 1],
  ["B4", "transport", "WebSocket connect timeout", "retry", 2],
  ["B5", "transport", "WebSocket closed mid-stream", "full-retry", 1],
  ["B6", "transport", "HTTP fallback after WebSocket failure", "retry", 1],
  ["B7", "transport", "response body read failure (decode error)", "full-retry", 1],
  ["B8", "transport", "request cancelled / interrupted", "escalate", 0],
  ["B9", "transport", "proxy / gateway HTML error page", "retry", 1],
  ["B10", "transport", "unknown transport failure", "retry", 1],
  // C — MCP servers.
  ["C1", "mcp", "MCP server startup timeout", "retry", 1],
  ["C2", "mcp", "MCP call execution timeout", "retry", 1],
  ["C3", "mcp", "MCP server crashed / exited", "escalate", 0],
  ["C4", "mcp", "MCP tool not found / unknown tool", "fail-fast", 0],
  ["C5", "mcp", "MCP auth missing (login required)", "escalate", 0],
  ["C6", "mcp", "MCP catalog / health check failed", "retry", 1],
  // D — config / files.
  ["D1", "config", "broken config file (invalid JSON/YAML)", "fail-fast", 0],
  ["D2", "config", "config file missing", "escalate", 0],
  ["D3", "config", "config value out of range / wrong type", "fail-fast", 0],
  ["D4", "config", "unreadable file (permission / ENOENT)", "fail-fast", 0],
  ["D5", "config", "file write failed (disk full / read-only)", "retry", 1],
  ["D6", "config", "corrupt project file (bad JSON in state)", "escalate", 0],
  ["D7", "config", "path escapes the workspace", "fail-fast", 0],
  ["D8", "config", "symlink / realpath resolution failed", "fail-fast", 0],
  ["D9", "config", "instruction source unavailable", "retry", 1],
  ["D10", "config", "rules file failed to load", "escalate", 0],
  ["D11", "config", "environment variable missing for provider", "escalate", 0],
  ["D12", "config", "plugin failed to load", "escalate", 0],
  ["D13", "config", "schema validation failed on load", "fail-fast", 0],
  ["D14", "config", "unknown config / file error", "escalate", 0],
  // E — git.
  ["E1", "git", "not a git repository", "fail-fast", 0],
  ["E2", "git", "git command failed (merge conflict / dirty tree)", "escalate", 0],
  ["E3", "git", "git network failure (fetch/push)", "retry", 2],
  ["E4", "git", "git lock held by another process", "retry", 1],
  ["E5", "git", "git binary missing", "escalate", 0],
  ["E6", "git", "unknown git error", "escalate", 0],
  // F — server startup.
  ["F1", "server", "port already in use (EADDRINUSE)", "escalate", 0],
  ["F2", "server", "server failed to bind / listen", "escalate", 0],
  ["F3", "server", "server startup dependency failed (DB / service)", "retry", 1],
  ["F4", "server", "unknown server startup failure", "escalate", 0],
  // G — tool / desktop / playtest validation.
  ["G1", "tool", "tool called with missing required argument", "fail-fast", 0],
  ["G2", "tool", "tool input failed schema validation", "fail-fast", 0],
  ["G3", "tool", "unknown tool name from the model", "fail-fast", 0],
  ["G4", "tool", "desktop action missing coordinates / text / keys", "fail-fast", 0],
  ["G5", "tool", "desktop capture disabled", "escalate", 0],
  ["G6", "tool", "playtest step missing path / title / keys", "fail-fast", 0],
  ["G7", "tool", "playtest app failed to open a window", "escalate", 0],
  ["G8", "tool", "tool result missing after provider-hosted execution", "escalate", 0],
  ["G9", "tool", "permission declined for tool", "escalate", 0],
  ["G10", "tool", "unknown tool execution failure", "escalate", 0],
  // H — database / journal / migration.
  ["H1", "database", "database migration failed", "escalate", 0],
  ["H2", "database", "database is not empty and has no session table", "escalate", 0],
  ["H3", "database", "database locked / busy timeout", "retry", 2],
  ["H4", "database", "journal write failed", "retry", 1],
  ["H5", "database", "journal / event decode failed", "escalate", 0],
  ["H6", "database", "checkpoint / snapshot failed", "retry", 1],
  ["H7", "database", "database file corrupt", "escalate", 0],
  ["H8", "database", "V1 migration copy failed", "escalate", 0],
  ["H9", "database", "unknown database error", "escalate", 0],
  // I — session / drain / state.
  ["I1", "session", "session not found on drain", "fail-fast", 0],
  ["I2", "session", "session already busy / claim held", "pause", 1],
  ["I3", "session", "session interrupted (user / shutdown)", "escalate", 0],
  ["I4", "session", "step limit reached", "escalate", 0],
  ["I5", "session", "compaction failed", "escalate", 0],
  ["I6", "session", "inbox / prompt conflict", "fail-fast", 0],
  ["I7", "session", "agent not found", "fail-fast", 0],
  ["I8", "session", "unknown session error", "escalate", 0],
  // J — orchestration / escalation.
  ["J1", "orchestration", "orchestrator failed to handle the error", "escalate", 0],
  ["J2", "orchestration", "retry limits exhausted", "escalate", 0],
  ["J3", "orchestration", "group observer failed (federation monitor)", "escalate", 0],
  ["J4", "orchestration", "no group / society to consult", "escalate", 0],
  ["J5", "orchestration", "no president chat to report to", "escalate", 0],
  ["J6", "orchestration", "council round failed / member offline", "retry", 1],
  ["J7", "orchestration", "worker failed and cannot continue", "escalate", 0],
  ["J8", "orchestration", "model fallback list exhausted", "escalate", 0],
  ["J9", "orchestration", "autoloop card unanswered / given up", "escalate", 0],
  ["J10", "orchestration", "run stopped after limits (autoloop)", "escalate", 0],
  ["J11", "orchestration", "escalation target unavailable", "escalate", 0],
  ["J12", "orchestration", "duplicate external action refused (idempotency)", "fail-fast", 0],
  ["J13", "orchestration", "unknown delivery: external action must not repeat", "fail-fast", 0],
  ["J14", "orchestration", "rule / permission blocked the action", "escalate", 0],
  ["J15", "orchestration", "unclassified error (no handler yet)", "escalate", 1],
]

export const TABLE: Readonly<Record<string, TaxonomyEntry>> = Object.fromEntries(
  ROWS.map(([code, family, title, action, maxRetries]) => [
    code,
    { code, family, title, action, maxRetries } as TaxonomyEntry,
  ]),
)

export const UNKNOWN: TaxonomyEntry = TABLE["J15"]!

/**
 * Fallback models for the project's main session, which carries no
 * operator-given model list. Only models that answered in all Anymodel
 * chat-test rounds on 2026-11-05. `anymodel-v4.1-flash` is DEAD in all three
 * rounds — never use it as a fallback. Gated in `llm.ts` to sessions already
 * running on the same provider, so the provider is known to exist.
 */
export const MAIN_SESSION_FALLBACK_MODELS: ReadonlyArray<string> = ["anymodel/sonnet-5", "anymodel/anymodel-coder"]

const byCode = (code: string): TaxonomyEntry => TABLE[code] ?? UNKNOWN

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? `${cause.message}\n${cause.cause instanceof Error ? cause.cause.message : ""}` : String(cause)

/** Classify any failure into its taxonomy row. Never throws; unknown shapes land on J15. */
export function classifyError(cause: unknown): TaxonomyEntry {
  if (cause instanceof AIError) return classifyAIError(cause)
  if (cause instanceof ToolFailure) return byCode("G10")
  const message = messageOf(cause)
  // A database cause outranks the server-startup wording around it: a
  // server that "failed to start: database is locked" is a database error
  // (H1/H3), not a server error (F2) — the root cause decides the handler.
  if (/migration|no session table|database is locked|SQLITE_BUSY/i.test(message)) return byCode("H1")
  if (/database|sqlite|journal/i.test(message)) return byCode("H9")
  if (/EADDRINUSE|address already in use/i.test(message)) return byCode("F1")
  if (/listen|failed to (bind|start)|server (failed to )?start/i.test(message)) return byCode("F2")
  if (/not a git repository|fatal: |git (fetch|push|pull|merge|clone) failed|ENOENT.*\bgit\b/i.test(message))
    return byCode("E2")
  if (/\bgit\b/i.test(message)) return byCode("E6")
  if (/mcp|model context protocol/i.test(message)) return byCode("C6")
  if (/session not found|drain/i.test(message)) return byCode("I1")
  if (/Unexpected token|is not valid JSON|invalid JSON|config.*(invalid|corrupt|failed to load)|ENOENT.*config/i.test(message))
    return byCode("D1")
  if (/config/i.test(message)) return byCode("D14")
  return UNKNOWN
}

function classifyAIError(error: AIError): TaxonomyEntry {
  const reason = error.reason
  const status = reason.http?.status
  const text = [reason.message, reason.body ?? ""].join("\n")
  switch (reason._tag) {
    case "RateLimit":
      return /freeusagelimiterror/i.test(text) ? byCode("A18") : byCode("A1")
    case "QuotaExceeded":
      return /freeusagelimiterror/i.test(text) ? byCode("A18") : byCode("A2")
    case "Authentication":
      return byCode("A3")
    case "ContentPolicy":
      return byCode("A13")
    case "ProviderInternal":
      if (status === 502 || status === 503 || status === 504) return byCode("A6")
      return byCode("A5")
    case "InvalidRequest":
      if (status === 409) return byCode("A8")
      if (status === 404 || /model_not_found|model .* not found|unknown model/i.test(text)) return byCode("A4")
      if (reason.classification === "context-overflow") return byCode("A12")
      if (reason.classification === "payload-too-large") return byCode("A14")
      return byCode("A15")
    case "InvalidProviderOutput":
      if (reason.classification === "incomplete-stream") return byCode("A10")
      return byCode("A11")
    case "Transport":
      if (reason.code === "Timeout") return byCode("A9")
      if (reason.code === "idle-timeout" || reason.code === "idle-data") return byCode("B3")
      if (reason.code === "connect-timeout") return byCode("B4")
      if (reason.operation === "read") return byCode("B2")
      return byCode("B10")
    case "UnsupportedOperation":
      return byCode("A16")
    case "NoRoute":
      return byCode("A17")
    case "Timeout":
      return byCode("A7")
    case "UnknownProvider":
      return byCode("A19")
    default: {
      const exhaustive: never = reason
      return exhaustive
    }
  }
}
