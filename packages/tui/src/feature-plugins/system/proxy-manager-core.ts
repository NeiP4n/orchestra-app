import { request as httpRequest } from "node:http"
import { isIP } from "node:net"
import { connect as tlsConnect } from "node:tls"

export type ProxyStatus = "unchecked" | "healthy" | "limited" | "dead"
export type ProxyEntry = {
  id: string
  host: string
  port: number
  source: string
  exitIp?: string
  status: ProxyStatus
  latencyMs?: number
  checkedAt?: number
  detail?: string
  /** Consecutive healthy probes; any failed probe resets it to 0. */
  streak?: number
}
export type ProxySource = (typeof PROXY_SOURCES)[number]
export type ProxySourceResult = {
  name: string
  entries: ProxyEntry[]
  count: number
  error: string
}

// Ordered by the share of endpoints that passed the real CONNECT + TLS + Zen probe (sampled October 2026);
// the scan queue checks earlier sources first. Feeds that yielded nothing (clarketm, jetkai) were dropped.
export const PROXY_SOURCES = [
  { name: "ProxyScrape SSL", url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text&ssl=yes&timeout=5000" },
  { name: "ProxyScrape v2 SSL", url: "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=5000&country=all&ssl=yes&anonymity=all" },
  { name: "monosans", url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt" },
  { name: "hideip.me", url: "https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt" },
  { name: "elliottophellia", url: "https://raw.githubusercontent.com/elliottophellia/proxylist/master/results/http/global/http_checked.txt" },
  { name: "mmpx12", url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt" },
  { name: "dpangestuw", url: "https://raw.githubusercontent.com/dpangestuw/Free-Proxy/main/http_proxies.txt" },
  { name: "iplocate", url: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt" },
  { name: "Proxifly HTTP", url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt" },
] as const

const MAX_SOURCE_BYTES = 2_500_000
const MAX_POOL_SIZE = 12_000
const OPENCODE_HOST = "opencode.ai"
const OPENCODE_PATH = "/zen/v1/models"
const EGRESS_HOST = "api.ipify.org"
const EGRESS_PATH = "/?format=json"

/** The Zen probe is unauthenticated, so 401 means the endpoint is reachable—not that the proxy is dead. */
export const OPENCODE_PROBE = { host: OPENCODE_HOST, path: OPENCODE_PATH } as const
export const PROXY_EGRESS_PROBE = { host: EGRESS_HOST, path: EGRESS_PATH } as const

export function parseProxyExitIp(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
    const ip = (parsed as { ip?: unknown }).ip
    return typeof ip === "string" && isIP(ip) !== 0 ? ip : undefined
  } catch {
    return
  }
}

export function classifyZenProbe(statusCode: number, body: string): ProxyStatus {
  if (statusCode === 429 || /free tier counts requests per ip address|daily allowance.*ip|per ip address.*daily/i.test(body)) {
    return "limited"
  }
  // Zen requires credentials for model access. An unauthenticated 401 proves the HTTPS/API
  // route is reachable; the IP quota cannot be known without making a real authenticated inference.
  if (statusCode === 200 || statusCode === 401) return "healthy"
  return "dead"
}

/** Most consecutive passes first: free proxies mostly die within minutes, so survivors are the best bet. Latency breaks ties. */
export function byStability(a: ProxyEntry, b: ProxyEntry) {
  return (b.streak ?? 0) - (a.streak ?? 0) || (a.latencyMs ?? 999_999) - (b.latencyMs ?? 999_999)
}

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
    // Some feeds append a country label (`ip:port:Country`); a numeric suffix would be credentials, so reject it.
    const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})(?::[^\d:][^:]*)?$/.exec(line)
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
const MAX_PROBE_TIME_MS = 6_000
const MAX_PROBE_RESPONSE_BYTES = 1024 * 1024

function decodeChunkedBody(input: Buffer): Buffer | undefined {
  const parts: Buffer[] = []
  let offset = 0
  while (offset < input.length) {
    const lineEnd = input.indexOf("\r\n", offset)
    if (lineEnd < 0) return
    const sizeToken = input.toString("ascii", offset, lineEnd).split(";", 1)[0].trim()
    if (!/^[0-9a-f]+$/i.test(sizeToken)) return
    const size = Number.parseInt(sizeToken, 16)
    if (!Number.isSafeInteger(size) || size < 0) return
    offset = lineEnd + 2
    if (size === 0) {
      if (input.length >= offset + 2 && input.subarray(offset, offset + 2).equals(Buffer.from("\r\n"))) {
        return Buffer.concat(parts)
      }
      const trailerEnd = input.indexOf("\r\n\r\n", offset)
      if (trailerEnd < 0) return
      return Buffer.concat(parts)
    }
    if (input.length < offset + size + 2) return
    parts.push(input.subarray(offset, offset + size))
    offset += size
    if (!input.subarray(offset, offset + 2).equals(Buffer.from("\r\n"))) return
    offset += 2
  }
  return
}

type ProxyHttpsResponse = {
  statusCode: number
  headers: Record<string, string>
  body: Buffer
  latencyMs: number
}

/** Small raw HTTPS request through an HTTP CONNECT proxy, with strict origin TLS validation. */
function requestHttpsThroughProxy(
  entry: ProxyEntry,
  host: string,
  path: string,
  timeoutMs = MAX_PROBE_TIME_MS,
): Promise<ProxyHttpsResponse> {
  const started = performance.now()
  return new Promise((resolve, reject) => {
    let settled = false
    let secureSocket: ReturnType<typeof tlsConnect> | undefined
    const chunks: Buffer[] = []
    let receivedBytes = 0
    let responseEnded = false
    const request = httpRequest({
      hostname: entry.host,
      port: entry.port,
      method: "CONNECT",
      path: host + ":443",
      headers: { Host: host + ":443" },
      agent: false,
    })
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs)

    const finish = (error?: Error, response?: Omit<ProxyHttpsResponse, "latencyMs">) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      secureSocket?.destroy()
      request.destroy()
      if (error) reject(error)
      else if (response) resolve({ ...response, latencyMs: Math.round(performance.now() - started) })
      else reject(new Error("empty proxy response"))
    }

    const parseResponse = () => {
      const raw = Buffer.concat(chunks)
      const headerEnd = raw.indexOf(Buffer.from("\r\n\r\n"))
      if (headerEnd < 0) {
        if (responseEnded) finish(new Error("incomplete HTTP response headers"))
        return
      }
      const lines = raw.subarray(0, headerEnd).toString("latin1").split("\r\n")
      const match = /^HTTP\/1\.[01] (\d{3})\b/.exec(lines[0] ?? "")
      if (!match) {
        finish(new Error("invalid HTTP response status"))
        return
      }
      const headers: Record<string, string> = {}
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":")
        if (colon <= 0) continue
        const name = line.slice(0, colon).trim().toLowerCase()
        const value = line.slice(colon + 1).trim()
        headers[name] = headers[name] ? headers[name] + ", " + value : value
      }
      const body = raw.subarray(headerEnd + 4)
      let bodyBytes: Buffer | undefined
      if (/chunked/i.test(headers["transfer-encoding"] ?? "")) {
        bodyBytes = decodeChunkedBody(body)
        if (!bodyBytes && responseEnded) finish(new Error("incomplete chunked response"))
      } else if (headers["content-length"] !== undefined) {
        const length = Number(headers["content-length"])
        if (!Number.isSafeInteger(length) || length < 0) {
          finish(new Error("invalid content length"))
          return
        }
        if (body.length < length) {
          if (responseEnded) finish(new Error("truncated response body"))
          return
        }
        bodyBytes = body.subarray(0, length)
      } else {
        if (!responseEnded) return
        bodyBytes = body
      }
      if (bodyBytes) {
        finish(undefined, {
          statusCode: Number(match[1]),
          headers,
          body: bodyBytes,
        })
      }
    }

    request.once("connect", (response, socket, head) => {
      const status = response.statusCode ?? 0
      if (status < 200 || status >= 300) {
        socket.destroy()
        finish(new Error("CONNECT " + String(response.statusCode ?? "failed")))
        return
      }
      if (head.length) socket.unshift(head)
      secureSocket = tlsConnect({ socket, servername: host, rejectUnauthorized: true })
      secureSocket.once("secureConnect", () => {
        secureSocket?.write(
          "GET " + path + " HTTP/1.1\r\n" +
          "Host: " + host + "\r\n" +
          "Accept: application/json, text/plain, */*\r\n" +
          "Connection: close\r\n\r\n",
        )
      })
      secureSocket.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length
        if (receivedBytes > MAX_PROBE_RESPONSE_BYTES) {
          finish(new Error("oversized response"))
          return
        }
        chunks.push(Buffer.from(chunk))
        parseResponse()
      })
      secureSocket.once("end", () => {
        responseEnded = true
        parseResponse()
      })
      secureSocket.once("error", () => finish(new Error("TLS failed")))
      secureSocket.once("close", () => {
        if (!settled) {
          responseEnded = true
          parseResponse()
        }
      })
    })
    request.once("response", (response) => finish(new Error("unexpected proxy HTTP " + String(response.statusCode ?? "response"))))
    request.once("error", (cause) => finish(cause instanceof Error ? cause : new Error("connection failed")))
    request.end()
  })
}

