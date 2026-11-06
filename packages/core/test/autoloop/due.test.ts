import { describe, expect, test } from "bun:test"
import {
  MINUTE,
  OFFLINE_AFTER,
  RUN_LEASE,
  SEEN_EVERY,
  WORKER_FRESH,
  deadlines,
  offlineCard,
  waitingOn,
  workers,
} from "@orchestra/core/autoloop/kernel/due"
import { emptyView } from "@orchestra/core/autoloop/kernel/evolve"
import type { View } from "@orchestra/core/autoloop/kernel/evolve"
import { emptyRules } from "@orchestra/core/autoloop/kernel/rules"
import type { Rules } from "@orchestra/core/autoloop/kernel/rules"

const T0 = Date.parse("2026-11-05T21:00:00.000Z")

const rules: Rules = {
  ...emptyRules("UTC"),
  agents: {
    coder: { name: "coder", worker: "worker-1", use: "code", access: "edit" },
  },
  channels: {},
  rules: [],
}

const withRows = (rows: Record<string, Record<string, Record<string, unknown>>>): View => {
  const view = emptyView()
  for (const [collection, entries] of Object.entries(rows)) {
    view[collection] = { ...entries }
  }
  return view
}

describe("AutoloopDue constants", () => {
  test("leases and freshness match the Orchestra limits", () => {
    expect(RUN_LEASE).toBe(5 * MINUTE)
    expect(WORKER_FRESH).toBe(2 * MINUTE)
    expect(OFFLINE_AFTER).toBe(10 * MINUTE)
    expect(SEEN_EVERY).toBe(MINUTE)
  })
})

describe("AutoloopDue workers and waiting", () => {
  test("workers come from seen rows and from the rule set", () => {
    const view = withRows({
      seen: { "worker:worker-2": { kind: "worker", name: "worker-2", seen_at: new Date(T0).toISOString() } },
      runs: {
        1: { id: 1, agent: "coder", state: "queued", created_at: new Date(T0).toISOString() },
      },
    })

    expect(workers(view, rules).sort()).toEqual(["worker-1", "worker-2"])
    expect(waitingOn(view, "worker-1", rules)).toHaveLength(1)
    expect(waitingOn(view, "worker-2", rules)).toHaveLength(0)
  })

  test("unknown runs still wait on their worker", () => {
    const view = withRows({
      runs: {
        1: { id: 1, agent: "coder", state: "unknown", created_at: new Date(T0).toISOString() },
      },
    })

    expect(waitingOn(view, "worker-1", rules)).toHaveLength(1)
  })

  test("offlineCard is untold until an open card exists or the waiting work predates the closed one", () => {
    const waiting = [{ created_at: new Date(T0).toISOString() }]
    const bare = withRows({})
    expect(offlineCard(bare, "worker-1", waiting)).toMatchObject({ told: false })

    const open = withRows({
      cards: {
        1: { id: 1, key: "worker:worker-1:offline:never", state: "open" },
      },
    })
    expect(offlineCard(open, "worker-1", waiting).told).toBe(true)

    const closed = withRows({
      seen: { "worker:worker-1": { kind: "worker", name: "worker-1", seen_at: new Date(T0).toISOString() } },
      cards: {
        1: {
          id: 1,
          key: `worker:worker-1:offline:${new Date(T0).toISOString()}`,
          state: "closed",
          closed_at: new Date(T0 + MINUTE).toISOString(),
        },
      },
    })
    expect(offlineCard(closed, "worker-1", waiting).told).toBe(true)
  })
})

describe("AutoloopDue deadlines", () => {
  test("a queued run waiting out its retry pause is due at not_before", () => {
    const view = withRows({
      runs: {
        1: {
          id: 1,
          state: "queued",
          not_before: new Date(T0 + 5 * MINUTE).toISOString(),
          created_at: new Date(T0).toISOString(),
        },
      },
    })

    expect(deadlines(view, T0, rules)).toEqual({
      "retry:1": { kind: "retry", key: "1", at: new Date(T0 + 5 * MINUTE).toISOString() },
    })
    expect(deadlines(view, T0 + 6 * MINUTE, rules)).toEqual({})
  })

  test("a card delivery waiting to resend is due at its not_before", () => {
    const view = withRows({
      deliveries: {
        "1:web": { card_id: 1, channel: "web", given_up: 0, not_before: new Date(T0 + MINUTE).toISOString() },
      },
    })

    expect(deadlines(view, T0, rules)).toEqual({
      "delivery:1:web": { kind: "delivery", key: "1:web", at: new Date(T0 + MINUTE).toISOString() },
    })
  })

  test("a claimed run whose worker is fresh but stopped mentioning it gets a lease deadline", () => {
    const view = withRows({
      seen: { "worker:worker-1": { kind: "worker", name: "worker-1", seen_at: new Date(T0).toISOString() } },
      runs: {
        1: {
          id: 1,
          agent: "coder",
          state: "claimed",
          seen_at: new Date(T0 - 4 * MINUTE).toISOString(),
          created_at: new Date(T0 - 4 * MINUTE).toISOString(),
        },
      },
    })

    const due = deadlines(view, T0 + MINUTE, rules)
    expect(due["lease:1"]).toMatchObject({ kind: "lease", key: "1" })
    expect(Date.parse(due["lease:1"]!.at)).toBe(T0 + MINUTE + 1)
  })

  test("a worker with waiting work and no offline card gets an offline deadline", () => {
    const view = withRows({
      runs: {
        1: { id: 1, agent: "coder", state: "queued", created_at: new Date(T0).toISOString() },
      },
    })

    const due = deadlines(view, T0, rules)
    expect(due["offline:worker-1"]).toMatchObject({ kind: "offline", key: "worker-1" })
    expect(Date.parse(due["offline:worker-1"]!.at)).toBe(T0 + OFFLINE_AFTER + 1)
  })

  test("a dead worker's stale claimed run gets a lease deadline", () => {
    const view = withRows({
      runs: {
        1: {
          id: 1,
          agent: "coder",
          state: "claimed",
          seen_at: new Date(T0 - 6 * MINUTE).toISOString(),
          created_at: new Date(T0 - 6 * MINUTE).toISOString(),
        },
      },
    })

    const due = deadlines(view, T0, rules)
    expect(due["lease:1"]).toMatchObject({ kind: "lease", key: "1" })
    expect(Date.parse(due["lease:1"]!.at)).toBe(T0)
  })

  test("a dead worker's unknown run gets a requeue deadline", () => {
    const view = withRows({
      seen: { "worker:worker-1": { kind: "worker", name: "worker-1", seen_at: new Date(T0 - 5 * MINUTE).toISOString() } },
      runs: {
        1: {
          id: 1,
          agent: "coder",
          state: "unknown",
          seen_at: new Date(T0 - 6 * MINUTE).toISOString(),
          created_at: new Date(T0 - 6 * MINUTE).toISOString(),
        },
      },
    })

    const due = deadlines(view, T0, rules)
    expect(due["requeue:1"]).toMatchObject({ kind: "requeue", key: "1" })
    expect(Date.parse(due["requeue:1"]!.at)).toBe(T0)
  })
})
