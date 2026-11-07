export * as WebFetchTool from "./webfetch.js"

import type { Context } from "@orchestra/plugin/effect/plugin"
import { ToolFailure } from "@orchestra/ai"
import { Duration, Effect, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { Parser } from "htmlparser2"
import { Permission } from "../../permission.js"
import { convertHTMLToMarkdown, MAX_MARKDOWN_BYTES } from "../html-markdown.js"
import { collectBoundedResponseBody } from "../http-body.js"
import { Ssrf } from "../ssrf.js"

export const name = "webfetch"
export const MAX_RESPONSE_BYTES = MAX_MARKDOWN_BYTES
export const DEFAULT_TIMEOUT_SECONDS = 30
export const MAX_TIMEOUT_SECONDS = 600
// Upstream fetch server (modelcontextprotocol/servers v2.3.0) timeout window,
// in milliseconds: per-call timeout_ms, FETCH_TIMEOUT_MS env, default 30 s,
// range 100–600_000. The native tool keeps its legacy per-call `timeout` in
// seconds alongside `timeout_ms`; both clamp into this window.
export const MIN_TIMEOUT_MS = 100
export const MAX_TIMEOUT_MS = 600_000
export const DEFAULT_TIMEOUT_MS = 30_000
export const FETCH_TIMEOUT_MS_ENV = "FETCH_TIMEOUT_MS"

/**
 * Effective fetch timeout in milliseconds. Precedence: per-call `timeout_ms`,
 * then per-call `timeout` in seconds, then the `FETCH_TIMEOUT_MS` env default,
 * then 30 s. Everything clamps into the upstream 100–600_000 ms window, so a
 * stale env value or an over-eager model can neither spin forever nor ask for
 * less than a round trip.
 */
export function resolveFetchTimeoutMs(
  input: { readonly timeout?: number; readonly timeout_ms?: number },
  env: Record<string, string | undefined> = process.env,
): number {
  const fromEnv = () => {
    const raw = env[FETCH_TIMEOUT_MS_ENV]
    if (raw === undefined) return undefined
    const parsed = Number.parseInt(raw, 10)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  const requested =
    input.timeout_ms ??
    (input.timeout !== undefined ? input.timeout * 1_000 : undefined) ??
    fromEnv() ??
    DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(requested, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
}

export const description = `Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.

Use a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.`

const Timeout = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_TIMEOUT_SECONDS))

export const Input = Schema.Struct({
  url: Schema.String.annotate({ description: "The HTTP or HTTPS URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({ description: "The format to return the content in. Defaults to markdown." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed("markdown" as const))),
  timeout: Schema.optionalKey(Timeout).annotate({
    description: `Optional timeout in seconds (maximum: ${MAX_TIMEOUT_SECONDS}); timeout_ms wins when both are given.`,
  }),
  timeout_ms: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(MIN_TIMEOUT_MS),
      Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS),
    ),
  ).annotate({
    description: `Optional timeout in milliseconds (${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}); wins over timeout when both are given.`,
  }),
})

const Output = Schema.Struct({
  url: Schema.String,
  contentType: Schema.String,
  format: Input.fields.format,
  output: Schema.String,
})
type Format = (typeof Input.Type)["format"]

const acceptHeader = (format: Format) => {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
  }
}

const headers = (format: Format, userAgent: string) => ({
  "User-Agent": userAgent,
  Accept: acceptHeader(format),
  "Accept-Language": "en-US,en;q=0.9",
})

const openCodeUserAgent =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Orchestra-User/1.0; +https://github.com/NeiP4n/orchestra-app"

const isCloudflareChallenge = (response: HttpClientResponse.HttpClientResponse) =>
  response.status === 403 && response.headers["cf-mitigated"] === "challenge"

const request = (url: string, format: Format, userAgent = openCodeUserAgent) =>
  HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers(format, userAgent)))

const assertHttpUrl = (url: URL) => {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http:// or https://")
}

// Redirects are followed by hand, one hop at a time, so every hop passes the SSRF check:
// a transparent client redirect could otherwise carry a public URL to 169.254.169.254.
// `redirect: "manual"` keeps the underlying fetch from following them on its own.
const isRedirectStatus = (status: number) =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308

