import { describe, expect, test } from "bun:test"
import path from "path"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import { Deferred, Effect, Fiber, Layer, Ref, Scope, Stream } from "effect"
import { AutoloopCard } from "@orchestra/schema/autoloop-card"
import { KV } from "@orchestra/core/kv"
import { SessionContinuation } from "@orchestra/core/session/continuation"
import { Bus } from "@orchestra/core/bus"
import { Database } from "@orchestra/core/database/database"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Autoloop } from "@orchestra/core/autoloop/service"
import { createRun, finishRun } from "@orchestra/core/autoloop/orchestrator"
import type { RunRow } from "@orchestra/core/autoloop/kernel/decide"
import { emptyRules } from "@orchestra/core/autoloop/kernel/rules"
import type { Rules } from "@orchestra/core/autoloop/kernel/rules"
import { AutoloopStore } from "@orchestra/core/autoloop/kernel/store"
import { Global } from "@orchestra/util/global"
import { testEffect } from "../lib/effect"

const MINUTE = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

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

const cronRules: Rules = {
  ...rules,
  rules: [
    ...rules.rules,
    {
      name: "nightly",
      when: { cron: "* * * * *" },
      to: "coder",
      cwd: "/tmp/work",
      group: "nightly",
      tell: "needed",
    },
  ],
}

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, Autoloop.node, SessionContinuation.node, KV.node])),
)

const runRow = (view: Record<string, Record<string, unknown>>, id: number) =>
  view["runs"]?.[String(id)] as RunRow | undefined
const cardRows = (view: Record<string, Record<string, unknown>>) =>
  Object.values(view["cards"] ?? {}) as Array<Record<string, unknown>>
const timerRow = (view: Record<string, Record<string, unknown>>, id: number) =>
  view["timers"]?.[String(id)] as Record<string, unknown> | undefined

const fullRun = (overrides: Partial<RunRow>): RunRow => ({
  id: 1,
  rule: "build",
  agent: "coder",
  grp: "build",
  lane: "",
  state: "queued",
  attempts: 0,
  verifyIterations: 0,
  claim: null,
  issued: null,
  last_issued: null,
  last_result: null,
  last_answer: null,
  cancel_at: null,
  resume: null,
  session: null,
  link: null,
  claimed_at: null,
  seen_at: null,
  finished_at: null,
  summary: null,
  error: null,
  error_fingerprint: null,
  error_repeat: 0,
  error_history: null,
  fix_test_file: null,
  fix_test_run: null,
  verification: null,
  usage: null,
  not_before: iso(Date.now()),
  created_at: iso(Date.now()),
  rules_version: 1,
  ...overrides,
})

const putRow = (collection: string, key: string, data: Record<string, unknown>) => ({
  id: `seed:${collection}:${key}`,
  type: "test.seed",
  collection,
  key,
  data,
})

/** Poll a check until it returns a non-null value, or fail after the timeout. */
const until = <A, E, R>(effect: Effect.Effect<A | null, E, R>, timeoutMs = 5000): Effect.Effect<A, E | Error, R> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const result = yield* effect
      if (result !== null) return result
      if (Date.now() >= deadline) return yield* Effect.fail(new Error("timed out waiting for the condition"))
      yield* Effect.sleep("50 millis")
    }
  })

const setRules = (svc: Autoloop.Interface, given: Rules) => svc.execute({ type: "rules", args: [given] })

/** A bus that records what the service publishes, or fails every publish. */
const stubBus = (events: Array<{ type: string; data: unknown }>, fail: boolean) =>
  Layer.succeed(Bus.Service, {
    publish: ((definition: { type: string }, data: unknown) => {
      if (fail) return Effect.fail(new Error("bus down"))
      events.push({ type: definition.type, data })
      return Effect.succeed(undefined as never)
    }) as unknown as Bus.Interface["publish"],
  } as unknown as Bus.Interface)

const runManual = <A, E>(
  effect: Effect.Effect<A, E, Autoloop.Service | Scope.Scope>,
  bus: Layer.Layer<Bus.Service>,
  dbPath = ":memory:",
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Autoloop.layer()),
      Effect.provide(Database.layer({ path: dbPath })),
      Effect.provide(bus),
      Effect.provideService(Global.Service, Global.make({ data: path.join(process.cwd(), ".test-data") })),
      Effect.scoped,
    ),
  )

