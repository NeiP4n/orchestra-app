export * as McpClient from "./client.js"

import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  UnsupportedProtocolVersionError,
  type CallToolResult as SdkCallToolResult,
  type ElicitRequestFormParams,
  type ElicitRequestParams,
  type ElicitRequestURLParams,
  type ElicitResult,
  type GetPromptResult,
  type Implementation,
  type OAuthClientProvider,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplateType,
  type ServerCapabilities,
  type Tool,
  type Transport,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client"
import { Cause, Clock, Duration, Effect, Exit, Schedule, Schema } from "effect"
import { ConfigMCP } from "@orchestra/schema/config/mcp"
import type { Session } from "@orchestra/schema/session"
import { McpStdio } from "./stdio.js"
import { Limits } from "../limits.js"
import { Ssrf } from "../tool/ssrf.js"

const DEFAULT_STARTUP_TIMEOUT = 30_000
const DEFAULT_CATALOG_TIMEOUT = 30_000
// npx and uvx download the server on first launch, which takes well over 30s on a slow connection;
// killing them mid-download also leaves a broken package in their cache that fails every later start.
const RUNNER_STARTUP_TIMEOUT = 5 * 60 * 1_000
const RUNNERS = new Set(["npx", "uvx", "bunx", "pnpx"])
const DEFAULT_EXECUTION_TIMEOUT = 5 * 60 * 1_000 // 5 minutes: a tool call that runs longer is stuck, not working
// MCP execution is clamped to this wall unless the operator acknowledges full limits disable.
const MAX_EXECUTION_TIMEOUT_MS = 30 * 60 * 1_000
// Tools that legitimately run longer than the 5-minute default: a language
// server starting up behind Serena, a remote model answering behind
// DeepWiki. An entry needs a tool observed to exceed the default — never add
// one pre-emptively "just in case", or the table becomes a second default.
// Explicit per-server config still wins over the table.
const TOOL_EXECUTION_TIMEOUT_MS: Readonly<Record<string, number>> = {
  "serena:initial_instructions": 10 * 60 * 1_000,
  "serena:serena_repl": 10 * 60 * 1_000,
  "deepwiki:ask_question": 10 * 60 * 1_000,
}

/**
 * Execution timeout for one tool call, in milliseconds. Explicit per-server
 * config wins; then the per-tool table; then the 5-minute default. The hard
 * wall caps execution unless the operator acknowledges full limits disable. `tool` is the raw tool name the server sees (no `<server>_` prefix).
 */
export function executionTimeoutFor(
  server: string,
  tool: string | undefined,
  configured: number | undefined,
  env: Record<string, string | undefined> = process.env,
): number {
  const fallback =
    tool === undefined ? DEFAULT_EXECUTION_TIMEOUT : (TOOL_EXECUTION_TIMEOUT_MS[`${server}:${tool}`] ?? DEFAULT_EXECUTION_TIMEOUT)
  if (Limits.fullyDisabled(env)) return Limits.UNBOUNDED_MS
  return Math.min(Limits.timeout(configured, fallback, env), MAX_EXECUTION_TIMEOUT_MS)
}
const TERMINATE_TIMEOUT = 1_000
const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

// HTTP statuses and network error codes live on error properties and are lost once flattened to a message.
const describe = (error: unknown) => {
  if (!(error instanceof Error)) return String(error)
  const detail =
    error instanceof SdkHttpError
      ? `HTTP ${error.status}`
      : !(error instanceof SdkError) && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined
  return detail && !error.message.includes(detail) ? `${error.message} (${detail})` : error.message
}

// Overloaded or restarting servers and dropped connections usually recover within a second.
// Fetch reports network failures as a TypeError carrying a system error code.
// 501 means the server will never support the request.
const isTransient = (error: unknown) =>
  error instanceof SdkHttpError
    ? error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501)
    : (error instanceof TypeError && "code" in error) ||
      (error instanceof Error && /timed out waiting for response headers/i.test(error.message))

/**
 * True when a local MCP command spawns the official filesystem server
 * (`@modelcontextprotocol/server-filesystem`, whose bin is
 * `mcp-server-filesystem`): the only server the client passes `--read-only`
 * to. Anything else is left alone — appending an unknown flag to another
 * server would break its startup.
 */
