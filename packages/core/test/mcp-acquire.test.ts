import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { McpAcquire } from "../src/mcp/acquire"
import type { Mcp } from "../src/mcp/index"
import { OrchestraTool } from "../src/tool/plugin/orchestra"

const info = (name: string, status: Mcp.Status): Mcp.ServerInfo => ({ name, status }) as Mcp.ServerInfo
const tool = (server: string, name: string) => ({ server, name }) as unknown as Mcp.Tool

const saved = { sentry: process.env["SENTRY_ACCESS_TOKEN"] }
afterEach(() => {
  if (saved.sentry === undefined) delete process.env["SENTRY_ACCESS_TOKEN"]
  else process.env["SENTRY_ACCESS_TOKEN"] = saved.sentry
})

describe("classify", () => {
  test("distinguishes unknown, missing-credential and not-installed servers", () => {
    delete process.env["SENTRY_ACCESS_TOKEN"]
    expect(McpAcquire.classify("nope", undefined, []).state).toBe("unavailable")
    // No catalog entry is platform-gated: a cross-platform entry classifies the same everywhere.
    expect(McpAcquire.classify("agent-desktop", undefined, [], "linux").state).toBe("not_installed")
    const auth = McpAcquire.classify("sentry", undefined, [])
    expect(auth.state).toBe("needs_auth")
    expect(auth.missing).toEqual(["SENTRY_ACCESS_TOKEN"])
    expect(McpAcquire.classify("context7", undefined, []).state).toBe("not_installed")
  })

  test("a connected server is healthy only when tools were actually discovered", () => {
    const connected = info("context7", { status: "connected" })
    expect(McpAcquire.classify("context7", connected, [tool("context7", "resolve")]).state).toBe("healthy")
    expect(McpAcquire.classify("context7", connected, []).state).toBe("degraded")
    expect(McpAcquire.classify("context7", connected, [tool("other", "x")]).state).toBe("degraded")
  })

  test("service statuses map to honest states", () => {
    expect(McpAcquire.classify("context7", info("context7", { status: "pending" }), []).state).toBe("configured")
    expect(McpAcquire.classify("context7", info("context7", { status: "disabled" }), []).state).toBe("disabled")
    expect(McpAcquire.classify("context7", info("context7", { status: "failed", error: "boom" }), []).state).toBe("failed")
    expect(McpAcquire.classify("context7", info("context7", { status: "needs_auth", error: "sign in" }), []).state).toBe(
      "needs_auth",
    )
  })
})

describe("select", () => {
  test("matches a capability need to catalog servers deterministically", () => {
    const browser = McpAcquire.select("browser automation")
    expect(browser.length).toBeGreaterThan(0)
    expect(["playwright", "chrome-devtools"]).toContain(browser[0]!.entry.id)
    expect(browser[0]!.reasons).toContain("browser")
    const docs = McpAcquire.select("library documentation")
    expect(docs.map((match) => match.entry.id)).toContain("context7")
    expect(McpAcquire.select("zzqqx nonexistent")).toEqual([])
    expect(McpAcquire.select("")).toEqual([])
    // Same need, same winner.
    expect(McpAcquire.select("browser automation")[0]!.entry.id).toBe(browser[0]!.entry.id)
  })

  test("one generic word is not a match; unicode needs tokenize safely", () => {
    // "use" appears in most catalog entries' usage lines, so
    // it discriminates nothing and must not drag a server in on its own.
    // A rare word may qualify alone: "browser" appears in only 2 entries.
    expect(McpAcquire.select("use")).toEqual([])
    expect(McpAcquire.select("when")).toEqual([])
    // Cyrillic tokenizes (no crash, no false match against the English catalog),
    // and a Latin name token inside a mixed-language need still matches by name.
    expect(McpAcquire.select("автоматизация браузера")).toEqual([])
    expect(McpAcquire.select("нужен playwright пожалуйста")[0]!.entry.id).toBe("playwright")
  })
})

describe("acquire ceiling (the role guard in front of acquisition)", () => {
  test("refuses servers outside the role's ceiling and allows the ones inside it", () => {
    const researcher = { name: "Researcher", tools: ["read", "context7_*", "playwright_*"] }
    expect(OrchestraTool.acquireCeiling(researcher, "playwright")).toBeUndefined()
    expect(OrchestraTool.acquireCeiling(researcher, "context7")).toBeUndefined()
    const refusal = OrchestraTool.acquireCeiling(researcher, "sentry")
    expect(refusal).toContain("may not use sentry")
    // `read` in the tool list implies the serena server (implied tools).
    expect(refusal).toContain("context7, playwright, serena")
    // A role without a tool boundary is unrestricted; a role with no MCP
    // tools at all is refused everything.
    expect(OrchestraTool.acquireCeiling({ name: "Open" }, "sentry")).toBeUndefined()
    expect(OrchestraTool.acquireCeiling({ name: "Notes", tools: [] }, "context7")).toContain("no MCP servers")
  })
})

