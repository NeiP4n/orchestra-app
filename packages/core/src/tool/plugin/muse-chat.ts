export * as MuseChatTool from "./muse-chat.js"

import type { Context } from "@orchestra/plugin/effect/plugin"
import { SystemPart, ToolFailure } from "@orchestra/ai"
import { Effect, Schema } from "effect"
import { optional } from "@orchestra/schema/schema"
import { Agent } from "../../agent.js"
import { Model } from "../../model.js"
import { Orchestra } from "../../orchestra.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import type { SessionSchema } from "../../session/schema.js"

// Muse chat tools: how a Muse session manages the very Orchestra it runs
// in. A Muse chat is a session pinned to the meta provider (muse-spark);
// these tools are the bridge back into Orchestra from that chat: list the
// agents, open a new session for one of them, send it a prompt, or switch
// an existing session's agent or model. They are on-demand tools (not
// core), so they do not clutter sessions that never ask for them.
//
// Security boundary, enforced in code below — not just in the prompt:
// - get/prompt/switch act only on sessions in the same project as the
//   calling chat (a project that owns both sessions, or the same
//   directory when neither is project-owned), never on a project's main
//   session, and only after a permission.assert the operator can deny;
// - list hides hidden agents, and create/switch reject unknown or hidden
//   agent ids instead of storing them verbatim;
// - model references parse to a ToolFailure, never a defect.
export const name = "muse-chat"

const Output = Schema.Struct({ output: Schema.String })
type Output = typeof Output.Type

function text(output: string): { readonly output: Output; readonly content: string } {
  return { output: { output }, content: output }
}

function failed(error: unknown) {
  if (error instanceof ToolFailure) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ToolFailure({ message, error })
}

