export * as McpCatalog from "./catalog.js"

import type { Context } from "@orchestra/plugin/effect/plugin"
import type { ServerConfig } from "@orchestra/schema/mcp"
import { Effect } from "effect"
import { Config } from "../config.js"
import { McpRoleProfiles } from "./role-profiles.js"

export type HealthStatus = "healthy" | "degraded" | "unhealthy"

export interface ServerHealthState {
  readonly server: string
  readonly status: HealthStatus
  readonly consecutiveFailures: number
  readonly consecutiveSuccesses: number
  readonly lastCheckAt: number
  readonly lastError?: string
  readonly latencyMs?: number
  readonly trippedAt?: number
}

export interface HealthCheckOptions {
  readonly timeoutMs?: number
  readonly failureThreshold?: number
  readonly recoveryThreshold?: number
  readonly cooldownMs?: number
}

export const DEFAULT_HEALTH_TIMEOUT_MS = 3_000
export const DEFAULT_FAILURE_THRESHOLD = 3
export const DEFAULT_RECOVERY_THRESHOLD = 2
export const DEFAULT_COOLDOWN_MS = 30_000

export class McpCircuitBreaker {
  private states = new Map<string, ServerHealthState>()

  constructor(private readonly defaultOptions: HealthCheckOptions = {}) {}

  getState(server: string): ServerHealthState {
    const existing = this.states.get(server)
    if (existing) return existing
    const initial: ServerHealthState = {
      server,
      status: "healthy",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastCheckAt: 0,
    }
    this.states.set(server, initial)
    return initial
  }

  getAll(): ReadonlyMap<string, ServerHealthState> {
    return this.states
  }

  isAvailable(server: string, options?: HealthCheckOptions): boolean {
    const state = this.getState(server)
    if (state.status === "healthy") return true
    if (state.status === "degraded") return true

    const cooldown = options?.cooldownMs ?? this.defaultOptions.cooldownMs ?? DEFAULT_COOLDOWN_MS
    if (state.trippedAt && Date.now() - state.trippedAt >= cooldown) {
      return true
    }
    return false
  }

  recordSuccess(server: string, latencyMs?: number): ServerHealthState {
    const current = this.getState(server)
    const successes = current.consecutiveSuccesses + 1
    const next: ServerHealthState = {
      server,
      status: "healthy",
      consecutiveFailures: 0,
      consecutiveSuccesses: successes,
      lastCheckAt: Date.now(),
      latencyMs,
    }
    this.states.set(server, next)
    return next
  }

  recordFailure(server: string, error?: string, options?: HealthCheckOptions): ServerHealthState {
    const current = this.getState(server)
    const failures = current.consecutiveFailures + 1
    const threshold = options?.failureThreshold ?? this.defaultOptions.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD

    const status: HealthStatus = failures >= threshold ? "unhealthy" : "degraded"
    const trippedAt = status === "unhealthy" ? (current.trippedAt ?? Date.now()) : undefined

    const next: ServerHealthState = {
      server,
      status,
      consecutiveFailures: failures,
      consecutiveSuccesses: 0,
      lastCheckAt: Date.now(),
      lastError: error,
      trippedAt,
    }
    this.states.set(server, next)
    return next
  }

  reset(server?: string): void {
    if (server) {
      this.states.delete(server)
    } else {
      this.states.clear()
    }
  }

