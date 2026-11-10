import type { FileSystem } from "@orchestra/core/filesystem"
import path from "path"
import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, LayerMap } from "effect"
import { Database } from "@orchestra/core/database/database"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { makeGlobalNode } from "@orchestra/util/effect/app-node"
import { Bus } from "@orchestra/core/bus"
import { Config } from "@orchestra/core/config"
import { ManagedPolicy } from "@orchestra/core/managed-policy"
import { Image } from "@orchestra/core/image"
import { Location } from "@orchestra/core/location"
import { LocationServiceMap } from "@orchestra/core/location-service-map"
import type { LocationServices } from "@orchestra/core/location-services"
import { Project } from "@orchestra/core/project"
import { Plugin } from "@orchestra/core/plugin"
import { PluginHooks } from "@orchestra/core/plugin/hooks"
import { AbsolutePath } from "@orchestra/core/schema"
import { Session } from "@orchestra/core/session"
import { SessionExecution } from "@orchestra/core/session/execution"
import { SessionEvent } from "@orchestra/core/session/event"
import { SessionMessage } from "@orchestra/core/session/message"
import { SessionProjector } from "@orchestra/core/session/projector"
import { SessionStore } from "@orchestra/core/session/store"
import { SessionInbox } from "@orchestra/core/session/inbox"
import { KV } from "@orchestra/core/kv"
import { ProcessSkills } from "@orchestra/core/process-skills"
import { Skill } from "@orchestra/core/skill"
import { Event } from "@orchestra/schema/event"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { registerIntegrationPolicy } from "./fixture/policy"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const info = Skill.Info.make({
  id: Skill.ID.make("effect"),
  name: Skill.Name.make("Effect"),
  description: "Effect guidance",
  path: AbsolutePath.make(path.resolve("/skills/effect.md")),
  content: "  Use Effect\n",
})
const localID = Skill.ID.make(ProcessSkills.namespace("prj_session_skills") + "1")
const localInfo = { ...info, id: localID, content: "Project-only instructions" }
const locations = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const managed = yield* ManagedPolicy.Service
      const kv = yield* KV.Service
      return yield* LayerMap.make(
        (_ref: Location.Ref) =>
          // These tests need skill activation and prompt preparation from the same location services.
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          Layer.mergeAll(
            Layer.effectDiscard(
              Effect.gen(function* () {
                const skills = yield* Skill.Service
                yield* skills.transform((editor) => {
                  editor.add(info)
                  editor.add(localInfo)
                })
                yield* registerIntegrationPolicy({ skill: skills })
              }),
            ).pipe(
              Layer.provideMerge(
                LayerNode.compile(
                  LayerNode.group([PluginHooks.node, Image.node, Skill.node, Config.node, ManagedPolicy.node]),
                  {
                    replacements: [
                      Config.node.replace(Config.testLayer()),
                      ManagedPolicy.node.replace(Layer.succeed(ManagedPolicy.Service, managed)),
                      KV.node.replace(Layer.succeed(KV.Service, kv)),
                    ],
                  },
                ),
              ),
            ),
            Layer.mock(Plugin.Service, { awaitActivation: Effect.void }),
          ) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
        { idleTimeToLive: Duration.infinity },
      )
    }),
  ),
  deps: [ManagedPolicy.node, KV.node],
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      KV.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      ManagedPolicy.node,
      LocationServiceMap.node,
    ]),
    [
      LocationServiceMap.node.replace(locations),
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)

