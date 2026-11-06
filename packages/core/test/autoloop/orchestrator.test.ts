import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ConfigOrchestra } from "@orchestra/schema/config/orchestra"
import { Document, Info } from "@orchestra/schema/config"
import { Bus } from "@orchestra/core/bus"
import { Config } from "@orchestra/core/config"
import { Database } from "@orchestra/core/database/database"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Autoloop } from "@orchestra/core/autoloop/service"
import {
  WORKER,
  cancelRun,
  claimDueRun,
  createRun,
  finishRun,
  limitsFromConfig,
  looksLikeNothing,
  mergeDispatchRule,
  orchestraRules,
  readRun,
  receiptForReport,
} from "@orchestra/core/autoloop/orchestrator"
import { emptyRules } from "@orchestra/core/autoloop/kernel/rules"
import { testEffect } from "../lib/effect"

const MINUTE = 60_000

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, Autoloop.node])))

const cardKeys = (view: Record<string, Record<string, unknown>>) =>
  Object.values(view["cards"] ?? {}).map((card) => (card as Record<string, unknown>)["key"])

const task = { sessionID: "worker-1", projectID: "project-1", text: "fix the bug", messageID: "msg-1" }

const setRules = (svc: Autoloop.Interface) => svc.execute({ type: "rules", args: [orchestraRules()] })

/** Dispatch a task, then hand back its run and token. */
const dispatch = (svc: Autoloop.Interface) =>
  Effect.gen(function* () {
    yield* setRules(svc)
    const created = yield* createRun(svc, task)
    expect(created).not.toBeNull()
    return created!
  })

const failedReceipt = { outcome: "failed" as const, error: "boom" }

describe("AutoloopOrchestrator rules and limits", () => {
  test("orchestraRules routes task.created from the orchestrator to one lane per worker session", () => {
    const rules = orchestraRules()
    expect(rules.rules).toHaveLength(1)
    expect(rules.rules[0]).toMatchObject({
      name: "orchestra-task",
      when: { source: "orchestra", types: ["task.created"] },
      to: "orchestrator",
      group: "orchestra",
      tell: "needed",
      parallel: 30,
    })
    expect(rules.agents["orchestrator"]).toMatchObject({ worker: "orchestra", use: "orchestra" })
  })

  test("limitsFromConfig takes only the numbers the operator set", () => {
    expect(limitsFromConfig(undefined)).toEqual({})
    expect(limitsFromConfig(new ConfigOrchestra.Autoloop({ maxAttempts: 1 }))).toEqual({ maxAttempts: 1 })
  })

  test("mergeDispatchRule appends the dispatch rule and keeps the operator rules", () => {
    const stored = {
      ...emptyRules("UTC"),
      rules: [
        {
          name: "nightly",
          when: { cron: "0 0 * * *" },
          to: "orchestrator",
          cwd: "",
          group: "nightly",
          tell: "needed" as const,
        },
      ],
    }
    const merged = mergeDispatchRule(stored)
    expect(merged.rules.map((rule) => rule.name)).toEqual(["nightly", "orchestra-task"])
    expect(merged.rules[1]).toMatchObject({ when: { source: "orchestra", types: ["task.created"] } })
  })

  test("mergeDispatchRule leaves a stored dispatch rule alone", () => {
    const merged = mergeDispatchRule(orchestraRules())
    expect(merged.rules.map((rule) => rule.name)).toEqual(["orchestra-task"])
  })

  test("receiptForReport maps every session outcome to a receipt", () => {
    const base = { state: "done" as const, outcome: "complete" as const, summary: "ok", workerRemoved: false }
    expect(receiptForReport(base)).toMatchObject({ outcome: "done" })
    expect(receiptForReport({ ...base, state: "failed" })).toMatchObject({ outcome: "failed" })
    expect(receiptForReport({ ...base, state: "stopped" })).toMatchObject({ outcome: "cancelled" })
    expect(receiptForReport({ ...base, state: "recovered", outcome: "complete" })).toMatchObject({ outcome: "done" })
    expect(receiptForReport({ ...base, state: "recovered", outcome: "partial" })).toMatchObject({
      outcome: "done",
      verifyFailed: true,
    })
    expect(receiptForReport({ ...base, state: "nothing" })).toMatchObject({ outcome: "nothing" })
    expect(receiptForReport({ ...base, workerRemoved: true })).toMatchObject({ outcome: "failed" })
  })

  test("receiptForReport turns a partial DONE into a failed verification, not a done run", () => {
    const base = { state: "done" as const, outcome: "partial" as const, summary: "half done", workerRemoved: false }
    expect(receiptForReport(base)).toMatchObject({ outcome: "done", verifyFailed: true })
    expect(receiptForReport(base).verifyFailed).toBe(true)
    // A worker that admits the task failed or is not done is a failed run, never a done one.
    expect(receiptForReport({ ...base, outcome: "failed" })).toMatchObject({ outcome: "failed" })
    expect(receiptForReport({ ...base, outcome: "incomplete" })).toMatchObject({ outcome: "failed" })
    // No status line at all: no claim was made either way, so the run still ends done.
    expect(receiptForReport({ ...base, outcome: "unknown" })).toMatchObject({ outcome: "done" })
    expect(receiptForReport({ ...base, outcome: "unknown" }).verifyFailed).toBeUndefined()
    // A complete DONE stays a plain done receipt: no verification round.
    expect(receiptForReport({ ...base, outcome: "complete" }).verifyFailed).toBeUndefined()
  })

  test("looksLikeNothing needs both no answer and no trace of work", () => {
    expect(looksLikeNothing("(no text answer)", "")).toBe(true)
    expect(looksLikeNothing("some answer", "")).toBe(false)
    expect(looksLikeNothing("(no text answer)", "ran a command")).toBe(false)
  })
})

