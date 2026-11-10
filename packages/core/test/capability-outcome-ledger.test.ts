import { expect } from "bun:test"
import { Effect } from "effect"
import { KV } from "@orchestra/core/kv"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { testEffect } from "./lib/effect"
import { OutcomeLedger as L } from "../src/capabilities/outcome-ledger"
import { CapabilityRegistry as R } from "../src/capabilities/registry"
import { CapabilityRecommendation as C } from "../src/capabilities/recommend"

const it = testEffect(LayerNode.compile(KV.node))
const now = 1794310000000
const scope = { projectID: "prj_test", role: "orchestrator", capability: "files" }
const attempt = (id: string, extra: Partial<L.Attempt> = {}): L.Attempt => ({
  id,
  taskID: "task_1",
  toolID: "native:grep",
  at: now - 1000,
  latencyMs: 40,
  outputTokens: 20,
  costUsd: null,
  ...extra,
})
const verified: L.Verification = { id: "acceptance-1", source: "test", outcome: "passed", at: now - 500 }
const snapshot = () =>
  R.snapshot(
    [
      { id: "native:grep", kind: "native", group: "files", requires: [], dangerous: false },
      { id: "hub:rg", kind: "hub", group: "files", requires: ["rg"], dangerous: false },
      { id: "mcp:disabled", kind: "mcp", group: "files", requires: [], dangerous: false },
      { id: "mcp:paid", kind: "mcp", group: "files", requires: [], dangerous: false },
    ],
    new Map([
      ["native:grep", { state: "ready", permission: "allowed", credential: "ready", cost: "local-only" }],
      ["hub:rg", { state: "ready", permission: "allowed", credential: "ready", cost: "local-only" }],
      ["mcp:disabled", { state: "disabled", permission: "allowed", credential: "ready", cost: "local-only" }],
      ["mcp:paid", { state: "ready", permission: "allowed", credential: "ready", cost: "unknown" }],
    ]),
    now,
  )

