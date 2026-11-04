import { describe, expect, test } from "bun:test"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { McpBudget } from "@orchestra/core/mcp/budget"
import { Database } from "@orchestra/core/database/database"
import { KVTable } from "@orchestra/core/kv/sql"
import { Global } from "@orchestra/util/global"
import { tmpdir } from "./fixture/tmpdir"

const limit = (overrides?: Partial<McpBudget.Limit>): McpBudget.Limit => ({
  servers: "all",
  maxCalls: 10,
  perServer: {},
  ...overrides,
})

const stamp = (value: McpBudget.Limit, epoch = "epoch-1"): McpBudget.Stamp => ({ kind: "limit", limit: value, epoch })

const empty: McpBudget.Usage = { total: 0, perServer: {} }

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

describe("McpBudget.decide", () => {
  test("allowlist denials consume nothing", () => {
    const decision = McpBudget.decide({ limit: limit({ servers: ["docs"] }), server: "other", usage: empty })
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.message).toContain("not in this task's MCP allowlist")
  })

  test("the total cap denies at the cap and allows below it", () => {
    const value = limit({ maxCalls: 2 })
    const below = McpBudget.decide({ limit: value, server: "a", usage: { total: 1, perServer: { a: 1 } } })
    expect(below).toEqual({ allowed: true, next: { total: 2, perServer: { a: 2 } } })
    const at = McpBudget.decide({ limit: value, server: "a", usage: { total: 2, perServer: { a: 2 } } })
    expect(at.allowed).toBe(false)
    if (!at.allowed) expect(at.message).toContain("MCP budget exhausted for this task")
  })

  test("per-server caps are independent of the total", () => {
    const value = limit({ maxCalls: 10, perServer: { a: 1 } })
    const denied = McpBudget.decide({ limit: value, server: "a", usage: { total: 1, perServer: { a: 1 } } })
    expect(denied.allowed).toBe(false)
    if (!denied.allowed) expect(denied.message).toContain('MCP budget exhausted for server "a"')
    expect(McpBudget.decide({ limit: value, server: "b", usage: { total: 1, perServer: { a: 1 } } }).allowed).toBe(true)
  })
})

const withMemoryDb = (run: (db: Database.Interface["db"]) => Effect.Effect<void>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* run(database.db)
    }).pipe(
      Effect.provide(Database.layer()),
      Effect.provideService(Global.Service, Global.make({ data: "/tmp" })),
      Effect.scoped,
    ),
  )