/**
 * Test both the actual public egress IP and the Orchestra Zen endpoint. The Zen test is anonymous:
 * 401 is expected and means the route works; only the real per-IP allowance error is "limited".
 */
export async function probeHttpProxy(entry: ProxyEntry, timeoutMs = MAX_PROBE_TIME_MS): Promise<ProxyEntry> {
  const started = performance.now()
  try {
    const [egress, zen] = await Promise.all([
      requestHttpsThroughProxy(entry, EGRESS_HOST, EGRESS_PATH, timeoutMs),
      requestHttpsThroughProxy(entry, OPENCODE_HOST, OPENCODE_PATH, timeoutMs),
    ])
    const exitIp = parseProxyExitIp(egress.body.toString("utf8"))
    if (egress.statusCode !== 200 || !exitIp) {
      return {
        ...entry,
        status: "dead",
        latencyMs: Math.round(performance.now() - started),
        checkedAt: Date.now(),
        detail: "Could not verify public egress IP",
        streak: 0,
      }
    }
    const body = zen.body.toString("utf8")
    const status = classifyZenProbe(zen.statusCode, body)
    const detail = status === "limited"
      ? "Zen daily IP allowance appears exhausted"
      : status === "healthy" && zen.statusCode === 401
        ? "Orchestra reachable; authentication required; quota not tested"
        : status === "healthy"
          ? "Orchestra reachable; egress IP verified"
          : "Orchestra returned HTTP " + zen.statusCode
    return {
      ...entry,
      status,
      exitIp,
      latencyMs: Math.round(performance.now() - started),
      checkedAt: Date.now(),
      detail,
      streak: status === "healthy" ? (entry.streak ?? 0) + 1 : 0,
    }
  } catch (cause) {
    return {
      ...entry,
      status: "dead",
      latencyMs: Math.round(performance.now() - started),
      checkedAt: Date.now(),
      detail: cause instanceof Error ? cause.message.slice(0, 120) : "proxy check failed",
      streak: 0,
    }
  }
}

/** Call onResult as each proxy finishes, instead of waiting for an entire batch before updating the UI. */
export async function checkHttpProxies(
  entries: readonly ProxyEntry[],
  concurrency = 32,
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
