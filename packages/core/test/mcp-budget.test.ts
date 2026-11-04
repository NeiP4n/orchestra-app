import { describe, expect, test } from "bun:test"
import { McpBudget } from "@orchestra/core/mcp/budget"

const limit = (overrides?: Partial<McpBudget.Limit>): McpBudget.Limit => ({
  servers: "all",
  maxCalls: 10,
  perServer: {},
  ...overrides,
})

const stamp = (value: McpBudget.Limit, epoch = "epoch-1"): McpBudget.Stamp => ({ kind: "limit", limit: value, epoch })

describe("McpBudget.parseStamp", () => {
  test("no metadata or no stamp is ungated", () => {
    expect(McpBudget.parseStamp(undefined)).toEqual({ kind: "none" })
    expect(McpBudget.parseStamp({})).toEqual({ kind: "none" })
    expect(McpBudget.parseStamp({ other: 1 })).toEqual({ kind: "none" })
  })

  test("a valid stamp parses with its budgetEpoch", () => {
    const parsed = McpBudget.parseStamp({
      [McpBudget.LIMIT_METADATA_KEY]: { servers: ["docs"], maxCalls: 3, perServer: { docs: 2 }, budgetEpoch: "task-9" },
    })
    expect(parsed).toEqual({
      kind: "limit",
      limit: { servers: ["docs"], maxCalls: 3, perServer: { docs: 2 } },
      epoch: "task-9",
    })
  })

  test("a stamp without budgetEpoch falls back to a limit fingerprint", () => {
    const value = limit({ maxCalls: 4 })
    const parsed = McpBudget.parseStamp({ [McpBudget.LIMIT_METADATA_KEY]: value })
    expect(parsed.kind).toBe("limit")
    if (parsed.kind === "limit") expect(parsed.epoch).toBe(JSON.stringify(value))
  })

  test("malformed stamps fail closed as invalid", () => {
    const cases: unknown[] = [
      "nope",
      [],
      { servers: "all", maxCalls: -1, perServer: {} },
      { servers: "all", maxCalls: 1.5, perServer: {} },
      { servers: "all", maxCalls: "2", perServer: {} },
      { servers: [42], maxCalls: 2, perServer: {} },
      { servers: "all", maxCalls: 2, perServer: { docs: -1 } },
      { servers: "all", maxCalls: 2 },
      { maxCalls: 2, perServer: {} },
    ]
    for (const value of cases)
      expect(McpBudget.parseStamp({ [McpBudget.LIMIT_METADATA_KEY]: value })).toEqual({ kind: "invalid" })
  })
})

describe("McpBudget.parsePersistedUsage", () => {
  test("parses a well-formed record and rejects the rest", () => {
    expect(McpBudget.parsePersistedUsage({ epoch: "e", total: 2, perServer: { a: 2 } })).toEqual({
      epoch: "e",
      total: 2,
      perServer: { a: 2 },
    })
    expect(McpBudget.parsePersistedUsage(undefined)).toBeUndefined()
    expect(McpBudget.parsePersistedUsage({ total: 2, perServer: {} })).toBeUndefined()
    expect(McpBudget.parsePersistedUsage({ epoch: "e", total: -1, perServer: {} })).toBeUndefined()
    expect(McpBudget.parsePersistedUsage({ epoch: "e", total: 1, perServer: { a: "x" } })).toBeUndefined()
  })
})

