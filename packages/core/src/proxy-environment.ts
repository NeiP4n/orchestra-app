export * as ProxyEnvironment from "./proxy-environment.js"

import type { ConfigProxy } from "@orchestra/schema/config/proxy"
import { Effect } from "effect"
import net from "node:net"

/** Proxy variables captured before any config file could change them. */
export const initial = {
  HTTP_PROXY: process.env.HTTP_PROXY,
  http_proxy: process.env.http_proxy,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  https_proxy: process.env.https_proxy,
  NO_PROXY: process.env.NO_PROXY,
  no_proxy: process.env.no_proxy,
}

export type Initial = typeof initial

/** Variables written for a proxy config, or the captured initial state when there is none. */
export type Variables = Partial<Record<keyof Initial, string>>

/** The proxy a config document declares, without the networking details. */
export interface Settings {
  readonly http?: string
  readonly https?: string
  readonly no_proxy?: readonly string[]
}

export interface Options {
  /** Probe timeout; a proxy that does not answer in time is treated as unavailable. */
  readonly timeoutMs?: number
  /** Target used for the CONNECT probe. */
  readonly target?: string
  /**
   * Tunnels opened before a relay counts as usable. A relay at its connection limit
   * accepts one handshake and refuses the next, so one success proves nothing.
   */
  readonly attempts?: number
}

const TARGET = "models.dev:443"
const TIMEOUT = 2_000
/** Skip probing entirely; a configured proxy is then always applied as written. */
const DISABLE = process.env.ORCHESTRA_PROXY_PROBE === "0"

export function settings(proxy: Settings | undefined): Settings | undefined {
  if (!proxy) return undefined
  if (!proxy.http && !proxy.https) return undefined
  return proxy
}

/**
 * Proxy variables for a config document. `undefined` keeps the connection direct:
 * a proxy whose endpoints are all empty is the same as no proxy at all.
 */
export function variables(proxy: Settings | undefined, captured: Partial<Initial> = initial): Variables {
  const selected = settings(proxy)
  const value: Variables = {}
  if (!selected) {
    for (const [name, item] of Object.entries(captured) as Array<[keyof Initial, string | undefined]>) {
      if (item !== undefined) value[name] = item
    }
    return value
  }
  const http = selected.http ?? captured.HTTP_PROXY ?? captured.http_proxy
  const https = selected.https ?? captured.HTTPS_PROXY ?? captured.https_proxy
  const noProxy = selected.no_proxy?.join(",") ?? captured.NO_PROXY ?? captured.no_proxy
  if (http !== undefined) {
    value.HTTP_PROXY = http
    value.http_proxy = http
  }
  if (https !== undefined) {
    value.HTTPS_PROXY = https
    value.https_proxy = https
  }
  if (noProxy !== undefined) {
    value.NO_PROXY = noProxy
    value.no_proxy = noProxy
  }
  return value
}

/** Replaces every proxy variable with `value`, removing the ones it does not mention. */
export function write(value: Variables) {
  for (const name of Object.keys(initial) as Array<keyof Initial>) {
    const next = value[name]
    if (next) process.env[name] = next
    else delete process.env[name]
  }
}

function endpoints(proxy: Settings): string[] {
  return [...new Set([proxy.https, proxy.http].filter((item): item is string => !!item))]
}

/**
 * A proxy answers when it completes a CONNECT tunnel to `target`. A plain TCP
 * handshake is not enough: a proxy can accept connections and still refuse the
 * tunnel (503), which would poison every request made through it.
 */
export function probe(endpoint: string, options: Options = {}): Effect.Effect<boolean> {
  const timeout = options.timeoutMs ?? TIMEOUT
  return Effect.promise(
    () =>
      new Promise<boolean>((resolve) => {
        let url: URL
        try {
          url = new URL(endpoint)
        } catch {
          resolve(false)
          return
        }
        if (!url.hostname || !url.port) {
          resolve(false)
          return
        }
        const socket = net.connect({ host: url.hostname, port: Number(url.port) })
        let settled = false
        const finish = (result: boolean) => {
          if (settled) return
          settled = true
          socket.destroy()
          resolve(result)
        }
        socket.setTimeout(timeout, () => finish(false))
        socket.on("error", () => finish(false))
        socket.on("close", () => finish(false))
        socket.on("connect", () => {
          const authorization = url.username
            ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}\r\n`
            : ""
          socket.write(`CONNECT ${options.target ?? TARGET} HTTP/1.1\r\nHost: ${options.target ?? TARGET}\r\n${authorization}\r\n`)
        })
        socket.on("data", (chunk) => {
          const status = /^HTTP\/1\.[01] (\d{3})/.exec(chunk.toString("latin1"))?.[1]
          if (status === undefined) return
          finish(Number(status) >= 200 && Number(status) < 300)
        })
      }),
  )
}

/** Probes every endpoint in order and returns the first one that answers every attempt. */
export function firstReachable(proxy: Settings, options: Options = {}): Effect.Effect<string | undefined> {
  const attempts = Math.max(1, options.attempts ?? 3)
  return Effect.gen(function* () {
    for (const endpoint of endpoints(proxy)) {
      let usable = true
      for (let attempt = 0; attempt < attempts && usable; attempt++) {
        usable = yield* probe(endpoint, options)
      }
      if (usable) return endpoint
    }
    return undefined
  })
}

/** Result of resolving a document for the process environment. */
export interface Resolution {
  readonly applied: boolean
  readonly endpoint?: string
  readonly value: Variables
}

/**
 * Resolves the proxy a config declares into process variables, falling back to a
 * direct connection when the proxy does not answer. A dead relay in a config file
 * must not take the catalog, MCP servers and OAuth refresh down with it.
 */
export const resolve = Effect.fn("ProxyEnvironment.resolve")(function* (
  proxy: Settings | undefined,
  options: Options = {},
) {
  const selected = settings(proxy)
  if (!selected) return { applied: false, value: variables(undefined) } satisfies Resolution
  if (DISABLE) return { applied: true, value: variables(selected) } satisfies Resolution
  const endpoint = yield* firstReachable(selected, options)
  if (endpoint === undefined) {
    yield* Effect.logWarning("configured proxy is unreachable; using a direct connection", {
      endpoints: endpoints(selected),
    })
    return { applied: false, value: variables(undefined) } satisfies Resolution
  }
  return { applied: true, endpoint, value: variables({ ...selected, http: endpoint, https: endpoint }) } satisfies Resolution
})

let cached: { key: string; resolution: Resolution } | undefined
let cachedAt = 0
const CACHE_TTL = 60_000

/** Resolves and writes process variables, probing the same proxy at most once a minute. */
export const apply = Effect.fn("ProxyEnvironment.apply")(function* (
  proxy: Settings | undefined,
  options: Options = {},
) {
  const key = JSON.stringify(settings(proxy) ?? null)
  const now = Date.now()
  if (cached && cached.key === key && now - cachedAt < CACHE_TTL) {
    write(cached.resolution.value)
    return cached.resolution
  }
  const resolution = yield* resolve(proxy, options)
  cached = { key, resolution }
  cachedAt = now
  write(resolution.value)
  return resolution
})

export type { ConfigProxy }