export const Plugin = {
  id: "orchestra.tool.muse-chat",
  effect: Effect.fn("MuseChatTool.Plugin")(function* (ctx: Context) {
    const agents = yield* Agent.Service
    const models = yield* Model.Service
    const orchestra = yield* Orchestra.Service
    const permission = yield* Permission.Service

    const parseModel = Effect.fn("MuseChatTool.parseModel")(function* (input: string) {
      const ref = yield* Effect.try({
        try: () => Model.Ref.parse(input),
        catch: () =>
          new ToolFailure({
            message: `Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`,
          }),
      })
      const model = (yield* models.available()).find(
        (item) => item.providerID === ref.providerID && item.id === ref.id,
      )

      if (model === undefined)
        return yield* new ToolFailure({
          message: `Model "${ref.providerID}/${ref.id}" is not available. Use the models tool to see what is available.`,
        })

      return ref
    })

    const resolveAgent = Effect.fn("MuseChatTool.resolveAgent")(function* (id: string) {
      const agent = yield* agents.resolve(id)

      if (agent === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${id}` })
      if (agent.hidden) return yield* new ToolFailure({ message: `Agent ${id} is hidden and cannot be delegated to` })

      return agent
    })

    // The calling chat may only touch sessions in its own project: a
    // project that owns both sessions, or the same directory when neither
    // session is project-owned. A project's main session is never a valid
    // target — it is the orchestrator, not a worker to reconfigure.
    const scopedSession = Effect.fn("MuseChatTool.scopedSession")(function* (
      callerID: SessionSchema.ID,
      targetID: SessionSchema.ID,
    ) {
      const caller = yield* ctx.session
        .get({ sessionID: callerID })
        .pipe(Effect.mapError(() => new ToolFailure({ message: "Calling session not found" })))
      const target = yield* ctx.session
        .get({ sessionID: targetID })
        .pipe(Effect.mapError(() => new ToolFailure({ message: `Session not found: ${targetID}. List sessions first and use a complete id.` })))

      if (caller.id === target.id) return target

      const projects = yield* orchestra.projects()

      if (projects.some((project) => project.main === target.id))
        return yield* new ToolFailure({ message: `Session ${targetID} is a project's main session and cannot be managed from a Muse chat` })

      const shared = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const ownsCaller = yield* orchestra.owns(project, caller)
          const ownsTarget = yield* orchestra.owns(project, target)

          return ownsCaller && ownsTarget
        }),
      )

      const sameDirectory = caller.location.directory === target.location.directory

      if (!shared.some(Boolean) && !sameDirectory)
        return yield* new ToolFailure({
          message: `Session ${targetID} is in a different project than this Muse chat. Muse-chat tools only manage sessions in the same project.`,
        })

      return target
    })

    const assertPermission = Effect.fn("MuseChatTool.assertPermission")(function* (
      action: string,
      resources: readonly string[],
      context: { sessionID: SessionSchema.ID; agent: Agent.ID; messageID: string; id: string },
    ) {
      yield* permission
        .assert({
          action,
          resources: [...resources],
          save: [...resources],
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.messageID, id: context.id },
        })
        .pipe(Effect.mapError((error) => new ToolFailure({ message: `${action} denied`, error })))
    })

    // Sessions running on the meta provider are Muse chats: give them the
    // Muse identity and the orchestra tools in their system context.
    // The identity is Muse Spark via the Meta Model API — not the personal
    // Muse browser agent, which Meta exposes no API for.
    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => {
        if (event.model.providerID !== "meta") return

        event.system.push(
          SystemPart.make(
            [
              "You are Muse Spark, running inside Orchestra via the Meta Model API — not the personal Muse browser agent.",
              "Use the orchestra_* tools to manage sessions in this chat's project: list agents, create a session,",
              "send a prompt to a session, or switch a session's agent or model. Do not invent session ids or agent names; list first.",
            ].join(" "),
          ),
        )
      }),
    )

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "orchestra_list_agents",
        description: "List Orchestra agents (id and name) that a Muse chat can delegate work to. Hidden agents are never listed.",
        input: Schema.Struct({}),
        output: Output,
        options: { codemode: false },
        execute: () =>
          Effect.gen(function* () {
            const listed = yield* ctx.agent.list()

            const lines = listed.data
              .filter((agent) => !agent.hidden)
              .map((agent) => `${agent.id} — ${agent.name}`)

            return text(lines.length > 0 ? lines.join("\n") : "No agents are available.")
          }).pipe(Effect.mapError(failed)),
      })

      editor.add({
        name: "orchestra_create_session",
        description: "Create a new Orchestra session in this chat's project, optionally for a given agent (agent id) and model (provider/model). Returns the new session id.",
        input: Schema.Struct({
          title: optional(Schema.String),
          agent: optional(Schema.String),
          model: optional(Schema.String),
        }),
        output: Output,
        options: { codemode: false },
        execute: (input, context) =>
          Effect.gen(function* () {
            const agent = input.agent ? yield* resolveAgent(input.agent) : undefined
            const model = input.model ? yield* parseModel(input.model) : undefined

            if (agent) yield* assertPermission("orchestra_create_session", [agent.id], context)

            const created = yield* ctx.session.create({
              title: input.title,
              agent: agent ? Agent.ID.make(agent.id) : undefined,
              model,
            })

            return text(`Created session ${created.id}${created.title ? ` — ${created.title}` : ""}.`)
          }).pipe(Effect.mapError(failed)),
      })

      editor.add({
        name: "orchestra_get_session",
        description: "Get an Orchestra session's title, agent and model by its id. Only sessions in this chat's project can be read.",
        input: Schema.Struct({ sessionID: Schema.String }),
        output: Output,
        options: { codemode: false },
        execute: (input, context) =>
          Effect.gen(function* () {
            const session = yield* scopedSession(context.sessionID, Session.ID.make(input.sessionID))

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
        description: "Send a text prompt to an existing Orchestra session in this chat's project, so its agent works on it.",
        input: Schema.Struct({ sessionID: Schema.String, text: Schema.String }),
        output: Output,
        options: { codemode: false },
        execute: (input, context) =>
          Effect.gen(function* () {
            const session = yield* scopedSession(context.sessionID, Session.ID.make(input.sessionID))

            yield* assertPermission("orchestra_prompt_session", [session.id], context)

            const sent = yield* ctx.session.prompt({
              sessionID: session.id,
              text: input.text,
            })

            return text(`Prompt sent to session ${input.sessionID} (message ${sent.id}).`)
          }).pipe(Effect.mapError(failed)),
      })

      editor.add({
        name: "orchestra_switch_agent",
        description: "Switch an existing Orchestra session in this chat's project to another agent (agent id).",
        input: Schema.Struct({ sessionID: Schema.String, agent: Schema.String }),
        output: Output,
        options: { codemode: false },
        execute: (input, context) =>
          Effect.gen(function* () {
            const session = yield* scopedSession(context.sessionID, Session.ID.make(input.sessionID))
            const agent = yield* resolveAgent(input.agent)

            yield* assertPermission("orchestra_switch_agent", [session.id, agent.id], context)

            yield* ctx.session.switchAgent({
              sessionID: session.id,
              agent: Agent.ID.make(agent.id),
            })

            return text(`Session ${input.sessionID} now uses agent ${input.agent}.`)
          }).pipe(Effect.mapError(failed)),
      })

      editor.add({
        name: "orchestra_switch_model",
        description: "Switch an existing Orchestra session in this chat's project to another model (provider/model, e.g. meta/muse-spark-1.3).",
        input: Schema.Struct({ sessionID: Schema.String, model: Schema.String }),
        output: Output,
        options: { codemode: false },
        execute: (input, context) =>
          Effect.gen(function* () {
            const session = yield* scopedSession(context.sessionID, Session.ID.make(input.sessionID))
            const model = yield* parseModel(input.model)

            yield* assertPermission("orchestra_switch_model", [session.id], context)

            yield* ctx.session.switchModel({
              sessionID: session.id,
              model,
            })

            return text(`Session ${input.sessionID} now uses model ${input.model}.`)
          }).pipe(Effect.mapError(failed)),
      })
    })
  }),
}