describe("AutoloopService tick", () => {
  it.live("holds the clock until resume recovery refreshes a still-owned lease", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service,
        control = yield* SessionContinuation.Service
      yield* setRules(svc, rules)
      yield* svc.execute({
        type: "ingest",
        args: ["user", { id: "pause-lease", type: "task.created", subject: "lease" }],
      })
      const job = (yield* svc.execute({ type: "claimNext", args: ["worker-1", "paused-claim"] })) as {
        run: number
        token: string
      }
      yield* control.set(false)
      yield* AutoloopStore.commitLatest([
        putRow("runs", String(job.run), {
          ...runRow(yield* svc.getView(), job.run)!,
          seen_at: iso(Date.now() - 30 * MINUTE),
        }),
      ])
      const ready = yield* Deferred.make<void>(),
        allow = yield* Deferred.make<void>()
      const remove = control.listen(
        (enabled) =>
          !enabled
            ? Effect.void
            : Effect.gen(function* () {
                yield* Deferred.succeed(ready, undefined)
                yield* Deferred.await(allow)
                yield* svc.heartbeat("worker-1", [job.run]).pipe(Effect.orDie)
              }),
        20,
      )
      yield* Effect.addFinalizer(() => Effect.sync(remove))
      yield* svc.start()
      const resume = yield* control.set(true).pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      yield* Effect.sleep(100)
      expect(runRow(yield* svc.getView(), job.run)?.state).toBe("claimed")
      expect((yield* svc.stats()).ticks).toBe(0)
      yield* Deferred.succeed(allow, undefined)
      yield* Fiber.join(resume)
      yield* Effect.sleep(100)
      const after = runRow(yield* svc.getView(), job.run)
      expect(after?.state).toBe("claimed")
      expect(after?.claim).toBe("paused-claim")
      expect(Date.parse(after!.seen_at!)).toBeGreaterThan(Date.now() - 5000)
    }).pipe(Effect.scoped),
  )

  it.live("rejects direct work admission while OFF but retains incoming events", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service,
        control = yield* SessionContinuation.Service
      yield* setRules(svc, rules)
      yield* control.set(false)
      yield* svc.execute({
        type: "ingest",
        args: ["user", { id: "paused-incoming", type: "task.created", subject: "retained" }],
      })
      for (const input of [
        { type: "tick", args: [] },
        { type: "claimNext", args: ["worker-1", "bypass"] },
        { type: "sweep", args: [] },
      ] as const) {
        const result = yield* svc.execute({ ...input, args: [...input.args] }).pipe(Effect.result)
        expect(result._tag).toBe("Failure")
      }
      expect(runRow(yield* svc.getView(), 1)?.state).toBe("queued")
      yield* control.set(true)
      expect(yield* svc.execute({ type: "claimNext", args: ["worker-1", "now-allowed"] })).toMatchObject({ run: 1 })
    }),
  )

  it.live("does not fire due timers while operator-paused and wakes the clock on ON", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service,
        control = yield* SessionContinuation.Service
      yield* control.set(false)
      yield* svc.start()
      yield* setRules(svc, rules)
      yield* AutoloopStore.commitLatest([
        putRow("timers", "1", {
          id: 1,
          rule: "build",
          lane: "",
          key: "paused",
          source: "user",
          at: iso(Date.now() - 100),
          about: "retained",
          session: null,
          hops: 0,
          event_id: null,
          created_at: iso(Date.now()),
        }),
      ])
      yield* svc.heartbeat("worker-1", [])
      yield* Effect.sleep(100)
      expect(timerRow(yield* svc.getView(), 1)?.event_id).toBeNull()
      expect((yield* svc.stats()).ticks).toBe(0)
      yield* control.set(true)
      yield* until(
        Effect.gen(function* () {
          return timerRow(yield* svc.getView(), 1)?.event_id ? true : null
        }),
      )
      expect(runRow(yield* svc.getView(), 1)).toMatchObject({ rule: "build", state: "queued" })
    }),
  )

  it.live("wakes a due later timer and queues its run", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      yield* svc.start()
      yield* setRules(svc, rules)
      const at = Date.now() + 150
      yield* AutoloopStore.commitLatest([
        putRow("timers", "1", {
          id: 1,
          rule: "build",
          lane: "",
          key: "review",
          source: "user",
          at: iso(at),
          about: "check later",
          session: null,
          hops: 0,
          event_id: null,
          created_at: iso(Date.now()),
        }),
      ])
      // Seeding writes the journal directly, so wake the loop with a heartbeat.
      yield* svc.heartbeat("worker-1", [])

      const fired = yield* until(
        Effect.gen(function* () {
          const view = yield* svc.getView()
          const timer = timerRow(view, 1)
          return timer?.["event_id"] !== null && timer?.["event_id"] !== undefined ? timer : null
        }),
      )
      expect(fired["event_id"]).toBe(1)
      const view = yield* svc.getView()
      expect(runRow(view, 1)).toMatchObject({ rule: "build", state: "queued" })
      expect((yield* svc.stats()).ticks).toBeGreaterThanOrEqual(1)
    }),
  )

  it.live("wakes a due cron schedule and queues its run", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      yield* svc.start()
      yield* setRules(svc, cronRules)
      yield* AutoloopStore.commitLatest([
        putRow("schedules", "nightly", {
          rule: "nightly",
          cron: "* * * * *",
          next_at: iso(Date.now() + 150),
        }),
      ])
      yield* svc.heartbeat("worker-1", [])

      const view = yield* until(
        Effect.gen(function* () {
          const seen = yield* svc.getView()
          return runRow(seen, 1)?.rule === "nightly" ? seen : null
        }),
      )
      expect(runRow(view, 1)).toMatchObject({ rule: "nightly", state: "queued" })
      expect(Object.values(view["events"] ?? {})).toHaveLength(1)
      expect((yield* svc.stats()).ticks).toBeGreaterThanOrEqual(1)
    }),
  )

  it.live("wakes at a retry pause and runs exactly one tick", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      yield* svc.start()
      yield* setRules(svc, rules)
      yield* AutoloopStore.commitLatest([putRow("runs", "1", fullRun({ not_before: iso(Date.now() + 200) }))])
      yield* svc.heartbeat("worker-1", [])

      const stats = yield* until(
        Effect.gen(function* () {
          const current = yield* svc.stats()
          return current.ticks >= 1 ? current : null
        }),
      )
      expect(stats.ticks).toBe(1)
      // The tick wakes the retry; it does not claim it, and it does not fire again.
      const view = yield* svc.getView()
      expect(runRow(view, 1)).toMatchObject({ state: "queued" })
      yield* Effect.sleep("200 millis")
      expect((yield* svc.stats()).ticks).toBe(1)
    }),
  )

  it.live("sweep marks a claimed run unknown when its worker stays fresh but the run goes quiet", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      yield* svc.start()
      yield* setRules(svc, rules)
      const now = Date.now()
      yield* AutoloopStore.commitLatest([
        putRow("seen", "worker:worker-1", {
          kind: "worker",
          name: "worker-1",
          seen_at: iso(now - 30_000),
        }),
        putRow(
          "runs",
          "1",
          fullRun({
            state: "claimed",
            claim: "claim-1",
            claimed_at: iso(now - 6 * MINUTE),
            seen_at: iso(now - 6 * MINUTE),
            created_at: iso(now - 10 * MINUTE),
          }),
        ),
      ])
      yield* svc.heartbeat("worker-1", [])

      const view = yield* until(
        Effect.gen(function* () {
          const seen = yield* svc.getView()
          return runRow(seen, 1)?.state === "unknown" ? seen : null
        }),
      )
      expect(runRow(view, 1)).toMatchObject({ state: "unknown" })
      expect(cardRows(view).map((card) => card["key"])).toContain("run:1:unknown")
    }),
  )

  it.live("sweep tells the owner when a worker never comes", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      yield* svc.start()
      yield* setRules(svc, rules)
      const now = Date.now()
      yield* AutoloopStore.commitLatest([
        putRow("runs", "1", fullRun({ created_at: iso(now - 11 * MINUTE), not_before: iso(now - 11 * MINUTE) })),
      ])
      // A channel seen wakes the loop without stamping the worker as seen.
      yield* svc.execute({ type: "channelSeen", args: ["web"] })

      const view = yield* until(
        Effect.gen(function* () {
          const seen = yield* svc.getView()
          return cardRows(seen).some((card) => String(card["key"]).startsWith("worker:worker-1:offline:")) ? seen : null
        }),
      )
      const card = cardRows(view).find((candidate) => String(candidate["key"]).startsWith("worker:worker-1:offline:"))
      expect(card).toMatchObject({ title: "Исполнитель не на связи", state: "open" })
    }),
  )

  it.live("with nothing due the clock runs no ticks, and fires exactly once at the next due", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      yield* svc.start()
      yield* setRules(svc, rules)
      yield* Effect.sleep("400 millis")
      expect((yield* svc.stats()).ticks).toBe(0)
      expect(yield* AutoloopStore.readLog()).toHaveLength(1)

      yield* AutoloopStore.commitLatest([
        putRow("timers", "1", {
          id: 1,
          rule: "build",
          lane: "",
          key: "review",
          source: "user",
          at: iso(Date.now() + 200),
          about: "check later",
          session: null,
          hops: 0,
          event_id: null,
          created_at: iso(Date.now()),
        }),
      ])
      yield* svc.execute({ type: "channelSeen", args: ["web"] })

      yield* until(
        Effect.gen(function* () {
          const view = yield* svc.getView()
          const timer = timerRow(view, 1)
          return timer?.["event_id"] !== null && timer?.["event_id"] !== undefined ? timer : null
        }),
      )
      // One timer on the nearest due: the loop fired once, at the due — it never polled.
      expect((yield* svc.stats()).ticks).toBe(1)
    }),
  )
})

