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

export const PROXY_SOURCES = [
  { name: "TheSpeedX", url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt" },
  { name: "monosans", url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt" },
  { name: "clarketm", url: "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt" },
  { name: "Proxifly", url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt" },
  { name: "jetkai", url: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt" },
] as const

const MAX_SOURCE_BYTES = 2_500_000
const MAX_POOL_SIZE = 12_000

export function proxyUrl(entry: Pick<ProxyEntry, "host" | "port">) {
  return "http://" + entry.host + ":" + entry.port
}

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

export async function loadHttpProxyPool() {
  const downloaded = await Promise.all(PROXY_SOURCES.map(async (source) => {
    try {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(12_000) })
      if (!response.ok) throw new Error("HTTP " + response.status)
      if (Number(response.headers.get("content-length") ?? 0) > MAX_SOURCE_BYTES) throw new Error("Source exceeds 2.5 MB")
      const content = await response.text()
      if (content.length > MAX_SOURCE_BYTES) throw new Error("Source exceeds 2.5 MB")
      const entries = parseHttpProxyList(content, source.name)
      return { name: source.name, entries, count: entries.length, error: "" }
    } catch (cause) {
      return { name: source.name, entries: [] as ProxyEntry[], count: 0, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }))
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

export function probeHttpProxy(entry: ProxyEntry, timeoutMs = 4_000): Promise<ProxyEntry> {
  const started = performance.now()
  return new Promise((resolve) => {
    let settled = false
    let secureSocket: ReturnType<typeof tlsConnect> | undefined
    const request = httpRequest({
      hostname: entry.host,
      port: entry.port,
      method: "CONNECT",
      path: "www.cloudflare.com:443",
      headers: { Host: "www.cloudflare.com:443" },
      agent: false,
    })
    const timer = setTimeout(() => finish(false, "timeout"), timeoutMs)
    const finish = (ok: boolean, detail: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      secureSocket?.destroy()
      request.destroy()
      resolve({ ...entry, status: ok ? "healthy" : "dead", latencyMs: Math.round(performance.now() - started), checkedAt: Date.now(), detail })
    }
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        finish(false, "CONNECT " + String(response.statusCode ?? "failed"))
        return
      }
      if (head.length) socket.unshift(head)
      secureSocket = tlsConnect({ socket, servername: "www.cloudflare.com", rejectUnauthorized: true })
      secureSocket.once("secureConnect", () => secureSocket?.write("GET /cdn-cgi/trace HTTP/1.1\r\nHost: www.cloudflare.com\r\nConnection: close\r\n\r\n"))
      let received = ""
      secureSocket.on("data", (chunk) => {
        received += chunk.toString("utf8")
        if (received.length > 16_384) {
          finish(false, "oversized response")
          return
        }
        const match = /^HTTP\/1\.[01] (\d{3})\b/.exec(received.split("\r\n", 1)[0])
        if (!match) return
        const status = Number(match[1])
        finish(status >= 200 && status < 400, "HTTPS " + status)
      })
      secureSocket.once("error", () => finish(false, "TLS failed"))
    })
    request.once("response", (response) => finish(false, "unexpected HTTP " + String(response.statusCode ?? "response")))
    request.once("error", (cause) => finish(false, cause instanceof Error ? cause.message.slice(0, 100) : "connection failed"))
    request.end()
  })
}

export async function checkHttpProxies(entries: readonly ProxyEntry[], concurrency = 12) {
  const result = [...entries]
  let next = 0
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), entries.length) }, async () => {
    while (next < entries.length) {
      const index = next++
      result[index] = await probeHttpProxy(entries[index])
    }
  }))
  return result
}
