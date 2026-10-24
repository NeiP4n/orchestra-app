import { describe, expect } from "bun:test"
import { Message } from "@orchestra/ai"
import { OpenAIChat } from "@orchestra/ai/protocols"
import { Agent } from "@orchestra/schema/agent"
import { Money } from "@orchestra/schema/money"
import { Session } from "@orchestra/schema/session"
import { Location } from "@orchestra/core/location"
import { PluginHooks } from "@orchestra/core/plugin/hooks"
import { Project } from "@orchestra/core/project"
import { AbsolutePath } from "@orchestra/core/schema"
import { SessionMessage } from "@orchestra/core/session/message"
import { SessionModelRequest } from "@orchestra/core/session/model-request"
import { SessionModelTransport } from "@orchestra/core/session/model-transport"
import { SessionRunnerModel } from "@orchestra/core/session/runner/model"
import { Tool } from "@orchestra/core/tool"
import type { Info } from "@orchestra/schema/tool"
import { ToolRouter } from "@orchestra/core/tool/router"
import { DateTime, Effect, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const session = Session.Info.make({
  id: Session.ID.make("ses_tool_router"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const model = SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit: { context: 200_000, output: 32_000 },
})
const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})

const tool = (name: string, options: Tool.Options): Info => ({
  name,
  description: `The ${name} tool. It does ${name} things.`,
  input: Schema.Struct({ text: Schema.String }),
  options,
  execute: ({ text }) => Effect.succeed({ content: `${name}:${text}` }),
})

const register = Effect.gen(function* () {
  const registry = yield* Tool.Service
  yield* registry.transform((editor) => {
    editor.add(tool("read", { codemode: false, core: true }))
    editor.add(tool("playtest", { codemode: false, triggers: ["запусти игру"] }))
    editor.add(tool("desktop", { codemode: false }))
    editor.add(tool("desktop_click", { codemode: false }))
    editor.add(tool("desktop_type", { codemode: false }))
  })
  return registry
})

const prepare = (messages: Array<Message>) =>
  Effect.gen(function* () {
    const registry = yield* register
    const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
    return yield* requests.primary({
      session,
      agent: Agent.ID.make("build"),
      model,
      tools: yield* registry.snapshot(),
      system: [],
      messages,
    })
  }).pipe(Effect.provideService(SessionModelTransport.Service, transport))

// The plugin fixture's Code Mode wrapper is not part of what the router decides.
const names = (prepared: SessionModelRequest.Prepared) =>
  prepared.request.tools
    .map((item) => item.name)
    .filter((name) => name !== "execute")
    .toSorted()

describe("ToolRouter", () => {
  it.effect("advertises core tools and an index instead of on-demand schemas", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare([Message.user("hello")])
      expect(names(prepared)).toEqual(["read", "tools"])
      const index = prepared.request.tools.find((item) => item.name === ToolRouter.name)?.description ?? ""
      expect(index).toContain("- playtest: The playtest tool.")
      expect(index).toContain("- desktop (3 tools: click, type): The desktop tool.")
    }),
  )

  it.effect("adds a group once the session loads it, and keeps it for later steps", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare([
        Message.user("hello"),
        Message.assistant([{ type: "tool-call", id: "call_1", name: "tools", input: { load: ["desktop"] } }]),
      ])
      expect(names(prepared)).toEqual(["desktop", "desktop_click", "desktop_type", "read", "tools"])
    }),
  )

  it.effect("loads a tool the user's words trigger", () =>
    Effect.gen(function* () {
      expect(names(yield* prepare([Message.user("Запусти игру и проверь меню")]))).toContain("playtest")
      expect(names(yield* prepare([Message.user("use playtest on it")]))).toContain("playtest")
    }),
  )

  it.effect("loads an on-demand tool the model calls before loading it, without running it", () =>
    Effect.gen(function* () {
      const call = { type: "tool-call" as const, id: "call_2", name: "playtest", input: { text: "go" } }
      const prepared = yield* prepare([Message.user("hello")])
      const failure = yield* prepared
        .executeTool({
          sessionID: session.id,
          agent: Agent.ID.make("build"),
          messageID: SessionMessage.ID.make("msg_router"),
          call,
        })
        .pipe(Effect.flip)
      expect(failure).toBeInstanceOf(Tool.Error)
      expect((failure as Tool.Error).message).toContain("playtest was not loaded for this step")
      expect(names(yield* prepare([Message.user("hello"), Message.assistant([call])]))).toContain("playtest")
    }),
  )

  it.effect("keeps a loaded tool that a context hook removed out of reach", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          delete event.tools.playtest
        }),
      )
      const prepared = yield* prepare([Message.user("use playtest")])
      expect(names(prepared)).not.toContain("playtest")
      const failure = yield* prepared
        .executeTool({
          sessionID: session.id,
          agent: Agent.ID.make("build"),
          messageID: SessionMessage.ID.make("msg_router"),
          call: { type: "tool-call", id: "call_4", name: "playtest", input: { text: "go" } },
        })
        .pipe(Effect.flip)
      expect(failure).toBeInstanceOf(Tool.Error)
      expect((failure as Tool.Error).message).not.toContain("was not loaded")
    }),
  )

  it.effect("answers a session's first call of a tool with its guide, then runs later calls", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      yield* registry.transform((editor) =>
        editor.add(tool("forge", { codemode: false, core: true, guide: "Forge guide: list before you create." })),
      )
      const call = { type: "tool-call" as const, id: "call_5", name: "forge", input: { text: "go" } }
      const execute = (prepared: SessionModelRequest.Prepared) =>
        prepared.executeTool({
          sessionID: session.id,
          agent: Agent.ID.make("build"),
          messageID: SessionMessage.ID.make("msg_router"),
          call,
        })
      const first = yield* execute(yield* prepare([Message.user("hello")]))
      expect(first.content).toEqual([
        {
          type: "text",
          text: "Forge guide: list before you create.\n\nThis is how forge works; the call did not run. Call it again with what you need.",
        },
      ])
      const later = yield* execute(yield* prepare([Message.user("hello"), Message.assistant([call])]))
      expect(later.content).toEqual([{ type: "text", text: "forge:go" }])
      const index = (yield* prepare([Message.user("hello")])).request.tools.find((item) => item.name === "forge")
      expect(index?.description).not.toContain("Forge guide")
    }),
  )

  it.effect("reports what a tools call loaded", () =>
    Effect.gen(function* () {
      const prepared = yield* prepare([Message.user("hello")])
      const result = yield* prepared.executeTool({
        sessionID: session.id,
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_router"),
        call: { type: "tool-call", id: "call_3", name: "tools", input: { load: ["desktop", "nope"] } },
      })
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Loaded: desktop, desktop_click, desktop_type. Call them directly from your next step.\nNot in the tools index: nope.",
        },
      ])
    }),
  )
})
