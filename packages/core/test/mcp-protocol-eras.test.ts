import { describe, expect, test } from "bun:test"
import { SUPPORTED_PROTOCOL_VERSIONS, Server, createMcpHandler } from "@modelcontextprotocol/server"
import { ConfigMCP } from "@orchestra/schema/config/mcp"
import { McpClient } from "@orchestra/core/mcp/client"
import { Effect, Exit } from "effect"
import { hostEnvironmentLayer } from "./fixture/environment"

// MCP 2026-07-28 era negotiation (news run7, БРАТЬ №4): absent `protocol`
// is auto — probe with server/discover, fall back to the legacy initialize
// handshake when the server does not speak 2026-07-28. "legacy" skips the
// probe; "2026-07-28" pins the modern era and fails loudly otherwise.

type RecordedRequest = { readonly method: string | undefined; readonly headers: Headers }

const echoTool = {
  name: "echo",
  description: "Echoes the call back",
  inputSchema: { type: "object" as const, properties: {} },
}

const readMethod = async (request: { text(): Promise<string> }) => {
  const text = await request.text()
  try {
    return { text, method: (JSON.parse(text) as { method?: string }).method }
  } catch {
    return { text, method: undefined }
  }
}

async function serveModern(options?: { tasks?: boolean }) {
  const requests: RecordedRequest[] = []
  // A 2026-07-28 server is stateless and era-bound per request: the SDK's
  // session-generating transport rejects server/discover before initialize
  // with 400 ("Server not initialized"), and a plain Server answers the
  // probe with Method Not Found unless the transport binds the modern era.
  // The documented modern shape is createMcpHandler with a server factory:
  // it classifies each request and serves modern ones over a
  // PerRequestHTTPServerTransport (one Server instance per HTTP request).
  const makeServer = () => {
    const protocol = new Server(
      { name: "era-fixture", version: "1.2.3" },
      {
        capabilities: {
          tools: {},
          // Tasks are advertised through the extension on the modern era:
          // the legacy `tasks` key is dropped by the modern wire codec.
          ...(options?.tasks === true ? { extensions: { "io.modelcontextprotocol/tasks": { list: {} } } } : {}),
        },
        // A server only answers the discover probe with 2026-07-28 when the
        // revision is in its supported list; the default list is legacy-only
        // and the probe is rejected otherwise.
        supportedProtocolVersions: ["2026-07-28", ...SUPPORTED_PROTOCOL_VERSIONS],
      },
    )
    protocol.setRequestHandler("tools/list", () => Promise.resolve({ tools: [echoTool] }))
    protocol.setRequestHandler("tools/call", (request) =>
      Promise.resolve({ content: [{ type: "text", text: `ok:${request.params.name}` }] }),
    )
    return protocol
  }
  const handler = createMcpHandler(() => makeServer())
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      // The handler reads the body itself, so sniff the method off a clone.
      const { method } = await readMethod(request.clone())
      requests.push({ method, headers: request.headers })
      // Bun.serve overload inference lands on the undici Request type here, but
      // the runtime object is Bun's Request, which has the textStream the SDK
      // handler's own Request type requires.
      return handler.fetch(request as unknown as Parameters<typeof handler.fetch>[0])
    },
  })
  return {
    server,
    requests,
    stop: async () => {
      await handler.close()
      server.stop(true)
    },
  }
}

// A server that only speaks the 2025-11-25 wire: it answers server/discover
// with Method Not Found and runs the plain initialize handshake.
function serveLegacyOnly(options?: { tasks?: boolean }) {
  const requests: RecordedRequest[] = []
  const sessionID = crypto.randomUUID()
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { text, method } = await readMethod(request)
      requests.push({ method, headers: request.headers })
      let body: { id?: string | number; method?: string } | undefined
      try {
        body = JSON.parse(text) as { id?: string | number; method?: string }
      } catch {
        body = undefined
      }
      // Notifications carry no id and get an empty 202.
      if (body === undefined || body.id === undefined) return new Response(null, { status: 202 })
      const headers = { "mcp-session-id": sessionID }
      const result = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body?.id, result }, { headers })
      const error = (code: number, message: string) =>
        Response.json({ jsonrpc: "2.0", id: body?.id, error: { code, message } }, { headers })
      switch (body.method) {
        case "server/discover":
          return error(-32601, "Method not found")
        case "initialize":
          return result({
            protocolVersion: "2025-11-25",
            capabilities: { tools: {}, ...(options?.tasks === true ? { tasks: { list: {} } } : {}) },
            serverInfo: { name: "legacy-fixture", version: "0.9.0" },
          })
        case "tools/list":
          return result({ tools: [echoTool] })
        case "tools/call":
          return result({ content: [{ type: "text", text: "ok:echo" }], isError: false })
        case "ping":
          return result({})
        default:
          return error(-32601, `Method not found: ${body.method}`)
      }
    },
  })
  return { server, requests, stop: () => server.stop(true) }
}

const runConnected = <A>(
  url: string,
  protocol: ConfigMCP.Protocol | undefined,
  use: (connection: McpClient.Connection) => Effect.Effect<A, Error>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        McpClient.connect(
          "era-fixture",
          new ConfigMCP.Remote({
            type: "remote",
            url,
            oauth: false,
            ...(protocol === undefined ? {} : { protocol }),
          }),
          import.meta.dir,
          undefined,
          undefined,
          undefined,
          { allowPrivateUrl: true },
        ),
        use,
      ),
    ).pipe(Effect.provide(hostEnvironmentLayer)),
  )

