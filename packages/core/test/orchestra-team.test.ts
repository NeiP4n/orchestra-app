import { ProjectTemplateReader } from "../src/project-template-reader"
import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer, Schedule, Schema, Scope, Stream } from "effect"
import { Mode } from "@orchestra/schema/mode"
import { Money } from "@orchestra/schema/money"
import { Event } from "@orchestra/schema/event"
import { Form } from "@orchestra/schema/form"
import { Tool } from "@orchestra/schema/tool"
import { OrchestraTool } from "@orchestra/core/tool/plugin/orchestra"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { Global } from "@orchestra/util/global"
import { makeGlobalNode } from "@orchestra/util/effect/app-node"
import { Database } from "@orchestra/core/database/database"
import { Bus } from "@orchestra/core/bus"
import { Autoloop } from "@orchestra/core/autoloop/service"
import { orchestraRules } from "@orchestra/core/autoloop/orchestrator"
import type { RunRow } from "@orchestra/core/autoloop/kernel/decide"
import { Skill } from "@orchestra/core/skill"
import { Model } from "@orchestra/core/model"
import { Provider } from "@orchestra/core/provider"
import { Agent } from "@orchestra/core/agent"
import { Job } from "@orchestra/core/job"
import { LocationServiceMap } from "@orchestra/core/location-service-map"
import { Orchestra } from "@orchestra/core/orchestra"
import { Federation } from "@orchestra/core/federation"
import { Dod } from "@orchestra/core/dod"
import { CompactionPolicy } from "@orchestra/core/session/compaction-policy"
import { SessionPlan } from "@orchestra/core/session/plan"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Session } from "@orchestra/core/session"
import { SessionEvent } from "@orchestra/core/session/event"
import { SessionInbox } from "@orchestra/core/session/inbox"
import { SessionExecution } from "@orchestra/core/session/execution"
import { SessionMessage } from "@orchestra/core/session/message"
import { SessionStore } from "@orchestra/core/session/store"
import { SessionTable } from "@orchestra/core/session/sql"
import { eq } from "drizzle-orm"
import { Trigger } from "@orchestra/core/trigger"
import { CredentialVault } from "@orchestra/core/credential-vault/index"
import { ScheduleView } from "@orchestra/core/schedule-view"
import { ScheduleRequests } from "@orchestra/core/schedule-requests"
import { KV } from "@orchestra/core/kv"
import { Form as FormService } from "@orchestra/core/form"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { Location } from "@orchestra/core/location"
import { AbsolutePath } from "@orchestra/core/schema"
import { location } from "./fixture/location"
import { TeamPlugin } from "@orchestra/core/plugin/team"
import { EXPLORE_LIMIT, isLimitReport } from "@orchestra/core/plugin/team"
import { SandboxPlugin } from "@orchestra/core/plugin/sandbox"
import type { ShellCreateBefore } from "@orchestra/plugin/effect/shell"
import { agentHost, host } from "./plugin/host"
import type { PermissionEvaluation } from "@orchestra/plugin/effect/permission"
import type { SessionContext } from "@orchestra/plugin/effect/session"

const model = Model.Ref.make({ id: Model.ID.make("member"), providerID: Provider.ID.make("test") })
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
// Test-only control for a worker run that finishes before its queued team task is promoted.
const deferTaskDelivery = new Set<Session.ID>()
// Simulates losing a terminal event while the worker answer remains durable.
const suppressTerminalEvent = new Set<Session.ID>()
// Adds a tool-heavy assistant turn to exercise report extraction beyond one message page.
const longTurnMessages = new Map<Session.ID, number>()
const deliverRegularInput = new Set<Session.ID>()

// Stands in for the runner: a woken team session answers with its title and ends
// its run the way the title asks ("fails", "stops at shutdown" or succeeds).
const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const inbox = yield* SessionInbox.Service
      const run = Effect.fn("OrchestraTeamTest.run")(function* (sessionID: Session.ID) {
        const session = yield* store.get(sessionID)
        if (!session) return
        const pending = yield* inbox.list(sessionID)
        const move = pending.find((item) => item.type === "move")
        if (move) {
          yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: move.id })
          yield* bus.publish(SessionEvent.Moved, { sessionID, ...move.payload })
          return
        }
        if (session.agent === Orchestra.agent) return
        const task = pending.find((item) => item.type === "user" && item.payload.metadata?.orchestra !== undefined)
        let taskDelivered = false
        if (task && !deferTaskDelivery.has(sessionID)) {
          yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: task.id })
          taskDelivered = true
        } else if (deliverRegularInput.has(sessionID)) {
          const item = pending.find((entry) => entry.type === "user")
          if (item) yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: item.id })
        }
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: session.agent ?? Agent.ID.make("build"),
          model,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
        yield* bus.publish(SessionEvent.Text.Ended, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
          text: `${session.title}: ${taskDelivered ? "task answer" : "unrelated answer"}`,
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
        const extraMessages = longTurnMessages.get(sessionID) ?? 0
        for (let index = 0; index < extraMessages; index++) {
          const extraID = SessionMessage.ID.create()
          yield* bus.publish(SessionEvent.Step.Started, {
            sessionID,
            assistantMessageID: extraID,
            agent: session.agent ?? Agent.ID.make("build"),
            model,
            started: index + 1,
          })
          yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID: extraID, ordinal: 0 })
          yield* bus.publish(SessionEvent.Text.Ended, {
            sessionID,
            assistantMessageID: extraID,
            ordinal: 0,
            text:
              index === extraMessages - 1
                ? `${session.title}: final long-turn answer`
                : `${session.title}: intermediate continuation ${index + 1}`,
          })
          yield* bus.publish(SessionEvent.Step.Ended, {
            sessionID,
            assistantMessageID: extraID,
            finish: "stop",
            cost: Money.USD.zero,
            tokens,
          })
        }
        if (suppressTerminalEvent.has(sessionID)) return
        if (session.title?.includes("fails"))
          return yield* bus.publish(SessionEvent.Execution.Failed, {
            sessionID,
            error: { type: "provider.transport", message: "Disconnected" },
          })
        if (session.title?.includes("shutdown"))
          return yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "shutdown" })
        yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: run,
        wake: (sessionID) => run(sessionID).pipe(Effect.ignore),
        interrupt: () => Effect.succeed(false),
        awaitIdle: () => Effect.void,
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node, SessionInbox.node],
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Job.node,
      Session.node,
      SessionStore.node,
      KV.node,
      SessionInbox.node,
      SessionExecution.node,
      LocationServiceMap.node,
      Orchestra.node,
      Federation.node,
      Agent.node,
      Skill.node,
      FormService.node,
      Autoloop.node,
    ]),
    [
      // Keep durable event rows in this suite so recovery can prove whether the
      // terminal event committed even when the live subscriber never saw it.
      Bus.node.replace(Bus.configured({ persist: true })),
      SessionExecution.node.replace(executionNode),
      Global.node.replace(tempGlobalLayer),
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
      ),
      offlineModels,
    ],
  ),
)

// The run the cycle holds for one worker session, read from the journal.
const runForSession = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const autoloop = yield* Autoloop.Service
    const view = yield* autoloop.getView()
    const rows = Object.values(view["runs"] ?? {}) as Array<RunRow>
    return rows.find((row) => row.session === sessionID) ?? null
  })

/** Wait until the worker's run reaches the given state in the journal. */
const untilRun = (sessionID: Session.ID, state: string) =>
  runForSession(sessionID).pipe(
    Effect.filterOrFail((row) => row !== null && row.state === state),
    Effect.retry(Schedule.spaced("10 millis")),
    Effect.timeout("2 seconds"),
  )

/**
 * Wait until the worker's task marker is gone. The report lands in the
 * orchestrator's inbox before the run finishes in the journal and the
 * marker is removed, so checking right after the report is a race.
 */
const untilNoPending = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const orchestra = yield* Orchestra.Service
    return yield* orchestra.pending(sessionID)
  }).pipe(
    Effect.filterOrFail((pending) => pending === undefined),
    Effect.retry(Schedule.spaced("10 millis")),
    Effect.timeout("2 seconds"),
  )

// Reports are admitted to the orchestrator's inbox; the stub runner never delivers them.
const reports = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const inbox = yield* sessions.inbox(sessionID)
    return inbox.flatMap((item) =>
      item.type === "synthetic" && item.payload.text.startsWith("<team-report") ? [item.payload.text] : [],
    )
  })

describe("Orchestra sandbox project", () => {
  it.live("works in a new worktree of the repository and leaves the source checkout untouched", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-sandbox-")))
      yield* Effect.promise(async () => {
        await Bun.write(path.join(tmp.path, "README.md"), "source\n")
        await Bun.$`git init -q && git add . && git -c user.name=t -c user.email=t@t commit -qm init`.cwd(tmp.path)
      })
      const orchestra = yield* Orchestra.Service
      const project = yield* orchestra.create({ name: "Sandbox", directory: tmp.path, isolation: "environment" })

      expect(project.sandbox).toMatchObject({ source: tmp.path, isolation: "environment" })
      expect(project.directory).toBe(path.join(project.sandbox!.home, "repo"))
      // Git may check the file out with CRLF on Windows (core.autocrlf).
      const readme = yield* Effect.promise(() => Bun.file(path.join(project.directory, "README.md")).text())
      expect(readme.replaceAll("\r\n", "\n")).toBe("source\n")
      expect(yield* Effect.promise(() => Bun.file(path.join(project.directory, Dod.FILE)).exists())).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, Dod.FILE)).exists())).toBe(false)
      expect((yield* orchestra.projects()).find((item) => item.id === project.id)?.sandbox).toEqual(project.sandbox)
    }),
  )

  it.live("confines shell commands inside the sandbox and leaves other directories alone", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-sandbox-shell-")))
      yield* Effect.promise(() =>
        Bun.$`git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`.cwd(tmp.path),
      )
      const orchestra = yield* Orchestra.Service
      const project = yield* orchestra.create({ name: "Shell", directory: tmp.path, isolation: "environment" })
      const hooks: Array<(event: ShellCreateBefore) => Effect.Effect<void>> = []
      yield* SandboxPlugin.Plugin.effect(
        host({
          shell: {
            hook: (_, callback) => Effect.sync(() => hooks.push(callback)).pipe(Effect.as({ dispose: Effect.void })),
          },
        }),
      )
      const run = (cwd: string) =>
        Effect.gen(function* () {
          const event: ShellCreateBefore = {
            command: "opencode",
            cwd,
            timeout: 0,
            shell: "sh",
            env: { HOME: "/home/user", ORCHESTRA_SERVER_PASSWORD: "secret" },
          }
          for (const hook of hooks) yield* hook(event)
          return event
        })

      const inside = yield* run(path.join(project.directory, "packages"))
      expect(inside.env.ORCHESTRA_SERVER_PASSWORD).toBeUndefined()
      expect(inside.env.XDG_STATE_HOME).toBe(path.join(project.sandbox!.home, "state"))
      expect(inside.command).toBe("opencode")
      const source = yield* run(tmp.path)
      expect(source.env).toEqual({ HOME: "/home/user", ORCHESTRA_SERVER_PASSWORD: "secret" })
    }),
  )

  it.live("rejects a directory that is not a git repository", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-sandbox-plain-")))
      const orchestra = yield* Orchestra.Service
      const error = yield* orchestra
        .create({ name: "Plain", directory: tmp.path, isolation: "environment" })
        .pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "Orchestra.SandboxError", reason: "repository" })
      expect(yield* orchestra.projects()).toEqual([])
    }),
  )

  it.live("pages past the 1000-entry KV scan limit for projects", () =>
    Effect.gen(function* () {
      const orchestra = yield* Orchestra.Service
      const kv = yield* KV.Service
      // One scan page holds 1000 entries: seed 1001 projects so the tail past
      // the first page must be followed through `next` to be seen.
      const ids = Array.from({ length: 1001 }, (_, index) => `prj_page-${String(index).padStart(4, "0")}`)
      yield* Effect.forEach(
        ids,
        (id, index) =>
          kv.set(`orchestra/project/${id}`, { id, name: `page-${index}`, directory: `/tmp/page-${index}`, created: index }),
        { concurrency: 8, discard: true },
      )
      expect((yield* orchestra.projects()).filter((project) => project.name.startsWith("page-"))).toHaveLength(1001)
    }),
  )
})