describe("AutoloopService execute", () => {
  it.live("notifies subscribers of the new view", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      yield* setRules(svc, rules)
      const received = yield* svc.subscribe().pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* svc.execute({
        type: "ingest",
        args: ["user", { id: "evt-1", type: "task.created", subject: "task-1", summary: "make it" }],
      })

      const views = yield* Fiber.join(received)
      expect(views).toHaveLength(1)
      expect(runRow(views[0]!, 1)).toMatchObject({ rule: "build", state: "queued" })
    }),
  )

  it.live("heartbeat marks the worker seen, and a second heartbeat within a minute writes nothing", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      yield* svc.heartbeat("worker-1", [])
      const first = yield* svc.getView()
      const firstSeen = first["seen"]?.["worker:worker-1"] as Record<string, unknown> | undefined
      expect(firstSeen?.["kind"]).toBe("worker")
      expect(typeof firstSeen?.["seen_at"]).toBe("string")

      yield* svc.heartbeat("worker-1", [])
      const second = yield* svc.getView()
      expect(second["seen"]?.["worker:worker-1"]).toEqual(firstSeen)
    }),
  )

  it.live("an unknown input fails instead of writing", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      const error = yield* svc.execute({ type: "nope", args: [] }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Autoloop.ServiceFailure)
      expect(error).toMatchObject({ code: "invalid" })
      expect(yield* AutoloopStore.readLog()).toHaveLength(0)
    }),
  )
})

