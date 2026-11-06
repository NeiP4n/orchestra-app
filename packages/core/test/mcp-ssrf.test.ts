import { describe, expect, test } from "bun:test"
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server"
import { ConfigMCP } from "@orchestra/schema/config/mcp"
import { McpClient } from "@orchestra/core/mcp/client"
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
