import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import net from "node:net"
import { ProxyEnvironment } from "../src/proxy-environment"

const servers: net.Server[] = []

/** Starts a local relay that answers CONNECT with `status` and returns its URL. */
async function relay(status: number) {
  const server = net.createServer((socket) => {
    socket.on("data", () => {
      socket.write(`HTTP/1.1 ${status} ${status === 200 ? "Connection Established" : "Service Unavailable"}\r\n\r\n`)
      if (status === 200) socket.pause()
      else socket.end()
    })
    socket.on("error", () => {})
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as net.AddressInfo
  return `http://127.0.0.1:${address.port}`
}

/** A port nothing listens on, so the connection is refused. */
async function closedEndpoint() {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${address.port}`
}

afterAll(() => {
  for (const server of servers) server.close()
})

describe("ProxyEnvironment.variables", () => {
  test("keeps the captured environment when the config has no proxy", () => {
    expect(
      ProxyEnvironment.variables(undefined, {
        HTTP_PROXY: "http://initial:1",
        http_proxy: "http://initial:1",
        HTTPS_PROXY: undefined,
        https_proxy: undefined,
        NO_PROXY: "localhost",
        no_proxy: "localhost",
      }),
    ).toEqual({ HTTP_PROXY: "http://initial:1", http_proxy: "http://initial:1", NO_PROXY: "localhost", no_proxy: "localhost" })
  })

  test("writes the configured relay into both spellings", () => {
    expect(
      ProxyEnvironment.variables(
        { http: "http://relay:3128", https: "http://relay:3128", no_proxy: ["localhost", "127.0.0.1"] },
        {},
      ),
    ).toEqual({
      HTTP_PROXY: "http://relay:3128",
      http_proxy: "http://relay:3128",
      HTTPS_PROXY: "http://relay:3128",
      https_proxy: "http://relay:3128",
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
    })
  })

  test("treats a relay with no endpoints as no proxy at all", () => {
    expect(ProxyEnvironment.settings({})).toBeUndefined()
    expect(ProxyEnvironment.variables({}, {})).toEqual({})
  })
})

describe("ProxyEnvironment.probe", () => {
  test("accepts a relay that completes the tunnel", async () => {
    const endpoint = await relay(200)
    expect(await Effect.runPromise(ProxyEnvironment.probe(endpoint))).toBe(true)
  })

  test("rejects a relay that refuses the tunnel", async () => {
    const endpoint = await relay(503)
    expect(await Effect.runPromise(ProxyEnvironment.probe(endpoint))).toBe(false)
  })

  test("rejects an address nothing listens on", async () => {
    const endpoint = await closedEndpoint()
    expect(await Effect.runPromise(ProxyEnvironment.probe(endpoint, { timeoutMs: 500 }))).toBe(false)
  })

  test("rejects a value that is not a URL with a port", async () => {
    expect(await Effect.runPromise(ProxyEnvironment.probe("not a proxy"))).toBe(false)
    expect(await Effect.runPromise(ProxyEnvironment.probe("http://relay.example"))).toBe(false)
  })
})

describe("ProxyEnvironment.firstReachable", () => {
  test("skips a dead relay and returns the working one", async () => {
    const dead = await relay(503)
    const working = await relay(200)
    expect(await Effect.runPromise(ProxyEnvironment.firstReachable({ http: dead, https: working }))).toBe(working)
  })
})

describe("ProxyEnvironment.resolve", () => {
  test("applies a relay that answers", async () => {
    const endpoint = await relay(200)
    const resolution = await Effect.runPromise(ProxyEnvironment.resolve({ http: endpoint, https: endpoint }))
    expect(resolution.applied).toBe(true)
    expect(resolution.endpoint).toBe(endpoint)
    expect(resolution.value.HTTPS_PROXY).toBe(endpoint)
  })

  test("falls back to a direct connection when the relay is dead", async () => {
    const dead = await closedEndpoint()
    const resolution = await Effect.runPromise(ProxyEnvironment.resolve({ http: dead, https: dead }, { timeoutMs: 500 }))
    expect(resolution.applied).toBe(false)
    expect(resolution.value.HTTPS_PROXY).toBeUndefined()
    expect(resolution.value.HTTP_PROXY).toBeUndefined()
  })

  test("has nothing to resolve without a proxy", async () => {
    const resolution = await Effect.runPromise(ProxyEnvironment.resolve(undefined))
    expect(resolution.applied).toBe(false)
  })
})

describe("ProxyEnvironment.write", () => {
  test("removes variables the resolution does not mention", () => {
    process.env.ORCHESTRA_PROXY_PROBE_TEST = "1"
    const previous = process.env.HTTPS_PROXY
    process.env.HTTPS_PROXY = "http://stale:1"
    ProxyEnvironment.write({ HTTP_PROXY: "http://fresh:1", http_proxy: "http://fresh:1" })
    expect(process.env.HTTP_PROXY).toBe("http://fresh:1")
    expect(process.env.HTTPS_PROXY).toBeUndefined()
    if (previous === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = previous
    delete process.env.ORCHESTRA_PROXY_PROBE_TEST
  })
})