describe("Orchestra team", () => {
  it.live("creates the project DoD and main orchestrator even when no team is selected", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-project-")))
      const orchestra = yield* Orchestra.Service
      const project = yield* orchestra.create({ name: "No team", directory: tmp.path })

      const dodPath = path.join(tmp.path, Dod.FILE)
      expect(yield* Effect.promise(() => Bun.file(dodPath).exists())).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(dodPath).text())).toContain("task_id: PROJECT-BOARD")
      expect(yield* Dod.read(tmp.path)).toMatchObject({ status: "ready", items: [] })
      expect(project.main).toBeDefined()
      const main = yield* orchestra.main(project.id)
      expect(main.id).toBe(project.main!)
      expect(main.title).toBe("No team · Orchestrator")
      expect(main.agent).toBe(Orchestra.agent)
      expect(main.metadata?.[SessionPlan.CONTEXT_KEY]).toEqual(CompactionPolicy.mainThreshold)
      expect(yield* orchestra.mainOf(main.id)).toMatchObject({ id: project.id })
    }),
  )

  it.live("automatically assigns default compaction threshold to all project sessions even without team", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-single-chat-")))
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const project = yield* orchestra.create({ name: "Single Chat Project", directory: tmp.path })

      // Main session gets threshold
      const main = yield* orchestra.main(project.id)
      expect(main.metadata?.[SessionPlan.CONTEXT_KEY]).toEqual(CompactionPolicy.mainThreshold)

      // Create an auxiliary single session in project folder without explicit metadata
      const singleSession = yield* sessions.create({
        location: { directory: AbsolutePath.make(tmp.path) },
        title: "User Scratchpad",
      })
      // Ensure that orchestra.sessions guarantees threshold on every project session
      const list = yield* orchestra.sessions(project.id)
      const found = list.find((s) => s.id === singleSession.id)
      expect(found).toBeDefined()
      expect(found?.metadata?.[SessionPlan.CONTEXT_KEY]).toEqual(CompactionPolicy.mainThreshold)
    }),
  )

  it.live("gives the orchestrator the playbook of the team the project was opened with", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-playbook-")))
      const orchestra = yield* Orchestra.Service
      const mobile = yield* orchestra.create({ name: "Phone", directory: tmp.path, template: "mobile-app" })
      const plain = yield* orchestra.create({ name: "Plain", directory: tmp.path })

      const playbook = yield* orchestra.playbook(mobile.id)
      expect(playbook?.name).toBe("Mobile app")
      expect(playbook?.text).toContain("mobile-developer")
      expect(yield* orchestra.playbook(plain.id)).toBeUndefined()

      // An edited template's own playbook replaces the built-in one for projects opened from it.
      const template = (yield* orchestra.templates()).find((item) => item.id === "mobile-app")!
      yield* orchestra.saveTemplate("mobile-app", { ...template, playbook: "Ship the Flutter app only." })
      expect((yield* orchestra.playbook(mobile.id))?.text).toBe("Ship the Flutter app only.")

      yield* orchestra.remove(mobile.id)
      expect(yield* orchestra.playbook(mobile.id)).toBeUndefined()
    }),
  )

  it.live("reattaches a durable orphaned orchestrator instead of creating a duplicate", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-orphan-main-")))
      const orchestra = yield* Orchestra.Service
      const kv = yield* KV.Service
      const project = yield* orchestra.create({ name: "Orphan", directory: tmp.path })
      const originalID = project.main!

      // Simulate the old crash window: Session was stored, but Project.main was not.
      yield* kv.set(
        `orchestra/project/${project.id}`,
        Schema.encodeSync(Orchestra.Project)({
          id: project.id,
          name: project.name,
          directory: project.directory,
          created: project.created,
        }),
      )
      const main = yield* orchestra.main(project.id)
      expect(main.id).toBe(originalID)
      expect(main.metadata?.[SessionPlan.CONTEXT_KEY]).toEqual(CompactionPolicy.mainThreshold)
      expect((yield* orchestra.projects()).find((item) => item.id === project.id)?.main).toBe(originalID)
      expect(yield* orchestra.mainOf(originalID)).toMatchObject({ id: project.id })
    }).pipe(Effect.scoped),
  )

  it.live("reuses the reserved main ID after interrupted initialization", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-main-reservation-")))
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const kv = yield* KV.Service
      const project = yield* orchestra.create({ name: "Reservation", directory: tmp.path })
      yield* sessions.remove(project.main!)
      yield* kv.set(
        `orchestra/project/${project.id}`,
        Schema.encodeSync(Orchestra.Project)({
          id: project.id,
          name: project.name,
          directory: project.directory,
          created: project.created,
        }),
      )
      const reservedID = Session.ID.create()
      yield* kv.set(`orchestra/main-initializing/${project.id}`, reservedID)

      const main = yield* orchestra.main(project.id)
      expect(main.id).toBe(reservedID)
      expect(main.title).toBe("Reservation · Orchestrator")
      expect((yield* orchestra.projects()).find((item) => item.id === project.id)?.main).toBe(reservedID)
    }).pipe(Effect.scoped),
  )

  it.live("concurrent main repair creates one orchestrator for a legacy project", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-concurrent-main-")))
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const kv = yield* KV.Service
      const project = yield* orchestra.create({ name: "Concurrent", directory: tmp.path })

      // Simulate an older project record whose main session was removed.
      yield* kv.set(
        `orchestra/project/${project.id}`,
        Schema.encodeSync(Orchestra.Project)({
          id: project.id,
          name: project.name,
          directory: project.directory,
          created: project.created,
        }),
      )
      yield* sessions.remove(project.main!)

      const repaired = yield* Effect.all(
        Array.from({ length: 8 }, () => orchestra.main(project.id)),
        { concurrency: "unbounded" },
      )
      expect(new Set(repaired.map((session) => session.id)).size).toBe(1)
      expect(repaired.every((session) => session.agent === Orchestra.agent)).toBe(true)
      expect((yield* orchestra.projects()).find((item) => item.id === project.id)?.main).toBe(repaired[0].id)
      expect(yield* orchestra.mainOf(repaired[0].id)).toMatchObject({ id: project.id })
    }).pipe(Effect.scoped),
  )

  it.live("serializes project deletion with team creation so no workers remain claimed to a removed project", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-create-delete-")))
      const orchestra = yield* Orchestra.Service
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const creating = yield* orchestra
        .create({ name: "Create race", directory: tmp.path, template: "feature" })
        .pipe(Effect.forkIn(scope, { startImmediately: true }))

      // A project becomes visible before its main Session finishes initialization. Remove it at
      // that boundary, which used to let template workers be created after their owner was gone.
      const project = yield* orchestra.projects().pipe(
        Effect.map((items) => items.find((item) => item.name === "Create race" && item.main !== undefined)),
        Effect.filterOrFail((item): item is Orchestra.Project => item !== undefined),
        Effect.retry(Schedule.spaced("1 millis")),
        Effect.timeout("2 seconds"),
      )
      yield* orchestra.remove(project.id)
      // Creation can either finish before removal acquires the lock, or observe that removal won.
      // In both cases, the owner record must not survive under a project that no longer exists.
      yield* Fiber.join(creating).pipe(Effect.ignore)

      expect((yield* orchestra.projects()).some((item) => item.id === project.id)).toBe(false)
      expect(Object.values(yield* orchestra.owners())).not.toContain(project.id)
    }).pipe(Effect.scoped),
  ),

  it.live("serializes owner claims with project deletion so no session stays claimed by a removed project", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-owner-claim-race-")))
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const project = yield* orchestra.create({ name: "Owner claim race", directory: tmp.path })
      const worker = yield* sessions.create({
        location: { directory: AbsolutePath.make(tmp.path) },
        title: "Claim candidate",
      })

      // The claim either commits before removal and gets cleaned up, or removal wins and
      // the claim sees ProjectNotFoundError. Neither schedule may leave a dangling owner key.
      yield* Effect.all(
        {
          claim: orchestra.claim(worker.id, project.id).pipe(Effect.orElseSucceed(() => undefined)),
          remove: orchestra.remove(project.id).pipe(Effect.orElseSucceed(() => undefined)),
        },
        { concurrency: "unbounded" },
      )

      expect((yield* orchestra.projects()).some((item) => item.id === project.id)).toBe(false)
      expect(yield* orchestra.owners()).not.toHaveProperty(worker.id)
    }).pipe(Effect.scoped),
  ),

  it.live("forgetting a project releases its task reservation and cancels only its queued input", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-forget-tasks-")))
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const project = yield* orchestra.create({ name: "Forgotten tasks", directory: tmp.path, template: "bugfix" })
      const other = yield* orchestra.create({ name: "Other project", directory: tmp.path, template: "bugfix" })
      const worker = yield* orchestra.createMember({ project: project, title: "Developer", agent: Orchestra.role("developer") })
      const otherWorker = yield* orchestra.createMember({ project: other, title: "Developer", agent: Orchestra.role("developer") })

      // Keep both prompts queued so the test exercises cancellation before worker delivery.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          deferTaskDelivery.add(worker.id)
          deferTaskDelivery.add(otherWorker.id)
        }),
        () =>
          Effect.sync(() => {
            deferTaskDelivery.delete(worker.id)
            deferTaskDelivery.delete(otherWorker.id)
          }),
      )
      yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Finish the forgotten project task" })
      yield* orchestra.dispatch({ project: other, sessionID: otherWorker.id, text: "Finish the other project task" })
      yield* Effect.sleep("50 millis")
      expect(yield* orchestra.pending(worker.id)).toBeNumber()
      expect(yield* orchestra.pending(otherWorker.id)).toBeNumber()
      expect((yield* sessions.inbox(worker.id)).some((item) => item.type === "user")).toBe(true)
      expect((yield* sessions.inbox(otherWorker.id)).some((item) => item.type === "user")).toBe(true)

      yield* orchestra.remove(project.id)

      // Forgetting coordination records does not delete the session or its persisted history.
      yield* untilNoPending(worker.id)
      expect(yield* sessions.get(worker.id)).toMatchObject({ id: worker.id })
      expect(yield* sessions.get(project.main!)).toMatchObject({ id: project.main })
      expect(yield* orchestra.owners()).not.toHaveProperty(worker.id)
      expect((yield* sessions.inbox(worker.id)).some((item) => item.type === "user")).toBe(false)

      // Reservations and queued work belonging to a different project survive.
      expect(yield* orchestra.pending(otherWorker.id)).toBeNumber()
      expect(yield* sessions.get(other.main!)).toMatchObject({ id: other.main })
      expect((yield* sessions.inbox(otherWorker.id)).some((item) => item.type === "user")).toBe(true)
      expect((yield* orchestra.projects()).map((item) => item.id)).toContain(other.id)
      expect((yield* orchestra.projects()).map((item) => item.id)).not.toContain(project.id)
    }).pipe(Effect.scoped),
  ),

  it.live("project removal deletes only owned active triggers and their schedule views", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orchestra-trigger-delete-")))
      const orchestra = yield* Orchestra.Service, kv = yield* KV.Service
      const first = yield* orchestra.create({ name: "Removed trigger owner", directory: tmp.path })
      const other = yield* orchestra.create({ name: "Surviving trigger owner", directory: tmp.path })
      const make = (projectID: string, id: string) => {
        const made = Trigger.create({ kind: "interval", spec: "60", prompt: "Do not run after removal" }, { id, projectID, now: Date.now(), existing: 0 })
        if (!made.ok) throw Error(made.error)
        return made.trigger
      }
      const owned = make(first.id, "trg_removed_owner"), foreign = make(other.id, "trg_surviving_owner")
      yield* kv.set(Trigger.key(first.id, owned.id), owned as never)
      yield* kv.set(Trigger.key(other.id, foreign.id), foreign as never)
      // Even malformed placement is not permission to remove another project's trigger.
      const misplacedKey = Trigger.key(first.id, "foreign-placement")
      yield* kv.set(misplacedKey, foreign as never)
      ScheduleView.sync(owned, String(first.main))
      ScheduleView.sync(foreign, String(other.main))
      yield* orchestra.remove(first.id)
      expect(yield* kv.get(Trigger.key(first.id, owned.id))).toBeUndefined()
      expect(ScheduleView.list(String(first.main)).map(item => item.id)).not.toContain(owned.id)
      expect(Trigger.parse(yield* kv.get(Trigger.key(other.id, foreign.id)))).toEqual(foreign)
      expect(Trigger.parse(yield* kv.get(misplacedKey))).toEqual(foreign)
      expect(ScheduleView.list(String(other.main)).map(item => item.id)).toContain(foreign.id)
      yield* Effect.sleep("50 millis")
      expect(yield* kv.get(Trigger.key(first.id, owned.id))).toBeUndefined()
      ScheduleView.remove(foreign.id)
    }).pipe(Effect.scoped),
  )

  it.live("forgetting a project removes only its local Vault definitions, never other project slots", () =>
    Effect.gen(function* () {
      const orchestra = yield* Orchestra.Service
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orchestra-vault-delete-")))
      const first = yield* orchestra.create({ name: "Vault owner", directory: tmp.path })
      const a = CredentialVault.local(String(first.id)), b = CredentialVault.local("prj_other_vault")
      yield* Effect.promise(() => a.createEmptyLocalSlotsFromOperator([{ name: "service", type: "api-key", label: "Service" }]))
      yield* Effect.promise(() => b.createEmptyLocalSlotsFromOperator([{ name: "other", type: "login", label: "Other" }]))
      try {
        yield* orchestra.remove(first.id)
        expect(yield* Effect.promise(() => a.slots())).toEqual([])
        expect((yield* Effect.promise(() => b.slots())).map((slot) => slot.name)).toEqual(["other"])
      } finally {
        yield* Effect.promise(() => b.removeProjectSlots("prj_other_vault"))
      }
    }),
  )

  it.live("does not resolve a removed project's main session as a live orchestrator", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-forgotten-main-")))
      const orchestra = yield* Orchestra.Service
      const project = yield* orchestra.create({ name: "Forgotten", directory: tmp.path })
      const mainID = project.main!
      expect(yield* orchestra.mainOf(mainID)).toMatchObject({ id: project.id })

      yield* orchestra.remove(project.id)

      expect(yield* orchestra.mainOf(mainID)).toBeUndefined()
      expect((yield* orchestra.projects()).some((item) => item.id === project.id)).toBe(false)
    }).pipe(Effect.scoped),
  ),

  it.live("serializes project deletion with main recovery so a removed project cannot reappear", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-delete-race-")))
      const orchestra = yield* Orchestra.Service
      const project = yield* orchestra.create({ name: "Delete race", directory: tmp.path })

      const result = yield* Effect.all(
        {
          removed: orchestra.remove(project.id),
          main: orchestra.main(project.id).pipe(Effect.orElseSucceed(() => undefined)),
        },
        { concurrency: "unbounded" },
      )
      if (result.main) expect(result.main.id === project.main).toBe(true)
      expect((yield* orchestra.projects()).some((item) => item.id === project.id)).toBe(false)
    }).pipe(Effect.scoped),
  )

  it.live("moves the main orchestrator and owned sessions with the project directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-move-")))
      const source = path.join(tmp.path, "source")
      const sourceNested = path.join(source, "src")
      const destination = path.join(tmp.path, "destination")
      const destinationNested = path.join(destination, "src")
      yield* Effect.promise(() =>
        Promise.all([
          mkdir(sourceNested, { recursive: true }),
          mkdir(destinationNested, { recursive: true }),
        ]),
      )
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const project = yield* orchestra.create({ name: "Move", directory: source, template: "bugfix" })
      const nested = yield* sessions.create({
        location: { directory: AbsolutePath.make(sourceNested) },
        title: "Nested worker",
        agent: Orchestra.role("developer"),
      })
      yield* orchestra.claim(nested.id, project.id)
      yield* orchestra.setAccess(nested.id, "full")
      const originalMembers = yield* orchestra.sessions(project.id)

      const updated = yield* orchestra.update(project.id, { name: "Moved", directory: destination })
      expect(updated).toMatchObject({ name: "Moved", directory: destination, main: project.main })
      expect((yield* sessions.get(project.main!)).location.directory).toBe(AbsolutePath.make(destination))
      expect((yield* sessions.get(project.main!)).title).toBe("Moved · Orchestrator")
      for (const member of originalMembers) {
        // Sessions already nested beneath the project keep their relative path after migration.
        const expectedDirectory = member.id === nested.id ? destinationNested : destination
        expect((yield* sessions.get(member.id)).location.directory).toBe(AbsolutePath.make(expectedDirectory))
      }
      expect((yield* sessions.get(nested.id)).location.directory).toBe(AbsolutePath.make(destinationNested))
      const currentMembers = yield* orchestra.sessions(project.id)
      // The nested worker may already be in originalMembers; compare the expected roster as a set.
      expect(currentMembers.map((session) => session.id).toSorted()).toEqual(
        [...new Set([...originalMembers.map((session) => session.id), nested.id])].toSorted(),
      )
    }).pipe(Effect.scoped),
  ),
  it.live("continues a partially completed move toward a newly requested destination", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-move-recovery-")))
      const source = path.join(tmp.path, "source")
      const sourceNested = path.join(source, "src")
      const firstDestination = path.join(tmp.path, "destination-a")
      const firstDestinationNested = path.join(firstDestination, "src")
      const destination = path.join(tmp.path, "destination-b")
      const destinationNested = path.join(destination, "src")
      yield* Effect.promise(() =>
        Promise.all([
          mkdir(sourceNested, { recursive: true }),
          mkdir(firstDestinationNested, { recursive: true }),
          mkdir(destinationNested, { recursive: true }),
        ]),
      )
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const kv = yield* KV.Service
      const project = yield* orchestra.create({ name: "Move recovery", directory: source, template: "bugfix" })
      yield* orchestra.createMember({ project, title: "Developer", agent: Orchestra.role("developer") })
      const members = yield* orchestra.sessions(project.id)
      const nested = yield* sessions.create({
        location: { directory: AbsolutePath.make(sourceNested) },
        title: "Nested worker",
        agent: Orchestra.role("developer"),
      })
      yield* orchestra.claim(nested.id, project.id)
      yield* orchestra.setAccess(nested.id, "full")

      const moveKey = "orchestra/move-plan/" + project.id
      // Simulate a crash after one session moved, while the project record still points at source.
      // Management lookups must not block while the move waits for the active main session.
      yield* kv.set(moveKey, {
        from: source,
        to: firstDestination,
        members: [
          ...members.map((member) => ({ id: member.id, relative: "", targetRelative: "", main: false })),
          { id: nested.id, relative: "src", targetRelative: "src", main: false },
          { id: project.main!, relative: "", targetRelative: "", main: true },
        ],
      })
      expect(yield* orchestra.mainOf(project.main!)).toBeUndefined()
      expect(yield* orchestra.sessions(project.id)).toHaveLength(0)
      const alreadyMoved = members[0]
      yield* sessions.move({
        sessionID: alreadyMoved.id,
        directory: AbsolutePath.make(firstDestination),
        delivery: "queue",
      })
      yield* sessions.wait(alreadyMoved.id)
      expect((yield* sessions.get(alreadyMoved.id)).location.directory).toBe(AbsolutePath.make(firstDestination))

      // Redirect the interrupted migration. Every session, including the one already moved to A,
      // must follow the original plan to destination B.
      const updated = yield* orchestra.update(project.id, { directory: destination })
      expect(updated.directory).toBe(destination)
      for (const member of members) {
        expect((yield* sessions.get(member.id)).location.directory).toBe(AbsolutePath.make(destination))
      }
      expect((yield* sessions.get(nested.id)).location.directory).toBe(AbsolutePath.make(destinationNested))
      expect((yield* sessions.get(project.main!)).location.directory).toBe(AbsolutePath.make(destination))
      expect(yield* kv.get(moveKey)).toBeUndefined()
    }).pipe(Effect.scoped),
  ),
  it.live("rebuilds a partially created team from its durable roster plan", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-roster-recovery-")))
      const orchestra = yield* Orchestra.Service
      const sessionService = yield* Session.Service
      const kv = yield* KV.Service
      const project = yield* orchestra.create({ name: "Roster recovery", directory: tmp.path })
      const existingID = Session.ID.create()
      const missingID = Session.ID.create()
      const location = { directory: (yield* sessionService.get(project.main!)).location.directory }

      // The first worker made it to durable Session storage; the second never got created before the crash.
      yield* sessionService.create({
        id: existingID,
        location,
        title: "Recovered Architect",
        agent: Orchestra.role("architect"),
      })
      const key = `orchestra/team-plan/${project.id}`
      yield* kv.set(key, {
        created: Date.now(),
        members: [
          { id: existingID, agent: Orchestra.role("architect"), title: "Recovered Architect", category: "Planning" },
          { id: missingID, agent: Orchestra.role("developer"), title: "Recovered Developer", category: "Build" },
        ],
      })

      // Reopening the project's main session replays the same roster without duplicating the existing worker.
      const main = yield* orchestra.main(project.id)
      expect(main.id).toBe(project.main!)
      expect(yield* kv.get(key)).toBeUndefined()
      const members = yield* orchestra.sessions(project.id)
      expect(members.filter((item) => item.id === existingID)).toHaveLength(1)
      expect(members.filter((item) => item.id === missingID)).toHaveLength(1)
      expect(members.find((item) => item.id === existingID)).toMatchObject({
        title: "Recovered Architect",
        agent: Orchestra.role("architect"),
      })
      expect(members.find((item) => item.id === missingID)).toMatchObject({
        title: "Recovered Developer",
        agent: Orchestra.role("developer"),
      })
      expect((yield* orchestra.owners())[existingID]).toBe(project.id)
      expect((yield* orchestra.owners())[missingID]).toBe(project.id)
      expect(yield* orchestra.access(existingID)).toBe("full")
      expect(yield* orchestra.access(missingID)).toBe("full")
      expect(yield* orchestra.categories([existingID, missingID])).toEqual({
        [existingID]: "Planning",
        [missingID]: "Build",
      })

      // Reopening again is idempotent because the plan was cleared only after all writes succeeded.
      yield* orchestra.main(project.id)
      expect((yield* orchestra.sessions(project.id)).filter((item) => item.id === existingID)).toHaveLength(1)
      expect((yield* orchestra.sessions(project.id)).filter((item) => item.id === missingID)).toHaveLength(1)
    }).pipe(Effect.scoped),
  ),

  it.live("lists owned sessions even when hundreds of unrelated sessions are newer", () =>
    Effect.gen(function* () {
      const projectDir = yield* Effect.acquireDisposable(
        Effect.promise(() => tmpdir("opencode-orchestra-pagination-project-")),
      )
      const unrelatedDir = yield* Effect.acquireDisposable(
        Effect.promise(() => tmpdir("opencode-orchestra-pagination-unrelated-")),
      )
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const project = yield* orchestra.create({ name: "Pagination", directory: projectDir.path })
      const originalMainID = project.main!
      const oldWorker = yield* sessions.create({
        location: { directory: AbsolutePath.make(projectDir.path) },
        title: "Older project worker",
      })
      // Separate update timestamps so all 501 unrelated chats sort strictly after the project sessions.
      yield* Effect.sleep("10 millis")
      yield* Effect.forEach(
        Array.from({ length: 501 }, (_, index) => index),
        (index) =>
          sessions.create({
            location: { directory: AbsolutePath.make(unrelatedDir.path) },
            title: `Unrelated ${index}`,
          }),
        { concurrency: 1, discard: true },
      )

      // Simulate the legacy crash window: the main session exists, but Project.main was not saved.
      const kv = yield* KV.Service
      yield* kv.set(
        `orchestra/project/${project.id}`,
        Schema.encodeSync(Orchestra.Project)({
          id: project.id,
          name: project.name,
          directory: project.directory,
          created: project.created,
        }),
      )
      const main = yield* orchestra.main(project.id)
      expect(main.id).toBe(originalMainID)
      expect((yield* orchestra.projects()).find((item) => item.id === project.id)?.main).toBe(originalMainID)
      expect(yield* orchestra.mainOf(originalMainID)).toMatchObject({ id: project.id })

      const listed = yield* orchestra.sessions(project.id)
      expect(listed.map((session) => session.id)).toContain(oldWorker.id)
    }).pipe(Effect.scoped),
  ),

  it.live("a dispatched task reports back to the orchestrator when its run ends", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-team-")))
      const orchestra = yield* Orchestra.Service
      const project = yield* orchestra.create({ name: "Team", directory: tmp.path, template: "bugfix" })
      const dodPath = path.join(tmp.path, Dod.FILE)
      expect(yield* Effect.promise(() => Bun.file(dodPath).exists())).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(dodPath).text())).toContain("task_id: PROJECT-BOARD")
      const main = project.main!
      // Built-in templates no longer open a roster: the Orchestrator creates
      // the workers this task needs, as this test now does explicitly.
      yield* orchestra.createMember({ project, title: "Debugger", agent: Orchestra.role("debugger") })
      yield* orchestra.createMember({ project, title: "Developer", agent: Orchestra.role("developer") })
      yield* orchestra.createMember({ project, title: "Tester", agent: Orchestra.role("tester") })
      const members = yield* orchestra.sessions(project.id)
      const byTitle = (title: string) => members.find((session) => session.title === title)!

      expect(members.map((session) => session.agent).toSorted()).toEqual(
        [Orchestra.role("debugger"), Orchestra.role("developer"), Orchestra.role("tester")].toSorted(),
      )
      expect(yield* orchestra.categories(members.map((session) => session.id))).toEqual({
        [byTitle("Debugger").id]: "Quality",
        [byTitle("Developer").id]: "Build",
        [byTitle("Tester").id]: "Quality",
      })

      const developer = byTitle("Developer")
      yield* orchestra.dispatch({ project, sessionID: developer.id, text: "Fix the bug" })
      const [report] = yield* reports(main).pipe(
        Effect.filterOrFail((found) => found.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(report).toContain(`session="${developer.id}"`)
      expect(report).toContain('state="done"')
      expect(report).toContain("Developer: task answer")
      yield* untilNoPending(developer.id)

      // a second project in the same directory brings its own orchestrator, which joins neither team
      const neighbour = yield* orchestra.create({ name: "Neighbour", directory: tmp.path, template: "docs" })
      yield* orchestra.createMember({ project: neighbour, title: "Writer", agent: Orchestra.role("writer") })
      yield* orchestra.createMember({ project: neighbour, title: "Reviewer", agent: Orchestra.role("reviewer") })
      const ownIDs = (yield* orchestra.sessions(project.id)).map((session) => session.id)
      expect(ownIDs).not.toContain(neighbour.main)
      expect((yield* orchestra.sessions(neighbour.id)).map((session) => session.id)).not.toContain(main)
      // and neither team is copied into the other one
      expect(ownIDs.toSorted()).toEqual(members.map((session) => session.id).toSorted())
      const theirs = yield* orchestra.sessions(neighbour.id)
      expect(theirs.map((session) => session.agent).toSorted()).toEqual([
        Orchestra.role("reviewer"),
        Orchestra.role("writer"),
      ])
      expect(yield* orchestra.owns(project, theirs[0])).toBe(false)
      expect(yield* orchestra.owns(neighbour, theirs[0])).toBe(true)

      // a session no project opened goes to the oldest project in the directory until one claims it
      const sessions = yield* Session.Service
      const loose = yield* sessions.create({ location: { directory: developer.location.directory } })
      expect(yield* orchestra.owns(project, loose)).toBe(true)
      yield* orchestra.claim(loose.id, neighbour.id)
      expect(yield* orchestra.owns(project, loose)).toBe(false)
      expect((yield* orchestra.sessions(neighbour.id)).map((session) => session.id)).toContain(loose.id)
      // forgetting a project hands its sessions back to the directory rule
      yield* orchestra.remove(neighbour.id)
      expect(yield* orchestra.owners()).not.toHaveProperty(loose.id)
      expect(yield* orchestra.owns(project, loose)).toBe(true)

      // a run the operator started themselves is not reported
      yield* sessions.prompt({ sessionID: developer.id, text: "operator's own question" })
      yield* Effect.sleep("50 millis")
      expect(yield* reports(main)).toHaveLength(1)
    }).pipe(Effect.scoped),
  )

  it.live("dispatch creates an autoloop run, and the report finishes it", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-team-")))
      const orchestra = yield* Orchestra.Service
      const autoloop = yield* Autoloop.Service
      const project = yield* orchestra.create({ name: "Team", directory: tmp.path, template: "bugfix" })
      const main = project.main!
      const developer = yield* orchestra.createMember({ project, title: "Developer", agent: Orchestra.role("developer") })
      yield* autoloop.execute({ type: "rules", args: [orchestraRules()] })
      yield* orchestra.dispatch({ project, sessionID: developer.id, text: "Fix the bug" })
      const [report] = yield* reports(main).pipe(
        Effect.filterOrFail((found) => found.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(report).toContain('state="done"')
      expect(report).toContain("Developer: task answer")
      const run = yield* untilRun(developer.id, "done")
      expect(run).toMatchObject({ state: "done", session: developer.id, rule: "orchestra-task" })
    }).pipe(Effect.scoped),
  )

  it.live("a failed dispatch retries the run instead of closing it", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-team-")))
      const orchestra = yield* Orchestra.Service
      const autoloop = yield* Autoloop.Service
      const project = yield* orchestra.create({ name: "Team", directory: tmp.path, template: "bugfix" })
      const main = project.main!
      const developer = yield* orchestra.createMember({
        project,
        title: "Developer fails",
        agent: Orchestra.role("developer"),
      })
      yield* autoloop.execute({ type: "rules", args: [orchestraRules()] })
      yield* orchestra.dispatch({ project, sessionID: developer.id, text: "Fix the bug" })
      const [report] = yield* reports(main).pipe(
        Effect.filterOrFail((found) => found.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(report).toContain('state="failed"')
      const run = yield* untilRun(developer.id, "queued")
      expect(run).toMatchObject({ state: "queued", attempts: 1, session: developer.id })
      expect(Date.parse(run!.not_before)).toBeGreaterThan(Date.now())
    }).pipe(Effect.scoped),
  )

  it.live("forwards a worker's question during a dispatched task to the orchestrator", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-team-")))
      const orchestra = yield* Orchestra.Service
      const bus = yield* Bus.Service
      const sessions = yield* Session.Service
      const project = yield* orchestra.create({ name: "Team", directory: tmp.path, template: "bugfix" })
      const developer = yield* orchestra.createMember({
        project,
        title: "Developer",
        agent: Orchestra.role("developer"),
      })
      const tester = yield* orchestra.createMember({ project, title: "Tester", agent: Orchestra.role("tester") })
      // Keep the task outstanding, as it is while the worker waits for an answer.
      deferTaskDelivery.add(developer.id)
      yield* Effect.addFinalizer(() => Effect.sync(() => deferTaskDelivery.delete(developer.id)))
      yield* orchestra.dispatch({ project, sessionID: developer.id, text: "Fix the bug" })
      const ask = (sessionID: Session.ID) =>
        bus.publish(Form.Event.Created, {
          form: {
            id: Form.ID.create(),
            sessionID,
            title: "Questions",
            metadata: { kind: "question" },
            fields: [
              {
                key: "q0",
                type: "string",
                title: "Database",
                description: "Which database should the fix target?",
                options: [
                  { value: "Postgres", label: "Postgres", description: "Production" },
                  { value: "SQLite", label: "SQLite" },
                ],
                custom: true,
              },
            ],
          },
        })
      // A session outside every project is the operator's own conversation: it keeps asking the human.
      const outside = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-outside-")))
      const stray = yield* sessions.create({
        location: { directory: AbsolutePath.make(outside.path) },
        title: "Own conversation",
      })
      yield* ask(stray.id)
      yield* ask(developer.id)
      const questions = (sessionID: Session.ID) =>
        sessions
          .inbox(sessionID)
          .pipe(
            Effect.map((inbox) =>
              inbox.flatMap((item) =>
                item.type === "synthetic" && item.payload.text.startsWith("<team-question") ? [item.payload.text] : [],
              ),
            ),
          )
      const [question] = yield* questions(project.main!).pipe(
        Effect.filterOrFail((found) => found.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(question).toContain(`session="${developer.id}"`)
      expect(question).toMatch(/task="[a-zA-Z0-9_]+"/)
      expect(question).toContain("Which database should the fix target?")
      expect(question).toContain("- Postgres: Production")
      expect(question).toContain("- SQLite")
      expect(yield* questions(project.main!)).toHaveLength(1)
      // A member session between tasks (no outstanding task) is still the orchestrator's to decide for.
      yield* ask(tester.id)
      const both = yield* questions(project.main!).pipe(
        Effect.filterOrFail((found) => found.length > 1),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(both.some((text) => text.includes(`session="${tester.id}"`) && text.includes('task="legacy"'))).toBe(true)
      expect(both.some((text) => text.includes(`session="${stray.id}"`))).toBe(false)
      // The interact tool's decision blocks and the web search provider choice are forwarded the same way.
      const raise = (sessionID: Session.ID, kind: string, description: string) =>
        bus.publish(Form.Event.Created, {
          form: {
            id: Form.ID.create(),
            sessionID,
            title: "Decide",
            metadata: { kind },
            fields: [{ key: "choice", type: "string", description, options: [{ value: "a", label: "A" }], custom: false }],
          },
        })
      yield* raise(developer.id, "interactive", "Pick the rollout plan")
      yield* raise(developer.id, "websearch.provider", "Allow Orchestra to search the web?")
      yield* raise(developer.id, "something.else", "Unrelated form")
      const more = yield* questions(project.main!).pipe(
        Effect.filterOrFail((found) => found.length > 3),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(more.some((text) => text.includes("Pick the rollout plan"))).toBe(true)
      expect(more.some((text) => text.includes("Allow Orchestra to search the web?"))).toBe(true)
      expect(more.some((text) => text.includes("Unrelated form"))).toBe(false)
      const qItem = (yield* sessions.inbox(project.main!)).find(
        (item) => item.type === "synthetic" && item.payload.text.startsWith("<team-question"),
      )
      expect((qItem?.payload as { metadata?: { taskID?: string } })?.metadata?.taskID).toBeDefined()
    }).pipe(Effect.scoped),
  )

  it.live("restores a delivered task report when the project's main session is deleted", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-report-ledger-")))
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const project = yield* orchestra.create({ name: "Report ledger", directory: tmp.path, template: "bugfix" })
      const oldMain = project.main!
      const worker = yield* orchestra.createMember({ project: project, title: "Developer", agent: Orchestra.role("developer") })

      yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Fix the bug" })
      const [original] = yield* reports(oldMain).pipe(
        Effect.filterOrFail((items) => items.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(original).toContain("Developer: task answer")
      yield* untilNoPending(worker.id)

      // The worker reservation is gone, but the unacknowledged report is still project-owned.
      yield* sessions.remove(oldMain)
      yield* orchestra.recoverPendingTasks()
      const repaired = (yield* orchestra.projects()).find((item) => item.id === project.id)!
      expect(repaired.main).toBeDefined()
      expect(repaired.main).not.toBe(oldMain)
      const restored = yield* reports(repaired.main!).pipe(
        Effect.filterOrFail((items) => items.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(restored).toHaveLength(1)
      expect(restored[0]).toContain("Developer: task answer")

      // Re-running startup reconciliation does not duplicate a report already in the Inbox.
      yield* orchestra.recoverPendingTasks()
      expect(yield* reports(repaired.main!)).toHaveLength(1)
    }).pipe(Effect.scoped),
  ),

  it.live("keeps every report of a worker instead of only the latest", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-report-history-")))
      const orchestra = yield* Orchestra.Service
      const project = yield* orchestra.create({ name: "Report history", directory: tmp.path, template: "bugfix" })
      const main = project.main!
      const worker = yield* orchestra.createMember({ project, title: "Developer", agent: Orchestra.role("developer") })

      yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Fix the first bug" })
      yield* untilNoPending(worker.id)
      yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Fix the second bug" })
      yield* untilNoPending(worker.id)

      // Both reports are still there: the second dispatch must not overwrite the first.
      const delivered = yield* reports(main).pipe(
        Effect.filterOrFail((items) => items.length === 2),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(delivered).toHaveLength(2)
      const history = (yield* orchestra.outcomes(project.id))[worker.id]
      expect(history).toBeDefined()
      expect(history).toHaveLength(2)
      // Oldest first; the stub worker's answer carries no explicit outcome, so the
      // value itself is not the subject here — the count and the order are.
      expect(history![0]!.created).toBeLessThanOrEqual(history![1]!.created)
    }).pipe(Effect.scoped),
  ),

  it.live("does not acknowledge a report from an unrelated user turn before recovering it", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-report-ack-boundary-")))
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const kv = yield* KV.Service
      const project = yield* orchestra.create({ name: "Report acknowledgement", directory: tmp.path, template: "bugfix" })
      const oldMain = project.main!
      const worker = yield* orchestra.createMember({ project: project, title: "Developer", agent: Orchestra.role("developer") })

      yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Fix the bug" })
      const [pendingReport] = yield* reports(oldMain).pipe(
        Effect.filterOrFail((items) => items.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      const reportItem = (yield* sessions.inbox(oldMain)).find(
        (item) => item.type === "synthetic" && item.payload.text === pendingReport,
      )
      expect(reportItem).toBeDefined()
      if (!reportItem || reportItem.type !== "synthetic") throw new Error("Expected the worker report in the main inbox")

      // Make the report visible in history, then admit an unrelated user question after it.
      yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: oldMain, inboxID: reportItem.id })
      const unrelated = yield* sessions.prompt({
        sessionID: oldMain,
        text: "What is the current project name?",
        resume: false,
      })
      yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: oldMain, inboxID: unrelated.id })

      // Simulate a successful assistant turn after the unrelated prompt, not a response to the report.
      const assistantMessageID = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID: oldMain,
        assistantMessageID,
        agent: Orchestra.agent,
        model,
        started: 0,
      })
      yield* bus.publish(SessionEvent.Text.Started, { sessionID: oldMain, assistantMessageID, ordinal: 0 })
      yield* bus.publish(SessionEvent.Text.Ended, {
        sessionID: oldMain,
        assistantMessageID,
        ordinal: 0,
        text: "The project is Report acknowledgement.",
      })
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID: oldMain,
        assistantMessageID,
        finish: "stop",
        cost: Money.USD.zero,
        tokens,
      })
      yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID: oldMain })
      yield* Effect.sleep("50 millis")
      // Run the same durable reconciliation synchronously so the test does not depend on
      // when the live event subscriber gets scheduled.
      yield* orchestra.recoverPendingTasks()

      const ledger = yield* kv.get(`orchestra/report/${project.id}/${reportItem.id}`)
      expect(ledger).toBeDefined()
      expect((ledger as { acknowledged?: boolean }).acknowledged).not.toBe(true)

      // The unacknowledged report must survive deletion of the session it was originally sent to.
      yield* sessions.remove(oldMain)
      yield* orchestra.recoverPendingTasks()
      const repaired = (yield* orchestra.projects()).find((item) => item.id === project.id)!
      expect(repaired.main).toBeDefined()
      expect(repaired.main).not.toBe(oldMain)
      const restored = yield* reports(repaired.main!).pipe(
        Effect.filterOrFail((items) => items.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(restored).toHaveLength(1)
      expect(restored[0]).toContain("Developer: task answer")
    }).pipe(Effect.scoped),
  ),

  it.live("reattaches outstanding task reports when a deleted main session is recreated", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-main-recovery-")))
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const project = yield* orchestra.create({ name: "Main recovery", directory: tmp.path, template: "bugfix" })
      const oldMain = project.main!
      const worker = yield* orchestra.createMember({ project: project, title: "Developer", agent: Orchestra.role("developer") })
      yield* Effect.acquireRelease(
        Effect.sync(() => suppressTerminalEvent.add(worker.id)),
        () => Effect.sync(() => suppressTerminalEvent.delete(worker.id)),
      )

      yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Fix the bug" })
      yield* Effect.sleep("50 millis")
      expect(yield* reports(oldMain)).toHaveLength(0)
      expect(yield* orchestra.pending(worker.id)).toBeNumber()

      // Simulate a legacy/manual deletion. The task still points to oldMain after it disappears.
      yield* sessions.remove(oldMain)
      suppressTerminalEvent.delete(worker.id)
      const main = yield* orchestra.main(project.id)
      expect(main.id).not.toBe(oldMain)

      const [report] = yield* reports(main.id).pipe(
        Effect.filterOrFail((items) => items.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(report).toContain('state="recovered"')
      expect(report).toContain("Developer: task answer")
      yield* untilNoPending(worker.id)
    }).pipe(Effect.scoped),
  ),

  it.live("uses a durable terminal event when its live notification was missed", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-durable-terminal-")))
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const project = yield* orchestra.create({ name: "Durable terminal", directory: tmp.path, template: "bugfix" })
      const worker = yield* orchestra.createMember({ project: project, title: "Developer", agent: Orchestra.role("developer") })
      yield* Effect.acquireRelease(
        Effect.sync(() => suppressTerminalEvent.add(worker.id)),
        () => Effect.sync(() => suppressTerminalEvent.delete(worker.id)),
      )

      yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Fix the bug" })
      yield* Effect.sleep("50 millis")
      expect(yield* reports(project.main!)).toHaveLength(0)
      expect(yield* orchestra.pending(worker.id)).toBeNumber()

      // Simulate the crash window: persist Execution.Succeeded without publishing a live
      // notification to the Orchestra subscriber. Recovery must trust the ordered durable log.
      const events = yield* Stream.runCollect(sessions.log({ sessionID: worker.id, follow: false }))
      const lastSequence = events.reduce(
        (last, item) =>
          item.type === "log.synced" ? Math.max(last, Number(item.seq ?? -1)) : Math.max(last, Number(item.durable.seq)),
        -1,
      )
      yield* bus.replay(
        {
          id: Event.ID.create(),
          type: Bus.versionedType(
            SessionEvent.Execution.Succeeded.type,
            SessionEvent.Execution.Succeeded.durable.version,
          ),
          created: Date.now(),
          seq: lastSequence + 1,
          aggregateID: worker.id,
          data: { sessionID: worker.id },
        },
        { publish: false },
      )

      yield* orchestra.recoverPendingTasks()
      const [report] = yield* reports(project.main!).pipe(
        Effect.filterOrFail((items) => items.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(report).toContain('state="done"')
      expect(report).not.toContain('state="recovered"')
      expect(report).toContain("Developer: task answer")
      yield* untilNoPending(worker.id)
    }).pipe(Effect.scoped),
  ),

  it.live("recovers the final answer after a long tool-heavy worker turn", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-long-turn-")))
      const orchestra = yield* Orchestra.Service
      const project = yield* orchestra.create({ name: "Long turn", directory: tmp.path, template: "bugfix" })
      const worker = yield* orchestra.createMember({ project: project, title: "Developer", agent: Orchestra.role("developer") })
      const extraMessages = 65
      yield* Effect.acquireRelease(
        Effect.sync(() => suppressTerminalEvent.add(worker.id)),
        () => Effect.sync(() => suppressTerminalEvent.delete(worker.id)),
      )
      yield* Effect.acquireRelease(
        Effect.sync(() => longTurnMessages.set(worker.id, extraMessages)),
        () => Effect.sync(() => longTurnMessages.delete(worker.id)),
      )

      yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Fix the bug" })
      expect(yield* reports(project.main!)).toHaveLength(0)
      expect(yield* orchestra.pending(worker.id)).toBeNumber()

      // The final answer is more than one 50-message page after the dispatched user message.
      yield* orchestra.recoverPendingTasks()
      const [report] = yield* reports(project.main!).pipe(
        Effect.filterOrFail((items) => items.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(report).toContain('state="recovered"')
      expect(report).toContain("Developer: final long-turn answer")
      expect(report).not.toContain("intermediate continuation")
      yield* untilNoPending(worker.id)
    }).pipe(Effect.scoped),
  ),
  it.live("does not report a later user prompt as the assigned worker task's answer", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-answer-boundary-")))
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const project = yield* orchestra.create({ name: "Answer boundary", directory: tmp.path, template: "bugfix" })
      const worker = yield* orchestra.createMember({ project: project, title: "Developer", agent: Orchestra.role("developer") })
      yield* Effect.acquireRelease(
        Effect.sync(() => suppressTerminalEvent.add(worker.id)),
        () => Effect.sync(() => suppressTerminalEvent.delete(worker.id)),
      )

      yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Fix the assigned bug" })
      yield* Effect.sleep("50 millis")
      expect(yield* reports(project.main!)).toHaveLength(0)
      expect(yield* orchestra.pending(worker.id)).toBeNumber()

      // A direct user prompt arrives before the missing terminal event is reconciled.
      // Its completion must not overwrite the answer to the task already assigned by the orchestrator.
      yield* Effect.acquireRelease(
        Effect.sync(() => deliverRegularInput.add(worker.id)),
        () => Effect.sync(() => deliverRegularInput.delete(worker.id)),
      )
      yield* sessions.prompt({ sessionID: worker.id, text: "Now answer an unrelated question" })
      yield* sessions.prompt({ sessionID: worker.id, text: "One more unrelated question" })
      expect(yield* reports(project.main!)).toHaveLength(0)
      expect(yield* orchestra.pending(worker.id)).toBeNumber()

      yield* orchestra.recoverPendingTasks()
      const [report] = yield* reports(project.main!).pipe(
        Effect.filterOrFail((items) => items.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(report).toContain('state="recovered"')
      expect(report).toContain("Developer: task answer")
      expect(report).not.toContain("Developer: unrelated answer")
      yield* untilNoPending(worker.id)
    }).pipe(Effect.scoped),
  ),
  it.live("recovers a completed worker task when its terminal event was missed", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-recovery-")))
      const orchestra = yield* Orchestra.Service
      const sessionStore = yield* SessionStore.Service
      const project = yield* orchestra.create({ name: "Recovery", directory: tmp.path, template: "bugfix" })
      const unrelated = yield* orchestra.create({ name: "Unrelated", directory: tmp.path, template: "docs" })
      const worker = yield* orchestra.createMember({ project: project, title: "Developer", agent: Orchestra.role("developer") })
      yield* Effect.acquireRelease(
        Effect.sync(() => suppressTerminalEvent.add(worker.id)),
        () => Effect.sync(() => suppressTerminalEvent.delete(worker.id)),
      )

      yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Fix the bug" })
      yield* Effect.sleep("50 millis")
      expect(yield* reports(project.main!)).toHaveLength(0)
      expect(yield* orchestra.pending(worker.id)).toBeNumber()

      // A persisted execution claim means a worker must resume; don't mistake its durable partial
      // transcript for a finished task merely because this process has no local active fiber.
      yield* sessionStore.claim(worker.id)
      suppressTerminalEvent.delete(worker.id)
      yield* orchestra.mainOf(project.main!)
      expect(yield* reports(project.main!)).toHaveLength(0)
      expect(yield* orchestra.pending(worker.id)).toBeNumber()

      // Opening another project's main session must not reconcile this project's task.
      yield* sessionStore.release(worker.id)
      yield* orchestra.mainOf(unrelated.main!)
      expect(yield* reports(project.main!)).toHaveLength(0)
      expect(yield* orchestra.pending(worker.id)).toBeNumber()

      // Once the owning orchestrator is activated, it reconciles only its own task.
      yield* orchestra.mainOf(project.main!)
      const recovered = yield* reports(project.main!).pipe(
        Effect.filterOrFail((items) => items.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(recovered).toHaveLength(1)
      expect(recovered[0]).toContain('state="recovered"')
      expect(recovered[0]).toContain("Developer: task answer")
      yield* untilNoPending(worker.id)

      // Recovery is idempotent after the durable marker has been cleared.
      yield* orchestra.mainOf(project.main!)
      expect(yield* reports(project.main!)).toHaveLength(1)
    }).pipe(Effect.scoped),
  ),
  it.live("recovers a task whose worker claim went stale without a terminal event", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-stale-claim-")))
      const orchestra = yield* Orchestra.Service
      const sessionStore = yield* SessionStore.Service
      const database = yield* Database.Service
      const project = yield* orchestra.create({ name: "Stale claim", directory: tmp.path, template: "bugfix" })
      const worker = yield* orchestra.createMember({
        project,
        title: "Developer",
        agent: Orchestra.role("developer"),
      })
      yield* Effect.acquireRelease(
        Effect.sync(() => suppressTerminalEvent.add(worker.id)),
        () => Effect.sync(() => suppressTerminalEvent.delete(worker.id)),
      )

      yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Fix the bug" })
      yield* Effect.sleep("50 millis")
      expect(yield* reports(project.main!)).toHaveLength(0)
      expect(yield* orchestra.pending(worker.id)).toBeNumber()

      // The run died without a terminal event (provider failure, abnormal fiber
      // death): its execution claim was never released and nothing has touched
      // the session since. A fresh claim would belong to boot recovery, which
      // resumes the run; this one is dead, so the task must be recovered with a
      // report instead of the Orchestrator waiting forever.
      yield* sessionStore.claim(worker.id)
      yield* database.db
        .update(SessionTable)
        .set({ time_updated: Date.now() - 11 * 60 * 1000 })
        .where(eq(SessionTable.id, worker.id))
        .run()
        .pipe(Effect.orDie)

      yield* orchestra.mainOf(project.main!)
      const recovered = yield* reports(project.main!).pipe(
        Effect.filterOrFail((items) => items.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(recovered).toHaveLength(1)
      expect(recovered[0]).toContain('state="recovered"')
      expect(recovered[0]).toContain("went stale")
      yield* untilNoPending(worker.id)
      expect(yield* sessionStore.listSuspended()).not.toContain(worker.id)
    }).pipe(Effect.scoped),
  ),
  it.live("replaces provisional recovery content when the real terminal event arrives", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-provisional-report-")))
      const orchestra = yield* Orchestra.Service
      const kv = yield* KV.Service
      const bus = yield* Bus.Service
      const project = yield* orchestra.create({ name: "Provisional report", directory: tmp.path, template: "bugfix" })
      const worker = yield* orchestra.createMember({ project: project, title: "Developer", agent: Orchestra.role("developer") })
      yield* Effect.acquireRelease(
        Effect.sync(() => suppressTerminalEvent.add(worker.id)),
        () => Effect.sync(() => suppressTerminalEvent.delete(worker.id)),
      )

      yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Fix the bug" })
      yield* Effect.sleep("50 millis")
      expect(yield* reports(project.main!)).toHaveLength(0)

      const taskKey = `orchestra/task/${worker.id}`
      const value = yield* kv.get(taskKey)
      expect(value).toBeDefined()
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing task marker")
      const original = value as Record<string, unknown>
      expect(original.reportID).toBeDefined()
      // A crash may leave a recovery draft durable without having admitted it to the inbox.
      yield* kv.set(taskKey, {
        ...original,
        reportPrepared: true,
        reportState: "recovered",
        reportDetail: "Provisional recovery notice",
        reportText: "Provisional recovery answer",
        reportOutcome: "unknown",
        reportTitle: "Developer",
        reportRole: Orchestra.role("developer"),
      })

      suppressTerminalEvent.delete(worker.id)
      yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID: worker.id })
      const [report] = yield* reports(project.main!).pipe(
        Effect.filterOrFail((items) => items.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(report).toContain('state="done"')
      expect(report).toContain("Developer: task answer")
      expect(report).not.toContain("Provisional recovery notice")
      expect(report).not.toContain("Provisional recovery answer")
      yield* untilNoPending(worker.id)
    }).pipe(Effect.scoped),
  ),

  it.live("clears an orphaned task reservation when its prompt was never admitted", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-orphaned-task-")))
      const orchestra = yield* Orchestra.Service
      const kv = yield* KV.Service
      const project = yield* orchestra.create({ name: "Orphaned task", directory: tmp.path, template: "bugfix" })
      const worker = yield* orchestra.createMember({ project: project, title: "Developer", agent: Orchestra.role("developer") })
      const messageID = SessionMessage.ID.create()
      const reportID = SessionMessage.ID.create()
      const taskKey = `orchestra/task/${worker.id}`

      // Simulate a process crash after writing the reservation but before prompt admission.
      yield* kv.set(taskKey, { main: project.main!, sent: Date.now(), messageID, reportID })
      expect(yield* orchestra.pending(worker.id)).toBeNumber()

      yield* orchestra.mainOf(project.main!)
      yield* untilNoPending(worker.id)
      expect(yield* reports(project.main!)).toHaveLength(0)

      // The stale marker no longer blocks the worker from accepting a fresh assignment.
      yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Retry after recovery" })
      const [report] = yield* reports(project.main!).pipe(
        Effect.filterOrFail((items) => items.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(report).toContain("Developer: task answer")
      yield* untilNoPending(worker.id)
    }).pipe(Effect.scoped),
  ),

  it.live("reports a failed task when its worker session is deleted", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-deleted-worker-")))
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const project = yield* orchestra.create({ name: "Deleted worker", directory: tmp.path, template: "bugfix" })
      const worker = yield* orchestra.createMember({ project: project, title: "Developer", agent: Orchestra.role("developer") })
      yield* Effect.acquireRelease(
        Effect.sync(() => suppressTerminalEvent.add(worker.id)),
        () => Effect.sync(() => suppressTerminalEvent.delete(worker.id)),
      )

      yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Fix the bug" })
      yield* Effect.sleep("50 millis")
      expect(yield* orchestra.pending(worker.id)).toBeNumber()

      // Deleting a worker cannot silently discard the outstanding task.
      yield* sessions.remove(worker.id)
      suppressTerminalEvent.delete(worker.id)
      yield* orchestra.mainOf(project.main!)
      const [report] = yield* reports(project.main!).pipe(
        Effect.filterOrFail((items) => items.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(report).toContain('state="failed"')
      expect(report).toContain("Worker session")
      expect(report).toContain("was removed")
      yield* untilNoPending(worker.id)
    }).pipe(Effect.scoped),
  ),
  it.live("clears the marker when a report was admitted just before a crash", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-report-retry-")))
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const kv = yield* KV.Service
      const project = yield* orchestra.create({ name: "Report retry", directory: tmp.path, template: "bugfix" })
      const worker = yield* orchestra.createMember({ project: project, title: "Developer", agent: Orchestra.role("developer") })
      yield* Effect.acquireRelease(
        Effect.sync(() => suppressTerminalEvent.add(worker.id)),
        () => Effect.sync(() => suppressTerminalEvent.delete(worker.id)),
      )

      yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Fix the bug" })
      yield* Effect.sleep("50 millis")
      const taskKey = `orchestra/task/${worker.id}`
      const value = yield* kv.get(taskKey)
      expect(value).toBeDefined()
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing task marker")
      const reportID = SessionMessage.ID.create()
      const original = value as Record<string, unknown>
      yield* kv.set(taskKey, { ...original, reportID })

      // Simulate the crash window: the report made it to the inbox, but the task marker wasn't cleared.
      const taskID = typeof original.messageID === "string" ? original.messageID : "legacy"
      const reportText = `<team-report session="${worker.id}" task="${taskID}" title="Developer" role="${Orchestra.role("developer")}" state="done" outcome="unknown">\nOriginal durable report\n</team-report>`
      yield* sessions
        .synthetic({
          id: reportID,
          sessionID: project.main!,
          description: "Developer: done",
          text: reportText,
          metadata: {
            source: "team",
            sessionID: worker.id,
            state: "done",
            outcome: "unknown",
            ...(taskID === "legacy" ? {} : { taskID }),
          },
        })
        .pipe(Effect.orDie)
      expect(yield* reports(project.main!)).toHaveLength(1)

      // Reconciliation must recognize the already-admitted ID, not retry with a conflicting body.
      yield* orchestra.mainOf(project.main!)
      expect(yield* reports(project.main!)).toHaveLength(1)
      yield* untilNoPending(worker.id)
    }).pipe(Effect.scoped),
  ),
  it.live("creates manual members through a recoverable roster plan and rejects stale or removed owners", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-member-lifecycle-")))
      const orchestra = yield* Orchestra.Service
      const kv = yield* KV.Service
      const project = yield* orchestra.create({ name: "Member lifecycle", directory: tmp.path })

      const member = yield* orchestra.createMember({
        project,
        title: "Manual worker",
        agent: Orchestra.role("developer"),
        category: "Build",
      })
      expect(member).toMatchObject({ title: "Manual worker", agent: Orchestra.role("developer") })
      expect((yield* orchestra.owners())[member.id]).toBe(project.id)
      expect(yield* orchestra.access(member.id)).toBe("full")
      expect(yield* orchestra.categories([member.id])).toEqual({ [member.id]: "Build" })
      expect((yield* orchestra.sessions(project.id)).map((item) => item.id)).toContain(member.id)
      expect(yield* kv.get(`orchestra/team-plan/${project.id}`)).toBeUndefined()

      // Simulate a process crash after the write-ahead plan is stored but before the worker
      // Session exists. Opening the owning orchestrator resumes that exact ID and policy.
      const recoveredID = Session.ID.create()
      const planKey = `orchestra/team-plan/${project.id}`
      yield* kv.set(planKey, {
        created: Date.now(),
        members: [
          {
            id: recoveredID,
            agent: Orchestra.role("tester"),
            title: "Recovered manual worker",
            category: "Quality",
          },
        ],
      })
      yield* orchestra.mainOf(project.main!)
      const recovered = (yield* orchestra.sessions(project.id)).find((item) => item.id === recoveredID)
      expect(recovered).toMatchObject({ title: "Recovered manual worker", agent: Orchestra.role("tester") })
      expect((yield* orchestra.owners())[recoveredID]).toBe(project.id)
      expect(yield* orchestra.access(recoveredID)).toBe("full")
      expect(yield* orchestra.categories([recoveredID])).toEqual({ [recoveredID]: "Quality" })
      expect(yield* kv.get(planKey)).toBeUndefined()

      const stale = { ...project, main: undefined }
      const staleError = yield* orchestra
        .createMember({ project: stale, title: "Stale worker", agent: Orchestra.role("developer") })
        .pipe(Effect.flip)
      expect(staleError.message).toContain("main session")
      expect((yield* orchestra.sessions(project.id)).map((item) => item.title)).not.toContain("Stale worker")

      yield* orchestra.remove(project.id)
      const removedError = yield* orchestra
        .createMember({ project, title: "Late worker", agent: Orchestra.role("developer") })
        .pipe(Effect.flip)
      expect(removedError.message).toContain("no longer exists")
      expect(Object.values(yield* orchestra.owners())).not.toContain(project.id)
    }).pipe(Effect.scoped),
  ),

  it.live("rejects dispatch to a worker owned by another project in the same directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-cross-project-dispatch-")))
      const orchestra = yield* Orchestra.Service
      const first = yield* orchestra.create({ name: "First", directory: tmp.path, template: "bugfix" })
      const second = yield* orchestra.create({ name: "Second", directory: tmp.path, template: "bugfix" })
      const foreign = yield* orchestra.createMember({ project: second, title: "Developer", agent: Orchestra.role("developer") })
      expect(yield* orchestra.owns(first, foreign)).toBe(false)

      const failure = yield* orchestra
        .dispatch({ project: first, sessionID: foreign.id, text: "Should never reach the second project" })
        .pipe(Effect.flip)
      expect(failure.message).toContain("does not belong to project")
      yield* untilNoPending(foreign.id)
      expect(yield* reports(second.main!)).toHaveLength(0)
    }).pipe(Effect.scoped),
  ),

  it.live("rejects stale or removed projects instead of treating dispatch as success", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-stale-dispatch-")))
      const orchestra = yield* Orchestra.Service
      const project = yield* orchestra.create({ name: "Stale", directory: tmp.path, template: "bugfix" })
      const worker = yield* orchestra.createMember({ project: project, title: "Developer", agent: Orchestra.role("developer") })

      const stale = { ...project, main: undefined }
      const staleFailure = yield* orchestra
        .dispatch({ project: stale, sessionID: worker.id, text: "Stale caller" })
        .pipe(Effect.flip)
      expect(staleFailure.message).toContain("stale")
      yield* untilNoPending(worker.id)

      yield* orchestra.remove(project.id)
      const removedFailure = yield* orchestra
        .dispatch({ project, sessionID: worker.id, text: "Removed project" })
        .pipe(Effect.flip)
      expect(removedFailure.message).toContain("no longer exists")
      yield* untilNoPending(worker.id)
    }).pipe(Effect.scoped),
  ),

  it.live("does not report an unrelated completion for an undispatched queued task", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-task-")))
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const project = yield* orchestra.create({ name: "Task tracking", directory: tmp.path, template: "bugfix" })
      const worker = yield* orchestra.createMember({ project: project, title: "Developer", agent: Orchestra.role("developer") })
      yield* Effect.acquireRelease(
        Effect.sync(() => deferTaskDelivery.add(worker.id)),
        () => Effect.sync(() => deferTaskDelivery.delete(worker.id)),
      )

      yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Fix the bug" })
      yield* Effect.sleep("50 millis")
      expect(yield* reports(project.main!)).toHaveLength(0)
      expect(yield* orchestra.pending(worker.id)).toBeNumber()

      // A real queued Inbox item must survive recovery even though it is not in projected history yet.
      yield* orchestra.mainOf(project.main!)
      expect(yield* reports(project.main!)).toHaveLength(0)
      expect(yield* orchestra.pending(worker.id)).toBeNumber()

      const blocked = yield* orchestra.dispatch({ project, sessionID: worker.id, text: "Do another task" }).pipe(Effect.flip)
      expect(blocked.message).toContain("outstanding task")

      deferTaskDelivery.delete(worker.id)
      yield* sessions.resume(worker.id)
      const [report] = yield* reports(project.main!).pipe(
        Effect.filterOrFail((found) => found.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(report).toContain("Developer: task answer")
      expect(report).not.toContain("Developer: unrelated answer")
      yield* untilNoPending(worker.id)
    }).pipe(Effect.scoped),
  ),
  it.live("failed runs are reported and shutdowns wait for the resumed run", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-team-")))
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const project = yield* orchestra.create({ name: "Team", directory: tmp.path, template: "docs" })
      const main = project.main!
      const location = { directory: (yield* sessions.get(main)).location.directory }
      const failing = yield* sessions.create({ location, title: "Writer fails", agent: Orchestra.role("writer") })
      const paused = yield* sessions.create({ location, title: "Reviewer shutdown", agent: Orchestra.role("reviewer") })

      yield* orchestra.dispatch({ project, sessionID: paused.id, text: "Review" })
      yield* orchestra.dispatch({ project, sessionID: failing.id, text: "Write" })
      const found = yield* reports(main).pipe(
        Effect.filterOrFail((items) => items.length > 0),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(found).toHaveLength(1)
      expect(found[0]).toContain('state="failed"')
      expect(found[0]).toContain("Run failed: Disconnected")
      // the shutdown left its task open for the run that resumes after restart
      expect(yield* orchestra.pending(paused.id)).toBeNumber()
    }).pipe(Effect.scoped),
  )

  it.live("keeps imported process roles project-local through claims and project removal", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orchestra-process-roles-")))
      const orchestra = yield* Orchestra.Service
      const sessions = yield* Session.Service
      const kv = yield* KV.Service
      const first = yield* orchestra.create({ name: "Process A", directory: tmp.path })
      const second = yield* orchestra.create({ name: "Process B", directory: tmp.path })
      const id = `process-${createHash("sha256").update(first.id).digest("hex").slice(0, 16)}-1`
      const spec = { name: "Local reviewer", description: "Only this process", rules: "  preserve rules exactly\r\n", category: "Quality", readOnly: true, tools: ["read"] }
      const globalBefore = yield* orchestra.roles()
      const role = yield* orchestra.saveProjectRole(first.id, id, spec)
      expect(role.rules).toBe(spec.rules)
      expect(yield* orchestra.roles()).toEqual(globalBefore)
      expect((yield* orchestra.roles(first.id)).find(item => item.agent === role.agent)).toMatchObject(role)
      expect((yield* orchestra.roles(second.id)).some(item => item.agent === role.agent)).toBe(false)
      expect((yield* orchestra.scopedRoles()).find(item => item.agent === role.agent)?.projectID).toBe(first.id)
      expect(Exit.isFailure(yield* Effect.exit(orchestra.saveProjectRole(second.id, id, spec)))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(orchestra.saveProjectRole(first.id, id, { ...spec, rules: "overwrite" })))).toBe(true)
      const worker = yield* orchestra.createMember({ project: first, agent: role.agent })
      expect(yield* orchestra.projectRoleAllowed(worker.id, role.agent)).toBe(true)
      expect(yield* orchestra.projectRoleAllowed(second.main!, role.agent)).toBe(false)
      expect(Exit.isFailure(yield* Effect.exit(orchestra.createMember({ project: second, agent: role.agent })))).toBe(true)
      const unclaimed = yield* sessions.create({ agent: role.agent, location: { directory: AbsolutePath.make(tmp.path) } })
      expect(yield* orchestra.projectRoleAllowed(unclaimed.id, role.agent)).toBe(false)
      yield* orchestra.claim(worker.id, second.id)
      expect(yield* orchestra.projectRoleAllowed(worker.id, role.agent)).toBe(false)
      yield* orchestra.claim(worker.id, first.id)
      expect(yield* orchestra.projectRoleAllowed(worker.id, role.agent)).toBe(true)
      yield* kv.set("orchestra/process-skills/" + first.id, { version: 1, projectID: first.id, skills: [] })
      yield* kv.set("orchestra/process-skill-definitions/" + first.id, { version: 1, projectID: first.id })
      yield* orchestra.remove(first.id)
      expect(yield* kv.get("orchestra/process-skills/" + first.id)).toBeUndefined()
      expect(yield* kv.get("orchestra/process-skill-definitions/" + first.id)).toBeUndefined()
      expect(yield* orchestra.projectRoleAllowed(worker.id, role.agent)).toBe(false)
      expect((yield* orchestra.scopedRoles()).some(item => item.agent === role.agent)).toBe(false)
      expect(yield* orchestra.roles()).toEqual(globalBefore)
    }).pipe(Effect.scoped),
  )

  it.live("blocks local process agents at prompt, context, tool and permission boundaries outside their project", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orchestra-process-boundary-")))
      const orchestra = yield* Orchestra.Service
      const agents = yield* Agent.Service
      const sessions = yield* Session.Service
      const first = yield* orchestra.create({ name: "Process A", directory: tmp.path })
      const second = yield* orchestra.create({ name: "Process B", directory: tmp.path })
      const id = `process-${createHash("sha256").update(first.id).digest("hex").slice(0, 16)}-1`
      const role = yield* orchestra.saveProjectRole(first.id, id, { name: "Scoped reviewer", description: "Local", rules: "Review only", category: "Quality", readOnly: true, tools: ["read"] })
      const worker = yield* orchestra.createMember({ project: first, agent: role.agent })
      const foreign = yield* sessions.create({ agent: role.agent, location: { directory: AbsolutePath.make(tmp.path) } })
      yield* orchestra.claim(foreign.id, second.id)
      const contexts: Array<(event: SessionContext) => Effect.Effect<void>> = []
      const prompts: Array<(event: unknown) => Effect.Effect<void, unknown>> = []
      const before: Array<(event: unknown) => Effect.Effect<void, unknown>> = []
      const permissions: Array<(event: PermissionEvaluation) => Effect.Effect<void>> = []
      yield* TeamPlugin.Plugin.effect(host({
        agent: agentHost(agents),
        session: { hook: ((name: string, callback: (event: unknown) => Effect.Effect<void, unknown>) => Effect.sync(() => {
          if (name === "context") contexts.push(callback as (event: SessionContext) => Effect.Effect<void>)
          if (name === "prompt") prompts.push(callback)
        }).pipe(Effect.as({ dispose: Effect.void }))) as never },
        tool: { hook: ((name: string, callback: (event: unknown) => Effect.Effect<void, unknown>) => Effect.sync(() => { if (name === "execute.before") before.push(callback) }).pipe(Effect.as({ dispose: Effect.void }))) as never, transform: () => Effect.die("unused"), reload: () => Effect.void, list: () => Effect.succeed([]) },
        permission: { hook: (_, callback) => Effect.sync(() => permissions.push(callback)).pipe(Effect.as({ dispose: Effect.void })), list: () => Effect.die("unused"), get: () => Effect.die("unused"), reply: () => Effect.die("unused") },
      }))
      const tools = new Map<string, Tool.Info>()
      yield* OrchestraTool.Plugin.effect(host({
        session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
        tool: {
          transform: callback => Effect.sync(() => { callback({ list: () => [], get: () => undefined, namespace: () => {}, add: tool => { tools.set(tool.name, tool) }, update: () => {}, remove: () => {} }) }).pipe(Effect.as({ dispose: Effect.void })),
          reload: () => Effect.void, list: () => Effect.succeed([]), hook: () => Effect.succeed({ dispose: Effect.void }),
        },
      }))
      const createThroughTool = (sessionID: Session.ID) => tools.get("sessions")!.execute({ action: "create", role: role.id, newInstance: true, mcp: { servers: [], maxCalls: 0 } }, { sessionID, agent: Orchestra.agent, messageID: SessionMessage.ID.create(), id: Tool.CallID.make("local_role_create"), progress: () => Effect.void })
      yield* createThroughTool(first.main!)
      expect((yield* orchestra.sessions(first.id)).filter(session => session.agent === role.agent)).toHaveLength(2)
      expect(Exit.isFailure(yield* Effect.exit(createThroughTool(second.main!)))).toBe(true)
      expect((yield* agents.get(role.agent))?.hidden).toBe(true)
      const tool = (sessionID: Session.ID) => Effect.forEach(before, hook => hook({ sessionID, agent: role.agent, tool: "read", input: {} }))
      const prompt = (sessionID: Session.ID) => Effect.forEach(prompts, hook => hook({ sessionID, prompt: { text: "Review" } }))
      const context = (sessionID: Session.ID) => Effect.forEach(contexts, hook => hook({ sessionID, agent: role.agent, system: [], tools: {} } as unknown as SessionContext))
      const permission = (sessionID: Session.ID, action: string, effect: PermissionEvaluation["effect"] = "allow") => Effect.gen(function* () {
        const event: PermissionEvaluation = { sessionID, agent: role.agent, action, effect, resources: [tmp.path] }
        yield* Effect.forEach(permissions, hook => hook(event))
        return event.effect
      })
      yield* tool(worker.id)
      yield* prompt(worker.id)
      expect(yield* permission(worker.id, "read")).toBe("allow")
      expect(yield* permission(worker.id, "edit")).toBe("deny")
      expect(yield* permission(worker.id, "external_directory", "ask")).toBe("ask")
      expect(Exit.isFailure(yield* Effect.exit(tool(foreign.id)))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(prompt(foreign.id)))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(context(foreign.id)))).toBe(true)
      expect(yield* permission(foreign.id, "read")).toBe("deny")
      // The live ownership guard does not wait for asynchronous agent reloads.
      yield* orchestra.claim(worker.id, second.id)
      expect(Exit.isFailure(yield* Effect.exit(tool(worker.id)))).toBe(true)
      expect(yield* permission(worker.id, "read")).toBe("deny")
    }).pipe(Effect.scoped),
  )

  it.live("operators add their own roles and teams and edit the built-in ones", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-team-")))
      const orchestra = yield* Orchestra.Service
      const auditor = yield* orchestra.saveRole(undefined, {
        name: " Code Auditor ",
        description: "Audits",
        rules: "Check licenses.",
        category: "",
        readOnly: true,
        model: "test/member",
      })
      expect(auditor).toMatchObject({ id: "code-auditor", name: "Code Auditor", category: "Team", origin: "custom" })
      expect(auditor.agent).toBe(Orchestra.role("code-auditor"))
      // a second role of the same name gets its own id
      const second = yield* orchestra.saveRole(undefined, { ...auditor, model: undefined })
      expect(second.id).toBe("code-auditor-2")

      const edited = yield* orchestra.saveRole("tester", { ...auditor, name: "QA", model: undefined })
      expect(edited.origin).toBe("edited")
      const roles = yield* orchestra.roles()
      expect(roles.find((role) => role.id === "tester")).toMatchObject({ name: "QA", origin: "edited" })
      expect(roles.slice(-2).map((role) => role.id)).toEqual(["code-auditor", "code-auditor-2"])

      const template = yield* orchestra.saveTemplate(undefined, {
        name: "Audit",
        description: "",
        members: [{ agent: auditor.agent, title: "", category: "" }],
      })
      expect(template).toMatchObject({ id: "audit", origin: "custom" })
      expect(template.members).toEqual([{ agent: auditor.agent, title: "Code Auditor", category: "Team" }])

      const deduplicated = yield* orchestra.saveTemplate(undefined, {
        name: "Duplicate roster",
        description: "",
        members: [
          { agent: auditor.agent, title: "President", category: "Team" },
          { agent: auditor.agent, title: "President", category: "Team" },
          { agent: auditor.agent, title: "President 2", category: "Team" },
        ],
      })
      expect(deduplicated.members).toEqual([
        { agent: auditor.agent, title: "President", category: "Team" },
        { agent: auditor.agent, title: "President 2", category: "Team" },
      ])

      const project = yield* orchestra.create({ name: "Audit", directory: tmp.path, template: "audit" })
      const [member] = yield* orchestra.sessions(project.id)
      expect(member.agent).toBe(auditor.agent)
      // the runner reads only the session's model, so the role's model is set on its session
      expect(member.model).toMatchObject({ providerID: "test", id: "member" })

      // a custom role a team uses cannot be removed; removing an edited built-in restores it
      const blocked = yield* orchestra.removeRole("code-auditor").pipe(Effect.flip)
      expect(blocked.message).toContain("Audit")
      yield* orchestra.removeRole("tester")
      expect((yield* orchestra.roles()).find((role) => role.id === "tester")).toMatchObject({
        name: "Tester",
        origin: "builtin",
      })
      yield* orchestra.removeTemplate("audit")
      // the deduplicated roster still uses the role, so it has to go too
      yield* orchestra.removeTemplate(deduplicated.id)
      yield* orchestra.removeRole("code-auditor")
      expect((yield* orchestra.templates()).some((item) => item.id === "audit")).toBe(false)
      expect((yield* orchestra.roles()).some((role) => role.id === "code-auditor")).toBe(false)

      const invalid = yield* orchestra.saveRole(undefined, { ...auditor, model: "no-slash" }).pipe(Effect.flip)
      expect(invalid.field).toBe("model")
      const unknown = yield* orchestra
        .saveTemplate(undefined, {
          name: "X",
          description: "",
          members: [{ agent: Orchestra.role("nobody"), title: "", category: "" }],
        })
        .pipe(Effect.flip)
      expect(unknown.field).toBe("members")
    }).pipe(Effect.scoped),
  )

  it.live("team roles are agents that follow the operator's edits", () =>
    Effect.gen(function* () {
      const orchestra = yield* Orchestra.Service
      const agents = yield* Agent.Service
      const hooks: Array<(event: PermissionEvaluation) => Effect.Effect<void>> = []
      const contexts: Array<(event: SessionContext) => Effect.Effect<void>> = []
      const prompts: Array<(event: { sessionID: Session.ID }) => Effect.Effect<void>> = []
      const beforeTool: Array<(event: unknown) => Effect.Effect<void, Tool.Error>> = []
      yield* TeamPlugin.Plugin.effect(
        host({
          agent: agentHost(agents),
          session: {
            hook: ((name: string, callback: (event: unknown) => Effect.Effect<void, unknown>) =>
              Effect.sync(() => {
                if (name === "context") contexts.push(callback as (event: SessionContext) => Effect.Effect<void>)
                if (name === "prompt") prompts.push(callback as (event: { sessionID: Session.ID }) => Effect.Effect<void>)
              }).pipe(Effect.as({ dispose: Effect.void }))) as never,
          },
          tool: {
            hook: ((name: string, callback: (event: unknown) => Effect.Effect<void, Tool.Error>) =>
              Effect.sync(() => {
                if (name === "execute.before") beforeTool.push(callback)
              }).pipe(Effect.as({ dispose: Effect.void }))) as never,
            transform: () => Effect.die("unused tool.transform"),
            reload: () => Effect.die("unused tool.reload"),
            list: () => Effect.die("unused tool.list"),
          },
          permission: {
            hook: (_, callback) => Effect.sync(() => hooks.push(callback)).pipe(Effect.as({ dispose: Effect.void })),
            list: () => Effect.die("unused permission.list"),
            get: () => Effect.die("unused permission.get"),
            reply: () => Effect.die("unused permission.reply"),
          },
        }),
      )
      const tools = new Map<string, Tool.Info>()
      yield* OrchestraTool.Plugin.effect(
        host({
          session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
          tool: {
            transform: (callback) =>
              Effect.sync(() => {
                callback({
                  list: () => [],
                  get: () => undefined,
                  namespace: () => {},
                  add: (tool) => {
                    tools.set(tool.name, tool)
                  },
                  update: () => {},
                  remove: () => {},
                })
              }).pipe(Effect.as({ dispose: Effect.void })),
            reload: () => Effect.void,
            list: () => Effect.succeed([]),
            hook: () => Effect.succeed({ dispose: Effect.void }),
          },
        }),
      )
      // What the permission service passes to plugins once every agent and config rule allowed the edit.
      const evaluate = (
        agent: Agent.ID,
        action: string,
        effect: PermissionEvaluation["effect"] = "allow",
        sessionID: Session.ID = Session.ID.create(),
      ) =>
        Effect.gen(function* () {
          const event: PermissionEvaluation = {
            sessionID,
            agent,
            action,
            resources: ["/project/file.txt"],
            effect,
          }
          yield* Effect.forEach(hooks, (hook) => hook(event), { discard: true })
          return event.effect
        })
      expect(String((yield* agents.get(Orchestra.role("developer")))?.name)).toBe("Developer")
      const availableRoles = yield* orchestra.roles()
      const counterexampleRole = availableRoles.find((item) => item.id === "counterexample-engineer")
      expect(counterexampleRole).toMatchObject({
        name: "Counterexample Engineer",
        readOnly: true,
        category: "Quality",
      })
      const counterexample = yield* agents.get(Orchestra.role("counterexample-engineer")).pipe(
        Effect.filterOrFail((item) => item !== undefined),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect((counterexample.system ?? "").toLowerCase()).toContain("trying to disprove")
      expect((counterexample.system ?? "").toLowerCase()).toContain("concrete counterexamples")
      expect(counterexample.permissions).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
      const counterexampleEditEffect = yield* evaluate(Orchestra.role("counterexample-engineer"), "edit")
      expect(counterexampleEditEffect).toBe("deny")

      const role = yield* orchestra.saveRole(undefined, {
        name: "Translator",
        description: "Translates",
        rules: "Translate to Russian.",
        category: "Build",
        readOnly: true,
        model: "test/member",
      })
      const agent = yield* agents.get(role.agent).pipe(
        Effect.filterOrFail((item) => item !== undefined),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(agent.system).toEndWith("Translate to Russian.")
      expect(agent.model).toEqual(model)
      expect(agent.permissions).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
      // a global `edit: allow` from config cannot reopen a read-only role
      expect(yield* evaluate(role.agent, "edit")).toBe("deny")
      expect(yield* evaluate(role.agent, "read")).toBe("allow")
      expect(yield* evaluate(Orchestra.role("developer"), "edit")).toBe("allow")
      expect(yield* evaluate(Orchestra.agent, "edit")).toBe("deny")
      expect(yield* evaluate(Orchestra.agent, "subagent")).toBe("deny")
      expect(yield* evaluate(Orchestra.role("developer"), "subagent")).toBe("deny")
      // the Orchestrator settles other-directory access for its team instead of prompting the operator
      expect(yield* evaluate(Orchestra.role("developer"), "external_directory", "ask")).toBe("allow")
      expect(yield* evaluate(Orchestra.agent, "external_directory", "ask")).toBe("allow")
      expect(yield* evaluate(Agent.defaultID, "external_directory", "ask")).toBe("ask")

      yield* orchestra.removeRole(role.id)
      yield* agents.get(role.agent).pipe(
        Effect.filterOrFail((item) => item === undefined),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )

      // A role limited to some tools keeps that limit even where config allows a tool for everyone.
      const scout = yield* orchestra.saveRole(undefined, {
        name: "Scout",
        description: "Looks around",
        rules: "",
        category: "Planning",
        readOnly: false,
        tools: ["read", "grep", " grep ", "context7_*"],
        hub: ["git"],
      })
      expect(scout.tools).toEqual(["read", "grep", "context7_*"])
      const scoutAgent = yield* agents.get(scout.agent).pipe(
        Effect.filterOrFail((item) => item !== undefined),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("2 seconds"),
      )
      expect(scoutAgent.permissions).toContainEqual({ action: "*", resource: "*", effect: "deny" })
      expect(scoutAgent.permissions).toContainEqual({ action: "grep", resource: "*", effect: "allow" })
      expect(yield* evaluate(scout.agent, "shell")).toBe("deny")
      expect(yield* evaluate(scout.agent, "edit")).toBe("deny")
      expect(yield* evaluate(scout.agent, "read")).toBe("allow")
      // other actions, such as asking the operator, are not tools and stay untouched
      expect(yield* evaluate(scout.agent, "question")).toBe("allow")
      yield* orchestra.removeRole(scout.id)

      // The Orchestrator and its team read the project's shared notes with every request.
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-notes-")))
      const project = yield* orchestra.create({ name: "Notes", directory: tmp.path })
      const context = (agent: Agent.ID) =>
        Effect.gen(function* () {
          const event = { sessionID: project.main!, agent, system: [], tools: {} } as unknown as SessionContext
          yield* Effect.forEach(contexts, (hook) => hook(event), { discard: true })
          return event.system.map((part) => (part.type === "text" ? part.text : "")).join(" ")
        })
      expect(yield* context(Orchestra.agent)).toContain("The team has no notes yet")
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".opencode", "team-notes.md"), "Build: bun run build"))
      expect(yield* context(Orchestra.agent)).toContain("Build: bun run build")
      expect(yield* context(Agent.ID.make("build"))).toContain("Build: bun run build")

      const sessionService = yield* Session.Service
      // The tool's own path: the orchestrator calls sessions set_mode on a worker, and the
      // worker's stored metadata changes for its next task.
      const modeWorker = yield* sessionService.create({
        location: { directory: AbsolutePath.make(project.directory) },
        title: "Mode worker",
      })
      yield* orchestra.claim(modeWorker.id, project.id)
      yield* orchestra.setAccess(modeWorker.id, "write")
      const sessionsTool = tools.get("sessions")
      if (!sessionsTool) return yield* Effect.die("sessions tool was not registered")
      const setModeResult = yield* sessionsTool.execute(
        { action: "set_mode", sessionID: modeWorker.id, mode: "planning" },
        {
          sessionID: project.main!,
          agent: Orchestra.agent,
          messageID: SessionMessage.ID.create(),
          id: Tool.CallID.make("call_set_mode"),
          progress: () => Effect.void,
        },
      )
      expect(setModeResult.content).toContain("Planning")
      expect((yield* sessionService.get(modeWorker.id))?.metadata?.[Mode.MetadataKey]).toBe("planning")

      // Some models truncate sessionID to "ses" and put the real ID in text. The tool reads the
      // worker anyway, and a send explains that the message is missing instead of "not found: ses".
      const slip = (action: "read" | "send") =>
        sessionsTool.execute(
          { action, sessionID: "ses", text: modeWorker.id },
          {
            sessionID: project.main!,
            agent: Orchestra.agent,
            messageID: SessionMessage.ID.create(),
            id: Tool.CallID.make("call_slip"),
            progress: () => Effect.void,
          },
        )
      expect((yield* slip("read")).metadata).toEqual({ sessionID: modeWorker.id })
      expect((yield* slip("send").pipe(Effect.flip)).message).toContain("Pass the message as text")
      expect(
        (yield* sessionsTool
          .execute(
            { action: "read", sessionID: "ses" },
            {
              sessionID: project.main!,
              agent: Orchestra.agent,
              messageID: SessionMessage.ID.create(),
              id: Tool.CallID.make("call_unknown"),
              progress: () => Effect.void,
            },
          )
          .pipe(Effect.flip)).message,
      ).toBe("Сессия не существует или недоступна: ses. Обновите sessions list; не повторяйте отправку по старому ID.")

      // A mode narrows how a session works without changing its role. Planning removes the
      // editing tools from the request and still denies an edit that reaches the permission
      // hook; explicit `auto` restores the developer's normal working set.
      const modeSession = project.main!
      yield* sessionService.setMetadata({ sessionID: modeSession, metadata: { [Mode.MetadataKey]: "planning" } })
      const modeEvent = {
        sessionID: modeSession,
        agent: Orchestra.role("developer"),
        system: [],
        tools: { edit: {}, write: {}, patch: {} },
      } as unknown as SessionContext
      yield* Effect.forEach(contexts, (hook) => hook(modeEvent), { discard: true })
      const modeText = modeEvent.system.map((part) => (part.type === "text" ? part.text : "")).join(" ")
      expect(modeText).toContain("Work mode: Planning")
      expect(modeEvent.tools.edit).toBeUndefined()
      expect(modeEvent.tools.write).toBeUndefined()
      expect(modeEvent.tools.patch).toBeUndefined()
      expect(yield* evaluate(Orchestra.role("developer"), "edit", "allow", modeSession)).toBe("deny")

      yield* sessionService.setMetadata({ sessionID: modeSession, metadata: { [Mode.MetadataKey]: "auto" } })
      expect(yield* evaluate(Orchestra.role("developer"), "edit", "allow", modeSession)).toBe("allow")

      // An agent outside the team honours a mode the operator picked for its session, and is left
      // alone without one: the TUI offers the picker for every session.
      yield* sessionService.setMetadata({ sessionID: modeSession, metadata: { [Mode.MetadataKey]: "research" } })
      const plainEvent = {
        sessionID: modeSession,
        agent: Agent.ID.make("build"),
        system: [],
        tools: { edit: {}, write: {}, patch: {}, read: {} },
      } as unknown as SessionContext
      yield* Effect.forEach(contexts, (hook) => hook(plainEvent), { discard: true })
      expect(plainEvent.system.map((part) => (part.type === "text" ? part.text : "")).join(" ")).toContain(
        "Work mode: Research",
      )
      expect(plainEvent.tools.edit).toBeUndefined()
      expect(plainEvent.tools.read).toBeDefined()
      expect(yield* evaluate(Agent.ID.make("build"), "edit", "allow", modeSession)).toBe("deny")

      yield* sessionService.setMetadata({ sessionID: modeSession, metadata: { [Mode.MetadataKey]: "auto" } })
      expect(yield* evaluate(Agent.ID.make("build"), "edit", "allow", modeSession)).toBe("allow")

      // The Orchestrator may look around a few times, then must hand the work on: the next exploring call is
      // refused until it dispatches or a new prompt arrives. Other agents are never limited.
      let calls = 0
      const call = (tool: string, input: unknown = {}, agent: Agent.ID = Orchestra.agent) =>
        Effect.forEach(
          beforeTool,
          (hook) =>
            hook({
              tool,
              sessionID: modeSession,
              agent,
              messageID: SessionMessage.ID.create(),
              id: Tool.CallID.make(`call_explore_${calls++}`),
              input,
            }),
          { discard: true },
        )
      for (let index = 0; index < EXPLORE_LIMIT; index++) yield* call("read")
      const refused = yield* call("grep").pipe(Effect.flip)
      expect(refused.message).toContain("without dispatching anything")
      yield* call("sessions", { action: "send" })
      yield* call("shell")
      for (let index = 0; index < EXPLORE_LIMIT - 1; index++) yield* call("read")
      expect((yield* call("read").pipe(Effect.flip)).message).toContain("without dispatching anything")
      yield* Effect.forEach(prompts, (hook) => hook({ sessionID: modeSession, prompt: { text: "go on" } } as never), { discard: true })
      yield* call("read")
      for (let index = 0; index < 10; index++) yield* call("read", {}, Agent.ID.make("build"))

      // A team role that reaches for grep/rg/find in shell is pointed to the Registry once, then left alone.
      const developer = Orchestra.role("developer")
      yield* call("shell", { command: "ls -la" }, developer)
      const pointed = yield* call("shell", { command: "rg -n TODO packages" }, developer).pipe(Effect.flip)
      expect(pointed.message).toContain("Registry (hub tool)")
      yield* call("shell", { command: "rg -n TODO packages" }, developer)
      yield* call("shell", { command: "git grep -n x" }, developer)

      // Built-in roles and teams are never rewritten by the Orchestrator; a custom one may be.
      const rewrite = (action: string, id: string) => call("team_forge", { action, id })
      expect((yield* rewrite("edit_role", "developer").pipe(Effect.flip)).message).toContain("built-in roles or teams")
      expect((yield* rewrite("delete_team", "mobile-app").pipe(Effect.flip)).message).toContain("built-in roles or teams")
      yield* rewrite("edit_role", "no-such-custom-role")
      yield* call("team_forge", { action: "list" })
      yield* call("team_forge", { action: "edit_role", id: "developer" }, Agent.ID.make("build"))

      // After a worker fails on a provider limit the Orchestrator may not switch models or rewrite roles to get around it.
      const limitReport = `<team-report session="s" task="t" title="Dev" role="developer" state="failed" outcome="failed">Run failed: 429 FreeUsageLimitError</team-report>`
      yield* Effect.forEach(prompts, (hook) => (hook as (event: unknown) => Effect.Effect<void>)({ sessionID: modeSession, prompt: { text: limitReport } }), { discard: true })
      expect((yield* call("sessions", { action: "send", model: "opencode/other" }).pipe(Effect.flip)).message).toContain("provider limit")
      expect((yield* rewrite("edit_role", "no-such-custom-role").pipe(Effect.flip)).message).toContain("provider limit")
      yield* call("sessions", { action: "send" })
      // The operator's next message lifts the restriction.
      yield* Effect.forEach(prompts, (hook) => (hook as (event: unknown) => Effect.Effect<void>)({ sessionID: modeSession, prompt: { text: "continue" } }), { discard: true })
      yield* call("sessions", { action: "send", model: "opencode/other" })
      expect(isLimitReport("<team-report state=\"done\">quota text</team-report>")).toBe(false)
    }).pipe(Effect.scoped),
  )
})

