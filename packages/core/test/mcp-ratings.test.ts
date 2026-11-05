import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { McpRatings } from "@orchestra/core/mcp/ratings"
import { Database } from "@orchestra/core/database/database"
import { Global } from "@orchestra/util/global"

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

describe("McpRatings.parseRating", () => {
  test("parses a well-formed record and rejects the rest", () => {
    expect(
      McpRatings.parseRating({ calls: 3, successes: 2, failures: 1, totalLatencyMs: 300, totalOutputTokens: 50 }),
    ).toEqual({ calls: 3, successes: 2, failures: 1, totalLatencyMs: 300, totalOutputTokens: 50 })
    expect(McpRatings.parseRating(undefined)).toBeUndefined()
    expect(McpRatings.parseRating({ calls: 1 })).toBeUndefined()
    expect(McpRatings.parseRating({ calls: -1, successes: 0, failures: 0, totalLatencyMs: 0, totalOutputTokens: 0 })).toBeUndefined()
  })
})

describe("McpRatings.adjustment", () => {
  test("no history is no adjustment", () => {
    expect(McpRatings.adjustment(undefined)).toBe(0)
    expect(McpRatings.adjustment({ calls: 2, successes: 2, failures: 0, totalLatencyMs: 10, totalOutputTokens: 0 })).toBe(0)
  })

  test("a proven server gains, a failing one loses, a slow one loses more", () => {
    const good = McpRatings.adjustment({ calls: 10, successes: 10, failures: 0, totalLatencyMs: 1000, totalOutputTokens: 0 })
    expect(good).toBeGreaterThan(0)
    const bad = McpRatings.adjustment({ calls: 10, successes: 0, failures: 10, totalLatencyMs: 0, totalOutputTokens: 0 })
    expect(bad).toBeLessThan(0)
    const slow = McpRatings.adjustment({ calls: 10, successes: 10, failures: 0, totalLatencyMs: 60000, totalOutputTokens: 0 })
    expect(slow).toBeLessThan(good)
  })
})

describe("McpRatings.record / readAll (in-memory database)", () => {
  test("outcomes accumulate and survive a second read", async () => {
    await withMemoryDb((db) =>
      Effect.gen(function* () {
        yield* McpRatings.record(db, "playwright", { ok: true, latencyMs: 120, outputTokens: 40 })
        yield* McpRatings.record(db, "playwright", { ok: true, latencyMs: 80, outputTokens: 10 })
        yield* McpRatings.record(db, "playwright", { ok: false, latencyMs: 5000 })
        const rating = yield* McpRatings.readRating(db, "playwright")
        expect(rating).toEqual({ calls: 3, successes: 2, failures: 1, totalLatencyMs: 200, totalOutputTokens: 50 })
        expect(McpRatings.successRate(rating!)).toBeCloseTo(3 / 5, 5)
        expect(McpRatings.avgLatencyMs(rating!)).toBe(100)
        const all = yield* McpRatings.readAll(db)
        expect([...all.keys()]).toEqual(["playwright"])
        expect(yield* McpRatings.readRating(db, "context7")).toBeUndefined()
      }),
    )
  })
})