  check(
    server: string,
    probe: Effect.Effect<unknown, unknown>,
    options?: HealthCheckOptions,
  ): Effect.Effect<ServerHealthState> {
    const self = this
    const timeout = options?.timeoutMs ?? this.defaultOptions.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
    const startTime = Date.now()

    return Effect.gen(function* () {
      const probeOutcome = yield* probe.pipe(
        Effect.timeoutOrElse({
          duration: `${timeout} millis`,
          orElse: () => Effect.succeed("timeout" as const),
        }),
        Effect.map((res) => (res === "timeout" ? ("timeout" as const) : (true as const))),
        Effect.catch((err) =>
          Effect.succeed({
            failed: true as const,
            error: err instanceof Error ? err.message : typeof err === "string" ? err : "Healthcheck probe failed",
          }),
        ),
      )

      const elapsed = Date.now() - startTime

      if (probeOutcome === true) {
        return self.recordSuccess(server, elapsed)
      }

      const errorMessage =
        probeOutcome === "timeout"
          ? `Healthcheck timed out after ${timeout}ms`
          : typeof probeOutcome === "object" && probeOutcome.failed
            ? probeOutcome.error
            : "Healthcheck failed"
      return self.recordFailure(server, errorMessage, options)
    })
  }
}

export const circuitBreaker = new McpCircuitBreaker()

export const healthcheckServer = (
  server: string,
  probe: Effect.Effect<unknown, unknown>,
  options?: HealthCheckOptions,
): Effect.Effect<ServerHealthState> => circuitBreaker.check(server, probe, options)

export const isServerAvailable = (server: string, options?: HealthCheckOptions): boolean =>
  circuitBreaker.isAvailable(server, options)

// AI tools the Registry offers to install: MCP servers that give the model new abilities.
// Installing one writes it under mcp.servers in the global config; its tools then reach every
// session (narrowed per role by the team editor's tool list, as `<id>_*`).
export type Entry = {
  readonly id: string
  readonly name: string
  readonly description: string
  // How the model should use it; shown to every session that has it installed.
  readonly usage: string
  // The launcher the server needs on PATH, when it is a local process.
  readonly runtime?: "npx" | "uvx"
  readonly platforms?: readonly NodeJS.Platform[]
  // Environment variables the server exits without, so the Registry can say so before it looks installed.
  readonly requires?: readonly string[]
  // B7: the server drives the operator's real screen, mouse, or browser
  // (playwright, agent-desktop). It may only be acquired, selected, or
  // called when the real-screen opt-in is valid; see desktop-isolation.ts.
  readonly realScreen?: boolean
  readonly config: ServerConfig
}

/** Whether a catalog server touches the operator's real screen (block B7). */
export const isRealScreenServer = (id: string): boolean =>
  all.some((entry) => entry.id === id && entry.realScreen === true)

const local = (command: string[]): ServerConfig => ({ type: "local", command }) as ServerConfig
const remote = (url: string): ServerConfig => ({ type: "remote", url }) as ServerConfig

// Playwright defaults to Google Chrome stable, which many Windows machines lack; Edge ships
// with Windows and speaks the same protocol, so point it at Edge there.
const windows = process.platform === "win32"