describe("AutoloopOrchestrator createRun and finishRun", () => {
  it.live("createRun claims the run and records the worker session on it", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      const created = yield* dispatch(svc)
      const row = yield* readRun(svc, created.run)
      expect(row).toMatchObject({ state: "claimed", session: "worker-1" })
      const view = yield* svc.getView()
      const seen = view["seen"]?.["worker:orchestra"] as Record<string, unknown> | undefined
      expect(seen?.["kind"]).toBe("worker")
    }),
  )

  it.live("createRun installs the dispatch rule when the journal has none", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      const created = yield* createRun(svc, task)
      expect(created).not.toBeNull()
      expect(yield* readRun(svc, created!.run)).toMatchObject({ state: "claimed", session: "worker-1" })
      const view = yield* svc.getView()
      const stored = (view["config"]?.["rules"] as Record<string, unknown> | undefined)?.["value"] as
        | { rules: Array<{ name: string }> }
        | undefined
      expect(stored?.rules.map((rule) => rule.name)).toContain("orchestra-task")
    }),
  )

  it.live("createRun returns null when 30 runs are already in flight", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      for (let index = 0; index < 30; index++) {
        const created = yield* createRun(svc, {
          ...task,
          sessionID: `worker-${index}`,
          messageID: `msg-${index}`,
        })
        expect(created).not.toBeNull()
      }
      expect(yield* createRun(svc, { ...task, sessionID: "worker-31", messageID: "msg-31" })).toBeNull()
    }),
  )

  it.live("finish done ends the run, and a second finish of the same receipt changes nothing", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      const created = yield* dispatch(svc)
      const receipt = { outcome: "done" as const, summary: "fixed" }
      expect(yield* finishRun(svc, { ...created, receipt })).toMatchObject({ status: "finished", rejected: [] })
      expect(yield* readRun(svc, created.run)).toMatchObject({ state: "done" })
      expect(yield* finishRun(svc, { ...created, receipt })).toMatchObject({ status: "already-finished" })
      expect(yield* readRun(svc, created.run)).toMatchObject({ state: "done" })
    }),
  )

  it.live("finish nothing ends the run as nothing", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      const created = yield* dispatch(svc)
      expect(
        yield* finishRun(svc, { ...created, receipt: { outcome: "nothing" as const, summary: "no work" } }),
      ).toMatchObject({ status: "finished" })
      expect(yield* readRun(svc, created.run)).toMatchObject({ state: "nothing" })
    }),
  )

  it.live("a partial DONE requeues the run as a failed verification instead of ending it done", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      const created = yield* dispatch(svc)
      // This is the production path: the receipt comes from receiptForReport,
      // not hand-built — a DONE the transcript cannot back up must not end the run.
      const receipt = receiptForReport({
        state: "done",
        outcome: "partial",
        summary: "Reported DONE but no check ran",
        workerRemoved: false,
      })
      expect(receipt.verifyFailed).toBe(true)
      expect(yield* finishRun(svc, { ...created, receipt })).toMatchObject({ status: "finished", rejected: [] })
      expect(yield* readRun(svc, created.run)).toMatchObject({ state: "queued", verifyIterations: 1 })
      // The requeued run is claimable again: another fix round, not a finished task.
      const retry = (yield* svc.execute(
        { type: "claimNext", args: [WORKER, "dispatch:msg-1-verify-retry"] },
        Date.now() + MINUTE,
      )) as { run: number; token: string } | null
      expect(retry?.run).toBe(created.run)
      expect(yield* finishRun(svc, { run: retry!.run, token: retry!.token, receipt })).toMatchObject({
        status: "finished",
      })
      expect(yield* readRun(svc, created.run)).toMatchObject({ state: "queued", verifyIterations: 2 })
    }),
  )

  it.live("finish failed retries once, then stops the run and opens a card", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      const created = yield* dispatch(svc)
      expect(yield* finishRun(svc, { ...created, receipt: failedReceipt })).toMatchObject({ status: "finished" })
      const once = yield* readRun(svc, created.run)
      expect(once).toMatchObject({ state: "queued", attempts: 1 })
      expect(Date.parse(once!.not_before)).toBeGreaterThan(Date.now())

      const retry = (yield* svc.execute(
        { type: "claimNext", args: [WORKER, "dispatch:msg-1-retry"] },
        Date.now() + 6 * MINUTE,
      )) as { run: number; token: string } | null
      expect(retry?.run).toBe(created.run)
      expect(yield* finishRun(svc, { run: retry!.run, token: retry!.token, receipt: failedReceipt })).toMatchObject({
        status: "finished",
      })
      expect(yield* readRun(svc, created.run)).toMatchObject({ state: "cancelled", attempts: 2 })
      expect(cardKeys(yield* svc.getView())).toContain(`run:${created.run}:stopped`)
    }),
  )

  it.live("a failed run is re-claimed FIFO after its retry pause, via claimDueRun", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      const created = yield* dispatch(svc)
      expect(yield* finishRun(svc, { ...created, receipt: failedReceipt })).toMatchObject({ status: "finished" })
      expect(yield* readRun(svc, created.run)).toMatchObject({ state: "queued", attempts: 1 })
      // A newer task arrives while the failed run waits out its retry pause.
      // It queues behind the failed run: same rule, another worker's lane.
      yield* svc.execute({
        type: "ingest",
        args: [
          "orchestra",
          {
            id: "msg-2",
            type: "task.created",
            subject: "worker-2",
            summary: "second task",
            detail: "project:project-1",
            link: "",
            hops: 0,
          },
        ],
      })
      const queued = (Object.values((yield* svc.getView())["runs"] ?? {}) as Array<{ id: number; state: string }>)
        .filter((run) => run.state === "queued")
        .map((run) => run.id)
      expect(queued).toHaveLength(2)
      expect(queued).toContain(created.run)

      // New work goes first while the failed run waits out its pause.
      const fresh = yield* claimDueRun(svc)
      expect(fresh?.run).not.toBe(created.run)
      // After the pause, the oldest due run is the failed one — it comes back.
      const retry = yield* claimDueRun(svc, Date.now() + 6 * MINUTE)
      expect(retry?.run).toBe(created.run)
      expect(retry?.session).toBe("worker-1")
      // A second failure stops it; nothing is left to claim.
      expect(
        yield* finishRun(svc, { run: retry!.run, token: retry!.token, receipt: failedReceipt }),
      ).toMatchObject({ status: "finished" })
      expect(yield* readRun(svc, created.run)).toMatchObject({ state: "cancelled", attempts: 2 })
      expect(yield* claimDueRun(svc, Date.now() + 6 * MINUTE)).toBeNull()
    }),
  )

  it.live("finish cancelled ends the run finally, with no retry and no stop card", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      const created = yield* dispatch(svc)
      expect(
        yield* finishRun(svc, { ...created, receipt: { outcome: "cancelled" as const, summary: "stopped" } }),
      ).toMatchObject({ status: "finished" })
      expect(yield* readRun(svc, created.run)).toMatchObject({ state: "cancelled", attempts: 0 })
      expect(cardKeys(yield* svc.getView())).not.toContain(`run:${created.run}:stopped`)
    }),
  )

  it.live("finishRun on a run the journal never saw reports missing", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      expect(
        yield* finishRun(svc, { run: 99, token: "nope", receipt: { outcome: "done" as const } }),
      ).toMatchObject({ status: "missing" })
    }),
  )

  it.live("cancelRun ends a claimed run as cancelled", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      const created = yield* dispatch(svc)
      yield* cancelRun(svc, { ...created, reason: "never reached the worker" })
      expect(yield* readRun(svc, created.run)).toMatchObject({ state: "cancelled" })
    }),
  )

  it.live("readRun reads the run from the journal, not from memory", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      const created = yield* dispatch(svc)
      expect(yield* readRun(svc, created.run)).toMatchObject({ id: created.run, rule: "orchestra-task" })
      expect(yield* readRun(svc, 99)).toBeUndefined()
    }),
  )
})

