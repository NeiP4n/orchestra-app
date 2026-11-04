import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { McpCatalog } from "../src/mcp/catalog"
import { McpLifecycle } from "../src/mcp/lifecycle"
import type { Mcp } from "../src/mcp/index"
import type { ServerConfig } from "@orchestra/schema/mcp"

const local = (command: string[], extra?: Partial<Extract<ServerConfig, { type: "local" }>>): ServerConfig =>
  ({ type: "local", command, ...extra }) as ServerConfig

const catalogConfig = (id: string): ServerConfig => McpCatalog.all.find((entry) => entry.id === id)!.config

interface Runtime {
  status: Mcp.ServerInfo["status"]
  tools: string[]
}

function fake(init: { global?: Record<string, ServerConfig>; other?: Record<string, ServerConfig> } = {}) {
  const global = new Map(Object.entries(init.global ?? {}))
  const other = new Map(Object.entries(init.other ?? {}))
  const kv = new Map<string, Schema.Json>()
  const runtime = new Map<string, Runtime>()
  const calls: string[] = []
  const updates: Array<Record<string, ServerConfig | null>> = []

  const configured = () => Object.fromEntries([...global, ...other]) as Record<string, ServerConfig>
  for (const [name, config] of Object.entries(configured())) {
    if (config.disabled !== true) runtime.set(name, { status: { status: "connected" }, tools: [`${name}_tool`] })
  }

  const access: McpLifecycle.Access = {
    configured: () => Effect.sync(configured),
    globalConfigured: () => Effect.sync(() => Object.fromEntries(global)),
    update: (patch) =>
      Effect.sync(() => {
        updates.push(patch)
        for (const [name, value] of Object.entries(patch)) {
          if (value === null) global.delete(name)
          if (value !== null) global.set(name, value)
        }
      }),
    servers: () =>
      Effect.sync(() =>
        [...runtime].map(([name, entry]) => ({ name: name as Mcp.ServerInfo["name"], status: entry.status })),
      ),
    tools: () =>
      Effect.sync(() =>
        [...runtime].flatMap(([server, entry]) =>
          entry.status.status === "connected"
            ? entry.tools.map((name) => ({ server: server as Mcp.Tool["server"], name }) as Mcp.Tool)
            : [],
        ),
      ),
    add: (server, config) =>
      Effect.sync(() => {
        calls.push(`add:${server}`)
        global.set(server, config)
        if (config.disabled !== true) runtime.set(server, { status: { status: "pending" }, tools: [] })
      }),
    connect: (server) =>
      Effect.sync(() => {
        calls.push(`connect:${server}`)
        runtime.set(server, { status: { status: "connected" }, tools: [`${server}_tool`] })
      }),
    disconnect: (server) =>
      Effect.sync(() => {
        calls.push(`disconnect:${server}`)
        const entry = runtime.get(server)
        if (entry) entry.status = { status: "disabled" }
      }),
    removeRuntime: (server) =>
      Effect.sync(() => {
        calls.push(`removeRuntime:${server}`)
        runtime.delete(server)
      }),
    kvGet: (key) => Effect.sync(() => kv.get(key)),
    kvSet: (key, value) => Effect.sync(() => void kv.set(key, value)),
    kvRemove: (key) => Effect.sync(() => void kv.delete(key)),
  }
  return { access, global, kv, runtime, calls, updates }
}

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect)

describe("default-off migration", () => {
  test("disables every enabled global server once, preserving its configuration", async () => {
    const { access, global, updates } = fake({
      global: {
        context7: catalogConfig("context7"),
        custom: local(["my-server"], { environment: { TOKEN: "kept" }, disabled: false }),
        already: local(["off"], { disabled: true }),
      },
    })
    const first = await run(McpLifecycle.migrateDefaultOff(access))
    expect(first.alreadyApplied).toBe(false)
    expect(first.disabled.toSorted()).toEqual(["context7", "custom"])
    // One write, both servers, configuration intact apart from the flag.
    expect(updates).toHaveLength(1)
    expect(global.get("custom")).toMatchObject({ command: ["my-server"], environment: { TOKEN: "kept" }, disabled: true })
    expect(global.get("context7")?.disabled).toBe(true)
    expect(global.get("already")?.disabled).toBe(true)

    // Idempotent: a second pass (and a restart over the same stores) is a no-op.
    const second = await run(McpLifecycle.migrateDefaultOff(access))
    expect(second.alreadyApplied).toBe(true)
    expect(updates).toHaveLength(1)
  })

  test("project-defined servers are not rewritten by the global migration", async () => {
    const { access, updates } = fake({ other: { projectone: local(["proj"]) } })
    const result = await run(McpLifecycle.migrateDefaultOff(access))
    expect(result.disabled).toEqual([])
    expect(updates).toHaveLength(0)
  })
})

describe("ownership", () => {
  test("untouched catalog installs are Orchestra-managed; everything else is user-managed", () => {
    expect(McpLifecycle.originOf("context7", catalogConfig("context7"))).toBe("orchestra")
    const customized = { ...catalogConfig("context7") } as Extract<ServerConfig, { type: "local" }>
    expect(
      McpLifecycle.originOf("context7", { ...customized, environment: { EXTRA: "1" } }),
    ).toBe("user")
    expect(McpLifecycle.originOf("context7", local(["different"]))).toBe("user")
    expect(McpLifecycle.originOf("my-own", local(["mine"]))).toBe("user")
  })
})

