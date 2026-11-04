export * as McpAcquire from "./acquire.js"

import type { ServerConfig } from "@orchestra/schema/mcp"
import { Effect } from "effect"
import { which } from "../util/which.js"
import { McpCatalog } from "./catalog.js"
import type { Mcp } from "./index.js"

/**
 * Autonomous MCP acquisition: the Orchestrator's path from "this task needs a
 * capability" to a verified, usable MCP server — without the operator picking
 * servers by hand, and without ever pretending a server works when it does not.
 *
 * Ownership stays where it already lives:
 * - the catalog (catalog.ts) is the only source of installable servers;
 * - the MCP service (index.ts) owns configuration, connection and tools;
 * - role profiles (role-profiles.ts) remain the authoritative access boundary —
 *   installing a server here grants no role anything; it only makes the shared
 *   server exist. Per-role exposure is still decided by profiles, session
 *   permissions and per-task budgets.
 *
 * A server is "ready" only when it is connected AND its tools were actually
 * discovered. Missing credentials produce a needs_auth outcome naming the
 * variables to provide — never an invented value, never a claimed connection.
 */

export type State =
  | "healthy" // connected, tools discovered
  | "degraded" // connected, but no tools discovered
  | "configured" // installed, not connected (still starting or never started)
  | "needs_auth" // credentials or authorization missing
  | "failed" // last connection attempt failed
  | "disabled" // the operator disabled it; acquisition never overrides that
  | "not_installed" // in the catalog, not configured yet
  | "unavailable" // unknown id, or not offered on this platform

/** The slice of the MCP service acquisition needs; the real service satisfies it. */
export interface Access {
  readonly servers: () => Effect.Effect<ReadonlyArray<Mcp.ServerInfo>>
  readonly add: (server: string, config: ServerConfig) => Effect.Effect<void>
  readonly connect: (server: string) => Effect.Effect<void, unknown>
  readonly tools: () => Effect.Effect<ReadonlyArray<Mcp.Tool>>
}

export interface Classification {
  readonly id: string
  readonly state: State
  readonly detail: string
  /** Names of environment variables that must be provided before the server can run. */
  readonly missing: readonly string[]
  /** Tool names actually discovered on the server; only non-empty when connected. */
  readonly tools: readonly string[]
}

/** Classify one catalog server against live service state. Pure. */
export function classify(
  id: string,
  info: Mcp.ServerInfo | undefined,
  tools: ReadonlyArray<Mcp.Tool>,
  platform: NodeJS.Platform = process.platform,
): Classification {
  const entry = McpCatalog.all.find((item) => item.id === id)
  if (!entry) return { id, state: "unavailable", detail: `No MCP catalog entry named "${id}".`, missing: [], tools: [] }
  if (entry.platforms && !entry.platforms.includes(platform))
    return {
      id,
      state: "unavailable",
      detail: `${entry.name} is not offered on ${platform} (supports: ${entry.platforms.join(", ")}).`,
      missing: [],
      tools: [],
    }
  const own = tools.filter((tool) => String(tool.server) === id).map((tool) => tool.name)
  if (!info) {
    const missing = McpCatalog.missing(id, entry.config)
    if (missing.length > 0)
      return {
        id,
        state: "needs_auth",
        detail: `${entry.name} needs credentials before it can be installed: set ${missing.join(", ")}.`,
        missing,
        tools: [],
      }
    return { id, state: "not_installed", detail: `${entry.name} is in the catalog but not installed.`, missing: [], tools: [] }
  }
  switch (info.status.status) {
    case "connected":
      return own.length > 0
        ? { id, state: "healthy", detail: `${entry.name} is connected with ${own.length} tool(s) discovered.`, missing: [], tools: own }
        : { id, state: "degraded", detail: `${entry.name} is connected but no tools were discovered.`, missing: [], tools: [] }
    case "needs_auth":
      return { id, state: "needs_auth", detail: `${entry.name} needs authentication: ${info.status.error}`, missing: [], tools: [] }
    case "failed":
      return { id, state: "failed", detail: `${entry.name} failed to start: ${info.status.error}`, missing: [], tools: [] }
    case "disabled":
      return { id, state: "disabled", detail: `${entry.name} is disabled by the operator.`, missing: [], tools: [] }
    case "pending":
      return { id, state: "configured", detail: `${entry.name} is installed and still starting.`, missing: [], tools: [] }
  }
}

export interface Match {
  readonly entry: McpCatalog.Entry
  readonly score: number
  readonly reasons: readonly string[]
}

const tokens = (text: string) =>
  [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2))]

/**
 * Deterministic catalog search for a capability need ("browser automation",
 * "read GitHub issues"). Scores name/id matches above description and usage
 * text; ties break by id so the same need always selects the same server.
 * Returns only real matches (score > 0), best first.
 */
export function select(need: string, platform: NodeJS.Platform = process.platform): readonly Match[] {
  const wanted = tokens(need)
  if (wanted.length === 0) return []
  return McpCatalog.forPlatform(platform)
    .flatMap((entry) => {
      const fields: ReadonlyArray<readonly [string, number]> = [
        [`${entry.id} ${entry.name}`, 3],
        [entry.description, 2],
        [entry.usage, 1],
      ]
      let score = 0
      const reasons: string[] = []
      for (const token of wanted) {
        for (const [text, weight] of fields) {
          if (tokens(text).includes(token)) {
            score += weight
            reasons.push(token)
            break
          }
        }
      }
      return score > 0 ? [{ entry, score, reasons: [...new Set(reasons)] }] : []
    })
    .toSorted((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
}

export interface Ensured extends Classification {
  /** What this call actually did: reused a healthy server, connected an installed one, installed a new one, or nothing. */
  readonly action: "reused" | "connected" | "installed" | "none"
}

const snapshot = Effect.fnUntraced(function* (access: Access, id: string) {
  const infos = yield* access.servers()
  const tools = yield* access.tools()
  return classify(id, infos.find((info) => String(info.name) === id), tools)
})

/**
 * Make a catalog server usable, doing the smallest sufficient work:
 * healthy → reuse; installed but not connected → connect; absent → validate
 * (platform, credentials, runtime), install through the MCP service, connect,
 * and verify by the tools actually discovered. Disabled and failed servers are
 * reported, never silently retried or re-enabled: a disabled server is the
 * operator's decision, and a failed one needs its cause fixed first.
 */
export const ensure = Effect.fn("McpAcquire.ensure")(function* (access: Access, id: string) {
  const before = yield* snapshot(access, id)
  if (before.state === "healthy" || before.state === "degraded") return { ...before, action: "reused" as const }
  if (before.state !== "configured" && before.state !== "not_installed") return { ...before, action: "none" as const }

  if (before.state === "not_installed") {
    const entry = McpCatalog.all.find((item) => item.id === id)!
    if (entry.runtime && !which(entry.runtime))
      return {
        ...before,
        state: "failed" as const,
        action: "none" as const,
        detail: `${entry.name} needs the "${entry.runtime}" runtime on PATH, which was not found. Install the runtime first.`,
      }
    yield* access.add(id, entry.config)
  }
  yield* access.connect(id).pipe(Effect.catchCause(() => Effect.void))
  const after = yield* snapshot(access, id)
  return { ...after, action: before.state === "not_installed" ? ("installed" as const) : ("connected" as const) }
})