export function isFilesystemServerCommand(command: ReadonlyArray<string>): boolean {
  return command.some((part) => {
    // Any path segment names the server: the package
    // (@modelcontextprotocol/server-filesystem), its bin
    // (mcp-server-filesystem), or its built entry point
    // (.../server-filesystem/dist/index.js).
    const segments = part.split(/[\\/]/)
    return segments.includes("server-filesystem") || segments.includes("mcp-server-filesystem")
  })
}

/**
 * Spawn arguments for a local MCP server: the configured args, plus upstream
 * `--read-only` (servers v2.3.0) when the server is a filesystem server and
 * `readOnly` is set. Upstream parses options anywhere on the command line,
 * so appending after the allowed directories is safe. A flag already present
 * in the config is never duplicated.
 */
export function localSpawnArgs(config: typeof ConfigMCP.Local.Type): ReadonlyArray<string> {
  const [, ...args] = config.command
  if (config.readOnly !== true || !isFilesystemServerCommand(config.command)) return args
  return args.includes("--read-only") ? args : [...args, "--read-only"]
}

export type { GetPromptResult, Prompt, ReadResourceResult, Resource, Tool }
export type ResourceTemplate = ResourceTemplateType

export class NeedsAuthError extends Schema.TaggedError<NeedsAuthError>()("MCP.NeedsAuthError", {
  server: Schema.String,
  message: Schema.String,
}) {}

export class ConnectError extends Schema.TaggedError<ConnectError>()("MCP.ConnectError", {
  server: Schema.String,
  message: Schema.String,
}) {}

/** A legacy Streamable HTTP server no longer recognizes this connection's session; the lifecycle reconnects. */
export class SessionExpiredError extends Schema.TaggedError<SessionExpiredError>()("MCP.SessionExpiredError", {
  server: Schema.String,
}) {
  override get message() {
    return `MCP server session expired: ${this.server}`
  }
}

export type CallToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "media"; readonly data: string; readonly mimeType: string }

export interface CallToolResult {
  readonly isError: boolean
  readonly structured?: unknown
  readonly content: ReadonlyArray<CallToolContent>
}

export type ElicitationFormParams = ElicitRequestFormParams
export type ElicitationParams = ElicitRequestParams
export type ElicitationResult = ElicitResult

export interface ElicitationHandler {
  readonly create: (input: {
    readonly server: string
    readonly params: ElicitationParams
    readonly signal: AbortSignal
  }) => Effect.Effect<ElicitationResult, Error>
  /**
   * Legacy era only: the server announces that a URL-mode elicitation finished out of band. Removed in
   * 2026-07-28, where the client learns the outcome by retrying, but legacy servers still send it and
   * it lets the form settle without the user re-running the tool.
   */
  readonly complete: (input: {
    readonly server: string
    readonly elicitationID: ElicitRequestURLParams["elicitationId"]
  }) => Effect.Effect<void>
}

/** Handle over a connected MCP server that keeps the SDK `Client` out of the rest of core. */
export interface Connection {
  /** True when the connection negotiated revision 2026-07-28 or later; false is the initialize handshake. */
  readonly modern: boolean
  /**
   * The negotiated protocol revision (for example "2026-07-28" or
   * "2025-11-25"), from the `server/discover` result on a modern connection
   * or the `initialize` result on a legacy one.
   */
  readonly protocolVersion: string | undefined
  /**
   * The server's self-reported name and version: required on the legacy
   * `initialize` result, a SHOULD in the discover result's `_meta` on
   * 2026-07-28, so a modern server that stays anonymous leaves this
   * undefined. Untrusted data — a display label, never an identity proof.
   */
  readonly serverVersion: Implementation | undefined
  /**
   * True when the server advertises task support: on the 2026-07-28 era
   * tasks live in the official `io.modelcontextprotocol/tasks` extension,
   * advertised under `capabilities.extensions` (the modern wire codec drops
   * the legacy `capabilities.tasks` key); on a legacy connection the same
   * fact arrives as the 2025-11-25 `capabilities.tasks` key. Tasks have no
   * SDK runtime in either era, so this is only the gate a future
   * tasks-extension caller checks before speaking the extension — never a
   * promise that tasks work.
   */
  readonly supportsTasks: boolean
  readonly instructions: string | undefined
  readonly tools: () => Effect.Effect<Tool[], Error>
  readonly prompts: () => Effect.Effect<Prompt[], Error>
  readonly resources: () => Effect.Effect<Resource[], Error>
  readonly resourceTemplates: () => Effect.Effect<ResourceTemplateType[], Error>
  /** Resolves to undefined when the server does not advertise resources. */
  readonly readResource: (input: { readonly uri: string }) => Effect.Effect<ReadResourceResult | undefined, Error>
  readonly prompt: (input: {
    readonly name: string
    readonly args?: Record<string, string>
  }) => Effect.Effect<GetPromptResult, Error>
  readonly callTool: (input: {
    readonly name: string
    readonly args?: Record<string, unknown>
    readonly sessionID?: Session.ID
    /** Retry only when the server explicitly advertises this tool as read-only. */
    readonly readOnly?: boolean
    /**
     * Caller-asserted idempotency key: retrying a transient failure is safe
     * only when the call is read-only or the caller can prove the same key
     * will not execute the effect twice (the key travels in `_meta`, so a
     * server that understands it can dedupe). Without it, a non-read-only
     * call runs exactly once.
     */
    readonly idempotencyKey?: string
  }) => Effect.Effect<CallToolResult, Error>
  readonly onClose: (callback: (reason: string) => void) => void
  readonly onSessionExpired: (callback: () => void) => void
  readonly onToolsChanged: (callback: () => void) => void
  readonly onPromptsChanged: (callback: () => void) => void
  readonly onResourcesChanged: (callback: () => void) => void
}

