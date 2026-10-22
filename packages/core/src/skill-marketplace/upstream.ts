export * as SkillMarketplaceUpstream from "./upstream.js"

import { Duration, Effect, Result, Schema } from "effect"
import { SkillMarketplace } from "@orchestra/schema/skill-marketplace"

/**
 * The catalog's own MCP endpoint, and the only place this module ever speaks to. It is not the
 * REST endpoint the retired proxy used: that one allows fifty calls a day, and this one has no
 * daily quota at all — only a rate of thirty `tools/call` per minute per IP.
 */
export const ENDPOINT = "https://skillsmp.com/mcp"

/**
 * Sent as `MCP-Protocol-Version` on every request and declared in `initialize`. The endpoint
 * refuses a request without it (`MCP-Protocol-Version header is required`), and it refuses this
 * string too: measured live on 2026-10-15, `tools/list` and `initialize` both answer 200 with
 * `2025-06-18` and 403 with `2025-11-25`, and `initialize` echoes `2025-06-18` back. The value
 * the endpoint answers is therefore the one to send, not the latest the SDK here happens to know.
 */
export const PROTOCOL_VERSION = "2025-06-18"

export const USER_AGENT = "opencode-skill-catalog/1.0"

export const TIMEOUT = Duration.seconds(30)

/** How long the client waits for an answer nobody owes it before moving on. */
export const NOTIFICATION_WAIT = Duration.seconds(5)

/**
 * Thirty calls a minute per IP means two seconds apart at best. A pause this long keeps a burst
 * of searches from being answered with a refusal, and it is why nothing here retries: a blind
 * retry is what turns one refusal into several.
 */
export const MIN_INTERVAL = Duration.millis(2100)

export const SEARCH_TOOL = "search_skills"

export class UpstreamError extends Schema.TaggedError<UpstreamError>()("@orchestra/SkillMarketplace/UpstreamError", {
  message: Schema.String,
  /** The catalog's own refusal code when it sent one, for example `DAILY_QUOTA_EXCEEDED`. */
  code: Schema.String.pipe(Schema.optional),
  status: Schema.Number.pipe(Schema.optional),
}) {}

export interface Query {
  readonly query: string
  readonly limit?: number
  readonly page?: number
  readonly sortBy?: SkillMarketplace.SortOrder
  readonly category?: string
  readonly language?: SkillMarketplace.ContentLanguage
}

export type Fetch = typeof globalThis.fetch

export interface Options {
  /** Injected by the tests; production uses the platform fetch. */
  readonly fetch?: Fetch
  readonly endpoint?: string
  readonly timeout?: Duration.Duration
  /** Turning this off is for tests that make several calls in a second, never for production. */
  readonly wait?: boolean
}

/** Everything one `tools/call` needs that is not the catalog's own answer. */
export interface Session {
  /** `Mcp-Session-Id` from `initialize`, sent on every later request when the server gave one. */
  readonly id: string | undefined
}

const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error: unknown) => error })

const headers = (session: Session) => ({
  "User-Agent": USER_AGENT,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "MCP-Protocol-Version": PROTOCOL_VERSION,
  ...(session.id === undefined ? {} : { "Mcp-Session-Id": session.id }),
})

/**
 * Fires a notification and stops caring about the answer.
 *
 * A notification has no id and, by the protocol, no result — and this endpoint really sends
 * nothing back at all: measured live on 2026-10-15, one `notifications/initialized` in three
 * never answered and the request sat there until it was aborted, which is what turned a working
 * call into a timeout. So it is sent, given a bounded wait, and forgotten: whether the server
 * heard it is not this caller's problem, because the `tools/call` that follows is what the
 * session is judged on.
 */
