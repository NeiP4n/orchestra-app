import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer, Schema, Scope } from "effect"
import { ConfigOrchestra } from "@orchestra/schema/config/orchestra"
import { Bus } from "@orchestra/core/bus"
import { Database } from "@orchestra/core/database/database"
import { Autoloop } from "@orchestra/core/autoloop/service"
import {
  autonomyFromConfig,
  batchLimitsFromConfig,
} from "@orchestra/core/autoloop/orchestrator"
import {
  DEFAULT_AUTONOMY,
  DEFAULT_BATCH_LIMITS,
  MAX_BATCH_EVENTS,
  resolveAutonomy,
  shouldFlushBatch,
  type AutonomyMode,
} from "@orchestra/core/autoloop/kernel/autonomy"
import { decide } from "@orchestra/core/autoloop/kernel/decide"
import type { DecideEnv, DecideInput, Job } from "@orchestra/core/autoloop/kernel/decide"
import { emptyView, evolve } from "@orchestra/core/autoloop/kernel/evolve"
import type { View } from "@orchestra/core/autoloop/kernel/evolve"
import { emptyRules } from "@orchestra/core/autoloop/kernel/rules"
import type { Rules } from "@orchestra/core/autoloop/kernel/rules"
import { Global } from "@orchestra/util/global"

const T0 = Date.parse("2026-11-05T21:00:00.000Z")
const MINUTE = 60_000

const rules: Rules = {
  ...emptyRules("UTC"),
  sources: { user: { name: "user" } },
  agents: {
    coder: { name: "coder", worker: "worker-1", use: "code", access: "edit" },
  },
  channels: {},
  rules: [
    {
      name: "build",
      when: { source: "user", types: ["task.created"] },
      to: "coder",
      cwd: "/tmp/work",
      group: "build",
      tell: "needed",
    },
  ],
}

const env = (seq = 1, autonomy?: AutonomyMode): DecideEnv => ({ rules, tokenSecret: "test-secret", seq, rulesVersion: 1, autonomy })

const step = (view: View, input: DecideInput, now: number, seq = 1, autonomy?: AutonomyMode) => {
  const result = decide(view, input, now, env(seq, autonomy))
  return { view: result.facts.reduce(evolve, view), value: result.value, facts: result.facts }
}

const runRow = (view: View, id: number) => view["runs"]?.[String(id)] as Record<string, unknown> | undefined
const cardRows = (view: View) => Object.values(view["cards"] ?? {}) as Array<Record<string, unknown>>
const eventRows = (view: View) => Object.values(view["events"] ?? {}) as Array<Record<string, unknown>>
const task = (id: string) => ({ id, type: "task.created", subject: "task-1", summary: "make it" })

