export * as McpAcquire from "./acquire.js"

import type { ServerConfig } from "@orchestra/schema/mcp"
import { Cause, Effect } from "effect"
import { DesktopIsolation } from "../desktop-isolation.js"
import { which } from "../util/which.js"
import { McpCatalog } from "./catalog.js"
import type { Rating } from "./ratings.js"
import { McpSelect } from "./select.js"
import type { Mcp } from "./index.js"

export type { Match } from "./select.js"

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
    return {
      id,
      state: "not_installed",
      detail: `${entry.name} is in the catalog but not installed.`,
      missing: [],
      tools: [],
    }
  }
  switch (info.status.status) {
    case "connected":
      return own.length > 0
        ? {
            id,
            state: "healthy",
            detail: `${entry.name} is connected with ${own.length} tool(s) discovered.`,
            missing: [],
            tools: own,
          }
        : {
            id,
            state: "degraded",
            detail: `${entry.name} is connected but no tools were discovered.`,
            missing: [],
            tools: [],
          }
    case "needs_auth":
      return {
        id,
        state: "needs_auth",
        detail: `${entry.name} needs authentication: ${info.status.error}`,
        missing: [],
        tools: [],
      }
    case "failed":
      return {
        id,
        state: "failed",
        detail: `${entry.name} failed to start: ${info.status.error}`,
        missing: [],
        tools: [],
      }
    case "disabled":
      return { id, state: "disabled", detail: `${entry.name} is disabled by the operator.`, missing: [], tools: [] }
    case "pending":
      return {
        id,
        state: "configured",
        detail: `${entry.name} is installed and still starting.`,
        missing: [],
        tools: [],
      }
  }
}

/**
 * Deterministic catalog search for a capability need ("browser automation",
 * "автоматизация браузера"). Ranking lives in ./select.ts: Russian needs
 * are translated before matching, every match carries a confidence score,
 * and persistent server ratings nudge the order. Kept here so existing
 * callers (`mcp_manager acquire`, tests) keep one entry point.
 */
export function select(
  need: string,
  platform: NodeJS.Platform = process.platform,
  ratings?: ReadonlyMap<string, Rating>,
): readonly McpSelect.Match[] {
  return McpSelect.rank(need, platform, ratings)
}

export interface Ensured extends Classification {
  /** What this call actually did: reused a healthy server, connected an installed one, installed a new one, or nothing. */
  readonly action: "reused" | "connected" | "installed" | "none"
  /** The connect attempt's own failure, when it raised one and the server did not end up healthy. Never swallowed. */
  readonly connectError?: string
}

const snapshot = Effect.fnUntraced(function* (access: Access, id: string) {
  const infos = yield* access.servers()
  const tools = yield* access.tools()
  return classify(
    id,
    infos.find((info) => String(info.name) === id),
    tools,
  )
})

/** Catalog servers that launch their own Chrome. */
const SEPARATE_BROWSER: Readonly<Record<string, string>> = {
  "chrome-devtools": "ORCHESTRA_MCP_CHROME_DEVTOOLS",
  playwright: "ORCHESTRA_MCP_PLAYWRIGHT",
}

/**
 * Make a catalog server usable, doing the smallest sufficient work:
 * healthy → reuse; installed but not connected → connect; absent → validate
 * (platform, credentials, runtime), install through the MCP service, connect,
 * and verify by the tools actually discovered. Disabled and failed servers are
 * reported, never silently retried or re-enabled: a disabled server is the
 * operator's decision, and a failed one needs its cause fixed first.
 */
export const ensure: (access: Access, id: string) => Effect.Effect<Ensured> = Effect.fn("McpAcquire.ensure")(function* (
  access: Access,
  id: string,
) {
  const before = yield* snapshot(access, id)
  if (!McpCatalog.mcpEnabled(process.env))
    return {
      ...before,
      state: "failed" as const,
      action: "none" as const,
      detail:
        "MCP is switched off for agents (the operator can set ORCHESTRA_MCP=1). Use the native tools: websearch, webfetch, research, browser.",
    }
  if (before.state === "healthy") return { ...before, action: "reused" as const }
  // A degraded server (connected, but no tools discovered) is NOT reused as
  // if it worked: it gets one reconnect, which restarts it and re-runs tool
  // discovery. If it is still toolless afterwards, the result says so.
  if (before.state !== "configured" && before.state !== "not_installed" && before.state !== "degraded")
    return { ...before, action: "none" as const }
  // B7: a real-screen server (playwright, agent-desktop) is never installed
  // or connected while the real-screen opt-in is invalid — not even when it
  // is already configured. The operator's screen is not a default.
  const entry = McpCatalog.all.find((item) => item.id === id)
  if (McpCatalog.isRealScreenServer(id)) {
    const denial = DesktopIsolation.realScreenDenial(process.env, id)
    if (denial)
      return {
        ...before,
        state: "failed" as const,
        action: "none" as const,
        detail: `${entry?.name ?? id} drives the operator's real screen and is blocked: ${denial}`,
      }
  }

  // A server that starts a browser of its own is not installed behind the operator's back: the Browser tab's `browser`
  // tool is the browser, and a removed chrome-devtools came straight back through acquisition. Installing it needs
  // its ORCHESTRA_MCP_* flag set to 1 (chrome-devtools, playwright); one that is already configured is left as it is.
  if (
    before.state === "not_installed" &&
    SEPARATE_BROWSER[id] !== undefined &&
    process.env[SEPARATE_BROWSER[id]!] !== "1"
  )
    return {
      ...before,
      state: "unavailable" as const,
      action: "none" as const,
      detail: `${McpCatalog.all.find((item) => item.id === id)?.name ?? id} would open a second Chrome next to the Browser tab and is not installed automatically. Use the browser tool (screenshot, text, open, click, type on the Browser tab's session). The operator can allow it with ${SEPARATE_BROWSER[id]}=1.`,
    }
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
  // The connect attempt's failure is captured, not swallowed: when the
  // server does not end up healthy, the original cause travels with the
  // result so the failure can be diagnosed from the report alone.
  let connectError: string | undefined
  yield* access.connect(id).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        connectError = Cause.pretty(cause)
      }),
    ),
  )
  const after = yield* snapshot(access, id)
  return {
    ...after,
    action: before.state === "not_installed" ? ("installed" as const) : ("connected" as const),
    ...(connectError && after.state !== "healthy"
      ? {
          connectError,
          detail: `${after.detail} The connect attempt itself reported: ${connectError}`,
        }
      : {}),
  }
})
