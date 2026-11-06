import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { KV } from "@orchestra/core/kv"
import { DEFAULT_TTL_MS, check, dedup, keyFor, normalizeTarget, prune, record } from "@orchestra/core/tool/idempotency"

const fakeKV = (): { kv: KV.Interface; store: Map<string, KV.Value> } => {
  const store = new Map<string, KV.Value>()
  const kv: KV.Interface = {
    get: (key) => Effect.succeed(store.get(key)),
    set: (key, value) => Effect.sync(() => void store.set(key, value)),
    remove: (key) => Effect.sync(() => void store.delete(key)),
    scan: (options) =>
      Effect.sync(() => ({
        entries: [...store.entries()]
          .filter(([key]) => key.startsWith(options.prefix))
          .map(([key, value]) => ({ key, value })),
      })),
  }
  return { kv, store }
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("Idempotency keys", () => {
  test("the same session, action and target hash to one key; anything else differs", () => {
    expect(keyFor("ses-1", "desktop_open", "https://example.com")).toBe(keyFor("ses-1", "desktop_open", "https://example.com"))
    expect(keyFor("ses-1", "desktop_open", "https://example.com")).not.toBe(keyFor("ses-2", "desktop_open", "https://example.com"))
    expect(keyFor("ses-1", "desktop_open", "https://example.com")).not.toBe(keyFor("ses-1", "desktop_open", "https://other.com"))
    expect(keyFor("ses-1", "desktop_open", "https://example.com")).not.toBe(keyFor("ses-1", "zen_browser navigate", "https://example.com"))
    expect(keyFor("ses-1", "desktop_open", "https://example.com")).toBe(keyFor("ses-1", "desktop_open", "https://example.com/"))
    expect(keyFor("ses-1", "desktop_open", "https://example.com")).toBe(keyFor("ses-1", "desktop_open", "https://example.com#frag"))
  })

  test("normalizeTarget trims and strips URL fragments and trailing slashes", () => {
    expect(normalizeTarget("  https://example.com/page/#top ")).toBe("https://example.com/page")
    expect(normalizeTarget("notepad")).toBe("notepad")
  })
})

describe("Idempotency dedup", () => {
  test("a link opens once across three calls: the repeats return the first result", async () => {
    const { kv } = fakeKV()
    const input = { sessionID: "ses-1", action: "desktop_open", target: "https://example.com" }
    let runs = 0
    const open = dedup(kv, input, Effect.sync(() => `opened https://example.com (#${(runs += 1)})`))
    const first = await run(open)
    const second = await run(open)
    const third = await run(open)
    expect(runs).toBe(1)
    expect(first).toEqual({ duplicate: false, result: "opened https://example.com (#1)" })
    expect(second).toEqual({ duplicate: true, result: "opened https://example.com (#1)" })
    expect(third).toEqual({ duplicate: true, result: "opened https://example.com (#1)" })
  })

  test("a different session or a different link runs again", async () => {
    const { kv } = fakeKV()
    let runs = 0
    const open = (sessionID: string, target: string) =>
      dedup(kv, { sessionID, action: "desktop_open", target }, Effect.sync(() => `run ${runs += 1}`))
    await run(open("ses-1", "https://a.example"))
    await run(open("ses-2", "https://a.example"))
    await run(open("ses-1", "https://b.example"))
    expect(runs).toBe(3)
  })

  test("an expired record lets the action run again, and check removes it", async () => {
    const { kv, store } = fakeKV()
    const input = { sessionID: "ses-1", action: "desktop_open", target: "https://example.com" }
    await run(record(kv, input, "opened", 1_000))
    expect(await run(check(kv, input, 1_000 + DEFAULT_TTL_MS - 1))).toMatchObject({ result: "opened" })
    expect(await run(check(kv, input, 1_000 + DEFAULT_TTL_MS))).toBeUndefined()
    expect([...store.keys()].every((key) => !key.startsWith("autoloop/idempotency/") || key.endsWith("__pruned_at"))).toBe(true)
  })

  test("a failed run stores nothing, so the next call may run", async () => {
    const { kv } = fakeKV()
    const input = { sessionID: "ses-1", action: "desktop_open", target: "https://example.com" }
    await expect(run(dedup(kv, input, Effect.fail(new Error("boom"))))).rejects.toThrow("boom")
    expect(await run(check(kv, input))).toBeUndefined()
    const retry = await run(dedup(kv, input, Effect.succeed("opened on retry")))
    expect(retry).toEqual({ duplicate: false, result: "opened on retry" })
  })

  test("prune removes expired records and leaves live ones", async () => {
    const { kv } = fakeKV()
    await run(record(kv, { sessionID: "s", action: "a", target: "https://old.example" }, "old", 0))
    await run(record(kv, { sessionID: "s", action: "a", target: "https://new.example" }, "new", 100_000))
    expect(await run(prune(kv, 100_000 + DEFAULT_TTL_MS - 1))).toBe(1)
    expect(await run(check(kv, { sessionID: "s", action: "a", target: "https://new.example" }, 100_000 + DEFAULT_TTL_MS - 1))).toMatchObject({ result: "new" })
  })
})
