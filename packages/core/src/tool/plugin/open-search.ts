import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import { collectBoundedResponseBody } from "../http-body.js"

export interface OpenSearchResult {
  readonly title: string
  readonly url: string
  readonly snippet: string
}

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

const MAX_BODY_BYTES = 2 * 1024 * 1024 // 2 MB

const readText = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<string, Error> =>
  collectBoundedResponseBody(response, MAX_BODY_BYTES, () => new Error("Response too large")).pipe(
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
  )

const readJson = <T>(response: HttpClientResponse.HttpClientResponse): Effect.Effect<T, Error> =>
  readText(response).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as T,
        catch: (cause) => new Error(`Failed to parse JSON response: ${cause}`),
      }),
    ),
  )

export function decodeDuckDuckGo(href: string): string | undefined {
  if (!href) return undefined
  const absolute = href.startsWith("//") ? `https:${href}` : href
  if (!URL.canParse(absolute)) return undefined
  const url = new URL(absolute)
  const target = url.searchParams.get("uddg")
  if (target && URL.canParse(target)) return target
  return url.hostname.endsWith("duckduckgo.com") ? undefined : url.href
}

export function parseDuckDuckGo(html: string, max = 8): OpenSearchResult[] {
  const results: OpenSearchResult[] = []
  let current: { url: string; title: string; snippet: string } | undefined
  let text = ""
  let inSnippet = false

  const flush = () => {
    if (!current) return
    const title = (current.title || text).replace(/\s+/g, " ").trim()
    const snippet = current.snippet.replace(/\s+/g, " ").trim()
    if (title && current.url) {
      results.push({ title, url: current.url, snippet })
    }
    current = undefined
    text = ""
    inSnippet = false
  }

  const parser = new Parser({
    onopentag(tag, attributes) {
      if (tag === "a") {
        const classes = attributes.class?.split(/\s+/) ?? []
        if (classes.includes("result__snippet")) {
          inSnippet = true
          return
        }
        if (classes.includes("result__a") || classes.includes("result-link")) {
          flush()
          const href = decodeDuckDuckGo(attributes.href ?? "")
          if (href) {
            current = { url: href, title: "", snippet: "" }
          }
        }
      }
    },
    ontext(value) {
      if (inSnippet && current) {
        current.snippet += value
      } else if (current) {
        text += value
      }
    },
    onclosetag(tag) {
      if (tag === "a") {
        if (inSnippet) {
          inSnippet = false
        } else if (current && text) {
          current.title = text
          text = ""
        }
      }
      if (tag === "tr" || tag === "td" || tag === "div") {
        if (current && current.title) {
          flush()
        }
      }
    },
  })
  parser.write(html)
  parser.end()
  flush()
  return dedupe(results).slice(0, max)
}

function dedupe(items: ReadonlyArray<OpenSearchResult>): OpenSearchResult[] {
  const seen = new Set<string>()
  const result: OpenSearchResult[] = []
  for (const item of items) {
    if (!item.url || seen.has(item.url)) continue
    seen.add(item.url)
    result.push(item)
  }
  return result
}

export const duckduckgoHtml = (
  http: HttpClient.HttpClient,
  query: string,
  max = 8,
): Effect.Effect<OpenSearchResult[]> =>
  Effect.gen(function* () {
    const response = yield* http.execute(
      HttpClientRequest.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`).pipe(
        HttpClientRequest.setHeaders({ "User-Agent": USER_AGENT, Accept: "text/html" }),
      ),
    )
    const ok = yield* HttpClientResponse.filterStatusOk(response)
    const html = yield* readText(ok)
    const results = parseDuckDuckGo(html, max)
    if (results.length > 0) return results

    // Fallback on DuckDuckGo Lite if html returned 0 results
    const liteResponse = yield* http.execute(
      HttpClientRequest.get(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`).pipe(
        HttpClientRequest.setHeaders({ "User-Agent": USER_AGENT, Accept: "text/html" }),
      ),
    )
    const liteOk = yield* HttpClientResponse.filterStatusOk(liteResponse)
    const liteHtml = yield* readText(liteOk)
    return parseDuckDuckGo(liteHtml, max)
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.orElseSucceed(() => [] as OpenSearchResult[]),
  )