/** A fake MCP service: add() registers a pending server, connect() settles it connected with tools. */
function fake(initial: Mcp.ServerInfo[] = [], settle: "connected" | "failed" = "connected") {
  const infos = new Map(initial.map((item) => [String(item.name), item]))
  const calls: string[] = []
  let tools: Mcp.Tool[] = initial.flatMap((item) =>
    item.status.status === "connected" ? [tool(String(item.name), "existing_tool")] : [],
  )
  const access: McpAcquire.Access = {
    servers: () => Effect.sync(() => [...infos.values()]),
    add: (server) =>
      Effect.sync(() => {
        calls.push(`add:${server}`)
        infos.set(server, info(server, { status: "pending" }))
      }),
    connect: (server) =>
      Effect.sync(() => {
        calls.push(`connect:${server}`)
        if (settle === "connected") {
          infos.set(server, info(server, { status: "connected" }))
          tools = [...tools, tool(server, "discovered_tool")]
        } else infos.set(server, info(server, { status: "failed", error: "did not start" }))
      }),
    tools: () => Effect.sync(() => tools),
  }
  return { access, calls }
}

describe("ensure", () => {
  test("reuses a healthy server without touching the service", async () => {
    const { access, calls } = fake([info("context7", { status: "connected" })])
    const result = await Effect.runPromise(McpAcquire.ensure(access, "context7"))
    expect(result.state).toBe("healthy")
    expect(result.action).toBe("reused")
    expect(result.tools).toEqual(["existing_tool"])
    expect(calls).toEqual([])
  })

  test("installs, connects and verifies a catalog server that is absent", async () => {
    const { access, calls } = fake()
    const result = await Effect.runPromise(McpAcquire.ensure(access, "context7"))
    expect(calls).toEqual(["add:context7", "connect:context7"])
    expect(result.action).toBe("installed")
    expect(result.state).toBe("healthy")
    expect(result.tools).toEqual(["discovered_tool"])
  })

  test("connects an installed server that is still starting", async () => {
    const { access, calls } = fake([info("context7", { status: "pending" })])
    const result = await Effect.runPromise(McpAcquire.ensure(access, "context7"))
    expect(calls).toEqual(["connect:context7"])
    expect(result.action).toBe("connected")
    expect(result.state).toBe("healthy")
  })

  test("never installs a server whose credentials are missing", async () => {
    delete process.env["SENTRY_ACCESS_TOKEN"]
    const { access, calls } = fake()
    const result = await Effect.runPromise(McpAcquire.ensure(access, "sentry"))
    expect(result.state).toBe("needs_auth")
    expect(result.action).toBe("none")
    expect(result.missing).toEqual(["SENTRY_ACCESS_TOKEN"])
    expect(calls).toEqual([])
  })

  test("never re-enables a disabled server or retries a failed one", async () => {
    const disabled = fake([info("context7", { status: "disabled" })])
    const off = await Effect.runPromise(McpAcquire.ensure(disabled.access, "context7"))
    expect(off.state).toBe("disabled")
    expect(off.action).toBe("none")
    expect(disabled.calls).toEqual([])

    const failed = fake([info("context7", { status: "failed", error: "boom" })])
    const out = await Effect.runPromise(McpAcquire.ensure(failed.access, "context7"))
    expect(out.state).toBe("failed")
    expect(out.action).toBe("none")
    expect(failed.calls).toEqual([])
  })

  test("reports a failed install honestly instead of claiming success", async () => {
    const { access } = fake([], "failed")
    const result = await Effect.runPromise(McpAcquire.ensure(access, "context7"))
    expect(result.action).toBe("installed")
    expect(result.state).toBe("failed")
    expect(result.detail).toContain("did not start")
  })

  test("a degraded server is reconnected once, not silently reused as working", async () => {
    let tools: Mcp.Tool[] = []
    const infos = new Map([["context7", info("context7", { status: "connected" })]])
    const calls: string[] = []
    const access: McpAcquire.Access = {
      servers: () => Effect.sync(() => [...infos.values()]),
      add: () => Effect.void,
      connect: (server) =>
        Effect.sync(() => {
          calls.push(`connect:${server}`)
          tools = [tool(server, "after_restart")]
        }),
      tools: () => Effect.sync(() => tools),
    }
    const result = await Effect.runPromise(McpAcquire.ensure(access, "context7"))
    expect(calls).toEqual(["connect:context7"])
    expect(result.action).toBe("connected")
    expect(result.state).toBe("healthy")
    expect(result.tools).toEqual(["after_restart"])
  })

  test("a server still toolless after reconnect is reported degraded, not healthy", async () => {
    const access: McpAcquire.Access = {
      servers: () => Effect.succeed([info("context7", { status: "connected" })]),
      add: () => Effect.void,
      connect: () => Effect.void,
      tools: () => Effect.succeed([]),
    }
    const result = await Effect.runPromise(McpAcquire.ensure(access, "context7"))
    expect(result.action).toBe("connected")
    expect(result.state).toBe("degraded")
    expect(result.tools).toEqual([])
  })

  test("a connect failure is preserved in the result instead of being swallowed", async () => {
    const access: McpAcquire.Access = {
      servers: () => Effect.succeed([info("context7", { status: "pending" })]),
      add: () => Effect.void,
      connect: () => Effect.fail(new Error("spawn npx ENOENT")),
      tools: () => Effect.succeed([]),
    }
    const result = await Effect.runPromise(McpAcquire.ensure(access, "context7"))
    expect(result.state).toBe("configured")
    expect(result.connectError).toContain("spawn npx ENOENT")
    expect(result.detail).toContain("spawn npx ENOENT")
  })
})
