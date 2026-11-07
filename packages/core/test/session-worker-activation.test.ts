import type { FileSystem } from "@orchestra/core/filesystem"
import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Database } from "@orchestra/core/database/database"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Bus } from "@orchestra/core/bus"
import { Instance } from "@orchestra/core/instance/service"
import { Job } from "@orchestra/core/job"
import { KV } from "@orchestra/core/kv"
import { LocationServiceMap } from "@orchestra/core/location-service-map"
import type { LocationServices } from "@orchestra/core/location-services"
import { Project } from "@orchestra/core/project"
import { ProjectTable } from "@orchestra/core/project/sql"
import { AbsolutePath } from "@orchestra/core/schema"
import { Session } from "@orchestra/core/session"
import { SessionActivation } from "@orchestra/core/session/activation"
import { SessionExecution } from "@orchestra/core/session/execution"
import { SessionRestart } from "@orchestra/core/session/execution/restart"
import { SessionHold } from "@orchestra/core/session/hold"
import { SessionInbox } from "@orchestra/core/session/inbox"
import { SessionMessage } from "@orchestra/core/session/message"
import { SessionRunner } from "@orchestra/core/session/runner/index"
import { SessionTable } from "@orchestra/core/session/sql"
import { SessionStore } from "@orchestra/core/session/store"
import { Context, Deferred, Effect, Exit, Layer, LayerMap, Option, Schema, Scope } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionStore.node, SessionInbox.node, Job.node, KV.node, Session.node]),
  ),
)

const WORKER = Session.ID.make("ses_activation_worker")
const MAIN = Session.ID.make("ses_activation_main")