describe("enable and disable", () => {
  test("enable persistently enables and verifies discovered tools", async () => {
    const { access, global, runtime } = fake({ global: { context7: { ...catalogConfig("context7"), disabled: true } } })
    runtime.delete("context7")
    const outcome = await run(McpLifecycle.enable(access, "context7"))
    expect(outcome.ok).toBe(true)
    expect(outcome.state).toBe("healthy")
    expect(outcome.tools).toEqual(["context7_tool"])
    expect(global.get("context7")?.disabled).toBe(false)
  })

  test("disable is blocked by another task's lease and by an operator pin", async () => {
    const { access } = fake({ global: { context7: catalogConfig("context7") } })
    await run(McpLifecycle.acquireLease(access, "context7", "task-a"))
    const blocked = await run(McpLifecycle.disable(access, "context7"))
    expect(blocked.ok).toBe(false)
    expect(blocked.blockedBy?.map((lease) => lease.holder)).toEqual(["task-a"])
    // The lease holder itself may release and then disable.
    const own = await run(McpLifecycle.disable(access, "context7", "task-a"))
    expect(own.ok).toBe(true)

    const pinned = fake({ global: { context7: catalogConfig("context7") } })
    await run(McpLifecycle.setPin(pinned.access, "context7", true))
    const refused = await run(McpLifecycle.disable(pinned.access, "context7"))
    expect(refused.ok).toBe(false)
    expect(refused.pinned).toBe(true)
  })

  test("disable persists the flag and stops the runtime server", async () => {
    const { access, global, calls } = fake({ global: { context7: catalogConfig("context7") } })
    const outcome = await run(McpLifecycle.disable(access, "context7"))
    expect(outcome.ok).toBe(true)
    expect(global.get("context7")?.disabled).toBe(true)
    expect(calls).toContain("disconnect:context7")
    expect(outcome.detail).toContain("will not reconnect on restart")
  })
})

describe("removal and restore", () => {
  test("user-managed servers need explicit approval; removal archives the config first", async () => {
    const { access, global, kv } = fake({ global: { mine: local(["mine"], { environment: { KEY: "v" } }) } })
    const refused = await run(McpLifecycle.removeServer(access, "mine", false))
    expect(refused.ok).toBe(false)
    expect(refused.needsApproval).toBe(true)
    expect(global.has("mine")).toBe(true)

    const removed = await run(McpLifecycle.removeServer(access, "mine", true))
    expect(removed.ok).toBe(true)
    expect(removed.archived).toBe(true)
    expect(global.has("mine")).toBe(false)
    const archive = kv.get("mcp/archive/mine") as unknown as { config: ServerConfig; origin: string }
    expect(archive.origin).toBe("user")
    expect(archive.config).toMatchObject({ command: ["mine"], environment: { KEY: "v" } })

    const restored = await run(McpLifecycle.restore(access, "mine"))
    expect(restored.ok).toBe(true)
    expect(global.get("mine")).toMatchObject({ command: ["mine"] })
    expect(kv.has("mcp/archive/mine")).toBe(false)
  })

  test("Orchestra-managed servers can be removed autonomously; leased ones cannot", async () => {
    const { access } = fake({ global: { context7: catalogConfig("context7") } })
    await run(McpLifecycle.acquireLease(access, "context7", "task-a"))
    const blocked = await run(McpLifecycle.removeServer(access, "context7", false))
    expect(blocked.ok).toBe(false)
    await run(McpLifecycle.releaseLease(access, "context7", "task-a"))
    const removed = await run(McpLifecycle.removeServer(access, "context7", false))
    expect(removed.ok).toBe(true)
  })
})

describe("leases", () => {
  test("leases are shared, released per holder, and swept after the TTL", async () => {
    const { access, kv } = fake()
    await run(McpLifecycle.acquireLease(access, "context7", "task-a"))
    await run(McpLifecycle.acquireLease(access, "context7", "task-b"))
    expect((await run(McpLifecycle.activeLeases(access, "context7"))).map((lease) => lease.holder)).toEqual([
      "task-a",
      "task-b",
    ])
    await run(McpLifecycle.releaseLease(access, "context7", "task-a"))
    expect((await run(McpLifecycle.activeLeases(access, "context7"))).map((lease) => lease.holder)).toEqual(["task-b"])

    // A lease abandoned by a dead session expires instead of blocking forever.
    kv.set("mcp/lease/context7", [{ holder: "ghost", at: Date.now() - McpLifecycle.LEASE_TTL_MS - 1 }])
    expect(await run(McpLifecycle.activeLeases(access, "context7"))).toEqual([])
  })
})

describe("inspect", () => {
  test("reports origin, definition source, tools, leases and pins together", async () => {
    const { access } = fake({
      global: { context7: catalogConfig("context7") },
      other: { projectone: local(["proj"], { disabled: true }) },
    })
    await run(McpLifecycle.acquireLease(access, "context7", "task-a", "research stage"))
    const rows = await run(McpLifecycle.inspect(access))
    const context7 = rows.find((row) => row.name === "context7")!
    expect(context7.origin).toBe("orchestra")
    expect(context7.definedIn).toBe("global")
    expect(context7.status).toBe("connected")
    expect(context7.tools).toEqual(["context7_tool"])
    expect(context7.leases.map((lease) => lease.holder)).toEqual(["task-a"])
    const project = rows.find((row) => row.name === "projectone")!
    expect(project.definedIn).toBe("other")
    expect(project.disabled).toBe(true)
  })
})