describe("Orchestra MCP assignment gate", () => {
  it.live("refuses a dispatch to a role session without an explicit MCP assignment", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-mcp-gate-")))
      const orchestra = yield* Orchestra.Service
      const project = yield* orchestra.create({ name: "Gate", directory: tmp.path })
      const worker = yield* orchestra.createMember({
        project,
        title: "Developer",
        agent: Orchestra.role("developer"),
      })
      const tools = new Map<string, Tool.Info>()
      yield* OrchestraTool.Plugin.effect(
        host({
          session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
          tool: {
            transform: (callback) =>
              Effect.sync(() => {
                callback({
                  list: () => [],
                  get: () => undefined,
                  namespace: () => {},
                  add: (tool) => {
                    tools.set(tool.name, tool)
                  },
                  update: () => {},
                  remove: () => {},
                })
              }).pipe(Effect.as({ dispose: Effect.void })),
            reload: () => Effect.void,
            list: () => Effect.succeed([]),
            hook: () => Effect.succeed({ dispose: Effect.void }),
          },
        }),
      )
      const sessionsTool = tools.get("sessions")
      if (!sessionsTool) return yield* Effect.die("sessions tool was not registered")
      const context = {
        sessionID: project.main!,
        agent: Orchestra.agent,
        messageID: SessionMessage.ID.create(),
        id: Tool.CallID.make("call_mcp_gate"),
        progress: () => Effect.void,
      }
      // No mcp field: refused, nothing sent — the assignment must be stated, not inherited.
      const refused = yield* sessionsTool
        .execute({ action: "send", sessionID: worker.id, text: "do the task" }, context)
        .pipe(Effect.flip)
      expect(refused.message).toContain("No MCP assignment")
      // An explicit no-MCP grant is a valid assignment: the dispatch goes through and the
      // session carries the explicit record with a zero budget.
      yield* sessionsTool.execute(
        { action: "send", sessionID: worker.id, text: "do the task", mcp: { servers: [], maxCalls: 0 } },
        context,
      )
      const sessionService = yield* Session.Service
      const stamped = yield* sessionService.get(worker.id)
      const assignment = OrchestraTool.mcpAssignmentOf(stamped?.metadata)
      expect(assignment?.explicit).toBe(true)
      expect(assignment?.servers).toEqual([])
      expect(assignment?.maxCalls).toBe(0)
    }),
  )
})