const notify = (body: unknown, session: Session, options: Options) =>
  attempt(async (signal) => {
    await (options.fetch ?? globalThis.fetch)(options.endpoint ?? ENDPOINT, {
      method: "POST",
      headers: headers(session),
      body: JSON.stringify(body),
      signal,
    })
  }).pipe(
    Effect.timeoutOrElse({ duration: NOTIFICATION_WAIT, orElse: () => Effect.void }),
    Effect.exit,
    Effect.asVoid,
  )

const post = (body: unknown, session: Session, options: Options) =>
  attempt(async (signal) => {
    const response = await (options.fetch ?? globalThis.fetch)(options.endpoint ?? ENDPOINT, {
      method: "POST",
      headers: headers(session),
      body: JSON.stringify(body),
      signal,
    })
    const text = await response.text()
    if (!response.ok)
      throw new UpstreamError({ message: `the catalog answered ${response.status}`, status: response.status })
    return { text, id: response.headers.get("Mcp-Session-Id") ?? session.id }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof UpstreamError
        ? error
        : new UpstreamError({ message: `the catalog request failed: ${text(error)}` }),
    ),
  )

/** The transport's own failure, named as it happened: a DNS error is worth more than "unknown". */
const text = (error: unknown) => (error instanceof globalThis.Error ? error.message : String(error))

/** JSON-RPC answers either one object or a stream of server-sent events; both carry `result`. */

const payload = (body: string) => {
  const direct = safeParse(body)
  if (direct !== undefined) return direct
  const event = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => safeParse(line.slice(5).trim()))
    .findLast((value) => value !== undefined)
  return event
}

const safeParse = (text: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(text)
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const refusal = (body: Record<string, unknown> | undefined) => {
  if (body === undefined) return new UpstreamError({ message: "the catalog answered something unreadable" })
  const error = body.error
  if (error === undefined || typeof error !== "object") return undefined
  const details = error as { code?: unknown; message?: unknown }
  return new UpstreamError({
    message: typeof details.message === "string" ? details.message : "the catalog refused the call",
    ...(typeof details.code === "string" ? { code: details.code } : {}),
  })
}

/** The `result` object of a JSON-RPC answer, or the refusal it carries instead of one. */
type Answer = {
  readonly failure?: UpstreamError
  readonly result?: { content?: unknown; isError?: unknown; structuredContent?: unknown }
}

const answered = (body: Record<string, unknown> | undefined): Answer => {
  const failure = refusal(body)
  if (failure !== undefined) return { failure }
  const result = body?.result
  if (result === undefined || typeof result !== "object") return {}
  return { result: result as { content?: unknown; isError?: unknown; structuredContent?: unknown } }
}

/**
 * One `tools/call`, decoded through the catalog contract.
 *
 * Every way the endpoint can say no becomes one error, so no caller can read one as "no skills
 * matched": a non-200 status, a JSON-RPC error object, a tool result marked `isError`, and a
 * body the contract rejects. Nothing from any of them may reach the cache.
 */
export const search = (input: Query, options: Options = {}): Effect.Effect<SkillMarketplace.Listing, UpstreamError> =>
  Effect.gen(function* () {
    if (options.wait !== false) yield* spaced
    const answer = yield* callTool(input, options)
    const parsed = decoded(answer.text)
    if (Result.isFailure(parsed))
      return yield* new UpstreamError({
        message: `the catalog answered something unreadable: ${parsed.failure.message}`,
      })
    if (SkillMarketplace.isError(parsed.success))
      return yield* new UpstreamError({ message: parsed.success.error.message, code: parsed.success.error.code })
    return parsed.success
  }).pipe(Effect.timeoutOrElse({ duration: options.timeout ?? TIMEOUT, orElse: () => Effect.fail(tooSlow()) }))

const tooSlow = () => new UpstreamError({ message: "the catalog did not answer in time" })

/**
 * Reads the body of a `tools/call`, which the endpoint sends as the listing itself — `skills`
 * and `pagination`, with no envelope and no echoed `filters` (measured live 2026-10-15). The
 * contract describes that same listing inside the REST envelope, so the body is read twice: as
 * the catalog wrote it, and wrapped with the two fields this channel leaves out. Both shapes are
 * real answers; a body that is neither stays a refusal, and the first failure is the one
 * reported, because it quotes the catalog's own words rather than this wrapping.
 */
const decoded = (body: string) => {
  const asWritten = SkillMarketplace.parse(body)
  if (Result.isSuccess(asWritten)) return asWritten
  const wrapped = SkillMarketplace.parse(wrap(body))
  return Result.isSuccess(wrapped) ? wrapped : asWritten
}

/**
 * `filters` is filled in as an empty object because this channel does not echo the request's
 * filters back; the rows, the counts and the pagination are the catalog's own and untouched.
 */
const wrap = (body: string) => {
  try {
    const listing = JSON.parse(body) as unknown
    if (listing === null || typeof listing !== "object") return body
    const echo = listing as { filters?: unknown }
    return JSON.stringify({ success: true, data: { ...echo, filters: echo.filters ?? {} } })
  } catch {
    // Not JSON at all: `asWritten` has already said so with the better message.
    return body
  }
}

type Text = { readonly text: string }

const callTool = (input: Query, options: Options) =>
  Effect.gen(function* () {
    const session = yield* open(options)
    const sent = yield* post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: SEARCH_TOOL, arguments: argumentsOf(input) },
      },
      session,
      options,
    )
    const answer = answered(payload(sent.text))
    if (answer.failure !== undefined) return yield* answer.failure
    if (answer.result === undefined)
      return yield* new UpstreamError({ message: "the catalog answered something unreadable" })
    if (answer.result.isError === true)
      return yield* new UpstreamError({ message: textOf(answer.result) || "the catalog refused the call" })
    const structured = answer.result.structuredContent
    // The endpoint answers with the catalog's own JSON, either as text or as structured content.
    const text =
      typeof structured === "object" && structured !== null ? JSON.stringify(structured) : textOf(answer.result)
    return { text } satisfies Text
  })