describe("Autonomy modes", () => {
  test("resolveAutonomy keeps the legacy behaviour when no mode is given", () => {
    expect(resolveAutonomy(undefined)).toBe("auto")
    expect(resolveAutonomy("observe")).toBe("observe")
    expect(DEFAULT_AUTONOMY).toBe("observe")
  })

  test("off records the event but routes nothing, queues nothing, claims nothing", () => {
    const ingested = step(emptyView(), { type: "ingest", args: ["user", task("evt-1")] }, T0, 1, "off")

    expect(ingested.value).toMatchObject({ event: 1, duplicate: false, routed: [], dropped: true })
    expect(eventRows(ingested.view)).toHaveLength(1)
    expect(runRow(ingested.view, 1)).toBeUndefined()
    expect(cardRows(ingested.view)).toHaveLength(0)

    const claimed = step(ingested.view, { type: "claimNext", args: ["worker-1", "claim-1"] }, T0, 2, "off")
    expect(claimed.value).toBeNull()
  })

  test("off stays silent even when a chain is too deep to route", () => {
    const { view, value } = step(
      emptyView(),
      { type: "ingest", args: ["user", { ...task("evt-deep"), hops: 9 }] },
      T0,
      1,
      "off",
    )

    expect(value).toMatchObject({ duplicate: false, routed: [], dropped: true })
    expect(eventRows(view)).toHaveLength(1)
    expect(cardRows(view)).toHaveLength(0)
  })

  test("observe queues the run as a proposal but hands nothing to a worker", () => {
    const ingested = step(emptyView(), { type: "ingest", args: ["user", task("evt-1")] }, T0, 1, "observe")

    expect(ingested.value).toMatchObject({ duplicate: false, routed: ["build"], dropped: false })
    expect(runRow(ingested.view, 1)).toMatchObject({ rule: "build", state: "queued" })

    const claimed = step(ingested.view, { type: "claimNext", args: ["worker-1", "claim-1"] }, T0, 2, "observe")
    expect(claimed.value).toBeNull()
    expect(runRow(claimed.view, 1)).toMatchObject({ state: "queued" })
  })

  test("flipping observe to auto claims the queued proposal — no work is lost", () => {
    const ingested = step(emptyView(), { type: "ingest", args: ["user", task("evt-1")] }, T0, 1, "observe")
    const refused = step(ingested.view, { type: "claimNext", args: ["worker-1", "claim-1"] }, T0, 2, "observe")
    expect(refused.value).toBeNull()

    const claimed = step(refused.view, { type: "claimNext", args: ["worker-1", "claim-1"] }, T0, 3, "auto")
    expect((claimed.value as Job)).toMatchObject({ run: 1, rule: "build", agent: "coder" })
    expect(runRow(claimed.view, 1)).toMatchObject({ state: "claimed" })
  })

  test("auto claims as before", () => {
    const ingested = step(emptyView(), { type: "ingest", args: ["user", task("evt-1")] }, T0, 1, "auto")
    const claimed = step(ingested.view, { type: "claimNext", args: ["worker-1", "claim-1"] }, T0, 2, "auto")
    expect((claimed.value as Job).run).toBe(1)
  })
})

describe("Silence rule", () => {
  test("ingest never notifies: three events in, zero cards out", () => {
    let view = emptyView()
    for (const id of ["evt-1", "evt-2", "evt-3"]) {
      view = step(view, { type: "ingest", args: ["user", task(id)] }, T0, 1, "auto").view
    }
    expect(eventRows(view)).toHaveLength(3)
    expect(cardRows(view)).toHaveLength(0)
  })

  test("a sweep in off mode still moves the run on, but tells nobody", () => {
    const ingested = step(emptyView(), { type: "ingest", args: ["user", task("evt-1")] }, T0, 1, "auto")
    const claimed = step(ingested.view, { type: "claimNext", args: ["worker-1", "claim-1"] }, T0, 2, "auto")
    expect((claimed.value as Job).run).toBe(1)

    // Ten minutes later, past the 5-minute run lease, with no heartbeat:
    // the run goes claimed → unknown → queued (the worker never showed
    // up), but no card is created in off mode.
    const swept = step(claimed.view, { type: "sweep", args: [] }, T0 + 10 * MINUTE, 3, "off")
    expect(runRow(swept.view, 1)).toMatchObject({ state: "queued" })
    expect(cardRows(swept.view)).toHaveLength(0)
  })

  test("the same sweep in auto mode tells the human the run went unknown", () => {
    const ingested = step(emptyView(), { type: "ingest", args: ["user", task("evt-1")] }, T0, 1, "auto")
    const claimed = step(ingested.view, { type: "claimNext", args: ["worker-1", "claim-1"] }, T0, 2, "auto")

    const swept = step(claimed.view, { type: "sweep", args: [] }, T0 + 10 * MINUTE, 3, "auto")
    expect(runRow(swept.view, 1)).toMatchObject({ state: "queued" })
    expect(cardRows(swept.view).map((card) => card["key"])).toEqual(["run:1:unknown"])
  })
})