describe("Orchestra workflow stages", () => {
  it.live("plans, transitions and replans stages persisted per project", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-stages-")))
      const orchestra = yield* Orchestra.Service
      const project = yield* orchestra.create({ name: "Stages", directory: tmp.path })

      const planned = yield* orchestra.planStages(project.id, [
        { id: "research", name: "Research", categories: ["Research"], acceptance: "sources cited" },
        { id: "build", name: "Build", dependsOn: ["research"] },
      ])
      expect(planned.map((stage) => stage.status)).toEqual(["planned", "planned"])

      // A dependent stage cannot start before its dependency completes.
      const early = yield* orchestra.setStage(project.id, "build", { status: "running" }).pipe(Effect.flip)
      expect(early._tag).toBe("Orchestra.StageError")
      expect(early.message).toContain("dependencies not completed")

      yield* orchestra.setStage(project.id, "research", { status: "running" })
      // Completion without evidence is refused.
      const bare = yield* orchestra.setStage(project.id, "research", { status: "completed" }).pipe(Effect.flip)
      expect(bare.message).toContain("result")
      const done = yield* orchestra.setStage(project.id, "research", { status: "completed", result: "report attached" })
      expect(done.completed).toBeTypeOf("number")

      // State survives a fresh read through the KV store.
      const stored = yield* orchestra.stages(project.id)
      expect(stored.find((stage) => stage.id === "research")?.result).toBe("report attached")

      // Replanning preserves the completed stage exactly and admits new work.
      const replanned = yield* orchestra.planStages(project.id, [
        { id: "research", name: "Research REDEFINED" },
        { id: "build", name: "Build" },
        { id: "verify", name: "Verify", dependsOn: ["build"] },
      ])
      expect(replanned.find((stage) => stage.id === "research")?.name).toBe("Research")
      expect(replanned.map((stage) => stage.id)).toEqual(["research", "build", "verify"])

      // Unknown projects fail typed, stages of a fresh project are empty.
      const other = yield* orchestra.create({ name: "Empty", directory: tmp.path })
      expect(yield* orchestra.stages(other.id)).toEqual([])
      const missing = yield* orchestra
        .planStages(Orchestra.ProjectID.make("prj_nonexistent"), [{ name: "X" }])
        .pipe(Effect.flip)
      expect(missing._tag).toBe("Orchestra.ProjectNotFoundError")
    }),
  )

  it.live("concurrent stage updates never lose each other's writes", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-orchestra-stages-race-")))
      const orchestra = yield* Orchestra.Service
      const project = yield* orchestra.create({ name: "Race", directory: tmp.path })
      yield* orchestra.planStages(project.id, [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
      ])

      // Three patches racing on the same stored plan: each is a
      // read-modify-write, so without per-project serialization the last
      // writer would silently erase the other two.
      yield* Effect.all(
        [
          orchestra.setStage(project.id, "a", { status: "running" }),
          orchestra.setStage(project.id, "b", { status: "running" }),
          orchestra.setStage(project.id, "c", { status: "running" }),
        ],
        { concurrency: "unbounded" },
      )
      const after = yield* orchestra.stages(project.id)
      expect(after.map((stage) => stage.status)).toEqual(["running", "running", "running"])

      // A replan racing a patch: the outcome must equal some sequential
      // application — a structurally valid plan, the completed stage's
      // evidence intact, and no stage silently resurrected or dropped.
      yield* Effect.all(
        [
          orchestra.setStage(project.id, "a", { status: "completed", result: "evidence A" }),
          orchestra.planStages(project.id, [
            { id: "a", name: "A" },
            { id: "b", name: "B" },
            { id: "c", name: "C" },
            { id: "d", name: "D", dependsOn: ["a"] },
          ]),
        ],
        { concurrency: "unbounded" },
      )
      const final = yield* orchestra.stages(project.id)
      expect(final.map((stage) => stage.id)).toEqual(["a", "b", "c", "d"])
      expect(final.find((stage) => stage.id === "a")?.status).toBe("completed")
      expect(final.find((stage) => stage.id === "a")?.result).toBe("evidence A")
    }),
  )
})