describe("AutoloopService delivery", () => {
  it.live("publishes a new card to web exactly once and marks it delivered", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      const bus = yield* Bus.Service
      yield* svc.start()
      const delivered = yield* Ref.make(0)
      yield* bus.subscribe(AutoloopCard.Event.Created).pipe(
        Stream.runForEach(() => Ref.update(delivered, (count) => count + 1)),
        Effect.forkScoped,
      )
      yield* Effect.yieldNow
      yield* svc.execute({ type: "createCard", args: [{ key: "hello", title: "hi", text: "hello" }] })
      yield* Effect.sleep("300 millis")

      expect(yield* Ref.get(delivered)).toBe(1)
      const view = yield* svc.getView()
      const card = cardRows(view)[0]!
      expect(card).toMatchObject({ title: "hi", state: "open" })
      const delivery = view["deliveries"]?.["1:web"] as Record<string, unknown> | undefined
      expect(delivery).toMatchObject({ given_up: 0, tries: 0, version: card["version"] })
    }),
  )

  test("a failed delivery comes back on the resend schedule", async () => {
    const events: Array<{ type: string; data: unknown }> = []
    await runManual(
      Effect.gen(function* () {
        const svc = yield* Autoloop.Service
        yield* svc.execute({ type: "createCard", args: [{ key: "hello", title: "hi", text: "hello" }] })
        const view = yield* svc.getView()
        const delivery = view["deliveries"]?.["1:web"] as Record<string, unknown> | undefined
        // Handed out once, publish failed: it rests a minute (RESEND_AT[1]) and tries again.
        expect(delivery).toMatchObject({ tries: 1, given_up: 0 })
        expect(typeof delivery?.["not_before"]).toBe("string")
        expect(typeof delivery?.["error"]).toBe("string")
        const due = view["due"]?.["delivery:1:web"] as Record<string, unknown> | undefined
        expect(due?.["at"]).toBe(delivery?.["not_before"])
        expect(events).toHaveLength(0)
      }),
      stubBus(events, true),
    )
  })

  test("a restart restores the runs and cards from the journal", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-autoloop-restart-"))
    try {
      const dbPath = path.join(dir, "orchestra-local.db")
      const events: Array<{ type: string; data: unknown }> = []
      const bus = stubBus(events, false)
      await runManual(
        Effect.gen(function* () {
          const svc = yield* Autoloop.Service
          yield* svc.start()
          yield* setRules(svc, rules)
          yield* svc.execute({
            type: "ingest",
            args: ["user", { id: "evt-1", type: "task.created", subject: "task-1", summary: "make it" }],
          })
          yield* svc.execute({ type: "createCard", args: [{ key: "hello", title: "hi" }] })
        }),
        bus,
        dbPath,
      )
      // A fresh service on the same journal: nothing was only in memory.
      await runManual(
        Effect.gen(function* () {
          const svc = yield* Autoloop.Service
          const view = yield* svc.getView()
          expect(runRow(view, 1)).toMatchObject({ rule: "build", state: "queued" })
          expect(cardRows(view)).toHaveLength(1)
          expect(cardRows(view)[0]).toMatchObject({ key: "hello", title: "hi", state: "open" })
          expect((view["config"]?.["rules"] as Record<string, unknown> | undefined)?.["value"]).toMatchObject({
            timezone: "UTC",
          })
        }),
        bus,
        dbPath,
      )
      expect(events.map((event) => event.type)).toContain("autoloop.card.created")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("AutoloopService claim tokens", () => {
  test("a claim token from one process does not verify in another", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orchestra-autoloop-secret-"))
    const dbPath = path.join(dir, "autoloop.db")
    try {
      const events: Array<{ type: string; data: unknown }> = []
      const created = await runManual(
        Effect.gen(function* () {
          const svc = yield* Autoloop.Service
          const created = yield* createRun(svc, {
            sessionID: "worker-1",
            projectID: "project-1",
            text: "fix the bug",
            messageID: "msg-1",
          })
          expect(created).not.toBeNull()
          return created!
        }),
        stubBus(events, false),
        dbPath,
      )
      // A new service instance over the same journal has a different secret,
      // so the old token must not verify: the run cannot be finished by it.
      const failure = await runManual(
        Effect.gen(function* () {
          const svc = yield* Autoloop.Service
          return yield* finishRun(svc, { ...created, receipt: { outcome: "done", summary: "fixed" } }).pipe(Effect.flip)
        }),
        stubBus(events, false),
        dbPath,
      )
      expect(failure).toMatchObject({ code: "forbidden" })
      // The normal flow still works inside one process: claim and finish
      // with the same service instance.
      await runManual(
        Effect.gen(function* () {
          const svc = yield* Autoloop.Service
          const second = yield* createRun(svc, {
            sessionID: "worker-2",
            projectID: "project-1",
            text: "fix the other bug",
            messageID: "msg-2",
          })
          expect(second).not.toBeNull()
          expect(yield* finishRun(svc, { ...second!, receipt: { outcome: "done", summary: "fixed" } })).toMatchObject({
            status: "finished",
          })
        }),
        stubBus(events, false),
        dbPath,
      )
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})


it.live("project pause protects only its leases and claims while other projects advance",()=>Effect.gen(function*(){
 const svc=yield* Autoloop.Service,kv=yield* KV.Service
 yield* svc.execute({type:"rules",args:[{...rules,rules:rules.rules.map(r=>({...r,parallel:4}))}]})
 yield* kv.set("orchestra/project/prj_pause_a",{workEnabled:true})
 yield* kv.set("orchestra/project/prj_pause_b",{workEnabled:true})
 const jobs:{run:number;token:string}[]=[]
 for(const [i,p] of ["a","b"].entries()){
  yield* svc.execute({type:"ingest",args:["user",{id:"project-pause-"+p,type:"task.created",subject:p,detail:"project:prj_pause_"+p}]})
  jobs.push((yield* svc.execute({type:"claimNext",args:["worker-1","project-claim-"+i]})) as {run:number;token:string})
 }
 expect(jobs[0]).not.toBeNull();expect(jobs[1]).not.toBeNull()
 yield* kv.set("orchestra/project/prj_pause_a",{workEnabled:false})
 for(const job of jobs)yield* AutoloopStore.commitLatest([putRow("runs",String(job.run),{...runRow(yield* svc.getView(),job.run)!,seen_at:iso(Date.now()-30*MINUTE)})])
 yield* svc.execute({type:"sweep",args:[]})
 expect(runRow(yield* svc.getView(),jobs[0].run)?.state).toBe("claimed")
 expect(runRow(yield* svc.getView(),jobs[1].run)?.state).toBe("queued")
 yield* svc.execute({type:"ingest",args:["user",{id:"paused-new",type:"task.created",subject:"a-new",detail:"project:prj_pause_a"}]})
 const next=(yield* svc.execute({type:"claimNext",args:["worker-1","other-claim"]})) as {run:number}
 expect(next.run).toBe(jobs[1].run)
 expect((yield* svc.getView()).runs["3"]).toMatchObject({state:"queued"})
}))