describe("SessionActivation", () => {
  test("isStarted needs new tokens since dispatch or a live execution", () => {
    // Cumulative tokens alone prove nothing: 100 tokens consumed before
    // the dispatch must not read as started.
    expect(SessionActivation.isStarted({ tokensInput: 100, tokensInputAtDispatch: 100, active: false })).toBe(false)
    expect(SessionActivation.isStarted({ tokensInput: 101, tokensInputAtDispatch: 100, active: false })).toBe(true)
    expect(SessionActivation.isStarted({ tokensInput: 100, tokensInputAtDispatch: 100, active: true })).toBe(true)
    // Without a baseline the token total is unusable: only live execution counts.
    expect(SessionActivation.isStarted({ tokensInput: 100, active: false })).toBe(false)
    expect(SessionActivation.isStarted({ tokensInput: 100, active: true })).toBe(true)
    expect(SessionActivation.isStarted({ tokensInput: 0, tokensInputAtDispatch: 0, active: false })).toBe(false)
  })

  test("checkDelayMs defaults to 5 minutes and clamps the env override", () => {
    expect(SessionActivation.checkDelayMs()).toBe(5 * 60_000)
    expect(SessionActivation.checkDelayMs(1)).toBe(60_000)
    expect(SessionActivation.checkDelayMs(0)).toBe(60_000)
    expect(SessionActivation.checkDelayMs(120)).toBe(60 * 60_000)
  })

  it.effect("isRunnable skips admit-only shell notices", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const admission = yield* SessionInbox.Service
      yield* seedSessions(database, [WORKER])
      yield* admission.admit({
        id: SessionMessage.ID.create(),
        sessionID: WORKER,
        item: {
          type: "user",
          payload: SessionInbox.UserPayload.make({ text: "Do the work", resumeOnStart: true }),
          delivery: "queue",
        },
      })
      yield* admission.admit({
        id: SessionMessage.ID.create(),
        sessionID: WORKER,
        item: {
          type: "synthetic",
          payload: SessionInbox.SyntheticPayload.make({
            text: "Background shell state",
            metadata: { source: "shell", state: "cancelled" },
            resumeOnStart: false,
          }),
          delivery: "steer",
        },
      })
      const items = yield* SessionInbox.list(database.db, WORKER)
      expect(items.map((item) => SessionActivation.isRunnable(item))).toEqual([true, false])
    }),
  )

  it.effect("verify reports idle for a worker with a queued task and no run", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const admission = yield* SessionInbox.Service
      const store = yield* SessionStore.Service
      const sessions = yield* Session.Service
      const kv = yield* KV.Service
      yield* seedSessions(database, [WORKER, MAIN])
      yield* admission.admit({
        id: SessionMessage.ID.create(),
        sessionID: WORKER,
        item: {
          type: "user",
          payload: SessionInbox.UserPayload.make({ text: "Do the work", resumeOnStart: true }),
          delivery: "queue",
        },
      })
      const result = yield* SessionActivation.verify({ kv, sessions, store }, WORKER)
      expect(result).toEqual({ status: "idle", tokensInput: 0, pending: 1 })
    }),
  )

  it.effect("verify reports gone for an unknown session and settled with no runnable work", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const sessions = yield* Session.Service
      const kv = yield* KV.Service
      yield* seedSessions(database, [WORKER])
      expect(
        yield* SessionActivation.verify({ kv, sessions, store }, Session.ID.make("ses_activation_missing")),
      ).toEqual({ status: "gone" })
      expect(yield* SessionActivation.verify({ kv, sessions, store }, WORKER)).toMatchObject({ status: "settled" })
    }),
  )

  it.effect("verify reports idle for a worker with a stale claim and old tokens", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const admission = yield* SessionInbox.Service
      const store = yield* SessionStore.Service
      const sessions = yield* Session.Service
      const kv = yield* KV.Service
      // M-07: a durable claim plus tokens consumed before the dispatch used
      // to read as "started" — the claim is a write-ahead marker that
      // survives a crash, and the tokens are a lifetime total.
      yield* seedSessions(database, [WORKER], { time_suspended: Date.now(), tokens_input: 100 })
      yield* admission.admit({
        id: SessionMessage.ID.create(),
        sessionID: WORKER,
        item: {
          type: "user",
          payload: SessionInbox.UserPayload.make({ text: "Do the work", resumeOnStart: true }),
          delivery: "queue",
        },
      })
      expect(yield* SessionActivation.verify({ kv, sessions, store }, WORKER, 100)).toEqual({
        status: "idle",
        tokensInput: 100,
        pending: 1,
      })
    }),
  )

  it.effect("verify counts only tokens consumed after the dispatch baseline", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const admission = yield* SessionInbox.Service
      const store = yield* SessionStore.Service
      const sessions = yield* Session.Service
      const kv = yield* KV.Service
      yield* seedSessions(database, [WORKER], { tokens_input: 500 })
      yield* admission.admit({
        id: SessionMessage.ID.create(),
        sessionID: WORKER,
        item: {
          type: "user",
          payload: SessionInbox.UserPayload.make({ text: "Do the work", resumeOnStart: true }),
          delivery: "queue",
        },
      })
      expect(yield* SessionActivation.verify({ kv, sessions, store }, WORKER, 500)).toMatchObject({ status: "idle" })
      yield* database.db
        .update(SessionTable)
        .set({ tokens_input: 501 })
        .where(eq(SessionTable.id, WORKER))
        .run()
        .pipe(Effect.orDie)
      expect(yield* SessionActivation.verify({ kv, sessions, store }, WORKER, 500)).toMatchObject({
        status: "started",
      })
    }),
  )

  it.effect("verify reports held while the Society is paused and started while a turn executes live", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const admission = yield* SessionInbox.Service
      const store = yield* SessionStore.Service
      const sessions = yield* Session.Service
      const kv = yield* KV.Service
      yield* seedSessions(database, [WORKER])
      yield* admission.admit({
        id: SessionMessage.ID.create(),
        sessionID: WORKER,
        item: {
          type: "user",
          payload: SessionInbox.UserPayload.make({ text: "Do the work", resumeOnStart: true }),
          delivery: "queue",
        },
      })

      SessionHold.install(() => Effect.succeed(true))
      yield* Effect.addFinalizer(() => Effect.sync(() => SessionHold.install(() => Effect.succeed(false))))
      expect(yield* SessionActivation.verify({ kv, sessions, store }, WORKER)).toEqual({ status: "held" })

      SessionHold.install(() => Effect.succeed(false))
      const draining = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () =>
        Deferred.succeed(draining, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const deps = activationDeps({ kv, sessions, store }, context)
      yield* execution.resume(WORKER).pipe(Effect.forkScoped)
      yield* Deferred.await(draining)
      // The turn executes live while the drain runs: the model has started.
      expect(yield* SessionActivation.verify(deps, WORKER)).toMatchObject({ status: "started" })
      yield* execution.interrupt(WORKER)
      yield* execution.awaitIdle(WORKER)
    }),
  )

  // Live clock: the watch sleeps for real between its two checks.
  it.live("watch restarts a never-starting worker once, then escalates to the Orchestrator", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const admission = yield* SessionInbox.Service
      const store = yield* SessionStore.Service
      const sessions = yield* Session.Service
      const kv = yield* KV.Service
      yield* seedSessions(database, [WORKER, MAIN])
      yield* admission.admit({
        id: SessionMessage.ID.create(),
        sessionID: WORKER,
        item: {
          type: "user",
          payload: SessionInbox.UserPayload.make({ text: "Do the work", resumeOnStart: true }),
          delivery: "queue",
        },
      })

      // The drain never consumes the task and never records tokens: the
      // worker looks exactly like the B14 parked workers.
      const drains: Array<Session.ID> = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) => Effect.sync(() => void drains.push(input.sessionID)))
      const deps = activationDeps({ kv, sessions, store }, context)

      yield* SessionActivation.watch(deps, {
        sessionID: WORKER,
        projectID: "project-test",
        mainID: MAIN,
        checkAfterMs: 50,
      })

      // One restart (the resume between the two checks) and then escalation.
      expect(drains).toEqual([WORKER])
      const stored = Option.getOrUndefined(
        Schema.decodeUnknownOption(SessionActivation.Record)(yield* kv.get(SessionActivation.key(WORKER))),
      )
      expect(stored).toMatchObject({ status: "escalated", attempts: 2, restarts: 1 })
      const mainInbox = yield* SessionInbox.list(database.db, MAIN)
      expect(mainInbox.some((item) => JSON.stringify(item).includes("activation-failure"))).toBe(true)
      // The queued task is still there: the escalation did not consume it.
      expect(yield* SessionInbox.list(database.db, WORKER)).toHaveLength(1)
    }),
  )

  // Live clock: the watch sleeps for real before its check.
  it.live("watch marks a worker started when the run claims before the check", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const admission = yield* SessionInbox.Service
      const store = yield* SessionStore.Service
      const sessions = yield* Session.Service
      const kv = yield* KV.Service
      yield* seedSessions(database, [WORKER, MAIN])
      yield* admission.admit({
        id: SessionMessage.ID.create(),
        sessionID: WORKER,
        item: {
          type: "user",
          payload: SessionInbox.UserPayload.make({ text: "Do the work", resumeOnStart: true }),
          delivery: "queue",
        },
      })

      const draining = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () =>
        Deferred.succeed(draining, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const deps = activationDeps({ kv, sessions, store }, context)
      // The worker starts on its own before the check fires.
      yield* execution.resume(WORKER).pipe(Effect.forkScoped)
      yield* Deferred.await(draining)
      yield* SessionActivation.watch(deps, {
        sessionID: WORKER,
        projectID: "project-test",
        mainID: MAIN,
        checkAfterMs: 50,
      })
      const stored = Option.getOrUndefined(
        Schema.decodeUnknownOption(SessionActivation.Record)(yield* kv.get(SessionActivation.key(WORKER))),
      )
      expect(stored).toMatchObject({ status: "started", attempts: 1, restarts: 0 })
      yield* execution.interrupt(WORKER)
      yield* execution.awaitIdle(WORKER)
    }),
  )

  // Live clock: the watch sleeps for real between its two checks.
  it.live("watch does not count tokens consumed before the dispatch as a start", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const admission = yield* SessionInbox.Service
      const store = yield* SessionStore.Service
      const sessions = yield* Session.Service
      const kv = yield* KV.Service
      // M-07: the worker ran yesterday (100 tokens, no live execution) and
      // never started today. The old check read the lifetime total as
      // "started" and never restarted or escalated it.
      yield* seedSessions(database, [WORKER, MAIN], { tokens_input: 100 })
      yield* admission.admit({
        id: SessionMessage.ID.create(),
        sessionID: WORKER,
        item: {
          type: "user",
          payload: SessionInbox.UserPayload.make({ text: "Do the work", resumeOnStart: true }),
          delivery: "queue",
        },
      })

      const drains: Array<Session.ID> = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) => Effect.sync(() => void drains.push(input.sessionID)))
      const deps = activationDeps({ kv, sessions, store }, context)

      yield* SessionActivation.watch(deps, {
        sessionID: WORKER,
        projectID: "project-test",
        mainID: MAIN,
        checkAfterMs: 50,
      })

      expect(drains).toEqual([WORKER])
      const stored = Option.getOrUndefined(
        Schema.decodeUnknownOption(SessionActivation.Record)(yield* kv.get(SessionActivation.key(WORKER))),
      )
      expect(stored).toMatchObject({
        status: "escalated",
        attempts: 2,
        restarts: 1,
        tokensInputAtDispatch: 100,
      })
    }),
  )

  // Live clock: the re-armed watch sleeps for real between its two checks.
  it.live("recover re-arms a watch killed by a restart", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const admission = yield* SessionInbox.Service
      const store = yield* SessionStore.Service
      const sessions = yield* Session.Service
      const kv = yield* KV.Service
      yield* seedSessions(database, [WORKER, MAIN])
      yield* admission.admit({
        id: SessionMessage.ID.create(),
        sessionID: WORKER,
        item: {
          type: "user",
          payload: SessionInbox.UserPayload.make({ text: "Do the work", resumeOnStart: true }),
          delivery: "queue",
        },
      })

      // The watch the dead server left behind: still watching, never checked.
      yield* kv.set(
        SessionActivation.key(WORKER),
        Schema.encodeSync(SessionActivation.Record)({
          sessionID: WORKER,
          projectID: "project-test",
          mainID: MAIN,
          createdAt: Date.now() - 60_000,
          checkAfterMs: 50,
          attempts: 0,
          restarts: 0,
          status: "watching",
          tokensInputAtDispatch: 0,
        }),
      )

      const drains: Array<Session.ID> = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) => Effect.sync(() => void drains.push(input.sessionID)))
      const deps = activationDeps({ kv, sessions, store }, context)

      yield* SessionActivation.recover(deps, { scope, checkAfterMs: 50 })
      // Let the re-armed cycle run: check, restart, re-check, escalate.
      yield* Effect.sleep(500)

      // The escalation wakes the Orchestrator main session, and the fake
      // drain runs for it too — only the worker's restarts count here.
      expect(drains.filter((id) => id === WORKER)).toEqual([WORKER])
      const stored = Option.getOrUndefined(
        Schema.decodeUnknownOption(SessionActivation.Record)(yield* kv.get(SessionActivation.key(WORKER))),
      )
      expect(stored).toMatchObject({ status: "escalated", attempts: 2, restarts: 1 })
      const mainInbox = yield* SessionInbox.list(database.db, MAIN)
      expect(mainInbox.some((item) => JSON.stringify(item).includes("activation-failure"))).toBe(true)
    }),
  )

  // Live clock: the re-armed watch sleeps for real before its check.
  it.live("recover escalates without a second restart when one already happened", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const admission = yield* SessionInbox.Service
      const store = yield* SessionStore.Service
      const sessions = yield* Session.Service
      const kv = yield* KV.Service
      yield* seedSessions(database, [WORKER, MAIN])
      yield* admission.admit({
        id: SessionMessage.ID.create(),
        sessionID: WORKER,
        item: {
          type: "user",
          payload: SessionInbox.UserPayload.make({ text: "Do the work", resumeOnStart: true }),
          delivery: "queue",
        },
      })

      // The dead server already restarted this worker once and died waiting
      // for the re-check: the restart budget is spent.
      yield* kv.set(
        SessionActivation.key(WORKER),
        Schema.encodeSync(SessionActivation.Record)({
          sessionID: WORKER,
          projectID: "project-test",
          mainID: MAIN,
          createdAt: Date.now() - 60_000,
          checkAfterMs: 50,
          attempts: 1,
          restarts: 1,
          status: "restarted",
          tokensInputAtDispatch: 0,
        }),
      )

      const drains: Array<Session.ID> = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, (input) => Effect.sync(() => void drains.push(input.sessionID)))
      const deps = activationDeps({ kv, sessions, store }, context)

      yield* SessionActivation.recover(deps, { scope, checkAfterMs: 50 })
      yield* Effect.sleep(500)

      // The escalation wakes the Orchestrator main session, and the fake
      // drain runs for it too — only the worker's restarts count here.
      expect(drains.filter((id) => id === WORKER)).toEqual([])
      const stored = Option.getOrUndefined(
        Schema.decodeUnknownOption(SessionActivation.Record)(yield* kv.get(SessionActivation.key(WORKER))),
      )
      expect(stored).toMatchObject({ status: "escalated", attempts: 2, restarts: 1 })
    }),
  )
})