describe("Session.skill", () => {
  it.effect("enforces project assignments for both standalone activation and explicit prompt attachments", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const kv = yield* KV.Service
      const session = yield* sessions.create({ location })
      const projectID = "prj_session_skills"
      yield* kv.set("orchestra/project/" + projectID, {
        id: projectID,
        name: "Process",
        directory: "/project",
        created: 1,
        main: session.id,
      })
      yield* ProcessSkills.install(kv, {
        version: 1,
        projectID,
        skills: [{ id: localID, dependencies: [], targets: [{ kind: "project" }] }],
      })
      yield* sessions.skill({ sessionID: session.id, skill: localID, resume: false })
      yield* sessions.prompt({ sessionID: session.id, text: "local", skills: [{ id: localID }], resume: false })
      const before = yield* sessions.messages({ sessionID: session.id })
      expect(JSON.stringify(before)).toContain("Project-only instructions")
      yield* kv.set("orchestra/owner/" + session.id, "prj_other")
      expect(
        yield* sessions.skill({ sessionID: session.id, skill: localID, resume: false }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "Session.SkillNotFoundError", skill: localID })
      expect(
        yield* sessions
          .prompt({ sessionID: session.id, text: "foreign", skills: [{ id: localID }], resume: false })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "Session.SkillNotFoundError", skill: localID })
      expect(yield* sessions.messages({ sessionID: session.id })).toEqual(before)
    }),
  )
  it.effect("refuses blocked skill mentions and standalone activation without writing their content", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const managed = yield* ManagedPolicy.Service
      const session = yield* sessions.create({ location })
      yield* managed.set({ statements: [{ action: "integration.use", resource: "skill:effect", effect: "deny" }] })
      expect(
        yield* sessions.skill({ sessionID: session.id, skill: info.id, resume: false }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "Session.SkillNotFoundError", skill: info.id })
      expect(
        yield* sessions
          .prompt({
            sessionID: session.id,
            text: "@effect",
            skills: [{ id: info.id, mention: { start: 0, end: 7, text: "@effect" } }],
            resume: false,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "Session.SkillNotFoundError", skill: info.id })
      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
      expect(yield* sessions.inbox(session.id)).toEqual([])
    }),
  )

  it.effect("materializes mentioned skills on their owning prompt", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const session = yield* sessions.create({ location })
      const id = SessionMessage.ID.make("msg_skill_attachment")

      yield* sessions.prompt({
        id,
        sessionID: session.id,
        text: "Apply @effect and @effect",
        skills: [
          { id: Skill.ID.make("effect"), mention: { start: 6, end: 13, text: "@effect" } },
          { id: Skill.ID.make("effect"), mention: { start: 18, end: 25, text: "@effect" } },
        ],
        resume: false,
      })
      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
      yield* SessionInbox.promote(database.db, bus, session.id, "steer")

      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([
        expect.objectContaining({
          id,
          type: "user",
          text: "Apply @effect and @effect",
          skills: [
            {
              id: "effect",
              name: "Effect",
              text: Skill.toModelOutput(info, []),
              mention: { start: 6, end: 13, text: "@effect" },
            },
            {
              id: "effect",
              name: "Effect",
              mention: { start: 18, end: 25, text: "@effect" },
            },
          ],
        }),
      ])
    }),
  )

  it.effect("excludes mentioned skills when forking before their prompt", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const bus = yield* Bus.Service
      const session = yield* sessions.create({ location })
      const initial = SessionMessage.ID.make("msg_before_skill_attachment")
      const selected = SessionMessage.ID.make("msg_fork_skill_attachment")

      yield* sessions.prompt({ id: initial, sessionID: session.id, text: "Before the skill", resume: false })
      yield* SessionInbox.promote(database.db, bus, session.id, "steer")
      yield* sessions.prompt({
        id: selected,
        sessionID: session.id,
        text: "Apply @effect",
        skills: [{ id: info.id, mention: { start: 6, end: 13, text: "@effect" } }],
        resume: false,
      })
      yield* SessionInbox.promote(database.db, bus, session.id, "steer")
      const forked = yield* sessions.fork({ sessionID: session.id, before: selected })

      expect(yield* sessions.messages({ sessionID: forked.id })).toEqual([
        expect.objectContaining({ type: "user", text: "Before the skill" }),
      ])
    }),
  )

  it.effect("publishes raw standalone content under the caller-supplied ID without inbox admission", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const session = yield* sessions.create({ location })
      const id = SessionMessage.ID.make("msg_caller_skill")
      const locations = yield* LocationServiceMap.Service
      yield* Skill.Service.use((skills) => skills.list()).pipe(Effect.provide(locations.get(session.location)))
      const events: Event.Payload[] = []
      yield* bus.listen((event) =>
        Effect.sync(() => {
          events.push(event)
        }),
      )

      yield* sessions.skill({ messageID: id, sessionID: session.id, skill: Skill.ID.make("effect"), resume: false })

      expect(events).toEqual([
        expect.objectContaining({
          id: "evt_caller_skill",
          type: SessionEvent.Skill.Activated.type,
          data: { sessionID: session.id, id: info.id, name: info.name, text: info.content },
        }),
      ])
      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([
        expect.objectContaining({ id, type: "skill", skill: "effect", name: "Effect", text: info.content }),
      ])
      expect(yield* sessions.inbox(session.id)).toEqual([])
    }),
  )
})