export const duckduckgoInstantAnswers = (
  http: HttpClient.HttpClient,
  query: string,
  max = 8,
): Effect.Effect<OpenSearchResult[]> =>
  Effect.gen(function* () {
    const response = yield* http.execute(
      HttpClientRequest.get(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      ).pipe(HttpClientRequest.setHeaders({ "User-Agent": USER_AGENT, Accept: "application/json" })),
    )
    const ok = yield* HttpClientResponse.filterStatusOk(response)
    const data = yield* readJson<{
      Heading?: string
      AbstractURL?: string
      AbstractText?: string
      RelatedTopics?: ReadonlyArray<{ FirstURL?: string; Text?: string }>
    }>(ok)
    const results: OpenSearchResult[] = []
    if (data.AbstractURL && data.AbstractText) {
      results.push({
        title: data.Heading || query,
        url: data.AbstractURL,
        snippet: data.AbstractText,
      })
    }
    if (Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics) {
        if (topic.FirstURL && topic.Text) {
          results.push({
            title: topic.Text.split(" - ")[0] || topic.FirstURL,
            url: topic.FirstURL,
            snippet: topic.Text,
          })
        }
      }
    }
    return results.slice(0, max)
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => [] as OpenSearchResult[]),
  )

export const wikipediaOpenSearch = (
  http: HttpClient.HttpClient,
  query: string,
  max = 8,
): Effect.Effect<OpenSearchResult[]> =>
  Effect.gen(function* () {
    const response = yield* http.execute(
      HttpClientRequest.get(
        `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=${max}&namespace=0&format=json`,
      ).pipe(HttpClientRequest.setHeaders({ "User-Agent": USER_AGENT, Accept: "application/json" })),
    )
    const ok = yield* HttpClientResponse.filterStatusOk(response)
    const data = yield* readJson<unknown>(ok)
    if (!Array.isArray(data) || data.length < 4) return [] as OpenSearchResult[]
    const titles = data[1] as string[]
    const snippets = data[2] as string[]
    const urls = data[3] as string[]
    return urls.map((url, i) => ({
      title: titles[i] || url,
      url,
      snippet: snippets[i] || "",
    }))
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => [] as OpenSearchResult[]),
  )

export const npmRegistrySearch = (
  http: HttpClient.HttpClient,
  query: string,
  max = 8,
): Effect.Effect<OpenSearchResult[]> =>
  Effect.gen(function* () {
    const response = yield* http.execute(
      HttpClientRequest.get(
        `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${max}`,
      ).pipe(HttpClientRequest.setHeaders({ "User-Agent": USER_AGENT, Accept: "application/json" })),
    )
    const ok = yield* HttpClientResponse.filterStatusOk(response)
    const data = yield* readJson<{
      objects?: ReadonlyArray<{
        package: {
          name: string
          version: string
          description?: string
          links?: { npm?: string; homepage?: string; repository?: string }
        }
      }>
    }>(ok)
    if (!data.objects || !Array.isArray(data.objects)) return [] as OpenSearchResult[]
    return data.objects.map((obj) => ({
      title: `${obj.package.name} (npm v${obj.package.version})`,
      url: obj.package.links?.npm || `https://www.npmjs.com/package/${obj.package.name}`,
      snippet: obj.package.description || "",
    }))
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => [] as OpenSearchResult[]),
  )

export const openSearch = (
  http: HttpClient.HttpClient,
  query: string,
  max = 8,
): Effect.Effect<OpenSearchResult[]> =>
  Effect.gen(function* () {
    // 1. Try DuckDuckGo HTML / Lite
    const ddg = yield* duckduckgoHtml(http, query, max)
    if (ddg.length > 0) return ddg

    // 2. Cascade fallback on Instant Answers, Wikipedia, and NPM registry search
    const [instantAnswers, wiki, npm] = yield* Effect.all([
      duckduckgoInstantAnswers(http, query, max),
      wikipediaOpenSearch(http, query, max),
      npmRegistrySearch(http, query, max),
    ])

    const combined = dedupe([...instantAnswers, ...wiki, ...npm])
    return combined.slice(0, max)
  })