describe("Router batching", () => {
  test("one ingestBatch pass records three events and queues one run for the lane", () => {
    const batched = step(
      emptyView(),
      { type: "ingestBatch", args: ["user", [task("evt-1"), task("evt-2"), task("evt-3")]] },
      T0,
      1,
      "auto",
    )

    expect(batched.value).toMatchObject({ received: 3, duplicates: 0, dropped: 0, routed: ["build"] })
    expect(eventRows(batched.view)).toHaveLength(3)
    expect(runRow(batched.view, 1)).toMatchObject({ rule: "build", state: "queued" })
    expect(Object.keys(batched.view["runs"] ?? {})).toHaveLength(1)
    expect(Object.keys(batched.view["run_events"] ?? {})).toHaveLength(3)
  })

  test("duplicates inside one batch and against the journal are recorded once", () => {
    const first = step(
      emptyView(),
      { type: "ingestBatch", args: ["user", [task("evt-1"), task("evt-1"), task("evt-2")]] },
      T0,
      1,
      "auto",
    )
    expect(first.value).toMatchObject({ received: 3, duplicates: 1 })
    expect(eventRows(first.view)).toHaveLength(2)

    const second = step(
      first.view,
      { type: "ingestBatch", args: ["user", [task("evt-1"), task("evt-2")]] },
      T0 + 1000,
      2,
      "auto",
    )
    expect(second.value).toMatchObject({ received: 2, duplicates: 2 })
    expect(second.facts).toEqual([])
    expect(eventRows(second.view)).toHaveLength(2)
  })

  test("a batch in off mode records the events and drops them all", () => {
    const batched = step(
      emptyView(),
      { type: "ingestBatch", args: ["user", [task("evt-1"), task("evt-2")]] },
      T0,
      1,
      "off",
    )
    expect(batched.value).toMatchObject({ received: 2, duplicates: 0, dropped: 2, routed: [] })
    expect(eventRows(batched.view)).toHaveLength(2)
    expect(runRow(batched.view, 1)).toBeUndefined()
  })

  test("a batch over the hard cap is rejected instead of growing one pass without bound", () => {
    const events = Array.from({ length: MAX_BATCH_EVENTS + 1 }, (_, index) => task(`evt-${index}`))
    expect(() =>
      decide(emptyView(), { type: "ingestBatch", args: ["user", events] }, T0, env(1, "auto")),
    ).toThrow(/до 200 событий/)
  })

  test("shouldFlushBatch fires on the size cap or when the window runs out", () => {
    expect(shouldFlushBatch(DEFAULT_BATCH_LIMITS.maxEvents, T0, T0, DEFAULT_BATCH_LIMITS)).toBe(true)
    expect(shouldFlushBatch(1, T0, T0 + DEFAULT_BATCH_LIMITS.windowMs, DEFAULT_BATCH_LIMITS)).toBe(true)
    expect(shouldFlushBatch(1, T0, T0 + DEFAULT_BATCH_LIMITS.windowMs - 1, DEFAULT_BATCH_LIMITS)).toBe(false)
    expect(shouldFlushBatch(0, T0, T0, DEFAULT_BATCH_LIMITS)).toBe(false)
  })
})