/**
 * Activation deps wired to the fake execution: resume runs the fake drain,
 * live execution is the fake drain's active set, and synthetic delivery
 * wakes the fake drain instead of the real runner.
 */
function activationDeps(
  base: { kv: KV.Interface; sessions: Session.Interface; store: SessionStore.Interface },
  context: Context.Context<SessionExecution.Service | Session.Service>,
): SessionActivation.Deps {
  const execution = Context.get(context, SessionExecution.Service)
  const builtSessions = Context.get(context, Session.Service)
  return {
    kv: base.kv,
    sessions: {
      ...base.sessions,
      resume: (id: Session.ID) => execution.resume(id),
      synthetic: builtSessions.synthetic,
      active: execution.active,
    },
    store: base.store,
  }
}

function seedSessions(
  database: Database.Service["Service"],
  sessionIDs: ReadonlyArray<Session.ID>,
  values: Partial<Pick<typeof SessionTable.$inferInsert, "time_suspended" | "resume_attempts" | "parent_id" | "tokens_input">> = {},
) {
  return Effect.gen(function* () {
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values(
        sessionIDs.map((id) => ({
          id,
          project_id: Project.ID.global,
          slug: id,
          directory: "/project",
          title: id,
          version: "test",
          ...values,
        })),
      )
      .run()
      .pipe(Effect.orDie)
  })
}