/** The argument names the catalog documents for this tool. */
const argumentsOf = (input: Query) => ({
  query: input.query,
  limit: input.limit ?? 20,
  page: input.page ?? 1,
  sortBy: input.sortBy ?? "stars",
  ...(input.category === undefined ? {} : { category: input.category }),
  ...(input.language === undefined ? {} : { language: input.language }),
})

const textOf = (result: { content?: unknown }) =>
  Array.isArray(result.content)
    ? result.content
        .flatMap((part) =>
          typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
            ? [String((part as { text?: unknown }).text ?? "")]
            : [],
        )
        .join("\n")
    : ""

/**
 * `initialize`, then the notification that tells the server the client is ready. The session id
 * the server hands back rides on every later request: without it some servers treat each
 * `tools/call` as a brand-new client.
 */
const open = (options: Options) =>
  Effect.gen(function* () {
    const initialize = yield* post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "opencode-skill-catalog", version: "1.0" },
        },
      },
      { id: undefined },
      options,
    )
    // An `initialize` that was refused ends the call here: a later `tools/call` would fail
    // against a session the server never opened, and the second failure would hide the first.
    const refused = refusal(payload(initialize.text))
    if (refused !== undefined) return yield* refused
    yield* notify({ jsonrpc: "2.0", method: "notifications/initialized" }, { id: initialize.id }, options)
    return { id: initialize.id } satisfies Session
  })

let reserved = 0

/**
 * Reserves the next free slot at least `MIN_INTERVAL` from the last one and waits for it. The
 * reservation happens when the effect runs, not when it is built, so two calls racing each other
 * take two different slots instead of the same one.
 */
const spaced = Effect.suspend(() => {
  const step = Duration.toMillis(MIN_INTERVAL)
  const wait = reserved + step - Date.now()
  reserved = Math.max(reserved, Date.now()) + step
  return wait > 0 ? Effect.sleep(Duration.millis(wait)) : Effect.void
})