describe("McpBudget.reserve (in-memory database)", () => {
  test("reserves up to the cap, then denies, and the row holds the count", async () => {
    await withMemoryDb((db) =>
      Effect.gen(function* () {
        const value = stamp(limit({ maxCalls: 2 }))
        expect(yield* McpBudget.reserve(db, { sessionID: "s", server: "a", stamp: value })).toBeUndefined()
        expect(yield* McpBudget.reserve(db, { sessionID: "s", server: "b", stamp: value })).toBeUndefined()
        expect(yield* McpBudget.reserve(db, { sessionID: "s", server: "a", stamp: value })).toContain("exhausted")
        expect(yield* McpBudget.readUsage(db, "s")).toEqual({ epoch: "epoch-1", total: 2, perServer: { a: 1, b: 1 } })
      }),
    )
  })

  test("none and invalid stamps never touch the store", async () => {
    await withMemoryDb((db) =>
      Effect.gen(function* () {
        expect(yield* McpBudget.reserve(db, { sessionID: "s", server: "a", stamp: { kind: "none" } })).toBeUndefined()
        expect(yield* McpBudget.reserve(db, { sessionID: "s", server: "a", stamp: { kind: "invalid" } })).toContain(
          "malformed",
        )
        expect(yield* McpBudget.readUsage(db, "s")).toBeUndefined()
      }),
    )
  })

  test("a new epoch atomically replaces the count; the old epoch's cap does not leak", async () => {
    await withMemoryDb((db) =>
      Effect.gen(function* () {
        const value = limit({ maxCalls: 1 })
        expect(yield* McpBudget.reserve(db, { sessionID: "s", server: "a", stamp: stamp(value, "e1") })).toBeUndefined()
        expect(yield* McpBudget.reserve(db, { sessionID: "s", server: "a", stamp: stamp(value, "e1") })).toContain(
          "exhausted",
        )
        expect(yield* McpBudget.reserve(db, { sessionID: "s", server: "a", stamp: stamp(value, "e2") })).toBeUndefined()
        expect(yield* McpBudget.readUsage(db, "s")).toEqual({ epoch: "e2", total: 1, perServer: { a: 1 } })
      }),
    )
  })

  test("corrupted usage fails closed instead of resetting spent budget", async () => {
    await withMemoryDb((db) =>
      Effect.gen(function* () {
        yield* db
          .insert(KVTable)
          .values({ key: McpBudget.usageKey("s"), value: "garbage" as never })
          .run()
          .pipe(Effect.orDie)
        const denial = yield* McpBudget.reserve(db, { sessionID: "s", server: "a", stamp: stamp(limit()) })
        expect(denial).toContain("unreadable")
        // Removing the row (session deletion / cleanup) is the recovery path.
        yield* McpBudget.removeUsage(db, "s")
        expect(yield* McpBudget.reserve(db, { sessionID: "s", server: "a", stamp: stamp(limit()) })).toBeUndefined()
      }),
    )
  })

  test("listUsage and removeUsage round-trip for the cleanup sweep", async () => {
    await withMemoryDb((db) =>
      Effect.gen(function* () {
        const value = stamp(limit({ maxCalls: 5 }))
        yield* McpBudget.reserve(db, { sessionID: "keep", server: "a", stamp: value })
        yield* McpBudget.reserve(db, { sessionID: "drop", server: "a", stamp: value })
        const listed = yield* McpBudget.listUsage(db)
        expect(listed.map((row) => row.sessionID).sort()).toEqual(["drop", "keep"])
        expect(listed.find((row) => row.sessionID === "keep")?.usage?.total).toBe(1)
        yield* McpBudget.removeUsage(db, "drop")
        expect((yield* McpBudget.listUsage(db)).map((row) => row.sessionID)).toEqual(["keep"])
      }),
    )
  })

  test("two fibers racing for the last slot on one connection: exactly one wins", async () => {
    await withMemoryDb((db) =>
      Effect.gen(function* () {
        const value = stamp(limit({ maxCalls: 1 }))
        const results = yield* Effect.all(
          [
            McpBudget.reserve(db, { sessionID: "s", server: "a", stamp: value }),
            McpBudget.reserve(db, { sessionID: "s", server: "a", stamp: value }),
          ],
          { concurrency: "unbounded" },
        )
        expect(results.filter((result) => result === undefined)).toHaveLength(1)
        expect(results.filter((result) => result?.includes("exhausted"))).toHaveLength(1)
        expect((yield* McpBudget.readUsage(db, "s"))?.total).toBe(1)
      }),
    )
  })
})

describe("McpBudget.reserve (two connections, one database file)", () => {
  const withFileDbs = (run: (a: Database.Interface["db"], b: Database.Interface["db"]) => Effect.Effect<void>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tmp = yield* Effect.promise(() => tmpdir())
        const file = path.join(tmp.path, "budget.db")
        const layer = () => Database.layer({ path: file })
        const a = yield* Layer.build(layer())
        const b = yield* Layer.build(layer())
        yield* run(Context.get(a, Database.Service).db, Context.get(b, Database.Service).db)
      }).pipe(
        Effect.scoped,
        Effect.provideService(Global.Service, Global.make({ data: "/tmp" })),
      ),
    )

  test("two connections racing for the last slot: exactly one reservation commits", async () => {
    await withFileDbs((a, b) =>
      Effect.gen(function* () {
        const value = stamp(limit({ maxCalls: 1 }))
        const results = yield* Effect.all(
          [
            McpBudget.reserve(a, { sessionID: "s", server: "x", stamp: value }),
            McpBudget.reserve(b, { sessionID: "s", server: "x", stamp: value }),
          ],
          { concurrency: "unbounded" },
        )
        expect(results.filter((result) => result === undefined)).toHaveLength(1)
        expect(results.filter((result) => result?.includes("exhausted"))).toHaveLength(1)
        // The count is durable and shared: the other connection reads it.
        expect((yield* McpBudget.readUsage(b, "s"))?.total).toBe(1)
        // And a later reservation on either connection (a "restart") resumes it.
        expect(yield* McpBudget.reserve(a, { sessionID: "s", server: "x", stamp: value })).toContain("exhausted")
      }),
    )
  })

  test("separate sessions on separate connections keep independent budgets", async () => {
    await withFileDbs((a, b) =>
      Effect.gen(function* () {
        const value = stamp(limit({ maxCalls: 1 }))
        expect(yield* McpBudget.reserve(a, { sessionID: "one", server: "x", stamp: value })).toBeUndefined()
        expect(yield* McpBudget.reserve(b, { sessionID: "two", server: "x", stamp: value })).toBeUndefined()
        expect(yield* McpBudget.reserve(b, { sessionID: "one", server: "x", stamp: value })).toContain("exhausted")
      }),
    )
  })
})
