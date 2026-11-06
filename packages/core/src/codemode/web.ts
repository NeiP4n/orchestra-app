export * as CodeModeWeb from "./web.js"

import { Extension } from "@orchestra/codemode"
import { Ssrf } from "../tool/ssrf.js"

const TIMEOUT_MS = 30_000

type Init = {
  readonly method?: string
  readonly headers?: Record<string, string> | Array<[string, string]>
  readonly body?: string | Uint8Array<ArrayBuffer> | URLSearchParams
}

const isRedirectStatus = (status: number) =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308

const fetch = async (input: string | URL, init: Init = {}) => {
  let current = String(input)
  let method = init.method
  let body = init.body
  const headers = new Headers(init.headers)
  let response: Response
  // Redirects are followed by hand, one hop at a time, so every hop passes the SSRF gate:
  // agent code fetching a public URL must not be carried to 169.254.169.254 or localhost by
  // a redirect, and the gate runs before the request, not after the response arrives.
  for (let redirects = 0; ; redirects++) {
    await Ssrf.assertPublicUrlPromise(current)
    response = await globalThis.fetch(current, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!isRedirectStatus(response.status)) break
    if (redirects >= Ssrf.MAX_REDIRECTS) throw new Error(`Too many redirects (maximum ${Ssrf.MAX_REDIRECTS})`)
    const location = response.headers.get("location")
    if (!location) throw new Error(`Redirect from ${current} has no location`)
    const next = new URL(location, current)
    // Credentials never follow a redirect to another origin: a public URL that bounces to
    // an attacker's host must not carry the agent's authorization header with it.
    if (next.origin !== new URL(current).origin) {
      headers.delete("authorization")
      headers.delete("cookie")
    }
    current = next.toString()
    if (response.status === 303) {
      method = "GET"
      body = undefined
    }
  }
  const bytes = await response.bytes()
  const responseHeaders = Object.fromEntries(response.headers)
  const text = () => new TextDecoder().decode(bytes)
  return {
    url: current,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    redirected: current !== String(input),
    headers: {
      get: (name: string) => responseHeaders[name.toLowerCase()] ?? null,
      has: (name: string) => name.toLowerCase() in responseHeaders,
      entries: () => Object.entries(responseHeaders),
    },
    text: async () => text(),
    json: async () => JSON.parse(text()) as unknown,
    bytes: async () => bytes,
  }
}

export const extension = Extension.make({ name: "web", globals: { fetch } })

/** What to show for a fetch call: its method and URL. */
export const display = (args: ReadonlyArray<unknown>) => {
  const [input, init] = args as [string | URL, Init | undefined]
  return { method: init?.method?.toUpperCase() ?? "GET", url: String(input) }
}