it.live("local trigger window applies operator pause/resume/export through the real scheduler with no model call", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orchestra-trigger-window-")))
    const orchestra = yield* Orchestra.Service, kv = yield* KV.Service
    const project = yield* orchestra.create({name:"Trigger window", directory:tmp.path})
    const main = yield* orchestra.main(project.id)
    const made = Trigger.create({kind:"interval",spec:"60",prompt:"private reviewed instruction"},{id:"trg_window",projectID:project.id,now:Date.now(),existing:0})
    if(!made.ok)throw Error(made.error)
    yield* kv.set(Trigger.key(project.id,made.trigger.id),made.trigger as never)
    ScheduleView.sync(made.trigger,String(main.id))
    for(const action of ["pause","resume","export"] as const){
      const command=ScheduleRequests.request(made.trigger.id,String(main.id),action)
      const result=yield* Effect.sync(()=>ScheduleRequests.result(command)).pipe(Effect.filterOrFail(value=>value!==undefined),Effect.retry(Schedule.spaced("20 millis")),Effect.timeout("8 seconds"))
      expect(result?.ok).toBe(true)
      const current=Trigger.parse(yield* kv.get(Trigger.key(project.id,made.trigger.id)))!
      expect(current.enabled).toBe(action!=="pause")
      expect(current.total).toBe(0)
      if(action==="export"){
        const content=yield* Effect.promise(()=>Bun.file(path.join(tmp.path,".orchestra","triggers",`trigger-${command.requestID}.json`)).text())
        expect(JSON.parse(content).format).toBe("orchestra.trigger-bundle")
        expect(content).not.toContain("private reviewed instruction")
      }
    }
  }),30_000)