export const all: readonly Entry[] = [
  {
    id: "context7",
    name: "Context7",
    description: "Up-to-date documentation and code examples for libraries and frameworks.",
    usage:
      "Before using a library API you are not sure about, resolve the library id, then fetch its docs for the exact version and topic.",
    runtime: "npx",
    config: local(["npx", "-y", "@upstash/context7-mcp"]),
  },
  {
    id: "serena",
    name: "Serena",
    description:
      "Semantic code intelligence at symbol level via language servers: find symbols and references, rename and edit precisely across 40+ languages.",
    usage:
      "Serena speaks through a session REPL, not flat tools: call initial_instructions first and keep the session id it returns, activate the project once, then drive the facades through serena_repl (s.lsp for declarations, references, implementations and rename; s.fs and s.edit for reading and precise edits). Needs uvx (the uv toolchain) on PATH. Prefer it over grep-and-read for cross-file questions; fall back to native symbols/grep when it is unavailable.",
    runtime: "uvx",
    config: local(["uvx", "--from", "serena-agent", "serena", "start-mcp-server", "--context", "desktop-app"]),
  },
  {
    id: "xerj",
    name: "Xerj",
    description:
      "Indexed retrieval over the project's code and docs: BM25 + vector passages with file:line citations, plus agent memory, from a local node.",
    usage:
      "Use xerj_search to search the indexed code instead of reading files one by one, and xerj_def when you already know the symbol name. A local node must be running first (xerj --data-dir ~/xerj-data, auth on by default — export XERJ_API_KEY from <data_dir>/admin.key); index once with xerj autoindex <project>. Never start a node with --insecure outside a local sandbox. If the node is down, fall back to serena, then native symbols/grep.",
    config: local(["xerj", "mcp", "--url", "http://127.0.0.1:9200", "--disable-feedback"]),
  },
  {
    id: "rea-anything",
    name: "REA — Reverse Engineer Anything",
    description:
      "Official REA MCP for evidence-based reverse engineering of native binaries, JavaScript/Electron apps, websites, Android APKs, and .NET assemblies.",
    usage:
      "Use REA to investigate how an app feature works without source code. Start with the narrowest matching analysis tool, inspect its evidence and limitations, and use runtime capture only when appropriate for the target.",
    runtime: "npx",
    config: local(["npx", "-y", "rea-agents@latest", "mcp"]),
  },
  {
    id: "playwright",
    name: "Playwright",
    description:
      "Drive a real browser: open pages, click, fill forms, read the accessibility tree, and take screenshots.",
    usage:
      "For web apps: navigate, inspect the page, interact with elements by stable references, and take screenshots to verify the result. B7: this drives the operator's real browser, so it needs the real-screen opt-in (ORCHESTRA_DESKTOP_REAL_SCREEN=on, allowlist naming playwright, future expiry); without it the server is not acquired and its tools refuse.",
    runtime: "npx",
    realScreen: true,
    config: local(["npx", "-y", "@playwright/mcp@latest", ...(windows ? ["--browser", "msedge"] : [])]),
  },
  {
    id: "chrome-devtools",
    name: "Chrome DevTools",
    description:
      "Drive Google Chrome via DevTools: inspect the page, act on elements by snapshot uid, run JS, read console and network, run Lighthouse audits.",
    usage:
      "In Chrome: take_snapshot first, then click/fill by the uid from the LATEST snapshot — uids go stale whenever the page changes, so never reuse a uid from an older snapshot (a stale uid fails, and the wrapper answers with a fresh snapshot: retry with the new uid). evaluate runs without timers (no setTimeout/setInterval inside it): wait with wait_for instead. This launches its own Chrome instance; it does not attach to the operator's running browser — do not add a --browserUrl pointing at it outside the real-screen opt-in.",
    runtime: "npx",
    config: local(["npx", "-y", "chrome-devtools-mcp@latest"]),
  },
  {
    id: "agent-desktop",
    name: "Agent Desktop",
    description:
      "Computer use for desktop apps on macOS, Windows, and Linux: see and operate them through the OS accessibility tree, with a ref for every element.",
    usage:
      "Use to operate a desktop app: snapshot it first, act on element refs (click, type, set-value), then snapshot again to verify the result. Actions are headless by default. B7: this drives the operator's real screen — it is NOT a virtual display. It needs the real-screen opt-in (ORCHESTRA_DESKTOP_REAL_SCREEN=on, allowlist naming agent-desktop, future expiry); without it the server is not acquired and its tools refuse. Prefer the desktop_* tools on the agent's virtual display. When the opt-in is on, run the server with DISPLAY set to the agent's virtual display (for example :99) so it acts inside that display, not on the operator's screen. The virtual display must also run a window manager (openbox works): on bare Xvfb snapshots refuse with native_window_unproven, and twm is not enough (frames_unanswered). B13: snapshots, screenshots and the clipboard can contain private data from the screen — never paste them into public logs or shared chats. Live-verified against agent-desktop 1.2.0 (pilot 2026-11-07): snapshot → type → click → re-snapshot works on GTK3/GTK4 apps under Xvfb :99 + openbox, and the MCP server answers handshake, tools/list (67 desktop_* tools) and tools/call.",
    runtime: "npx",
    realScreen: true,
    config: local(["npx", "-y", "agent-desktop", "mcp"]),
  },
  {
    id: "github",
    name: "GitHub",
    description:
      "Official GitHub MCP for repositories, code, issues, pull requests, Actions, and workflow intelligence.",
    usage:
      "Use when a task involves GitHub repositories, issues, pull requests, CI, releases, or code search. Authenticate with OAuth or a token supported by the host.",
    config: remote("https://api.githubcopilot.com/mcp/"),
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    description: "Ask questions about public GitHub repositories and read generated project documentation.",
    usage:
      "Use to quickly understand an unfamiliar public repository, its architecture, and the location of a feature before making changes.",
    config: remote("https://mcp.deepwiki.com/mcp"),
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Inspect application errors, events, performance data, and debugging context from Sentry.",
    usage:
      "Use when investigating production errors or regressions: inspect the relevant issue and recent events before proposing a fix.",
    runtime: "npx",
    requires: ["SENTRY_ACCESS_TOKEN"],
    config: local(["npx", "-y", "@sentry/mcp-server"]),
  },
]

