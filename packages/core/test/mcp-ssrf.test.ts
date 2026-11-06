import { describe, expect, test } from "bun:test"
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server"
import { ConfigMCP } from "@orchestra/schema/config/mcp"
import { McpClient } from "@orchestra/core/mcp/client"
import { McpOAuth } from "@orchestra/core/mcp/oauth"
import { Effect, Exit } from "effect"
import { hostEnvironmentLayer } from "./fixture/environment"

/**
 * The SSRF gate on remote MCP servers: a private or loopback URL is refused before any request
 * leaves the process, and only an explicit test-only opt-in connects to a loopback fixture.
 */
describe("MCP SSRF gate", () => {
  test("refuses a loopback server URL before any request reaches it", async () => {
    const requests: string[] = []
    const protocol = new Server({ name: "ssrf-fixture", version: "1.0.0" }, { capabilities: { tools: {} } })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    })
    await protocol.connect(transport)
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        requests.push(request.url)
        return transport.handleRequest(request)
      },
    })
    try {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          McpClient.connect(
            "ssrf-fixture",
            new ConfigMCP.Remote({ type: "remote", url: server.url.href, oauth: false }),
            import.meta.dir,
          ).pipe(Effect.provide(hostEnvironmentLayer)),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("Refusing to fetch")
        expect(String(exit.cause)).toContain("is a local address")
      }
      // The gate runs before the transport is built: the fixture never saw a request.
      expect(requests).toEqual([])
    } finally {
      await protocol.close().catch(() => {})
      server.stop(true)
    }
  })

  test("refuses the cloud metadata address without touching the network", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        McpClient.connect(
          "metadata",
          new ConfigMCP.Remote({ type: "remote", url: "http://169.254.169.254/latest/meta-data/", oauth: false }),
          import.meta.dir,
        ).pipe(Effect.provide(hostEnvironmentLayer)),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("Refusing to fetch")
  })

  test("the transport fetch refuses a private URL outright (T3-3 first hop)", async () => {
    const fetchFn = await Effect.runPromise(McpOAuth.loggedFetch({ server: "ssrf-fixture" }))
    await expect(fetchFn("http://169.254.169.254/latest/meta-data/")).rejects.toThrow("Refusing to fetch")
  })

  test("the transport fetch follows a same-origin redirect by hand but never re-sends a body cross-origin (T3-3)", async () => {
    const second = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = await request.text()
        return new Response(JSON.stringify({ sawBody: body }), { headers: { "content-type": "application/json" } })
      },
    })
    const first = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url)
        if (url.pathname === "/same")
          return new Response(null, { status: 302, headers: { location: "/final" } })
        if (url.pathname === "/final") return new Response(JSON.stringify({ ok: true }))
        if (url.pathname === "/cross")
          return new Response(null, { status: 307, headers: { location: `${second.url}token` } })
        return new Response("not found", { status: 404 })
      },
    })
    try {
      const fetchFn = await Effect.runPromise(
        McpOAuth.loggedFetch({ server: "redirect-fixture", allowPrivateUrl: true }),
      )
      const same = await fetchFn(`${first.url}same`)
      expect(same.status).toBe(200)
      expect(await same.json()).toEqual({ ok: true })
      // A 307 to another origin must not carry the token-exchange body (with its
      // client secret) with it — not even in the test-only loopback mode.
      await expect(
        fetchFn(`${first.url}cross`, {
          method: "POST",
          headers: { authorization: "Bearer sk-secret" },
          body: new URLSearchParams({ grant_type: "refresh_token", client_secret: "shh" }),
        }),
      ).rejects.toThrow("Refusing to follow a redirect")
    } finally {
      first.stop(true)
      second.stop(true)
    }
  })

  test("connects to a loopback server only with the explicit test opt-in", async () => {
    const protocol = new Server({ name: "ssrf-fixture", version: "1.0.0" }, { capabilities: { tools: {} } })
    protocol.setRequestHandler("tools/list", () => Promise.resolve({ tools: [] }))
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    })
    await protocol.connect(transport)
    const server = Bun.serve({ port: 0, fetch: (request) => transport.handleRequest(request) })
    try {
      const tools = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* McpClient.connect(
              "ssrf-fixture",
              new ConfigMCP.Remote({ type: "remote", url: server.url.href, oauth: false }),
              import.meta.dir,
              undefined,
              undefined,
              undefined,
              { allowPrivateUrl: true },
            ).pipe(Effect.provide(hostEnvironmentLayer))
            return yield* connection.tools()
          }),
        ),
      )
      expect(tools).toEqual([])
    } finally {
      await protocol.close().catch(() => {})
      server.stop(true)
    }
  })
})