it.effect("persists facts across service instances, deduplicates and never counts transport as verified success", () =>
  Effect.gen(function* () {
    const kv = yield* KV.Service,
      ledger = L.make(kv)
    yield* ledger.record(scope, attempt("a"))
    yield* ledger.record(scope, attempt("a"))
    expect(yield* L.make(kv).metrics(scope, now)).toMatchObject({
      unverified: 1,
      metrics: [{ attempts: 1, verifiedSuccesses: 0, totalCostUsd: null }],
    })
    yield* ledger.verify(scope, "a", verified)
    yield* L.make(kv).verify(scope, "a", verified)
    expect(yield* ledger.metrics(scope, now)).toMatchObject({
      unverified: 0,
      metrics: [{ attempts: 1, verifiedSuccesses: 1, totalLatencyMs: 40, totalOutputTokens: 20 }],
    })
    expect((yield* ledger.metrics({ ...scope, role: "coder" }, now)).metrics).toEqual([])
    expect((yield* ledger.metrics({ ...scope, projectID: "prj_other" }, now)).metrics).toEqual([])
  }),
)
it.effect("rejects conflicting events, orphan verification, malformed values and corruption", () =>
  Effect.gen(function* () {
    const kv = yield* KV.Service,
      ledger = L.make(kv)
    yield* ledger.record(scope, attempt("a"))
    for (const action of [
      ledger.record(scope, attempt("a", { outputTokens: 99 })),
      ledger.verify(scope, "missing", verified),
      ledger.verify(scope, "a", { ...verified, at: now - 2000 }),
      ledger.record(scope, attempt("bad", { latencyMs: -1 })),
      ledger.record(scope, attempt("bad", { costUsd: Number.NaN })),
      ledger.nextDecision(scope, "../?untrusted"),
    ])
      expect((yield* Effect.exit(action))._tag).toBe("Failure")
    yield* ledger.verify(scope, "a", verified)
    expect((yield* Effect.exit(ledger.verify(scope, "a", { ...verified, outcome: "failed" })))._tag).toBe("Failure")
    const broken = L.make({ get: () => Effect.succeed({ version: 999 }), atomicUpdate: kv.atomicUpdate })
    expect((yield* Effect.exit(broken.metrics(scope, now)))._tag).toBe("Failure")
  }),
)
it.effect("uses exactly the 30-day attempt window and keeps failed/unverified attempts in the denominator", () =>
  Effect.gen(function* () {
    const kv = yield* KV.Service,
      ledger = L.make(kv)
    yield* ledger.record(scope, attempt("old", { at: now - L.WINDOW_MS - 1 }))
    yield* ledger.verify(scope, "old", verified)
    yield* ledger.record(scope, attempt("edge", { at: now - L.WINDOW_MS, costUsd: 0.02 }))
    yield* ledger.verify(scope, "edge", verified)
    yield* ledger.record(scope, attempt("fail", { costUsd: 0.03 }))
    yield* ledger.verify(scope, "fail", { ...verified, outcome: "failed" })
    yield* ledger.record(scope, attempt("unverified"))
    yield* ledger.record(scope, attempt("future", { at: now + 1 }))
    expect(yield* ledger.metrics(scope, now)).toMatchObject({
      unverified: 1,
      metrics: [
        {
          attempts: 3,
          verifiedSuccesses: 1,
          totalCostUsd: null,
          totalLatencyMs: 120,
          totalOutputTokens: 60,
          firstAt: now - L.WINDOW_MS,
        },
      ],
    })
  }),
)
it.effect("atomic durable decisions are consecutive and retries do not consume extra exploration ordinals", () =>
  Effect.gen(function* () {
    const kv = yield* KV.Service,
      ledger = L.make(kv)
    const values = yield* Effect.forEach(
      Array.from({ length: 30 }, (_, i) => `decision-${i}`),
      (id) => L.make(kv).nextDecision(scope, id),
      { concurrency: 10 },
    )
    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
    const repeats = yield* Effect.forEach(
      Array.from({ length: 20 }),
      () => ledger.nextDecision(scope, "same-decision"),
      { concurrency: 10 },
    )
    expect(new Set(repeats).size).toBe(1)
    expect(repeats[0]).toBe(31)
    expect(yield* L.make(kv).nextDecision(scope, "restart")).toBe(32)
    expect(yield* ledger.nextDecision({ ...scope, role: "coder" }, "restart")).toBe(1)
  }),
)
it.effect("projects only allowlisted facts, including caller objects with raw extra fields", () =>
  Effect.gen(function* () {
    const actual = yield* KV.Service
    let stored: KV.Value | undefined
    const ledger = L.make({
      get: actual.get,
      atomicUpdate: (key, update) =>
        actual.atomicUpdate(key, (raw) => {
          stored = update(raw)
          return stored
        }),
    })
    yield* ledger.record(scope, { ...attempt("a"), output: "do-not-store", token: "do-not-store" } as L.Attempt)
    yield* ledger.verify(scope, "a", { ...verified, transcript: "do-not-store" } as L.Verification)
    expect(JSON.stringify(stored)).not.toContain("do-not-store")
  }),
)
it.effect("recommendation consumes durable evidence, refuses OFF/unknown cost, keeps exploration opt-in", () =>
  Effect.gen(function* () {
    const kv = yield* KV.Service,
      ledger = L.make(kv)
    for (let i = 0; i < 5; i++) {
      yield* ledger.record(scope, attempt(`a-${i}`))
      yield* ledger.verify(scope, `a-${i}`, verified)
    }
    const input = {
      scope,
      decisionID: "d-1",
      snapshot: snapshot(),
      now,
      readOnlyIDs: new Set(["native:grep", "hub:rg"]),
    }
    const result = yield* C.recommend(kv, input)
    expect(result).toMatchObject({
      mode: "recommendation-only",
      recommendedToolID: "native:grep",
      decisionOrdinal: 1,
      unknownCostToolIDs: ["mcp:paid"],
      excluded: [{ toolID: "mcp:disabled", reason: "unavailable" }],
    })
    expect((yield* C.recommend(kv, input)).decisionOrdinal).toBe(1)
    for (let i = 2; i <= 9; i++) yield* C.recommend(kv, { ...input, decisionID: `d-${i}` })
    expect((yield* C.recommend(kv, { ...input, decisionID: "d-10", exploration: true })).kind).toBe("exploration")
    expect((yield* C.recommend(kv, { ...input, decisionID: "d-10", exploration: true })).recommendedToolID).toBe(
      "hub:rg",
    )
    expect((yield* C.recommend(kv, { ...input, decisionID: "d-10" })).kind).toBe("ranked")
    expect((yield* Effect.exit(C.recommend(kv, { ...input, now: now + 60001 })))._tag).toBe("Failure")
  }),
)

it.effect("namespaced plugin adapter IDs are persisted and ranked without dropping their identity", () =>
  Effect.gen(function* () {
    const kv = yield* KV.Service,
      ledger = L.make(kv),
      plugin = "plugin:@vendor/plugin"
    for (let i = 0; i < 5; i++) {
      yield* ledger.record(scope, attempt(`plugin-${i}`, { toolID: plugin }))
      yield* ledger.verify(scope, `plugin-${i}`, verified)
    }
    const view = R.snapshot(
      [{ id: plugin, kind: "plugin", group: "files", requires: [], dangerous: "unknown" }],
      new Map([[plugin, { state: "ready", permission: "allowed", credential: "ready", cost: "local-only" }]]),
      now,
    )
    const result = yield* C.recommend(kv, {
      scope,
      decisionID: "plugin-decision",
      snapshot: view,
      now,
      readOnlyIDs: new Set(),
    })
    expect(result.recommendedToolID).toBe(plugin)
  }),
)