describe("AutoloopOrchestrator config", () => {
  it.live("configure applies operator limits: one failure stops the run at once", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      yield* svc.configure({ limits: { maxAttempts: 1 } })
      const created = yield* dispatch(svc)
      expect(yield* finishRun(svc, { ...created, receipt: failedReceipt })).toMatchObject({ status: "finished" })
      expect(yield* readRun(svc, created.run)).toMatchObject({ state: "cancelled", attempts: 1 })
      expect(cardKeys(yield* svc.getView())).toContain(`run:${created.run}:stopped`)
    }),
  )

  it.live("the first execute in a config-bearing context applies the operator limits itself", () =>
    Effect.gen(function* () {
      const svc = yield* Autoloop.Service
      yield* setRules(svc)
      const config = Config.testLayer([
        new Document({
          type: "document",
          info: new Info({
            orchestra: new ConfigOrchestra.Info({
              autoloop: new ConfigOrchestra.Autoloop({ maxAttempts: 1 }),
            }),
          }),
        }),
      ])
      const created = yield* createRun(svc, task).pipe(Effect.provide(config))
      expect(created).not.toBeNull()
      expect(yield* finishRun(svc, { ...created!, receipt: failedReceipt })).toMatchObject({ status: "finished" })
      expect(yield* readRun(svc, created!.run)).toMatchObject({ state: "cancelled", attempts: 1 })
      expect(cardKeys(yield* svc.getView())).toContain(`run:${created!.run}:stopped`)
    }),
  )
})