describe("Autonomy config", () => {
  test("no society setting means observe; an explicit setting wins", () => {
    expect(autonomyFromConfig(undefined)).toBe("observe")
    expect(autonomyFromConfig(new ConfigOrchestra.Info({}))).toBe("observe")
    expect(
      autonomyFromConfig(
        new ConfigOrchestra.Info({ society: new ConfigOrchestra.Society({ autonomy: "auto" }) }),
      ),
    ).toBe("auto")
    expect(
      autonomyFromConfig(
        new ConfigOrchestra.Info({ society: new ConfigOrchestra.Society({ autonomy: "off" }) }),
      ),
    ).toBe("off")
  })

  test("society autonomy decodes from config and rejects unknown modes", () => {
    const decoded = Schema.decodeUnknownSync(ConfigOrchestra.Info)({ society: { autonomy: "auto" } })
    expect(decoded.society?.autonomy).toBe("auto")
    expect(() =>
      Schema.decodeUnknownSync(ConfigOrchestra.Info)({ society: { autonomy: "sometimes" } }),
    ).toThrow()
  })

  test("batch limits come from the autoloop config, missing numbers fall back", () => {
    expect(batchLimitsFromConfig(undefined)).toEqual({})
    expect(
      batchLimitsFromConfig(new ConfigOrchestra.Autoloop({ batchWindowMs: 500, maxBatchEvents: 10 })),
    ).toEqual({ windowMs: 500, maxEvents: 10 })
    const decoded = Schema.decodeUnknownSync(ConfigOrchestra.Info)({
      autoloop: { batchWindowMs: 2000 },
    })
    expect(decoded.autoloop?.batchWindowMs).toBe(2000)
  })
})

/** A bus that records what the service publishes. */
const stubBus = (events: Array<{ type: string; data: unknown }>) =>
  Layer.succeed(
    Bus.Service,
    {
      publish: ((definition: { type: string }, data: unknown) => {
        events.push({ type: definition.type, data })
        return Effect.succeed(undefined as never)
      }) as unknown as Bus.Interface["publish"],
    } as unknown as Bus.Interface,
  )

const runManual = <A, E>(effect: Effect.Effect<A, E, Autoloop.Service | Scope.Scope>, dbPath = ":memory:") =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Autoloop.layer()),
      Effect.provide(Database.layer({ path: dbPath })),
      Effect.provide(stubBus([])),
      Effect.provideService(Global.Service, Global.make({ data: path.join(process.cwd(), ".test-data") })),
      Effect.scoped,
    ),
  )

describe("AutoloopService batching and autonomy", () => {
  test("ingestBatch commits a whole burst in one pass", () =>
    runManual(
      Effect.gen(function* () {
        const svc = yield* Autoloop.Service
        yield* svc.execute({ type: "rules", args: [rules] })
        const value = (yield* svc.ingestBatch("user", [task("evt-1"), task("evt-2"), task("evt-3")])) as {
          received: number
          duplicates: number
          routed: Array<string>
        }
        expect(value).toMatchObject({ received: 3, duplicates: 0, routed: ["build"] })
        const view = yield* svc.getView()
        expect(Object.keys(view["events"] ?? {})).toHaveLength(3)
        expect(Object.keys(view["runs"] ?? {})).toHaveLength(1)
      }),
    ))

  test("ingestEvent accumulates until flushBatch, then one pass takes the batch", () =>
    runManual(
      Effect.gen(function* () {
        const svc = yield* Autoloop.Service
        yield* svc.execute({ type: "rules", args: [rules] })
        yield* svc.ingestEvent("user", task("evt-1"))
        yield* svc.ingestEvent("user", task("evt-2"))
        const before = yield* svc.getView()
        expect(Object.keys(before["events"] ?? {})).toHaveLength(0)
        yield* svc.flushBatch()
        const after = yield* svc.getView()
        expect(Object.keys(after["events"] ?? {})).toHaveLength(2)
        expect(Object.keys(after["runs"] ?? {})).toHaveLength(1)
      }),
    ))

  test("configure observe blocks claims; configure auto lets them through", () =>
    runManual(
      Effect.gen(function* () {
        const svc = yield* Autoloop.Service
        yield* svc.execute({ type: "rules", args: [rules] })
        yield* svc.configure({ autonomy: "observe" })
        yield* svc.execute({ type: "ingest", args: ["user", task("evt-1")] })
        const refused = yield* svc.execute({ type: "claimNext", args: ["worker-1", "claim-1"] })
        expect(refused).toBeNull()
        yield* svc.configure({ autonomy: "auto" })
        const claimed = (yield* svc.execute({ type: "claimNext", args: ["worker-1", "claim-1"] })) as Job
        expect(claimed.run).toBe(1)
      }),
    ))
})
