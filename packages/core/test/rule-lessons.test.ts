import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { RuleLessons } from "@orchestra/core/rule-lessons"
import { RuleEnforce } from "@orchestra/core/rule-enforce"
import type { KV } from "@orchestra/core/kv"

function fixture() {
  const store = new Map<string, KV.Value>()
  const kv = {
    remove: (key: string) => Effect.sync(() => { store.delete(key) }),
    get: (key: string) => Effect.sync(() => store.get(key)),
    atomicUpdate: (key: string, update: (value: KV.Value | undefined) => KV.Value | undefined) => Effect.sync(() => {
      const value = update(store.get(key))
      if (value === undefined) store.delete(key)
      else store.set(key, value)
      return value
    }),
  } as KV.Interface
  return { store, kv }
}
const entry = { title: "Project", text: "deny tool shell", by: "operator" }

describe("bounded rule lessons", () => {
  test("requires two real rule refusals, persists only hashes/counts, keeps enforcement unchanged", async () => {
    const { kv, store } = fixture()
    const id = "lessons-real-refusal"
    const refresh = () => Effect.runPromise(RuleLessons.refresh(kv, "project-refusal", id, [entry]))
    RuleEnforce.remember(id, [entry])
    expect(await refresh()).toBe("")
    expect(RuleEnforce.resourceRefusal(id, { action: "shell", agent: "team-developer", resources: ["private-example-argument"] })).toContain(entry.text)
    expect(await refresh()).toBe("")
    expect(RuleEnforce.resourceRefusal(id, { action: "shell", agent: "team-developer", resources: ["private-example-argument"] })).toContain(entry.text)
    expect(await refresh()).toContain(entry.text)
    expect(RuleEnforce.recall(id)).toEqual([entry])
    const saved = JSON.stringify(Array.from(store.values()))
    expect(saved).not.toContain("private-example-argument")
    expect(saved).not.toContain(entry.text)
    expect(saved).not.toContain("operator")
    expect(saved).not.toContain(id)
    expect(await Effect.runPromise(RuleLessons.refresh(kv, "project-refusal", "new-session", [entry]))).toContain(entry.text)
  })

  test("project changes, removed or edited rules and unrelated projects cannot reuse a reminder", async () => {
    const { kv } = fixture()
    const id = "lessons-isolation"
    await Effect.runPromise(RuleLessons.refresh(kv, "a", id, [entry]))
    RuleLessons.record(id, entry)
    RuleLessons.record(id, entry)
    expect(await Effect.runPromise(RuleLessons.refresh(kv, "b", id, [entry]))).toBe("")
    RuleLessons.record(id, entry)
    RuleLessons.record(id, entry)
    expect(await Effect.runPromise(RuleLessons.refresh(kv, "b", id, [entry]))).toContain(entry.text)
    expect(await Effect.runPromise(RuleLessons.refresh(kv, "b", id, []))).toBe("")
    expect(await Effect.runPromise(RuleLessons.refresh(kv, "b", id, [{ ...entry, text: "deny tool write" }]))).toBe("")
    expect(await Effect.runPromise(RuleLessons.refresh(kv, undefined, id, [entry]))).toBe("")
  })

  test("off drops pending learning and injection immediately, without deleting existing learned reminders", async () => {
    const { kv } = fixture()
    const id = "lessons-toggle"
    await Effect.runPromise(RuleLessons.refresh(kv, "toggle", id, [entry]))
    RuleLessons.record(id, entry)
    RuleLessons.record(id, entry)
    expect(await Effect.runPromise(RuleLessons.refresh(kv, "toggle", id, [entry], false))).toBe("")
    RuleLessons.record(id, entry)
    expect(await Effect.runPromise(RuleLessons.refresh(kv, "toggle", id, [entry]))).toBe("")
    RuleLessons.record(id, entry)
    RuleLessons.record(id, entry)
    expect(await Effect.runPromise(RuleLessons.refresh(kv, "toggle", id, [entry]))).toContain(entry.text)
    expect(await Effect.runPromise(RuleLessons.refresh(kv, "toggle", id, [entry], false))).toBe("")
    expect(await Effect.runPromise(RuleLessons.refresh(kv, "toggle", id, [entry]))).toContain(entry.text)
  })

  test("bounds pending and durable fingerprints and displayed lessons at three, deduplicates exact identities", async () => {
    const { kv, store } = fixture()
    const id = "lessons-cap"
    const entries = Array.from({ length: 12 }, (_, i) => ({ ...entry, text: `deny tool tool${i}` }))
    await Effect.runPromise(RuleLessons.refresh(kv, "cap", id, entries))
    for (const row of entries) { RuleLessons.record(id, row); RuleLessons.record(id, row) }
    const block = await Effect.runPromise(RuleLessons.refresh(kv, "cap", id, [...entries, entries[11]!]))
    expect(block.split("- [Project]")).toHaveLength(4)
    expect(block).not.toContain("tool0")
    expect(block).toContain("tool11")
    expect(store.get("rule-lessons/cap")).toHaveLength(3)
    expect(JSON.stringify(store.get("rule-lessons/cap")).length).toBeLessThan(320)
  })
})


test("only actual refused/sent-back logs teach, and project deletion clears durable and pending reminders", async () => {
  const { kv, store } = fixture()
  const id = "lessons-log"
  RuleEnforce.remember(id, [entry])
  await Effect.runPromise(RuleLessons.refresh(kv, "log", id, [entry]))
  const item = { session: id, agent: "team-developer", layer: "soft" as const, rule: entry.text, by: entry.by, what: "synthetic private judge explanation" }
  RuleEnforce.log({ ...item, outcome: "passed" })
  RuleEnforce.log({ ...item, outcome: "sent-back" })
  expect(await Effect.runPromise(RuleLessons.refresh(kv, "log", id, [entry]))).toBe("")
  RuleEnforce.log({ ...item, outcome: "sent-back" })
  expect(await Effect.runPromise(RuleLessons.refresh(kv, "log", id, [entry]))).toContain(entry.text)
  expect(JSON.stringify(Array.from(store.values()))).not.toContain(item.what)
  RuleLessons.record(id, entry)
  await Effect.runPromise(RuleLessons.forgetProject(kv, "log"))
  expect(store.has("rule-lessons/log")).toBe(false)
  expect(await Effect.runPromise(RuleLessons.refresh(kv, "log", id, [entry]))).toBe("")
})