/** Builds the local execution layer plus the restart actions against the test harness services. */
function buildExecution(
  scope: Scope.Closeable,
  drain: (input: Parameters<SessionRunner.Interface["drain"]>[0]) => Effect.Effect<void, SessionRunner.RunError>,
  options?: SessionRestart.Options,
  overrideJobs?: Job.Interface,
) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const jobs = overrideJobs ?? (yield* Job.Service)
    const sessions = yield* Session.Service
    const sessionLayer = Layer.effect(
      Session.Service,
      Effect.gen(function* () {
        const execution = yield* SessionExecution.Service
        return Session.Service.of({
          ...sessions,
          synthetic: (input) =>
            sessions
              .synthetic({ ...input, resume: false })
              .pipe(Effect.tap(() => (input.resume === false ? Effect.void : execution.wake(input.sessionID)))),
        })
      }),
    )
    const runner = Layer.succeed(
      SessionRunner.Service,
      SessionRunner.Service.of({
        drain: (input) => drain(input).pipe(Effect.as(SessionRunner.DrainResult.Complete())),
      }),
    )
    const locations = Layer.effect(
      LocationServiceMap.Service,
      LayerMap.make(
        () =>
          // The local execution test only needs the Session runner from the Location graph.
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          runner as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
      ),
    )
    return yield* Layer.buildWithScope(
      SessionRestart.layer(options).pipe(
        Layer.provideMerge(sessionLayer),
        Layer.provideMerge(Layer.fresh(SessionExecution.layer)),
        Layer.provide(Layer.succeed(Database.Service, database)),
        Layer.provide(Layer.succeed(Bus.Service, bus)),
        Layer.provide(Layer.succeed(SessionStore.Service, store)),
        Layer.provide(Layer.succeed(Job.Service, jobs)),
        // Do not reuse the outer harness's selector with its already-captured Location map.
        Layer.provide(
          AppNodeBuilder.build(Instance.node, [LocationServiceMap.node.replace(locations)]).pipe(Layer.fresh),
        ),
      ),
      scope,
    )
  })
}
