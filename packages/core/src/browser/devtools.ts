export * as BrowserDevtools from "./devtools.js"

import type { Cdp } from "./cdp.js"

// What the BrowserAgent may see of the page's DevTools: JavaScript results, console lines, network requests, the
// names (never the values) of cookies and storage. Secrets are cut out before anything reaches the chat.

const LIMIT = 200

/** Cuts out what looks like a secret: bearer tokens, JWTs, long key-like strings, and password/token assignments. */
export function redact(text: string) {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[redacted jwt]")
    .replace(/\b(pass(?:word)?|pwd|secret|token|api[_-]?key|auth(?:orization)?|session(?:id)?|cookie)(["']?\s*[:=]\s*["']?)[^\s"',;&}]{3,}/gi, "$1$2[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted key]")
}

/** A URL with its query values hidden: the parameter names stay, tokens in them do not. */
export function safeUrl(raw: string) {
  try {
    const url = new URL(raw)
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "…")
    url.username = ""
    url.password = ""
    url.hash = ""
    return url.toString().slice(0, 300)
  } catch {
    return redact(raw).slice(0, 300)
  }
}

/**
 * Expressions the eval action refuses: reading cookies or storage, passwords and credentials, and sending data out
 * (network calls, forms). Those have their own safe actions or are not for the agent. A text filter is a guard
 * against mistakes, not a sandbox: the result is also redacted.
 */
const FORBIDDEN =
  /document\s*\.\s*cookie|localStorage|sessionStorage|indexedDB|cookieStore|type\s*=\s*["']?password|\.password\b|\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket\s*\(|EventSource\s*\(|\.submit\s*\(|requestSubmit|navigator\s*\.\s*credentials|credentials\.get/i

export function refuseExpression(expression: string): string | undefined {
  if (expression.trim() === "") return "eval needs an `expression`."
  if (FORBIDDEN.test(expression))
    return "That expression reads cookies, storage or passwords, or sends data out. Use the cookies and storage actions (names only), and ask the operator before anything that submits or sends."
  return undefined
}

export interface ConsoleLine {
  level: string
  text: string
}
export interface Request {
  id: string
  method: string
  url: string
  type?: string
  status?: number
  failed?: string
}

export interface Collector {
  console: ConsoleLine[]
  requests: Map<string, Request>
}

const collectors = new WeakMap<Cdp.Client, Collector>()

/** Starts recording console and network events of this connection, once. Only what happens after this is seen. */
export async function ensure(client: Cdp.Client): Promise<Collector> {
  const known = collectors.get(client)
  if (known) return known
  const collector: Collector = { console: [], requests: new Map() }
  collectors.set(client, collector)
  client.on("Runtime.consoleAPICalled", (event: { type?: string; args?: Array<{ value?: unknown; description?: string }> }) => {
    const text = (event.args ?? []).map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? ""))).join(" ")
    collector.console.push({ level: event.type ?? "log", text: redact(text).slice(0, 400) })
    if (collector.console.length > LIMIT) collector.console.shift()
  })
  client.on("Runtime.exceptionThrown", (event: { exceptionDetails?: { text?: string; exception?: { description?: string } } }) => {
    const text = event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "exception"
    collector.console.push({ level: "error", text: redact(text).slice(0, 400) })
    if (collector.console.length > LIMIT) collector.console.shift()
  })
  client.on("Network.requestWillBeSent", (event: { requestId: string; type?: string; request?: { method?: string; url?: string } }) => {
    collector.requests.set(event.requestId, {
      id: event.requestId,
      method: event.request?.method ?? "GET",
      url: safeUrl(event.request?.url ?? ""),
      type: event.type,
    })
    if (collector.requests.size > LIMIT) collector.requests.delete(collector.requests.keys().next().value as string)
  })
  client.on("Network.responseReceived", (event: { requestId: string; response?: { status?: number } }) => {
    const item = collector.requests.get(event.requestId)
    if (item) item.status = event.response?.status
  })
  client.on("Network.loadingFailed", (event: { requestId: string; errorText?: string }) => {
    const item = collector.requests.get(event.requestId)
    if (item) item.failed = event.errorText ?? "failed"
  })
  await client.send("Runtime.enable").catch(() => undefined)
  await client.send("Network.enable").catch(() => undefined)
  return collector
}

export function formatConsole(lines: readonly ConsoleLine[], count = 40) {
  const shown = lines.slice(-count)
  if (shown.length === 0)
    return "No console messages recorded since the browser tool connected. Reload the page or act, then ask again."
  return shown.map((line) => `[${line.level}] ${line.text}`).join("\n")
}

export function formatNetwork(requests: Iterable<Request>, count = 60) {
  const list = [...requests].slice(-count)
  if (list.length === 0)
    return "No requests recorded since the browser tool connected. Reload the page or act, then ask again."
  return list
    .map((item) => `${item.status ?? (item.failed ? "FAILED" : "pending")} ${item.method} ${item.url}${item.type ? ` (${item.type})` : ""}${item.failed ? ` - ${item.failed}` : ""}`)
    .join("\n")
}

/** Cookies by name, site and flags. Values are never listed. */
export function formatCookies(cookies: ReadonlyArray<{ name: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; session?: boolean }>) {
  if (cookies.length === 0) return "No cookies."
  return cookies
    .slice(0, 100)
    .map((item) => `${item.name} @ ${item.domain}${item.path ?? "/"}${item.secure ? " secure" : ""}${item.httpOnly ? " httpOnly" : ""}${item.session ? " session" : ""} (value hidden)`)
    .join("\n")
}

/** Script for the storage action: key names and value sizes of local and session storage, never the values. */
export const storageExpression = `(() => { const names = (s) => { try { return Object.keys(s).map((k) => k + ' (' + String(s.getItem(k) ?? '').length + ' chars)') } catch { return ['(not readable)'] } }; return { ok: true, text: 'localStorage:\\n' + (names(localStorage).join('\\n') || '(empty)') + '\\nsessionStorage:\\n' + (names(sessionStorage).join('\\n') || '(empty)') + '\\n(values hidden)' } })()`

/** Script for eval: runs the expression and returns its value as text; a promise is awaited. */
export function evalExpression(expression: string): Cdp.PageCall {
  return {
    functionDeclaration: `async function(expression) { try { const value = await (0, eval)(expression); let text; try { text = typeof value === 'string' ? value : JSON.stringify(value, (k, v) => typeof v === 'function' ? '[function]' : v instanceof Node ? '<' + v.nodeName.toLowerCase() + '>' : v) } catch { text = String(value) } return { ok: true, text: text === undefined ? 'undefined' : text } } catch (error) { return { ok: false, error: String(error && error.message || error) } } }`,
    arguments: [{ value: expression }],
  }
}