// Capability classes the catalog deliberately does NOT offer as MCP
// servers, because a native Orchestra tool already covers them — installing
// a server for one of these would only duplicate what the session can do.
// The selection ranking (./select.ts) answers these needs with the native
// tools instead of guessing a catalog server, and `mcp_manager inspect`
// lists them in the survey so the Orchestrator sees the whole capability
// map, not just the installable half. Keep this in step with AGENTS.md
// ("MCP Standards"): a class leaves this list only when a catalog server
// is added that genuinely beats the native tool.
export interface NativeAnalogue {
  readonly id: string
  readonly name: string
  readonly description: string
  /** Native tools that cover the class; named as the model calls them. */
  readonly nativeTools: readonly string[]
  /** English capability words that name this class (needs are translated to English before matching). */
  readonly keywords: readonly string[]
}

export const nativeAnalogues: readonly NativeAnalogue[] = [
  {
    id: "web-search",
    name: "Web search",
    description: "Search the web for pages, answers and current information.",
    nativeTools: ["websearch"],
    keywords: ["websearch", "search", "google", "find", "lookup", "internet", "web"],
  },
  {
    id: "fetch",
    name: "Fetch a URL",
    description: "Read one URL's content: a page, a file, an API response.",
    nativeTools: ["webfetch"],
    keywords: ["fetch", "download", "curl", "url", "webpage"],
  },
  {
    id: "memory",
    name: "Memory",
    description: "Durable notes and facts the team keeps across sessions.",
    nativeTools: ["note", "idea_bank"],
    keywords: ["memory", "remember", "notes", "note", "knowledge", "recall"],
  },
  {
    id: "sequential-thinking",
    name: "Step-by-step thinking",
    description: "Working through a hard problem in explicit steps.",
    nativeTools: ["reasoning"],
    keywords: ["thinking", "reasoning", "step", "plan", "think"],
  },
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read, write and search project files.",
    nativeTools: ["read", "edit", "write", "glob", "grep", "symbols"],
    keywords: ["filesystem", "file", "files", "read", "write", "edit", "directory"],
  },
  {
    id: "database",
    name: "Database",
    description: "Query a local database file (SQLite and friends) through the shell.",
    nativeTools: ["shell"],
    keywords: ["database", "sql", "sqlite", "query", "table", "db"],
  },
  {
    id: "task-tracker",
    name: "Task tracker",
    description: "The team's own board: stages, acceptance criteria and who does what.",
    nativeTools: ["sessions", "plan", "stages"],
    keywords: ["tracker", "tasks", "task", "board", "kanban", "todo", "stage", "stages"],
  },
  {
    id: "git",
    name: "Git",
    description: "Version control: history, diffs, branches, commits.",
    nativeTools: ["shell"],
    keywords: ["git", "commit", "branch", "diff", "history", "vcs"],
  },
  {
    id: "time",
    name: "Time",
    description: "The current date and time, and date arithmetic.",
    nativeTools: ["shell"],
    keywords: ["time", "date", "clock", "today", "now"],
  },
]

