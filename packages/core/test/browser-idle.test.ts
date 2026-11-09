import { expect } from "bun:test"
import { Cause, Context, Effect, Fiber, RcMap, Schedule } from "effect"
import { Browser } from "@orchestra/plugin-browser/rpc"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { makeGlobalNode } from "@orchestra/util/effect/app-node"
import { Global } from "@orchestra/util/global"
import { Bus } from "@orchestra/core/bus"
import { Database } from "@orchestra/core/database/database"
import { Location } from "@orchestra/core/location"
import { LocationActivity } from "@orchestra/core/location-activity"
import { LocationServiceMap } from "@orchestra/core/location-services"
import { Plugin } from "@orchestra/core/plugin"
import { Rpc } from "@orchestra/core/rpc"
import { AbsolutePath } from "@orchestra/core/schema"
import { Session } from "@orchestra/core/session"
import { SessionExecution } from "@orchestra/core/session/execution"
import { SessionStore } from "@orchestra/core/session/store"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, Session.node, LocationServiceMap.node, LocationActivity.node]),
    [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      LocationActivity.node.replace(
        makeGlobalNode({
          service: LocationActivity.Service,
          layer: LocationActivity.layer({ timeToLive: "2 seconds", sweepInterval: "100 millis" }),
          deps: [Bus.node, LocationServiceMap.node, SessionExecution.node, SessionStore.node],
        }),
      ),
    ],
  ),
)

// TEMP-DIAG (Windows CI: "RPC is unavailable: experimental.browser"): phase timestamps,
// RcMap residency, plugin activation states and the raw cause of the failing call.
// Remove this block once the Windows failure is diagnosed.
const diagPhase = (phase: string, extra?: Record<string, unknown>) =>
  Effect.sync(() => console.log(`[browser-idle-diag] ${phase} at ${Date.now()} ${JSON.stringify(extra ?? {})}`))

it.live(
  "idle eviction ends the browser attachment and permits a fresh attachment",
  () =>
    Effect.gen(function* () {
      // The browser.tabs.* plugin is offered only with ORCHESTRA_BROWSER_PLUGIN=1 (38834d81): this test is about that plugin.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env.ORCHESTRA_BROWSER_PLUGIN
          process.env.ORCHESTRA_BROWSER_PLUGIN = "1"
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.ORCHESTRA_BROWSER_PLUGIN
            else process.env.ORCHESTRA_BROWSER_PLUGIN = previous
          }),
      )
      const dir = yield* tmpdirScoped()
      const ref = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
      const locations = yield* LocationServiceMap.Service
      const context = yield* locations.contextEffect(ref).pipe(Effect.scoped)
      yield* diagPhase("context-acquired", {
        rcHas: yield* RcMap.has(locations.rcMap, LocationServiceMap.canonical(ref)),
      })
      yield* Plugin.awaitActivation.pipe(Effect.provideContext(context))
      yield* diagPhase("activation-settled", {
        rcHas: yield* RcMap.has(locations.rcMap, LocationServiceMap.canonical(ref)),
        plugins: Context.get(context, Plugin.Service)
          .list()
          .pipe(Effect.runSync)
          .filter((info) => (info.id ?? "").includes("browser")),
      })
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location: ref })
      const rpc = Context.get(context, Rpc.Service).client(Browser.Definition)
      const attachment = { sessionID: session.id, connectionID: crypto.randomUUID() }
      const state = { ...attachment, state: { tabs: [], focusedTabID: null } }
      const pending = yield* rpc
        .attach({ ...attachment, version: 4 })
        .pipe(Effect.provide(locations.get(ref)), Effect.flip, Effect.forkScoped)
      yield* diagPhase("pre-first-state", {
        rcHas: yield* RcMap.has(locations.rcMap, LocationServiceMap.canonical(ref)),
      })
      yield* rpc.state(state).pipe(
        Effect.retry({
          while: (error) => "type" in error && error.type === "unavailable",
          schedule: Schedule.spaced("10 millis"),
        }),
        Effect.timeout("5 seconds"),
        Effect.catchCause((cause) =>
          diagPhase("first-state-failed", {
            rcHas: Effect.runSync(RcMap.has(locations.rcMap, LocationServiceMap.canonical(ref))),
            cause: Cause.pretty(cause),
          }).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      )

      // Real idle cleanup must end the long-lived request, not leave a second registry behind it.
      expect(yield* Fiber.join(pending).pipe(Effect.timeout("10 seconds"))).toMatchObject({ type: "rpc.unavailable" })
      expect(yield* RcMap.has(locations.rcMap, LocationServiceMap.canonical(ref))).toBe(false)
      expect(yield* rpc.state(state).pipe(Effect.flip)).toMatchObject({ type: "rpc.unavailable" })

      const replacement = yield* locations.contextEffect(ref)
      yield* Plugin.awaitActivation.pipe(Effect.provideContext(replacement))
      yield* diagPhase("replacement-activation-settled", {
        plugins: Context.get(replacement, Plugin.Service)
          .list()
          .pipe(Effect.runSync)
          .filter((info) => (info.id ?? "").includes("browser")),
      })
      const fresh = Context.get(replacement, Rpc.Service).client(Browser.Definition)
      const resumed = yield* fresh.attach({ ...attachment, version: 4 }).pipe(Effect.forkScoped)
      yield* fresh.state(state).pipe(
        Effect.retry({
          while: (error) => "type" in error && error.type === "unavailable",
          schedule: Schedule.spaced("10 millis"),
        }),
        Effect.timeout("5 seconds"),
        Effect.catchCause((cause) =>
          diagPhase("replacement-state-failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.andThen(Effect.failCause(cause)),
          ),
        ),
      )
      expect(resumed.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(resumed)
    }),
  30_000,
)
