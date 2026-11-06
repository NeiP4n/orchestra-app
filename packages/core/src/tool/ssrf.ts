export * as Ssrf from "./ssrf.js"

import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { Effect } from "effect"

// A fetch that reaches a private address is a server-side request forgery: a page the model
// was told to read (or a redirect it followed) can otherwise probe the operator's LAN, the
// cloud metadata endpoint (169.254.169.254) or a service on localhost, and hand the answer
// back as ordinary tool output. This is the one shared gate for every outgoing URL in the
// app — webfetch, remote MCP servers, provider discovery, MCP Forge runtimes, Code Mode
// fetch, MCP OAuth discovery — not a webfetch-only helper. Every URL a caller touches —
// the requested one and every redirect target — must resolve to a public address first. DNS
// failures fail closed: a host that cannot be checked cannot be fetched, since a real fetch
// would fail on it anyway.
//
// Deliberately NOT blocked: 198.18.0.0/15 (benchmarking space — this sandbox's resolver
// answers public names from it) and the TEST-NET documentation ranges. The list below is
// the RFC 1918 / loopback / link-local / unique-local set the audit named, plus the
// unroutable space around it (0/8, CGNAT, multicast, reserved).

const BLOCKED_V4: ReadonlyArray<{ readonly octets: readonly number[]; readonly mask: number }> = [
  { octets: [0], mask: 8 },
  { octets: [10], mask: 8 },
  { octets: [100, 64], mask: 10 },
  { octets: [127], mask: 8 },
  { octets: [169, 254], mask: 16 },
  { octets: [172, 16], mask: 12 },
  { octets: [192, 168], mask: 16 },
  { octets: [224], mask: 4 },
  { octets: [240], mask: 4 },
] as const

const MAX_REDIRECTS = 5

/** True when a literal IP address is private, loopback, link-local or otherwise unroutable. */
export function isPrivateAddress(address: string): boolean {
  const clean = address.split("%", 1)[0] ?? address
  const family = isIP(clean)
  if (family === 4) return isPrivateIPv4(clean)
  if (family === 6) return isPrivateIPv6(clean)
  return false
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return BLOCKED_V4.some(({ octets, mask }) => {
    const value = (parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!
    const base =
      (octets[0]! << 24) | ((octets[1] ?? 0) << 16) | ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)
    const shift = 32 - mask
    return (value >> shift) === (base >> shift)
  })
}

function isPrivateIPv6(address: string): boolean {
  const lower = address.toLowerCase()
  if (lower === "::1" || lower === "::") return true
  // An IPv4 tail ( ::ffff:127.0.0.1, ::127.0.0.1 ) carries a v4 address: judge the tail.
  const tail = lower.split(":").at(-1)
  if (tail !== undefined && tail.includes(".")) return isPrivateIPv4(tail)
  const first = Number.parseInt(lower.split(":", 1)[0] ?? "", 16)
  if (!Number.isInteger(first)) return false
  // fe80::/10 link-local, fc00::/7 unique-local.
  return (first >= 0xfe80 && first <= 0xfebf) || (first >= 0xfc00 && first <= 0xfdff)
}

/** True when the hostname itself is local, before any DNS lookup. */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
}

/** A URL hostname keeps IPv6 literals in brackets (`[::1]`); the address itself has none. */
function literalHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
}

/**
 * Refuses a URL whose host is local or resolves to a private address, and returns the
 * parsed URL otherwise. Only http(s) URLs are fetchable; anything else is refused here
 * too, so a caller that only runs this check is still safe.
 */
export const assertPublicUrl = (input: string): Effect.Effect<URL, Error> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(input),
      catch: () => new Error(`Refusing to fetch ${input}: not a valid URL`),
    })
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return yield* Effect.fail(new Error("URL must use http:// or https://"))
    const host = url.hostname
    if (isBlockedHostname(host))
      return yield* Effect.fail(new Error(`Refusing to fetch ${input}: ${host} is a local address`))
    const literal = literalHost(host)
    if (isIP(literal) !== 0) {
      if (isPrivateAddress(literal))
        return yield* Effect.fail(new Error(`Refusing to fetch ${input}: ${host} is a private or loopback address`))
      return url
    }
    const resolved = yield* Effect.tryPromise({
      try: () => lookup(host, { all: true }),
      catch: () => new Error(`Refusing to fetch ${input}: could not resolve ${host}`),
    })
    const blocked = resolved.find((entry) => isPrivateAddress(entry.address))
    if (blocked)
      return yield* Effect.fail(
        new Error(`Refusing to fetch ${input}: ${host} resolves to a private address (${blocked.address})`),
      )
    return url
  })

/**
 * The same gate for plain async callers that do not run in an Effect (provider discovery, MCP
 * OAuth, Code Mode fetch). Rejects with the same "Refusing to fetch ..." error as the Effect.
 */
export const assertPublicUrlPromise = (input: string): Promise<URL> =>
  Effect.runPromise(assertPublicUrl(input))

/**
 * Synchronous half of the gate: refuses a non-http(s) URL, a local hostname, or a literal
 * private/loopback IP, without any DNS lookup. Use it where no async work is possible (sync
 * validation of a forged server spec or an OpenAPI base URL); a hostname that only resolves to a
 * private address still needs the full async `assertPublicUrl` before any fetch.
 */
export function assertPublicLiteralUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error(`Refusing to fetch ${input}: not a valid URL`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http:// or https://")
  if (isBlockedHostname(url.hostname))
    throw new Error(`Refusing to fetch ${input}: ${url.hostname} is a local address`)
  const literal = literalHost(url.hostname)
  if (isIP(literal) !== 0 && isPrivateAddress(literal))
    throw new Error(`Refusing to fetch ${input}: ${url.hostname} is a private or loopback address`)
  return url
}

export { MAX_REDIRECTS }
