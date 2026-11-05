import { describe, expect, test } from "bun:test"
import { evolve, emptyView, iso, rebuild, rows, snapshot } from "@orchestra/core/autoloop/kernel/evolve"
import type { AutoloopFact } from "@orchestra/core/autoloop/kernel/schema"

const fact = (id: string, collection: string, key: string, data: Record<string, unknown> | null): AutoloopFact => ({
  id,
  type: "test.write",
  collection,
  key,
  data,
})

describe("AutoloopEvolve", () => {
  test("upserts a projection row from a fact", () => {
    const view = evolve(emptyView(), fact("f1", "runs", "run_1", { state: "queued" }))

    expect(view).toEqual({ runs: { run_1: { state: "queued" } } })
  })

  test("a later fact overwrites the same row", () => {
    const view = [fact("f1", "runs", "run_1", { state: "queued" }), fact("f2", "runs", "run_1", { state: "done" })].reduce(
      evolve,
      emptyView(),
    )

    expect(view.runs?.run_1).toEqual({ state: "done" })
  })

  test("data null deletes the row and drops the empty collection", () => {
    const view = [fact("f1", "runs", "run_1", { state: "queued" }), fact("f2", "runs", "run_1", null)].reduce(
      evolve,
      emptyView(),
    )

    expect(view).toEqual({})
  })

  test("a journal-only fact leaves the view untouched", () => {
    const view = evolve(emptyView(), { id: "f1", type: "test.note", data: { note: "hello" } })

    expect(view).toEqual({})
  })

  test("rebuild from the journal restores the same state as incremental evolve", () => {
    const facts = [
      fact("f1", "runs", "run_1", { state: "queued" }),
      fact("f2", "runs", "run_2", { state: "queued" }),
      fact("f3", "runs", "run_1", { state: "done" }),
      fact("f4", "cards", "card_1", { title: "ask" }),
      fact("f5", "runs", "run_2", null),
      { id: "f6", type: "test.note" },
    ]
    const incremental = facts.reduce(evolve, emptyView())

    expect(rebuild(facts)).toEqual(incremental)
    expect(incremental).toEqual({
      runs: { run_1: { state: "done" } },
      cards: { card_1: { title: "ask" } },
    })
  })

  test("snapshot and rows round-trip a view", () => {
    const view = rebuild([fact("f1", "runs", "run_1", { state: "done" }), fact("f2", "cards", "card_1", { title: "ask" })])

    expect(snapshot(view).sort((a, b) => a.collection.localeCompare(b.collection))).toEqual([
      { collection: "cards", key: "card_1", data: { title: "ask" } },
      { collection: "runs", key: "run_1", data: { state: "done" } },
    ])
    expect(rows(view, "runs")).toEqual([{ collection: "runs", key: "run_1", data: { state: "done" } }])
    expect(rows(view, "missing")).toEqual([])
  })

  test("iso returns an ISO timestamp", () => {
    expect(iso(new Date("2026-11-05T21:00:00.000Z"))).toBe("2026-11-05T21:00:00.000Z")
    expect(iso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})