const runConnectExit = (url: string, protocol: ConfigMCP.Protocol | undefined) =>
  Effect.runPromiseExit(
    Effect.scoped(
      McpClient.connect(
        "era-fixture",
        new ConfigMCP.Remote({
          type: "remote",
          url,
          oauth: false,
          ...(protocol === undefined ? {} : { protocol }),
        }),
        import.meta.dir,
        undefined,
        undefined,
        undefined,
        { allowPrivateUrl: true },
      ),
    ).pipe(Effect.provide(hostEnvironmentLayer)),
  )

const toolCallHeaders = (requests: ReadonlyArray<RecordedRequest>) => {
  const call = requests.find((request) => request.method === "tools/call")
  expect(call).toBeDefined()
  if (!call) throw new Error("no tools/call request recorded")
  return call.headers
}

describe("MCP protocol eras (2026-07-28)", () => {
  test("default config negotiates the modern era and mirrors method/name/version into headers", async () => {
    const fixture = await serveModern()
    try {
      const result = await runConnected(fixture.server.url.href, undefined, (connection) =>
        Effect.gen(function* () {
          expect(connection.modern).toBe(true)
          expect(connection.protocolVersion).toBe("2026-07-28")
          expect(connection.serverVersion).toEqual({ name: "era-fixture", version: "1.2.3" })
          expect(connection.supportsTasks).toBe(false)
          const tools = yield* connection.tools()
          expect(tools.map((tool) => tool.name)).toContain("echo")
          const called = yield* connection.callTool({ name: "echo", args: {} })
          expect(called.content).toEqual([{ type: "text", text: "ok:echo" }])
          return true
        }),
      )
      expect(result).toBe(true)
      // Б13: a modern request carries the method, the tool name and the
      // protocol version as HTTP headers, so a gateway can filter it
      // without parsing the JSON-RPC body.
      const headers = toolCallHeaders(fixture.requests)
      expect(headers.get("mcp-protocol-version")).toBe("2026-07-28")
      expect(headers.get("mcp-method")).toBe("tools/call")
      expect(headers.get("mcp-name")).toBe("echo")
    } finally {
      await fixture.stop()
    }
  })

  test("protocol legacy pins the initialize handshake against a modern server", async () => {
    const fixture = await serveModern()
    try {
      const result = await runConnected(fixture.server.url.href, "legacy", (connection) =>
        Effect.gen(function* () {
          expect(connection.modern).toBe(false)
          expect(connection.protocolVersion).toBe("2025-11-25")
          expect(connection.serverVersion).toEqual({ name: "era-fixture", version: "1.2.3" })
          const tools = yield* connection.tools()
          expect(tools.map((tool) => tool.name)).toContain("echo")
          const called = yield* connection.callTool({ name: "echo", args: {} })
          expect(called.content).toEqual([{ type: "text", text: "ok:echo" }])
          return true
        }),
      )
      expect(result).toBe(true)
      // Legacy traffic is byte-identical to a 2025 client: no Mcp-Method /
      // Mcp-Name mirroring headers, only the 2025 protocol-version header.
      const headers = toolCallHeaders(fixture.requests)
      expect(headers.get("mcp-method")).toBeNull()
      expect(headers.get("mcp-name")).toBeNull()
      expect(headers.get("mcp-protocol-version")).toBe("2025-11-25")
    } finally {
      await fixture.stop()
    }
  })

  test("auto falls back to legacy when the server answers server/discover with Method Not Found", async () => {
    const fixture = serveLegacyOnly()
    try {
      const result = await runConnected(fixture.server.url.href, undefined, (connection) =>
        Effect.gen(function* () {
          expect(connection.modern).toBe(false)
          expect(connection.protocolVersion).toBe("2025-11-25")
          expect(connection.serverVersion).toEqual({ name: "legacy-fixture", version: "0.9.0" })
          expect(connection.supportsTasks).toBe(false)
          const tools = yield* connection.tools()
          expect(tools.map((tool) => tool.name)).toContain("echo")
          const called = yield* connection.callTool({ name: "echo", args: {} })
          expect(called.content).toEqual([{ type: "text", text: "ok:echo" }])
          return true
        }),
      )
      expect(result).toBe(true)
      // The probe really ran: the client asked server/discover first and
      // only then fell back to initialize.
      expect(fixture.requests.some((request) => request.method === "server/discover")).toBe(true)
      expect(fixture.requests.some((request) => request.method === "initialize")).toBe(true)
      const headers = toolCallHeaders(fixture.requests)
      expect(headers.get("mcp-method")).toBeNull()
    } finally {
      fixture.stop()
    }
  })

  test("pinning 2026-07-28 fails loudly against a legacy-only server", async () => {
    const fixture = serveLegacyOnly()
    try {
      const exit = await runConnectExit(fixture.server.url.href, "2026-07-28")
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("2026-07-28")
    } finally {
      fixture.stop()
    }
  })

  test("supportsTasks reflects the advertised tasks extension on a modern server", async () => {
    const fixture = await serveModern({ tasks: true })
    try {
      const result = await runConnected(fixture.server.url.href, "auto", (connection) =>
        Effect.gen(function* () {
          expect(connection.modern).toBe(true)
          expect(connection.supportsTasks).toBe(true)
          return true
        }),
      )
      expect(result).toBe(true)
    } finally {
      await fixture.stop()
    }
  })

  test("supportsTasks reflects the legacy tasks capability on a legacy server", async () => {
    const fixture = serveLegacyOnly({ tasks: true })
    try {
      const result = await runConnected(fixture.server.url.href, "legacy", (connection) =>
        Effect.gen(function* () {
          expect(connection.modern).toBe(false)
          expect(connection.supportsTasks).toBe(true)
          return true
        }),
      )
      expect(result).toBe(true)
    } finally {
      fixture.stop()
    }
  })
})