// The variables a catalog server exits without that neither its config nor the host provides. A key
// passed as a command-line flag instead (--api-key, --access-token) counts as provided.
export function missing(name: string, config: ServerConfig) {
  if (config.type !== "local") return []
  const flagged = config.command.some((arg) => /^--[\w-]*(key|token)/i.test(arg))
  if (flagged) return []
  return (all.find((entry) => entry.id === name)?.requires ?? []).filter(
    (key) => !config.environment?.[key] && !process.env[key],
  )
}

export const forPlatform = (platform: NodeJS.Platform = process.platform) =>
  all.filter((entry) => !entry.platforms || entry.platforms.includes(platform))

// Tells every session which installed AI tools it has and how to use them.
export const Plugin = {
  id: "opencode.mcp.catalog",
  effect: Effect.fn("McpCatalog.Plugin")(function* (ctx: Context) {
    const config = yield* Config.Service
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const servers = Config.latest(yield* config.entries(), "mcp")?.servers ?? {}
        // A server that failed or waits for sign-in has no tools; advertising it sent models into
        // calls that could only fail. A pending one is still listed: it usually connects in seconds.
        const down = new Set(
          (yield* ctx.mcp.list().pipe(
            Effect.map((response) => response.data),
            Effect.orElseSucceed(() => []),
          ))
            .filter((server) => server.status.status !== "connected" && server.status.status !== "pending")
            .map((server) => server.name),
        )
        // Isolate servers tripped by circuit breaker (unhealthy)
        for (const [name, state] of circuitBreaker.getAll()) {
          if (state.status === "unhealthy" && !circuitBreaker.isAvailable(name)) {
            down.add(name)
          }
        }
        // A server's tools are direct tools named <server>_<tool> when its Code Mode is off, and run
        // through the `execute` tool otherwise. Only servers this session can reach are listed, so a
        // role whose tool list leaves a server out is not told about it.
        const installed = all.filter(
          (entry) =>
            servers[entry.id] !== undefined &&
            servers[entry.id]?.disabled !== true &&
            !down.has(entry.id) &&
            (Object.keys(event.tools).some((tool) => tool.startsWith(`${entry.id}_`)) ||
              (event.tools.execute !== undefined && servers[entry.id]?.codemode !== false)),
        )
        // The role profile (mcp/role-profiles) says which of these servers this session's role
        // requires for its method, and which required ones it cannot reach right now; naming
        // both keeps the model from either skipping a required instrument or calling a dead one.
        const profile = McpRoleProfiles.forAgent(String(event.agent))
        const required = new Set(
          profile?.servers.filter((grant) => grant.access === "required").map((grant) => grant.server),
        )
        const unavailable = profile
          ? profile.servers
              .filter(
                (grant) =>
                  grant.access === "required" &&
                  (servers[grant.server] === undefined || servers[grant.server]?.disabled === true || down.has(grant.server)),
              )
              .map((grant) => grant.server)
          : []
        if (installed.length === 0 && unavailable.length === 0) return
        event.system.push({
          type: "text",
          text: [
            "# Installed AI tools",
            'These MCP servers are installed from the Registry. Call a server\'s tools directly when your tool list has them as <server>_<tool>; otherwise run them through the execute tool under tools["<server>"]. Use them when they fit:',
            ...installed.map(
              (entry) => `- ${entry.id} (${entry.name}): ${entry.usage}${required.has(entry.id) ? " (required for your role)" : ""}`,
            ),
            ...(unavailable.length === 0
              ? []
              : [
                  `Required for your role but not available: ${unavailable.join(", ")}. Do not call them; fall back to native tools for those jobs.`,
                ]),
          ].join("\n"),
        })
      }),
    )
  }),
}