it.live("template reader captures real project metadata without reading messages, creating sessions or carrying grants", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orchestra-template-live-reader-")))
    const orchestra = yield* Orchestra.Service
    const kv = yield* KV.Service
    const store = yield* SessionStore.Service
    const project = yield* orchestra.create({ name: "Template source", directory: tmp.path })
    const main = yield* orchestra.main(project.id)
    const [slot] = yield* Effect.promise(() => CredentialVault.local(project.id).createEmptyLocalSlotsFromOperator([{ name: "service", type: "api-key", label: "Service" }]))
    yield* kv.set("rules/orchestrator:" + project.id, [{ id: "r1", text: "Review the result.", by: "operator", at: 1 }])
    const before = (yield* store.list({ directoryPrefix: AbsolutePath.make(tmp.path) })).map((row) => row.id)
    const result = yield* ProjectTemplateReader.capture({ kv, getSession: (id) => store.get(Session.ID.make(id)), listSessionsInTree: (directory) => store.list({ directoryPrefix: AbsolutePath.make(directory), parentID: null }) }, project.id,
      { name: "Reusable factory", description: "Config only", minOrchestraVersion: "1.0.0" },
      { browsers: [], vault: [slot], selectedGlobalSlotIDs: new Set(), providers: [], mcp: [] })
    expect(result.bundle.sessions.some((row) => row.role === Orchestra.agent)).toBe(true)
    expect(result.bundle.rules.some((row) => row.scope === "orchestrator" && row.text === "Review the result.")).toBe(true)
    expect(result.bundle.vault.local).toEqual([{ name: "service", type: "api-key", label: "Service" }])
    expect(result.text).not.toContain(main.id)
    expect(result.text).not.toContain(project.id)
    expect(result.text).not.toContain(slot.id)
    expect((yield* store.list({ directoryPrefix: AbsolutePath.make(tmp.path) })).map((row) => row.id)).toEqual(before)
    yield* Effect.promise(() => CredentialVault.local(project.id).removeProjectSlots(project.id))
  }).pipe(Effect.scoped),
)