/**
 * Connects an MCP server; closing the calling scope tears down the transport and any spawned process.
 * A stdio server is spawned through the location's `Environment`, so it runs wherever the location's
 * shell commands run rather than always on the host.
 */
export const connect = Effect.fnUntraced(function* (
  server: string,
  config: typeof ConfigMCP.Server.Type,
  directory: string,
  // Remote only. A provider with no stored token and a no-op redirect ends in UnauthorizedError → needs_auth.
  authProvider?: OAuthClientProvider,
  elicitation?: ElicitationHandler,
  clientInfo: Implementation = { name: "orchestra", version: "unknown" },
  // Test-only escape hatch: the remote URL still has to be a valid http(s) URL, but the SSRF
  // gate is skipped so tests can connect to a loopback fixture server. Production callers
  // never pass this; a remote MCP server on a private or loopback address is refused.
  options?: { readonly allowPrivateUrl?: boolean },
) {
  // The SDK takes list-changed handlers at construction, but consumers register after connect. On a
  // modern connection the SDK opens the subscriptions/listen stream behind these itself.
  const changed = { tools: () => {}, prompts: () => {}, resources: () => {} }
  const listChanged = (key: keyof typeof changed) => ({
    autoRefresh: false,
    debounceMs: 0,
    onChanged: () => changed[key](),
  })

  // The SDK fails pending requests with a bare "Connection closed"; the transport error before it says why.
  let lastError: string | undefined
  const explain = (error: unknown) =>
    error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed && lastError
      ? `${describe(error)}: ${lastError}`
      : describe(error)

  // Two more attempts, 250 ms and 1 s later, while the failure is transient and the deadline has not passed.
  const retrying = <A, E>(what: string, effect: Effect.Effect<A, E>, deadline = Infinity) =>
    Effect.retry(
      effect,
      Schedule.max([Schedule.exponential("250 millis", 4), Schedule.recurs(2)]).pipe(
        Schedule.setInputType<E>(),
        Schedule.while(({ input, now, duration }) =>
          !isTransient(input) || now + Duration.toMillis(duration) >= deadline
            ? Effect.succeed(false)
            : Effect.logWarning(`retrying ${what}`, { server, error: describe(input) }).pipe(Effect.as(true)),
        ),
      ),
    )

  const startup =
    config.timeout?.startup ??
    (config.type === "local" && RUNNERS.has(path.parse(config.command[0] ?? "").name.toLowerCase())
      ? RUNNER_STARTUP_TIMEOUT
      : DEFAULT_STARTUP_TIMEOUT)

  const initialize = Effect.fnUntraced(function* (transport: Transport) {
    const runFork = Effect.runForkWith(yield* Effect.context())
    const client = new Client(clientInfo, {
      capabilities: {
        ...(elicitation ? { elicitation: { form: { applyDefaults: true }, url: {} } } : {}),
        // Legacy era only: roots are deprecated as of 2026-07-28 and modern servers cannot request them.
        // Some legacy servers refuse to run without one (https://github.com/anomalyco/opencode/issues/2308).
        roots: {},
      },
      versionNegotiation: negotiation(config.protocol),
      listChanged: {
        tools: listChanged("tools"),
        prompts: listChanged("prompts"),
        resources: listChanged("resources"),
      },
    })
    // Background work such as the standalone SSE stream reports failures only here; aborts come from close.
    client.onerror = (error) => {
      if (error.name === "AbortError") return
      lastError = describe(error)
      runFork(Effect.logWarning("mcp transport error", { server, error: lastError }))
    }
    client.setRequestHandler("roots/list", () => ({ roots: [{ uri: pathToFileURL(directory).href }] }))
    if (elicitation) {
      client.setRequestHandler("elicitation/create", (request, ctx) =>
        Effect.runPromise(elicitation.create({ server, params: request.params, signal: ctx.mcpReq.signal })),
      )
      client.setNotificationHandler("notifications/elicitation/complete", (notification) =>
        Effect.runPromise(elicitation.complete({ server, elicitationID: notification.params.elicitationId })),
      )
    }

    yield* Effect.tryPromise({
      try: (signal) =>
        client.connect(transport, { timeout: startup, signal }),
      catch: (error) => error,
    }).pipe(Effect.onError(() => Effect.promise(() => transport.close()).pipe(Effect.ignore)))
    return client
  })

  // Legacy era only: the transport holds the Mcp-Session-Id the server minted, and the server answering
  // it with 404, or with the 400 a freshly restarted single-session server emits, means it no longer
  // knows this connection. Modern connections never carry a session id, so a modern 404 for an unknown
  // method is not mistaken for expiry. Other 400s pass through untouched.
  const session: { transport?: StreamableHTTPClientTransport; expired?: () => void; reported: boolean } = {
    reported: false,
  }
  const failure = (error: unknown) => {
    if (!(error instanceof SdkHttpError) || session.transport?.sessionId === undefined) return new Error(explain(error))
    const expired =
      error.status === 404 ||
      (error.status === 400 &&
        typeof error.data.text === "string" &&
        error.data.text.includes("Bad Request: Server not initialized"))
    if (!expired) return new Error(explain(error))
    if (!session.reported) {
      session.reported = true
      session.expired?.()
    }
    return new SessionExpiredError({ server })
  }

  const exit = yield* Effect.gen(function* () {
    if (config.type === "local") {
      const [command] = config.command
      // A read-only flag on any other server would break its startup, so it
      // is silently dropped there — but loudly enough to notice in the log.
      if (config.readOnly === true && !isFilesystemServerCommand(config.command))
        yield* Effect.logWarning("readOnly is set for a non-filesystem MCP server; the flag is ignored", {
          server,
        })
      const transport = yield* McpStdio.make({
        server,
        command,
        args: localSpawnArgs(config),
        cwd: config.cwd ? path.resolve(directory, config.cwd) : directory,
        environment: {
          ...(command === "orchestra" ? { BUN_BE_BUN: "1" } : {}),
          ...config.environment,
        },
      })
      return yield* initialize(transport)
    }
    if (!URL.canParse(config.url))
      return yield* new ConnectError({ server, message: `Invalid MCP URL for "${server}"` })
    // A remote MCP URL is an outgoing fetch to an address the model (via `mcp add` or a forged
    // server) or the operator typed in: it passes the shared SSRF gate before any request, so
    // the operator's LAN, cloud metadata endpoint and localhost services are unreachable
    // through a crafted server URL. The checked URL is the one the transport dials.
    const checked =
      options?.allowPrivateUrl === true
        ? new URL(config.url)
        : yield* Ssrf.assertPublicUrl(config.url).pipe(
            Effect.mapError((error) => new ConnectError({ server, message: error.message })),
          )
    const { McpOAuth } = yield* Effect.promise(() => import("./oauth.js"))
    const fetch = yield* McpOAuth.loggedFetch({ server, directory, allowPrivateUrl: options?.allowPrivateUrl })
    // Servers that bundle their own Code Mode (Cloudflare and others) expose raw tools when asked
    // with ?codemode=false, which is what our Code Mode wants. The configured URL stays the OAuth identity.
    const url = new URL(checked)
    const addedCodemode = config.codemode !== false && !url.searchParams.has("codemode")
    if (addedCodemode) url.searchParams.set("codemode", "false")
    const open = Effect.fnUntraced(function* (url: URL) {
      session.transport = new StreamableHTTPClientTransport(url, {
        requestInit: config.headers ? { headers: config.headers } : undefined,
        authProvider,
        fetch,
      })
      return yield* initialize(session.transport)
    })

    // Every attempt opens a fresh transport; no retry starts once the startup timeout has passed.
    const deadline = (yield* Clock.currentTimeMillis) + (startup)
    return yield* retrying(
      "MCP connect",
      open(url).pipe(
        Effect.catch((error) => {
          if (!addedCodemode || !(error instanceof SdkHttpError) || (error.status !== 400 && error.status !== 404))
            return Effect.fail(error)
          // Servers that reject unknown query params get one retry at the configured URL.
          return open(new URL(checked))
        }),
      ),
      deadline,
    )
  }).pipe(Effect.exit)
  if (Exit.isSuccess(exit)) {
    const client = exit.value
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // Close only aborts streams; the legacy session lives on until the server expires it unless
        // terminated explicitly. Terminate first: close aborts the signal the DELETE shares.
        const transport = session.transport
        // Termination failures are logged below; onerror would report them a second time.
        client.onerror = undefined
        if (transport?.sessionId !== undefined && !session.reported)
          yield* Effect.tryPromise({ try: () => transport.terminateSession(), catch: toError }).pipe(
            Effect.timeoutOrElse({
              duration: TERMINATE_TIMEOUT,
              orElse: () => Effect.fail(new Error(`Timed out after ${TERMINATE_TIMEOUT}ms`)),
            }),
            Effect.tapError((error) =>
              Effect.logWarning("failed to terminate MCP session", { server, error: error.message }),
            ),
            Effect.ignore,
          )
        yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
      }),
    )
    const catalog = { timeout: config.timeout?.catalog ?? DEFAULT_CATALOG_TIMEOUT }
    const executionFor = (tool?: string) => executionTimeoutFor(server, tool, config.timeout?.execution)
    const request = <A>(what: string, run: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: failure }).pipe(
        Effect.tapError((error) => Effect.logWarning(`failed to ${what}`, { server, error: error.message })),
      )
    // Reads are safe to retry on transient failures; a failed read never
    // changed anything, so a second attempt cannot double-apply an effect.
    const readRequest = <A>(what: string, run: (signal: AbortSignal) => Promise<A>) =>
      retrying(what, request(what, run))
    // Listing is read-only, so a transient failure is safe to retry.
    const list = <A>(what: string, run: () => Promise<A>) =>
      retrying(what, Effect.tryPromise({ try: run, catch: (error) => error })).pipe(
        Effect.mapError(failure),
        Effect.tapError((error) => Effect.logWarning(`failed to ${what}`, { server, error: error.message })),
      )

    return {
      modern: client.getProtocolEra() === "modern",
      protocolVersion: client.getNegotiatedProtocolVersion(),
      serverVersion: client.getServerVersion(),
      supportsTasks: supportsTasks(client.getServerCapabilities()),
      instructions: client.getInstructions()?.trim() || undefined,
      tools: () => list("list MCP tools", () => client.listTools(undefined, catalog)).pipe(Effect.map((r) => r.tools)),
      prompts: () =>
        list("list MCP prompts", () => client.listPrompts(undefined, catalog)).pipe(Effect.map((r) => r.prompts)),
      resources: () =>
        list("list MCP resources", () => client.listResources(undefined, catalog)).pipe(Effect.map((r) => r.resources)),
      resourceTemplates: () =>
        list("list MCP resource templates", () => client.listResourceTemplates(undefined, catalog)).pipe(
          Effect.map((r) => r.resourceTemplates),
        ),
      readResource: (input) => {
        if (!client.getServerCapabilities()?.resources) return Effect.succeed(undefined)
        return readRequest("read MCP resource", (signal) =>
          client.readResource({ uri: input.uri }, { signal, timeout: executionFor() }),
        )
      },
      prompt: (input) =>
        readRequest("get MCP prompt", (signal) =>
          client.getPrompt({ name: input.name, arguments: input.args ?? {} }, { signal, timeout: executionFor() }),
        ),
      callTool: (input) => {
        const run = (signal: AbortSignal) =>
          client.callTool(
            {
              name: input.name,
              arguments: input.args ?? {},
              ...(input.sessionID === undefined && input.idempotencyKey === undefined
                ? {}
                : {
                    _meta: {
                      ...(input.sessionID === undefined ? {} : { "ai.opencode/sessionID": input.sessionID }),
                      ...(input.idempotencyKey === undefined
                        ? {}
                        : { "ai.opencode/idempotency-key": input.idempotencyKey }),
                    },
                  }),
            },
            // Requesting progress keeps long calls active; the execution timeout remains the hard wall.
            { signal, timeout: executionFor(input.name), onprogress: () => {} },
          )
        // Transient failures are retried for read-only tools and for calls
        // the caller marked idempotent; anything else runs exactly once, so
        // a retried write can never execute its effect twice.
        const retryable = input.readOnly === true || input.idempotencyKey !== undefined
        const operation = retryable
          ? retrying("call MCP tool", Effect.tryPromise({ try: run, catch: (error) => error })).pipe(
              Effect.mapError(failure),
              Effect.tapError((error) =>
                Effect.logWarning("failed to call MCP tool", { server, error: error.message }),
              ),
            )
          : request("call MCP tool", run)
        return operation.pipe(Effect.map(toCallToolResult))
      },
      onClose: (callback) => {
        client.onclose = () => callback(lastError ? `Connection closed: ${lastError}` : "Connection closed")
      },
      onSessionExpired: (callback) => {
        session.expired = callback
      },
      onToolsChanged: (callback) => {
        changed.tools = callback
      },
      onPromptsChanged: (callback) => {
        changed.prompts = callback
      },
      onResourcesChanged: (callback) => {
        changed.resources = callback
      },
    } satisfies Connection
  }

  const error = Cause.squash(exit.cause)
  if (error instanceof UnauthorizedError) return yield* new NeedsAuthError({ server, message: error.message })
  if (error instanceof UnsupportedProtocolVersionError)
    return yield* new ConnectError({
      server,
      message: `${error.message}; the server supports ${error.supported.join(", ")}. Set "protocol" for this server to one of those or to "legacy".`,
    })
  return yield* new ConnectError({ server, message: explain(error) })
})

