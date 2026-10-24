import { request as httpRequest } from "node:http"
import { isIP } from "node:net"
import { connect as tlsConnect } from "node:tls"

export type ProxyStatus = "unchecked" | "healthy" | "dead"
export type ProxyEntry = {
  id: string
  host: string
  port: number
  source: string
  status: ProxyStatus
  latencyMs?: number
  checkedAt?: number
  detail?: string
}
export type ProxySource = (typeof PROXY_SOURCES)[number]
export type ProxySourceResult = {
  name: string
  entries: ProxyEntry[]
  count: number
  error: string
}

export const PROXY_SOURCES = [
  // Recently verified HTTPS-capable HTTP proxies, sorted by measured speed by the upstream project.
  { name: "HTTPS-verified shortlist", url: "https://raw.githubusercontent.com/maximilianfeix/free-proxy-list/main/https.txt" },
  { name: "TheSpeedX", url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt" },
  { name: "monosans", url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt" },
  { name: "clarketm", url: "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt" },
  { name: "Proxifly", url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt" },
  { name: "jetkai", url: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt" },
] as const

const MAX_SOURCE_BYTES = 2_500_000
const MAX_POOL_SIZE = 12_000
const OPENCODE_HOST = "opencode.ai"
const OPENCODE_PATH = "/zen/v1/models"

/** OpenCode API compatibility check; this is a safe read-only model-list request, not an inference call. */
export const OPENCODE_PROBE = { host: OPENCODE_HOST, path: OPENCODE_PATH } as const

export function proxyUrl(entry: Pick<ProxyEntry, "host" | "port">) {
  return "http://" + entry.host + ":" + entry.port
}

/** Accept only IPv4 HTTP proxy endpoints; don't silently reinterpret SOCKS feeds as HTTP. */
export function parseHttpProxyList(input: string, source: string): ProxyEntry[] {
  const seen = new Set<string>()
  return input.split(/\r?\n/).flatMap((raw): ProxyEntry[] => {
    let line = raw.trim()
    if (!line || line.startsWith("#")) return []
    line = line.split(/\s+/)[0]
    if (line.toLowerCase().startsWith("http://")) line = line.slice(7)
    if (line.includes("://") || line.includes("/") || line.includes("@")) return []
    const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(line)
    if (!match || isIP(match[1]) !== 4) return []
    const port = Number(match[2])
    if (!Number.isInteger(port) || port < 1 || port > 65535) return []
    const id = match[1] + ":" + port
    if (seen.has(id)) return []
    seen.add(id)
    return [{ id, host: match[1], port, source, status: "unchecked" }]
  })
}

/** Fetch one source independently so the UI can show results while other sources are still downloading. */
export async function fetchHttpProxySource(source: ProxySource): Promise<ProxySourceResult> {
  try {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(12_000) })
    if (!response.ok) throw new Error("HTTP " + response.status)
    if (Number(response.headers.get("content-length") ?? 0) > MAX_SOURCE_BYTES) throw new Error("Source exceeds 2.5 MB")
    const content = await response.text()
    if (content.length > MAX_SOURCE_BYTES) throw new Error("Source exceeds 2.5 MB")
    const entries = parseHttpProxyList(content, source.name)
    return { name: source.name, entries, count: entries.length, error: "" }
  } catch (cause) {
    return {
      name: source.name,
      entries: [],
      count: 0,
      error: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

export async function loadHttpProxyPool() {
  const downloaded = await Promise.all(PROXY_SOURCES.map(fetchHttpProxySource))
  const unique = new Set<string>()
  const entries: ProxyEntry[] = []
  const maxLength = Math.max(0, ...downloaded.map((source) => source.entries.length))
  for (let index = 0; index < maxLength && entries.length < MAX_POOL_SIZE; index++) {
    for (const source of downloaded) {
      const entry = source.entries[index]
      if (!entry || unique.has(entry.id)) continue
      unique.add(entry.id)
      entries.push(entry)
      if (entries.length >= MAX_POOL_SIZE) break
    }
  }
  return {
    entries,
    sources: downloaded.map(({ name, count, error }) => ({ name, count, error })),
    total: entries.length,
  }
}

/**
 * Proxy is considered usable only when it completes CONNECT + verified TLS and the actual
 * OpenCode Zen models endpoint returns JSON. A working proxy for an unrelated site is not enough.
 */
export function probeHttpProxy(entry: ProxyEntry, timeoutMs = 5_000): Promise<ProxyEntry> {
  const started = performance.now()
  return new Promise((resolve) => {
    let settled = false
    let secureSocket: ReturnType<typeof tlsConnect> | undefined
    const request = httpRequest({
      hostname: entry.host,
      port: entry.port,
      method: "CONNECT",
      path: OPENCODE_HOST + ":443",
      headers: { Host: OPENCODE_HOST + ":443" },
      agent: false,
    })
    const timer = setTimeout(() => finish(false, "timeout"), timeoutMs)
    const finish = (ok: boolean, detail: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      secureSocket?.destroy()
      request.destroy()
      resolve({
        ...entry,
        status: ok ? "healthy" : "dead",
        latencyMs: Math.round(performance.now() - started),
        checkedAt: Date.now(),
        detail,
      })
    }
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        finish(false, "CONNECT " + String(response.statusCode ?? "failed"))
        return
      }
      if (head.length) socket.unshift(head)
      secureSocket = tlsConnect({ socket, servername: OPENCODE_HOST, rejectUnauthorized: true })
      secureSocket.once("secureConnect", () => {
        secureSocket?.write(
          "GET " + OPENCODE_PATH + " HTTP/1.1\r\n" +
          "Host: " + OPENCODE_HOST + "\r\n" +
          "Accept: application/json\r\n" +
          "Connection: close\r\n\r\n",
        )
      })
      let received = ""
      secureSocket.on("data", (chunk) => {
        received += chunk.toString("utf8")
        if (received.length > 32_768) {
          finish(false, "oversized OpenCode response")
          return
        }
        const headerEnd = received.indexOf("\r\n\r\n")
        if (headerEnd === -1) return
        const headers = received.slice(0, headerEnd)
        const statusLine = headers.split("\r\n", 1)[0]
        const match = /^HTTP\/1\.[01] (\d{3})\b/.exec(statusLine)
        if (!match) {
          finish(false, "invalid OpenCode response")
          return
        }
        const status = Number(match[1])
        const contentType = headers.split("\r\n").slice(1).find((line) => /^content-type:/i.test(line)) ?? ""
        if (status !== 200) {
          finish(false, "OpenCode API HTTP " + status)
          return
        }
        if (!/application\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) {
          finish(false, "OpenCode API did not return JSON")
          return
        }
        // TLS has validated opencode.ai and the actual API route returned HTTP 200 + JSON.
        finish(true, "OpenCode Zen API")
      })
      secureSocket.once("error", () => finish(false, "OpenCode TLS failed"))
    })
    request.once("response", (response) => finish(false, "unexpected proxy HTTP " + String(response.statusCode ?? "response")))
    request.once("error", (cause) => finish(false, cause instanceof Error ? cause.message.slice(0, 100) : "connection failed"))
    request.end()
  })
}

/** Call onResult as each proxy finishes, instead of waiting for an entire batch before updating the UI. */
export async function checkHttpProxies(
  entries: readonly ProxyEntry[],
  concurrency = 8,
  onResult?: (entry: ProxyEntry) => void,
) {
  const result = [...entries]
  let next = 0
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), entries.length) }, async () => {
    while (next < entries.length) {
      const index = next++
      result[index] = await probeHttpProxy(entries[index])
      onResult?.(result[index])
    }
  }))
  return result
}
