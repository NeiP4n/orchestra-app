import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { McpAcquire } from "../src/mcp/acquire"
import type { Mcp } from "../src/mcp/index"

const info = (name: string, status: Mcp.Status): Mcp.ServerInfo => ({ name, status }) as Mcp.ServerInfo
const tool = (server: string, name: string) => ({ server, name }) as unknown as Mcp.Tool

const saved = { brave: process.env["BRAVE_API_KEY"], sentry: process.env["SENTRY_ACCESS_TOKEN"] }
afterEach(() => {
  if (saved.brave === undefined) delete process.env["BRAVE_API_KEY"]
  else process.env["BRAVE_API_KEY"] = saved.brave
  if (saved.sentry === undefined) delete process.env["SENTRY_ACCESS_TOKEN"]
  else process.env["SENTRY_ACCESS_TOKEN"] = saved.sentry
})

describe("classify", () => {
  test("distinguishes unknown, wrong-platform, missing-credential and not-installed servers", () => {
    delete process.env["BRAVE_API_KEY"]
    expect(McpAcquire.classify("nope", undefined, []).state).toBe("unavailable")
    expect(McpAcquire.classify("windows", undefined, [], "linux").state).toBe("unavailable")
    const auth = McpAcquire.classify("brave-search", undefined, [])
    expect(auth.state).toBe("needs_auth")
    expect(auth.missing).toEqual(["BRAVE_API_KEY"])
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
    delete process.env["BRAVE_API_KEY"]
    const { access, calls } = fake()
    const result = await Effect.runPromise(McpAcquire.ensure(access, "brave-search"))
    expect(result.state).toBe("needs_auth")
    expect(result.action).toBe("none")
    expect(result.missing).toEqual(["BRAVE_API_KEY"])
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
})
