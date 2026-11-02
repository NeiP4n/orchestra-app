export * as MuseChatTool from "./muse-chat.js"

import type { Context } from "@orchestra/plugin/effect/plugin"
import { SystemPart } from "@orchestra/ai"
import { Effect, Schema } from "effect"
import { optional } from "@orchestra/schema/schema"
import { Agent } from "../../agent.js"
import { Model } from "../../model.js"
import { Session } from "../../session.js"

// Muse chat tools: how a Muse session manages the very Orchestra it runs
// in. A Muse chat is a session pinned to the meta provider (muse-spark);
// these tools are the bridge back into Orchestra from that chat: list the
// agents, open a new session for one of them, send it a prompt, or switch
// an existing session's agent or model. They are on-demand tools (not
// core), so they do not clutter sessions that never ask for them, and
// they are read/write in the open: creating and prompting sessions is
// exactly what the user asked the Muse chat to be able to do, and every
// call goes through Orchestra's own session API, with its permissions.
export const name = "muse-chat"

const Output = Schema.Struct({ output: Schema.String })
type Output = typeof Output.Type

function text(output: string): Output {
  return { output }
}

export const Plugin = {
  id: "orchestra.tool.muse-chat",
  effect: Effect.fn("MuseChatTool.Plugin")(function* (ctx: Context) {
    // Sessions running on the meta provider are Muse chats: give them the
    // Muse identity and the orchestra tools in their system context.
    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => {
        if (event.model.providerID !== "meta") return

        event.system.push(
          SystemPart.make(
            [
              "You are Muse, the personal AI agent, chatting in a dedicated Muse chat inside Orchestra.",
              "This chat is separate from other Orchestra sessions, but it is connected to the same Orchestra:",
              "use the orchestra_* tools to manage it — list agents, create a session, send a prompt to a session,",
              "or switch a session's agent or model. Do not invent session ids or agent names; list first.",
            ].join(" "),
          ),
        )
      }),
    )

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "orchestra_list_agents",
        description: "List Orchestra agents (id and name) that a Muse chat can delegate work to.",
        input: Schema.Struct({}),
        output: Output,
        options: { codemode: false },
        execute: () =>
          Effect.gen(function* () {
            const listed = yield* ctx.agent.list()

            const lines = listed.data.map((agent) => `${agent.id} — ${agent.name}`)

            return text(lines.length > 0 ? lines.join("\n") : "No agents are available.")
          }),
      })

      editor.add({
        name: "orchestra_create_session",
        description: "Create a new Orchestra session, optionally for a given agent (agent id) and model (provider/model). Returns the new session id.",
        input: Schema.Struct({
          title: optional(Schema.String),
          agent: optional(Schema.String),
          model: optional(Schema.String),
        }),
        output: Output,
        options: { codemode: false },
        execute: (input) =>
          Effect.gen(function* () {
            const created = yield* ctx.session.create({
              title: input.title,
              agent: input.agent ? Agent.ID.make(input.agent) : undefined,
              model: input.model ? Model.Ref.parse(input.model) : undefined,
            })

            return text(`Created session ${created.id}${created.title ? ` — ${created.title}` : ""}.`)
          }),
      })

      editor.add({
        name: "orchestra_get_session",
        description: "Get an Orchestra session's title, agent and model by its id.",
        input: Schema.Struct({ sessionID: Schema.String }),
        output: Output,
        options: { codemode: false },
        execute: (input) =>
          Effect.gen(function* () {
            const session = yield* ctx.session.get({ sessionID: Session.ID.make(input.sessionID) })

            return text(
              [
                `Session ${session.id}`,
                session.title ? `Title: ${session.title}` : undefined,
                session.agent ? `Agent: ${session.agent}` : undefined,
                session.model ? `Model: ${session.model.providerID}/${session.model.id}` : undefined,
              ]
                .filter(Boolean)
                .join("\n"),
            )
          }),
      })

      editor.add({
        name: "orchestra_prompt_session",
        description: "Send a text prompt to an existing Orchestra session, so its agent works on it.",
        input: Schema.Struct({ sessionID: Schema.String, text: Schema.String }),
        output: Output,
        options: { codemode: false },
        execute: (input) =>
          Effect.gen(function* () {
            const sent = yield* ctx.session.prompt({
              sessionID: Session.ID.make(input.sessionID),
              text: input.text,
            })

            return text(`Prompt sent to session ${input.sessionID} (message ${sent.id}).`)
          }),
      })

      editor.add({
        name: "orchestra_switch_agent",
        description: "Switch an existing Orchestra session to another agent (agent id).",
        input: Schema.Struct({ sessionID: Schema.String, agent: Schema.String }),
        output: Output,
        options: { codemode: false },
        execute: (input) =>
          Effect.gen(function* () {
            yield* ctx.session.switchAgent({
              sessionID: Session.ID.make(input.sessionID),
              agent: Agent.ID.make(input.agent),
            })

            return text(`Session ${input.sessionID} now uses agent ${input.agent}.`)
          }),
      })

      editor.add({
        name: "orchestra_switch_model",
        description: "Switch an existing Orchestra session to another model (provider/model, e.g. meta/muse-spark-1.3).",
        input: Schema.Struct({ sessionID: Schema.String, model: Schema.String }),
        output: Output,
        options: { codemode: false },
        execute: (input) =>
          Effect.gen(function* () {
            yield* ctx.session.switchModel({
              sessionID: Session.ID.make(input.sessionID),
              model: Model.Ref.parse(input.model),
            })

            return text(`Session ${input.sessionID} now uses model ${input.model}.`)
          }),
      })
    })
  }),
}