describe("McpBudget gate", () => {
  test("an unstamped session is never gated and clears prior counters", () => {
    const gate = McpBudget.createGate()
    expect(gate.reserve({ sessionID: "s", server: "a", stamp: stamp(limit({ maxCalls: 1 })) })).toBeUndefined()
    expect(gate.usage("s")?.usage.total).toBe(1)
    expect(gate.reserve({ sessionID: "s", server: "a", stamp: { kind: "none" } })).toBeUndefined()
    expect(gate.usage("s")).toBeUndefined()
  })

  test("an invalid stamp refuses every call", () => {
    const gate = McpBudget.createGate()
    const denial = gate.reserve({ sessionID: "s", server: "a", stamp: { kind: "invalid" } })
    expect(denial).toContain("malformed")
    expect(gate.usage("s")).toBeUndefined()
  })

  test("allowlist denials do not consume budget", () => {
    const gate = McpBudget.createGate()
    const value = stamp(limit({ servers: ["docs"], maxCalls: 1 }))
    const denial = gate.reserve({ sessionID: "s", server: "other", stamp: value })
    expect(denial).toContain("not in this task's MCP allowlist")
    expect(gate.usage("s")?.usage.total).toBe(0)
    expect(gate.reserve({ sessionID: "s", server: "docs", stamp: value })).toBeUndefined()
    expect(gate.usage("s")?.usage.total).toBe(1)
  })

  test("the total cap counts reservations and denials do not consume", () => {
    const gate = McpBudget.createGate()
    const value = stamp(limit({ maxCalls: 2 }))
    expect(gate.reserve({ sessionID: "s", server: "a", stamp: value })).toBeUndefined()
    expect(gate.reserve({ sessionID: "s", server: "b", stamp: value })).toBeUndefined()
    expect(gate.reserve({ sessionID: "s", server: "a", stamp: value })).toContain("MCP budget exhausted for this task")
    expect(gate.reserve({ sessionID: "s", server: "a", stamp: value })).toContain("MCP budget exhausted for this task")
    expect(gate.usage("s")?.usage).toEqual({ total: 2, perServer: { a: 1, b: 1 } })
  })

  test("per-server caps are independent of the total", () => {
    const gate = McpBudget.createGate()
    const value = stamp(limit({ maxCalls: 10, perServer: { a: 1 } }))
    expect(gate.reserve({ sessionID: "s", server: "a", stamp: value })).toBeUndefined()
    expect(gate.reserve({ sessionID: "s", server: "a", stamp: value })).toContain(
      'MCP budget exhausted for server "a"',
    )
    expect(gate.reserve({ sessionID: "s", server: "b", stamp: value })).toBeUndefined()
    expect(gate.usage("s")?.usage).toEqual({ total: 2, perServer: { a: 1, b: 1 } })
  })

  test("sessions have independent counters", () => {
    const gate = McpBudget.createGate()
    const value = stamp(limit({ maxCalls: 1 }))
    expect(gate.reserve({ sessionID: "one", server: "a", stamp: value })).toBeUndefined()
    expect(gate.reserve({ sessionID: "two", server: "a", stamp: value })).toBeUndefined()
    expect(gate.reserve({ sessionID: "one", server: "a", stamp: value })).toContain("exhausted")
  })

  test("a new epoch restarts the counters", () => {
    const gate = McpBudget.createGate()
    const value = limit({ maxCalls: 1 })
    expect(gate.reserve({ sessionID: "s", server: "a", stamp: stamp(value, "e1") })).toBeUndefined()
    expect(gate.reserve({ sessionID: "s", server: "a", stamp: stamp(value, "e1") })).toContain("exhausted")
    expect(gate.reserve({ sessionID: "s", server: "a", stamp: stamp(value, "e2") })).toBeUndefined()
    expect(gate.usage("s")).toEqual({ epoch: "e2", usage: { total: 1, perServer: { a: 1 } } })
  })

  test("persisted usage resumes only when the epoch still matches", () => {
    const value = limit({ maxCalls: 3 })
    const resumed = McpBudget.createGate()
    const persisted = { epoch: "e1", total: 2, perServer: { a: 2 } }
    expect(resumed.reserve({ sessionID: "s", server: "a", stamp: stamp(value, "e1"), persisted })).toBeUndefined()
    expect(resumed.reserve({ sessionID: "s", server: "a", stamp: stamp(value, "e1"), persisted })).toContain(
      "exhausted",
    )

    const fresh = McpBudget.createGate()
    expect(
      fresh.reserve({ sessionID: "s", server: "a", stamp: stamp(value, "e1"), persisted: { ...persisted, epoch: "old" } }),
    ).toBeUndefined()
    expect(fresh.usage("s")?.usage.total).toBe(1)
  })
})