it.live("template live materializer writes real sessions/KV/DoD and empty Vault, then resumes without duplicates", () =>
 Effect.gen(function*(){
  const {ProjectTemplateLiveStores}=yield* Effect.promise(()=>import('../src/project-template-live-stores'))
  const {ProjectTemplateBrowserStore}=yield* Effect.promise(()=>import('../src/project-template-browser-store'))
  const {ProjectTemplate}=yield* Effect.promise(()=>import('../src/project-template'))
  const {ProjectFilesBootstrap}=yield* Effect.promise(()=>import('../src/project-files/bootstrap'))
  const {SessionHold}=yield* Effect.promise(()=>import('../src/session/hold'))
  const tmp=yield* Effect.acquireDisposable(Effect.promise(()=>tmpdir('template-real-import-')))
  const kv=yield* KV.Service,sessions=yield* Session.Service,store=yield* SessionStore.Service,database=yield* Database.Service
  yield* Effect.promise(()=>mkdir(path.join(tmp.path,'browser-data')))
  const browserStore=ProjectTemplateBrowserStore.make(kv,path.join(tmp.path,'browser-data'));let failOnce=true,failBootstrapOnce=true
  const vault=(id:string)=>CredentialVault.make({directory:path.join(tmp.path,'vault'),projectID:id,collector:{collect:async()=>{throw Error('must not request secrets')}} as never})
  const adapter=ProjectTemplateLiveStores.make({kv,sessions,store,root:path.join(tmp.path,'imports'),installedVersion:'1.0.0',timezone:'UTC',
   availableRoles:async()=>new Set(['orchestrator','team-browser-agent']),availableModels:async()=>new Set(['demo/free']),vault,
   bootstrap:async(directory,name)=>{await Effect.runPromise(ProjectFilesBootstrap.initialize(directory,name,kv).pipe(Effect.provideService(Database.Service,database)));if(failBootstrapOnce){failBootstrapOnce=false;throw Error('simulated bootstrap completion loss')}},
   browsers:{ensure:async(r,rows)=>{await browserStore.ensure(r,rows);if(failOnce){failOnce=false;throw Error('simulated browser-store checkpoint loss')}},verify:browserStore.verify},
  })
  const removeGuard=SessionHold.addGuard(adapter.held);yield* Effect.addFinalizer(()=>Effect.sync(removeGuard))
  const template={format:'orchestra.project-template',version:1,name:'Factory',description:'Settings only',minOrchestraVersion:'1.0.0',variables:{projectName:'Fresh factory',folder:'${projectFolder}'},mainSession:'main',sessions:[{slot:'main',title:'Main',role:'orchestrator',model:{provider:'demo',id:'free',variant:null}},{slot:'browser',title:'Inbox',role:'team-browser-agent',model:null}],browsers:[{slot:'inbox',name:'Inbox',mode:'window',links:['https://example.com/inbox'],session:'browser'}],rules:[{scope:'orchestrator',session:null,text:'Check the output.'}],schedules:[{slot:'daily',source:{kind:'cron',spec:'0 9 * * *'},instruction:'Check status',maxPerHour:1,maxPerDay:1,missedPolicy:'skip'}],vault:{local:[{name:'service',type:'api-key',label:'Service'}],globalRequirements:['shared']},providers:[],mcp:[]}
  const preview=ProjectTemplate.preview(JSON.stringify(template));if(!preview.ok)throw Error(preview.error)
  const reservation=yield* Effect.promise(()=>adapter.reserve(preview.value.text,preview.value.digest))
  expect(yield* kv.get('orchestra/project/'+reservation.projectID)).toBeUndefined()
  const interrupted=yield* Effect.promise(()=>adapter.resume(reservation.id)).pipe(Effect.exit)
  expect(Exit.isFailure(interrupted)).toBe(true)
  expect(yield* kv.get('orchestra/project/'+reservation.projectID)).toBeUndefined()
  expect((yield* (yield* Orchestra.Service).projects()).some(p=>p.id===reservation.projectID)).toBe(false)
  expect(yield* SessionHold.held(reservation.plan.mainSessionID!)).toBe(true)
  expect(Exit.isFailure(yield* Effect.promise(()=>adapter.resume(reservation.id)).pipe(Effect.exit))).toBe(true)
  expect(yield* kv.get('orchestra/project/'+reservation.projectID)).toBeDefined()
  expect((yield* (yield* Orchestra.Service).projects()).some(p=>p.id===reservation.projectID)).toBe(false)
  expect(Exit.isFailure(yield* (yield* Orchestra.Service).main(Orchestra.ProjectID.make(reservation.projectID)).pipe(Effect.exit))).toBe(true)
  expect(yield* SessionHold.held(reservation.plan.mainSessionID!)).toBe(true)
  const created=yield* Effect.promise(()=>adapter.resume(reservation.id))
  expect(created.phase).toBe('published');expect((yield* (yield* Orchestra.Service).projects()).some(p=>p.id===reservation.projectID)).toBe(true);expect(yield* SessionHold.held(reservation.plan.mainSessionID!)).toBe(false)
  const main=yield* (yield* Orchestra.Service).main(Orchestra.ProjectID.make(reservation.projectID));expect(main.title).toBe('Main')
  const infos=yield* store.list({directoryPrefix:AbsolutePath.make(reservation.directory)})
  expect(infos).toHaveLength(2);expect(infos[0].permissions).toEqual([]);expect(infos[0].tokens.input).toBe(0)
  expect(yield* store.messages({sessionID:infos[0].id,limit:1})).toEqual([])
  expect(Trigger.parse(yield* kv.get(Trigger.key(reservation.projectID,reservation.plan.schedules[0].id)))?.enabled).toBe(false)
  expect((yield* Effect.promise(()=>vault(reservation.projectID).slots()))[0]).toMatchObject({state:'empty',allowedSessionIDs:[]})
  expect(yield* kv.get('rules/project-defaults:'+reservation.projectID)).toEqual([])
  expect(yield* Effect.promise(()=>Bun.file(path.join(tmp.path,'browser-data','browser-profiles',reservation.plan.browsers[0].id+'.tabs.json')).json())).toEqual({tabs:[{url:'https://example.com/inbox'}]})
  expect(yield* Effect.promise(()=>Bun.file(path.join(tmp.path,'browser-data','browser-profiles',reservation.plan.browsers[0].id,'Cookies')).exists())).toBe(false)
  expect(yield* Effect.promise(()=>Bun.file(path.join(reservation.directory,Dod.FILE)).exists())).toBe(true)
  yield* Effect.promise(()=>adapter.resume(reservation.id))
  expect(yield* store.list({directoryPrefix:AbsolutePath.make(reservation.directory)})).toHaveLength(2)
  const missing=yield* kv.get(ProjectTemplateLiveStores.RECEIPT+reservation.id)
  yield* kv.remove(ProjectTemplateLiveStores.RECEIPT+reservation.id)
  expect(yield* SessionHold.held(reservation.plan.mainSessionID!)).toBe(true)
  yield* kv.set(ProjectTemplateLiveStores.RECEIPT+reservation.id,missing!)
  const other=yield* Effect.promise(()=>adapter.reserve(preview.value.text,preview.value.digest))
  const changed=structuredClone(other);changed.plan.rules[0].scope='global'
  yield* kv.set(ProjectTemplateLiveStores.RECEIPT+other.id,JSON.parse(JSON.stringify(changed)))
  const globalBefore=yield* kv.get('rules/global')
  expect(Exit.isFailure(yield* Effect.promise(()=>adapter.resume(other.id)).pipe(Effect.exit))).toBe(true)
  expect(yield* kv.get('rules/global')).toEqual(globalBefore)
  expect(yield* store.get(Session.ID.make(other.plan.mainSessionID!))).toBeUndefined()
 }).pipe(Effect.scoped),30_000)