// Absent config is auto: the SDK probes with server/discover and falls back to the plain initialize
// handshake when the server does not speak 2026-07-28. "legacy" is the explicit opt-out that skips
// the probe entirely; a stdio probe spawns one short-lived sibling process per connect, and on HTTP
// a probe that times out rejects (silence on a deployed server is an outage, not a legacy signal).
function negotiation(protocol: ConfigMCP.Protocol | undefined): VersionNegotiationOptions | undefined {
  if (protocol === "legacy") return undefined
  if (protocol === undefined || protocol === "auto") return { mode: "auto" }
  return { mode: { pin: protocol } }
}

/** The official extension id tasks moved to in the 2026-07-28 revision. */
const TASKS_EXTENSION = "io.modelcontextprotocol/tasks"

/**
 * True when the server advertises task support: the modern-era extension
 * under `capabilities.extensions`, or the 2025-11-25 `capabilities.tasks`
 * key on a legacy connection (the modern wire codec drops that key, so a
 * modern server can only advertise tasks through the extension).
 */
function supportsTasks(capabilities: ServerCapabilities | undefined): boolean {
  return capabilities?.tasks !== undefined || capabilities?.extensions?.[TASKS_EXTENSION] !== undefined
}

function toCallToolResult(result: SdkCallToolResult): CallToolResult {
  return {
    isError: result.isError === true,
    structured: result.structuredContent,
    content: result.content.flatMap((part): CallToolContent[] => {
      if (part.type === "text") return [{ type: "text", text: part.text }]
      if (part.type === "image" || part.type === "audio")
        return [{ type: "media", data: part.data, mimeType: part.mimeType }]
      if (part.type === "resource_link") return [{ type: "text", text: part.uri }]
      if (part.type === "resource") {
        const resource = part.resource
        if ("text" in resource && typeof resource.text === "string") return [{ type: "text", text: resource.text }]
        if ("blob" in resource && typeof resource.blob === "string" && typeof resource.mimeType === "string")
          return [{ type: "media", data: resource.blob, mimeType: resource.mimeType }]
        return [{ type: "text", text: resource.uri }]
      }
      return []
    }),
  }
}