const fetchResponse = (
  http: HttpClient.HttpClient,
  url: string,
  format: Format,
  userAgent: string,
  redirects: number,
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError | Error> =>
  Effect.gen(function* () {
    const response = yield* http
      .execute(request(url, format, userAgent))
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
    if (isRedirectStatus(response.status)) {
      if (redirects >= Ssrf.MAX_REDIRECTS)
        return yield* Effect.fail(new Error(`Too many redirects (maximum ${Ssrf.MAX_REDIRECTS})`))
      const location = response.headers["location"]
      if (!location) return yield* Effect.fail(new Error(`Redirect from ${url} has no location`))
      const next = new URL(location, url).toString()
      yield* Ssrf.assertPublicUrl(next)
      return yield* fetchResponse(http, next, format, userAgent, redirects + 1)
    }
    if (isCloudflareChallenge(response) && userAgent !== "orchestra")
      return yield* fetchResponse(http, url, format, "orchestra", redirects)
    return yield* HttpClientResponse.filterStatusOk(response)
  })

const execute = (http: HttpClient.HttpClient, url: string, format: Format) =>
  fetchResponse(http, url, format, openCodeUserAgent, 0)

const collectBody = (response: HttpClientResponse.HttpClientResponse) =>
  collectBoundedResponseBody(
    response,
    MAX_RESPONSE_BYTES,
    () => new Error(`Response too large (exceeds ${MAX_RESPONSE_BYTES} byte limit)`),
  )

const mimeFrom = (contentType: string) => contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
const isImageAttachment = (mime: string) =>
  mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
const isTextualMime = (mime: string) =>
  !mime ||
  mime.startsWith("text/") ||
  mime === "application/json" ||
  mime.endsWith("+json") ||
  mime === "application/xml" ||
  mime.endsWith("+xml") ||
  mime === "application/javascript" ||
  mime === "application/x-javascript"
const convert = (content: string, contentType: string, format: Format) => {
  if (!contentType.includes("text/html")) return content
  if (format === "markdown") return convertHTMLToMarkdown(content)
  if (format === "text") return extractTextFromHTML(content)
  return content
}

export const Plugin = {
  id: "orchestra.tool.webfetch",
  effect: Effect.fn("WebFetchTool.Plugin")(function* (ctx: Context) {
    const http = yield* HttpClient.HttpClient
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, core: true },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* Effect.try({
                try: () => assertHttpUrl(new URL(input.url)),
                catch: (error) => error,
              })

              // A private or loopback address is refused before permission or transport:
              // no prompt can make fetching the metadata endpoint or the local network safe.
              yield* Ssrf.assertPublicUrl(input.url)

              yield* permission.assert({
                action: name,
                resources: [input.url],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })

              const { body, contentType } = yield* Effect.gen(function* () {
                const response = yield* execute(http, input.url, input.format)
                const contentType = response.headers["content-type"] || ""
                const mime = mimeFrom(contentType)
                if (isImageAttachment(mime))
                  return yield* Effect.fail(new Error(`Unsupported fetched image content type: ${mime}`))
                if (!isTextualMime(mime))
                  return yield* Effect.fail(new Error(`Unsupported fetched file content type: ${mime}`))
                return { body: yield* collectBody(response), contentType }
              }).pipe(
                Effect.timeoutOrElse({
                  duration: Duration.millis(resolveFetchTimeoutMs(input)),
                  orElse: () => Effect.fail(new Error("Request timed out")),
                }),
              )
              const content = new TextDecoder().decode(body)
              const output = yield* Effect.try({
                try: () => convert(content, contentType, input.format),
                catch: (error) => error,
              })
              const result = {
                url: input.url,
                contentType,
                format: input.format,
                output,
              }
              return { output: result, content: result.output, metadata: { contentType: result.contentType } }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: `Unable to fetch ${input.url}`, error }))),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

export function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) skipDepth++
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })
  parser.write(html)
  parser.end()
  return text.trim()
}

export { convertHTMLToMarkdown }
