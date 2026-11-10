import { expect, test } from "bun:test"
import { CapabilityRegistry as Registry } from "../src/capabilities/registry"
import { CapabilityCatalog as Catalog } from "../src/capabilities/catalog"
import { inspect } from "../src/capabilities/inspect"
import { all as hub } from "../src/hub/catalog/index"
import { all as mcp } from "../src/mcp/catalog"

test("every catalog adapter and program is covered exactly once, not in competing catalogs", () => {
  const rows = Catalog.definitions({
    native: ["browser", "read", "read"],
    plugins: ["sample"],
    skills: ["sample-method"],
  })
  expect(rows).toHaveLength(hub.length + mcp.length + 4)
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
  for (const item of hub) expect(rows.find((row) => row.id === "hub:" + item.id)?.requires).toEqual(item.requires ?? [])
  for (const row of rows) expect(Registry.groups).toContain(row.group)
  expect(rows.find((row) => row.id === "native:browser")?.group).toBe("browser")
  expect(rows.find((row) => row.id === "mcp:context7")?.group).toBe("research")
})
test("OFF wins, unknown is not ready, permission is not inferred from installation or transport", () => {
  const rows = Catalog.definitions({ native: ["read"], plugins: [], skills: [] })
  const observed = new Map<string, Registry.Observed>([
    ["mcp:context7", { state: "disabled", permission: "allowed", credential: "ready", cost: "metered" }],
    ["mcp:deepwiki", { state: "ready", credential: "ready" }],
    ["native:read", { state: "ready", permission: "allowed", credential: "ready", cost: "local-only" }],
  ])
  const snapshot = Registry.snapshot(rows, observed, 123)
  expect(snapshot.entries.find((row) => row.id === "mcp:context7")?.eligible).toBe(false)
  expect(snapshot.entries.find((row) => row.id === "mcp:deepwiki")?.eligible).toBe(false)
  expect(snapshot.entries.find((row) => row.id === "native:read")?.eligible).toBe(true)
  const unknown = snapshot.entries.find((row) => row.id === "hub:" + hub[0].id)!
  expect(unknown.state).toBe("unknown")
  expect(unknown.cost).toBe("unknown")
  expect(unknown.eligible).toBe(false)
  expect(Registry.summary(snapshot).join("\n")).toContain("Unknown cost is not free")
  expect(() => Registry.snapshot([rows[0], rows[0]], observed, 123)).toThrow("Duplicate")
  expect(() => Registry.snapshot(rows, observed, NaN)).toThrow("time")
})

test("effective local metadata snapshot preserves OFF, distinguishes loaded/discovered/indexed and never grants access", () => {
  const snapshot = inspect({
    at: 1,
    mcpEnabled: true,
    mcp: [
      { name: "context7", disabled: true, status: "connected", tools: ["stale"] },
      { name: "serena", disabled: false, status: "connected", tools: ["symbols"] },
      { name: "sentry", disabled: false, status: "needs_auth", tools: [] },
    ],
    native: ["read"],
    skills: ["method"],
    plugins: [{ id: "plugin", disabled: true }],
  })
  expect(snapshot.entries.find((row) => row.id === "mcp:context7")?.state).toBe("disabled")
  expect(snapshot.entries.find((row) => row.id === "mcp:serena")?.state).toBe("ready")
  expect(snapshot.entries.find((row) => row.id === "mcp:sentry")?.credential).toBe("missing")
  expect(snapshot.entries.find((row) => row.id === "skill:method")?.state).toBe("unknown")
  expect(snapshot.entries.find((row) => row.id === "plugin:plugin")?.state).toBe("disabled")
  expect(snapshot.entries.every((row) => row.eligible === false)).toBe(true)
  const off = inspect({ at: 1, mcpEnabled: false, mcp: [], native: [], skills: [], plugins: [] })
  expect(off.entries.filter((row) => row.kind === "mcp").every((row) => row.state === "disabled")).toBe(true)
})
