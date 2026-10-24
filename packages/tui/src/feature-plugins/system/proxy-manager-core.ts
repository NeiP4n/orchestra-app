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
const MAX_PROBE_TIME_MS = 2_500
const MAX_PROBE_RESPONSE_BYTES = 32_768

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

/**
 * A proxy is healthy only after the complete Zen model-list response arrives and parses as JSON.
 * The total deadline includes CONNECT, TLS, headers and body; headers-only checks let stalled
 * public relays look healthy even though actual OpenCode requests then hang indefinitely.
 */
export function probeHttpProxy(entry: ProxyEntry, timeoutMs = MAX_PROBE_TIME_MS): Promise<ProxyEntry> {
  const started = performance.now()
  return new Promise((resolve) => {
    let settled = false
    let secureSocket: ReturnType<typeof tlsConnect> | undefined
    const chunks: Buffer[] = []
    let receivedBytes = 0
    const request = httpRequest({
      hostname: entry.host,
      port: entry.port,
      method: "CONNECT",
      path: OPENCODE_HOST + ":443",
      headers: { Host: OPENCODE_HOST + ":443" },
      agent: false,
    })

    const timer = setTimeout(() => finish(false, "Zen API timed out"), timeoutMs)
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

    const validateResponse = () => {
      const raw = Buffer.concat(chunks)
      const headerEnd = raw.indexOf(Buffer.from("\r\n\r\n"))
      if (headerEnd < 0) {
        finish(false, "incomplete Zen API headers")
        return
      }
      const headers = raw.subarray(0, headerEnd).toString("latin1").split("\r\n")
      const match = /^HTTP\/1\.[01] (\d{3})\b/.exec(headers[0] ?? "")
      if (!match) {
        finish(false, "invalid Zen API status")
        return
      }
      const status = Number(match[1])
      if (status !== 200) {
        finish(false, "Zen API HTTP " + status)
        return
      }
      const contentType = headers.slice(1).find((line) => /^content-type:/i.test(line)) ?? ""
      if (!/application\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) {
        finish(false, "Zen API did not return JSON")
        return
      }

      const body = raw.subarray(headerEnd + 4)
      const transferEncoding = headers.find((line) => /^transfer-encoding:/i.test(line)) ?? ""
      const contentLengthHeader = headers.find((line) => /^content-length:/i.test(line))
      const contentLength = contentLengthHeader ? Number(contentLengthHeader.split(":", 2)[1].trim()) : undefined
      let bodyBytes: Buffer | undefined
      if (/chunked/i.test(transferEncoding)) bodyBytes = decodeChunkedBody(body)
      else if (contentLength !== undefined && Number.isSafeInteger(contentLength) && contentLength >= 0) {
        if (body.length < contentLength) return // A Content-Length response is still in flight.
        bodyBytes = body.subarray(0, contentLength)
      } else {
        bodyBytes = body
      }
      if (!bodyBytes?.length) return
      try {
        const parsed: unknown = JSON.parse(bodyBytes.toString("utf8"))
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          finish(false, "invalid Zen API JSON body")
          return
        }
        finish(true, "complete Zen API response")
      } catch {
        // A partial JSON body can arrive over multiple TCP chunks; wait for more until the deadline.
        if (settled) return
      }
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
      secureSocket.on("data", (chunk) => {
        receivedBytes += chunk.length
        if (receivedBytes > MAX_PROBE_RESPONSE_BYTES) {
          finish(false, "oversized Zen API response")
          return
        }
        chunks.push(Buffer.from(chunk))
        validateResponse()
      })
      secureSocket.once("end", () => validateResponse())
      secureSocket.once("error", () => finish(false, "Zen API TLS failed"))
      secureSocket.once("close", () => {
        if (!settled) validateResponse()
      })
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