it.live("v2 live import persists process before publication and resumes without carrying execution rights", () =>
 Effect.gen(function* () {
  const { ProjectTemplateV2 } = yield* Effect.promise(() => import('../src/project-template-v2'))
  const { ProjectTemplateV2Runtime } = yield* Effect.promise(() => import('../src/project-template-v2-runtime'))
  const { ProjectTemplateLiveStores } = yield* Effect.promise(() => import('../src/project-template-live-stores'))
  const { ProjectTemplateBrowserStore } = yield* Effect.promise(() => import('../src/project-template-browser-store'))
  const { ProcessSkills } = yield* Effect.promise(() => import('../src/process-skills'))
  const { Skill } = yield* Effect.promise(() => import('../src/skill'))
  const { SessionHold } = yield* Effect.promise(() => import('../src/session/hold'))
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir('v2-live-process-')))
  const kv = yield* KV.Service, sessions = yield* Session.Service, store = yield* SessionStore.Service, orchestra = yield* Orchestra.Service
  yield* Effect.promise(() => mkdir(path.join(tmp.path,'data')))
  const data = path.join(tmp.path,'data')
  const {ProjectTemplateCoreRoles}=yield* Effect.promise(()=>import('../src/project-template-core-roles'))
  const core=ProjectTemplateCoreRoles.current([])[0]
  const local = { agent:'team-process-reviewer', name:'Review process', description:'Review work', rules:'  Keep exact process rules.\r\n', category:'Quality', readOnly:true, tools:['read','skill'], autoTools:false }
  const content = '# Process skill\nRead guide.md.\n'
  const source = {format:'orchestra.project-template',version:2,name:'Process factory',description:'Process only',minOrchestraVersion:'1.0.0',variables:{projectName:'Imported process',folder:'${projectFolder}'},mainSession:'main',sessions:[{slot:'main',title:'Main',role:'orchestrator',model:{provider:'demo',id:'free',variant:null}},{slot:'reviewer',title:'Review',role:local.agent,model:null}],browsers:[],rules:[{scope:'role',role:local.agent,session:null,text:'Never publish without approval.'}],schedules:[],vault:{local:[],globalRequirements:[]},providers:[],mcp:[],process:{playbook:'Review the result before publishing.',recommendedRoles:[local.agent],roles:[core,local],skills:[{id:'review',name:'Review',entry:'SKILL.md',description:'Review work',files:[{path:'SKILL.md',content,sha256:ProjectTemplateV2.hash(content)},{path:'guide.md',content:'Check the result.\n',sha256:ProjectTemplateV2.hash('Check the result.\n')}],dependencies:[]}],skillAssignments:[{target:{kind:'project'},skills:['review']},{target:{kind:'role',role:local.agent},skills:[]},{target:{kind:'session',session:'main'},skills:['review']}],sessionModels:[{session:'main',models:[{provider:'demo',id:'free',variant:null},{provider:'demo',id:'backup',variant:'careful'}]},{session:'reviewer',models:[]}],programs:[]}}
  const preview = ProjectTemplateV2.preview(JSON.stringify(source)); if(!preview.ok) throw Error(preview.error)
  let changed=0,failOnce=true,failProcessOnce=true
  const process = ProjectTemplateV2Runtime.make({kv,dataDirectory:data,installedVersion:'1.0.0',destination:async()=>({roles:[core],skills:[],models:new Set(['demo/free','demo/backup#careful']),programs:new Set(),mcp:new Map(),providers:new Set()}),changed:async()=>{changed++;await Effect.runPromise(orchestra.reload())}})
  const vault=(id:string)=>CredentialVault.make({directory:path.join(tmp.path,'vault'),projectID:id,collector:{collect:async()=>{throw Error('must not request secrets')}} as never})
  const adapter=ProjectTemplateLiveStores.make({kv,sessions,store,root:path.join(tmp.path,'imports'),installedVersion:'1.0.0',timezone:'UTC',process:{...process,ensure:async r=>{await process.ensure(r);if(failProcessOnce){failProcessOnce=false;throw Error('process checkpoint lost')}}},
    availableRoles:async()=>new Set(['orchestrator']),availableModels:async()=>new Set(['demo/free','demo/backup#careful']),vault,browsers:ProjectTemplateBrowserStore.make(kv,data),bootstrap:async()=>{if(failOnce){failOnce=false;throw Error('publication checkpoint lost')}}})
  const guard=SessionHold.addGuard(adapter.held);yield* Effect.addFinalizer(()=>Effect.sync(guard))
  const rejected=structuredClone(source);rejected.process.roles[0].rules='Changed core runtime rules.'
  const invalid=ProjectTemplateV2.preview(JSON.stringify(rejected));if(!invalid.ok)throw Error(invalid.error)
  expect(Exit.isFailure(yield* Effect.promise(()=>adapter.reserve(invalid.value.text,invalid.value.digest)).pipe(Effect.exit))).toBe(true)
  const reserved=yield* Effect.promise(()=>adapter.reserve(preview.value.text,preview.value.digest))
  expect(reserved.process?.digest).toBe(preview.value.digest)
  const globalBefore=yield* orchestra.roles()
  expect(Exit.isFailure(yield* Effect.promise(()=>adapter.resume(reserved.id)).pipe(Effect.exit))).toBe(true)
  expect((yield* orchestra.projects()).some(project=>project.id===reserved.projectID)).toBe(false)
  expect(yield* store.get(Session.ID.make(reserved.plan.mainSessionID!))).toBeUndefined()
  expect(yield* orchestra.playbook(Orchestra.ProjectID.make(reserved.projectID))).toBeUndefined()
  expect(yield* store.list({directoryPrefix:AbsolutePath.make(reserved.directory)})).toEqual([])
  expect(Exit.isFailure(yield* Effect.promise(()=>adapter.resume(reserved.id)).pipe(Effect.exit))).toBe(true)
  expect(yield* SessionHold.held(reserved.plan.mainSessionID!)).toBe(true)
  const change=yield* orchestra.changes.pipe(Stream.take(1),Stream.runCollect,Effect.forkScoped({startImmediately:true}))
  const published=yield* Effect.promise(()=>adapter.resume(reserved.id))
  expect(yield* Fiber.join(change)).toHaveLength(1)
  expect(published.phase).toBe('published')
  expect(changed).toBe(1)
  expect(yield* SessionHold.held(reserved.plan.mainSessionID!)).toBe(false)
  const localAgent='team-'+ProcessSkills.namespace(reserved.projectID)+'2'
  expect((yield* orchestra.roles(Orchestra.ProjectID.make(reserved.projectID))).find(role=>role.agent===localAgent)?.rules).toBe(local.rules)
  expect(yield* orchestra.roles()).toEqual(globalBefore)
  expect(yield* orchestra.playbook(Orchestra.ProjectID.make(reserved.projectID))).toEqual({name:'Process factory',text:source.process.playbook})
  const imported=yield* store.list({directoryPrefix:AbsolutePath.make(reserved.directory)})
  expect(imported).toHaveLength(2)
  expect(imported.every(session=>session.permissions?.length===0 && session.tokens.input===0 && session.tokens.output===0)).toBe(true)
  const main=imported.find(session=>session.id===reserved.plan.mainSessionID)!
  expect(main.metadata?.["orchestra:worker-models"]).toEqual([{providerID:'demo',id:'free'},{providerID:'demo',id:'backup',variant:'careful'}])
  expect(yield* store.messages({sessionID:main.id,limit:1})).toEqual([])
  const catalog=yield* Skill.Service
  const skillID=Skill.ID.make(ProcessSkills.namespace(reserved.projectID)+'1')
  expect((yield* catalog.get(skillID,{sessionID:main.id,agent:'orchestrator'}))?.content).toBe(content)
  expect(yield* catalog.get(skillID,{sessionID:'ses_foreign',agent:'orchestrator'})).toBeUndefined()
  yield* Effect.promise(()=>adapter.resume(reserved.id))
  expect(yield* store.list({directoryPrefix:AbsolutePath.make(reserved.directory)})).toHaveLength(2)
  const {ProjectTemplateV2OwnerReader}=yield* Effect.promise(()=>import('../src/project-template-v2-owner-reader'))
  const {ProjectTemplateV2Reader}=yield* Effect.promise(()=>import('../src/project-template-v2-reader'))
  const exported=yield* Effect.promise(()=>ProjectTemplateV2Reader.capture(ProjectTemplateV2OwnerReader.make({kv,store,orchestra,coreRoles:async()=>[core]},reserved.projectID),reserved.projectID,{name:'Roundtrip process',description:'Process only',minOrchestraVersion:'1.0.0'},{browsers:[],vault:[],selectedGlobalSlotIDs:new Set<string>(),providers:[],mcp:[]}))
  expect(exported.bundle.process.playbook).toBe(source.process.playbook)
  expect(exported.bundle.process.roles.find(role=>role.agent===localAgent)?.rules).toBe(local.rules)
  expect(exported.bundle.process.skills[0].files).toEqual(source.process.skills[0].files)
  expect(exported.bundle.process.skills[0].id).toBe(skillID)
  expect(exported.bundle.process.sessionModels.find(row=>row.models.length>0)?.models).toEqual(source.process.sessionModels[0].models)
  expect(exported.text).not.toContain(reserved.directory)
  expect(exported.text).not.toContain(reserved.projectID)
  expect(exported.text).not.toContain(main.id)
  expect(exported.bundle.process.skillAssignments).toContainEqual({target:{kind:'role',role:localAgent},skills:[]})
  const second=yield* Effect.promise(()=>adapter.reserve(exported.text,exported.digest))
  yield* Effect.promise(()=>adapter.resume(second.id))
  const third=yield* Effect.promise(()=>ProjectTemplateV2Reader.capture(ProjectTemplateV2OwnerReader.make({kv,store,orchestra,coreRoles:async()=>[core]},second.projectID),second.projectID,{name:'Roundtrip process',description:'Process only',minOrchestraVersion:'1.0.0'},{browsers:[],vault:[],selectedGlobalSlotIDs:new Set<string>(),providers:[],mcp:[]}))
  expect(third.bundle.process.skills[0].files).toEqual(exported.bundle.process.skills[0].files)
  expect(third.bundle.process.playbook).toBe(exported.bundle.process.playbook)
  expect(third.bundle.process.roles.map(role=>({name:role.name,rules:role.rules,readOnly:role.readOnly,tools:role.tools}))).toEqual(exported.bundle.process.roles.map(role=>({name:role.name,rules:role.rules,readOnly:role.readOnly,tools:role.tools})))
  expect(third.bundle.process.sessionModels.map(row=>JSON.stringify(row.models)).sort()).toEqual(exported.bundle.process.sessionModels.map(row=>JSON.stringify(row.models)).sort())
  expect(yield* orchestra.roles()).toEqual(globalBefore)
  const {ProjectTemplateOperator}=yield* Effect.promise(()=>import('../src/project-template-operator'))
  const operator=ProjectTemplateOperator.make({kv,store,dataDirectory:data,installedVersion:'1.0.0',live:()=>adapter,processStores:projectID=>ProjectTemplateV2OwnerReader.make({kv,store,orchestra,coreRoles:async()=>[core]},projectID)})
  const saved=yield* Effect.promise(()=>operator.prepareSave(reserved.projectID,[]))
  expect(JSON.parse(saved.details).version).toBe(2)
  yield* Effect.promise(()=>operator.confirmSave(saved.token,[]))
  const library=yield* Effect.promise(()=>operator.list())
  expect(library).toHaveLength(1)
  expect(library[0].id).toStartWith('process:')
  yield* orchestra.update(Orchestra.ProjectID.make(reserved.projectID),{name:'Updated process factory'})
  const staleUpdate=yield* Effect.promise(()=>operator.prepareSave(reserved.projectID,[],library[0].id))
  yield* orchestra.update(Orchestra.ProjectID.make(reserved.projectID),{name:'Final process factory'})
  expect(Exit.isFailure(yield* Effect.promise(()=>operator.confirmSave(staleUpdate.token,[])).pipe(Effect.exit))).toBe(true)
  const update=yield* Effect.promise(()=>operator.prepareSave(reserved.projectID,[],library[0].id))
  yield* Effect.promise(()=>operator.confirmSave(update.token,[]))
  yield* Effect.promise(()=>operator.confirmSave(update.token,[]))
  const afterUpdate=yield* Effect.promise(()=>operator.list())
  expect(afterUpdate).toHaveLength(1)
  expect(afterUpdate[0].id).toBe(library[0].id)
  expect(afterUpdate[0].name).toBe('Final process factory')
  const create=yield* Effect.promise(()=>operator.prepareCreate(library[0].id,data))
  expect(JSON.parse(create.details).process.skills[0].files).toEqual(source.process.skills[0].files)
  const created=yield* Effect.promise(()=>operator.confirmCreate(create.token))
  expect(created.projectID).not.toBe(reserved.projectID)
  yield* Effect.promise(()=>operator.finishCreate(create.token))
  const resumed=yield* Effect.promise(()=>operator.confirmCreate(create.token))
  expect(resumed.projectID).toBe(created.projectID)
  const initial=yield* orchestra.create({name:'Initial v2 source',directory:tmp.path})
  yield* orchestra.main(initial.id)
  const initialExport=yield* Effect.promise(()=>operator.prepareSave(initial.id,[]))
  const initialBundle=JSON.parse(initialExport.details)
  expect(initialBundle.version).toBe(2)
  expect(initialBundle.process.roles.some((role:{agent:string})=>role.agent==='orchestrator')).toBe(true)
  expect(initialBundle.process.skills).toEqual([])
  const {SkillFile}=yield* Effect.promise(()=>import('../src/config/plugin/skill-file'))
  const legacyRoot=path.join(tmp.path,'skills','legacy-review')
  yield* Effect.promise(()=>mkdir(legacyRoot,{recursive:true}))
  const legacyDocument='---\nname: Legacy review\nmetadata:\n  orchestra/export:\n    version: 1\n    files: [SKILL.md, guide.md]\n    dependencies: []\n---\n# Review the work\n'
  yield* Effect.promise(()=>Bun.write(path.join(legacyRoot,'SKILL.md'),legacyDocument))
  yield* Effect.promise(()=>Bun.write(path.join(legacyRoot,'guide.md'),'Exact legacy guide.\r\n'))
  yield* Effect.promise(()=>Bun.write(path.join(legacyRoot,'private.md'),'NEIGHBOR_PRIVATE_DATA_CANARY'))
  const legacyParsed=SkillFile.parse(path.join(tmp.path,'skills'),path.join(legacyRoot,'SKILL.md'),legacyDocument)
  if(legacyParsed._tag!=='Parsed')throw Error('Legacy fixture must parse')
  const owningLegacy=ProjectTemplateOperator.make({kv,store,dataDirectory:data,installedVersion:'1.0.0',live:()=>adapter,processStores:projectID=>ProjectTemplateV2OwnerReader.make({kv,store,orchestra,coreRoles:async()=>[core],legacyCatalogs:async input=>input.sessionIDs.map(sessionID=>({sessionID,directory:tmp.path,skills:[legacyParsed.skill]}))},projectID)})
  const legacyPrepared=yield* Effect.promise(()=>owningLegacy.prepareSave(initial.id,[]))
  const capturedLegacy=JSON.parse(legacyPrepared.details)
  expect(capturedLegacy.process.skills).toHaveLength(1)
  expect(capturedLegacy.process.skills[0].files.map((file:{path:string})=>file.path)).toEqual(['SKILL.md','guide.md'])
  expect(capturedLegacy.process.skills[0].files[0].content).toBe(legacyDocument)
  expect(capturedLegacy.process.skillAssignments[0].target.kind).toBe('session')
  expect(legacyPrepared.details).not.toContain('NEIGHBOR_PRIVATE_DATA_CANARY')
  expect(legacyPrepared.details).not.toContain(legacyRoot)
  yield* Effect.promise(()=>owningLegacy.confirmSave(legacyPrepared.token,[]))
  const legacyLibrary=(yield* Effect.promise(()=>owningLegacy.list())).find(row=>row.name==='Initial v2 source')!
  const legacyCreate=yield* Effect.promise(()=>owningLegacy.prepareCreate(legacyLibrary.id,data))
  const legacyImported=yield* Effect.promise(()=>owningLegacy.confirmCreate(legacyCreate.token))
  yield* Effect.promise(()=>owningLegacy.finishCreate(legacyCreate.token))
  const legacyRoundtrip=yield* Effect.promise(()=>ProjectTemplateV2Reader.capture(ProjectTemplateV2OwnerReader.make({kv,store,orchestra,coreRoles:async()=>[core]},legacyImported.projectID),legacyImported.projectID,{name:'Legacy roundtrip',description:'Process only',minOrchestraVersion:'1.0.0'},{browsers:[],vault:[],selectedGlobalSlotIDs:new Set<string>(),providers:[],mcp:[]}))
  expect(legacyRoundtrip.bundle.process.skills[0].files).toEqual(capturedLegacy.process.skills[0].files)
  expect(legacyRoundtrip.bundle.process.skillAssignments[0].skills).toHaveLength(1)
  const {ProjectTemplateLibrary}=yield* Effect.promise(()=>import('../src/project-template-library'))
  const {ProjectTemplate}=yield* Effect.promise(()=>import('../src/project-template'))
  const {process:omittedProcess,...legacySource}=source
  const legacy=ProjectTemplate.preview(JSON.stringify({...legacySource,version:1}));if(!legacy.ok)throw Error(legacy.error)
  yield* Effect.promise(()=>ProjectTemplateLibrary.local(data).saveSerialized(legacy.value.text,'legacy_template',legacy.value.digest))
  expect((yield* Effect.promise(()=>operator.list())).some(row=>row.id==='legacy_template')).toBe(true)
  const legacyUpdate=yield* Effect.promise(()=>operator.prepareSave(reserved.projectID,[],'legacy_template'))
  expect(JSON.parse(legacyUpdate.details).version).toBe(1)
  expect(legacyUpdate.name).toBe(source.name)
  yield* Effect.promise(()=>operator.confirmSave(legacyUpdate.token,[]))
  yield* Effect.promise(()=>operator.confirmSave(legacyUpdate.token,[]))
  const legacyUpdated=yield* Effect.promise(()=>ProjectTemplateLibrary.local(data).preview('legacy_template'))
  expect(legacyUpdated.bundle.version).toBe(1)
  expect(legacyUpdated.bundle.name).toBe('Final process factory')
  expect((yield* Effect.promise(()=>ProjectTemplateLibrary.local(data).list())).filter(row=>row.state==='ready')).toHaveLength(1)
  const broken=structuredClone(published);broken.process!.template=broken.process!.template.replace('Review the result before publishing.','Changed playbook.')
  yield* kv.set(ProjectTemplateLiveStores.RECEIPT+reserved.id,JSON.parse(JSON.stringify(broken)))
  expect(Exit.isFailure(yield* Effect.promise(()=>adapter.resume(reserved.id)).pipe(Effect.exit))).toBe(true)
  yield* kv.set(ProjectTemplateLiveStores.RECEIPT+reserved.id,JSON.parse(JSON.stringify(published)))
 }).pipe(Effect.scoped),30_000)