describe("AutoloopOrchestrator fix-task proof passthrough (idea #6)", () => {
  const base = { state: "done" as const, outcome: "complete" as const, summary: "ok", workerRemoved: false }
  const proof = { file: "test/foo.test.ts", run: "bun test foo.test.ts: 1 fail" }

  test("a declared fix carries its failing-test proof onto the done receipt", () => {
    expect(receiptForReport({ ...base, fixTask: true, failingTest: proof })).toMatchObject({
      outcome: "done",
      fixTask: true,
      failingTest: proof,
    })
    expect(receiptForReport({ ...base, fixTask: true })).toMatchObject({ outcome: "done", fixTask: true })
    expect(receiptForReport({ ...base, fixTask: true }).failingTest).toBeUndefined()
  })

  test("the proof rides only on receipts that claim success", () => {
    expect(receiptForReport({ ...base, state: "failed", fixTask: true, failingTest: proof })).not.toHaveProperty("fixTask")
    expect(receiptForReport({ ...base, state: "nothing", fixTask: true, failingTest: proof })).not.toHaveProperty("fixTask")
    expect(receiptForReport({ ...base, outcome: "partial", fixTask: true, failingTest: proof })).toMatchObject({
      outcome: "done",
      verifyFailed: true,
      fixTask: true,
      failingTest: proof,
    })
  })
})

describe("AutoloopOrchestrator verification passthrough (idea #14)", () => {
  const base = { state: "done" as const, outcome: "complete" as const, summary: "ok", workerRemoved: false }
  const verification = [
    { kind: "command", detail: "CHECKS: 3 executed, 0 failed" },
    { kind: "transcript", detail: "commands ran, no edits after the last run" },
  ]

  test("declared verification rides onto the done receipt", () => {
    expect(receiptForReport({ ...base, verification })).toMatchObject({ outcome: "done", verification })
  })

  test("verification rides only on receipts that claim success", () => {
    expect(receiptForReport({ ...base, state: "failed", verification })).not.toHaveProperty("verification")
    expect(receiptForReport({ ...base, outcome: "partial", verification })).toMatchObject({
      outcome: "done",
      verifyFailed: true,
      verification,
    })
  })
})
