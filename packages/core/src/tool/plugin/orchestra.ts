export * as OrchestraTool from "./orchestra.js"

import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import type { SessionHooks } from "@orchestra/plugin/effect/session"
import { Mode } from "@orchestra/schema/mode"
import type { Permission } from "@orchestra/schema/permission"
import { Effect, Option, Schema } from "effect"
import { Form } from "../../form.js"
import { Model } from "../../model.js"
import { Orchestra } from "../../orchestra.js"
import { ModelRouter } from "../../session/model-router.js"
import { Token } from "../../util/token.js"
import { FormDecision } from "../../form-decision.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import type { SessionMessage } from "../../session/message.js"

export const name = "sessions"

// The modes the tool advertises come from the schema registry, so adding or removing a builtin
// mode cannot leave the orchestrator's instructions listing a stale set.
export const MODE_IDS = Mode.builtins
  .filter((mode) => String(mode.id) !== "jailbreak")
  .map((mode) => String(mode.id))
  .join(", ")

export const description = [
  "Run this project's AI team: the other sessions of the project, each a separate chat with its own role.",
  "Only the project's main session (the orchestrator) has this tool.",
  "Before creating a worker, inspect the roster and reuse an existing writable session with the needed role. Action create reuses an existing session of that role by default; set newInstance=true only when an additional parallel worker is deliberately needed.",
  "Do not call HTTP endpoints directly or invent /api/orchestra routes for team management. Use this tool. If a team action returns an endpoint or API error, report the actual error instead of creating a replacement session.",
  "Actions: list shows the team by category with each session's role, status, access and whether a task is outstanding;",
  "send queues a task without interrupting the worker's current work; its task-linked <team-report> arrives automatically when it finishes and wakes the Orchestrator again. The current turn ending after send is intentional; it does not mean the project task is complete.",
  "A report's state describes whether the worker run ended; outcome describes task progress. If outcome is partial, incomplete, failed, or stopped, treat the task as still open unless it is explicitly blocked or cancelled. outcome=unknown means the worker did not state its status: judge the report text yourself instead of re-sending the task. Compare the report with the acceptance criteria and send a focused follow-up to that same worker after its previous task is no longer outstanding. Do not mark the overall task complete until evidence satisfies the acceptance criteria; if the work is blocked, state the exact blocker.",
  "Copy the complete sessionID exactly from the roster or action list; never abbreviate or invent one. If a sessions action fails, inspect the exact error and current list/read state, correct the cause, then retry only with changed/corrected arguments. Never repeat an identical failed call.",
  "A worker that asks the human a question during its task blocks until someone answers; that question also arrives here as a <team-question>. Answer it with action answer (sessionID of the worker, answers: one list of chosen option labels or your own text per question, in order) when the task and the operator's instructions settle it; if only the operator can decide, tell the operator instead.",
  "read returns a session's latest messages; create accepts an exact role ID from the global Orchestra role registry even if no session exists for that role yet, reuses a writable matching session by default or creates one if needed, and can give it a first task; set_mode changes how an existing session works; stop interrupts a running session.",
  `Modes: ${MODE_IDS}. A mode changes how a session works and may make it read-only; it never widens the role's permissions. Pass mode to send or create, or use action set_mode. Use fast for trivial work, planning or research before building, coding for implementation, architecture for parallel-safe design, test to verify, review or debug for checks, and self-improvement for work on the product itself. A planner in coding mode still cannot edit files.`,
  "Never pass a display title as a role ID: use an exact role id from the roles listed with your team.",
  "Access per session is hidden < read < write < full: read allows list and read, write adds send, full adds stop. Sessions you create get full access.",
].join("\n")

type WorkerRow = {
  role: string
  access: Orchestra.Access
  mode?: string
  session: { id: string; title?: string }
}

export function reusableWorker<T extends WorkerRow>(
  rows: ReadonlyArray<T>,
  role: string,
  pending: ReadonlySet<string>,
) {
  const matches = rows.filter((row) => row.role === role)
  const writable = matches.filter((row) => Orchestra.allows(row.access, "write"))
  return {
    matches,
    writable,
    session: writable.find((row) => !pending.has(row.session.id)),
  }
}

export const Input = Schema.Struct({
  action: Schema.Literals(["list", "read", "send", "create", "set_mode", "stop", "answer"]),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({ description: "Target session for read, send and stop" }),
  text: Schema.optionalKey(Schema.String).annotate({
    description: "Message for send, or the first task for create",
  }),
  title: Schema.optionalKey(Schema.String).annotate({ description: "Title of the session to create" }),
  role: Schema.optionalKey(Schema.String).annotate({
    description: "Exact ID of a built-in or saved Orchestra role, required for create; not the display title. The available role ids are listed with your team.",
  }),
  category: Schema.optionalKey(Schema.String).annotate({
    description: "Category of the session to create, e.g. Planning, Build or Quality",
  }),
  newInstance: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Normally omit this: create reuses an existing writable session with this role. Set true only when a separate parallel worker is deliberately needed.",
  }),
  answers: Schema.optionalKey(Schema.Array(Schema.Array(Schema.String))).annotate({
    description:
      "For answer: one entry per question of the worker's <team-question>, in order; each entry lists the chosen option labels, or your own text as a single item",
  }),
  reason: Schema.optionalKey(Schema.String).annotate({
    description:
      "For answer: one short sentence on why you chose this answer. The operator sees it beside the answer, so they can tell an AI decision from their own and judge it.",
  }),
  limit: Schema.optionalKey(Schema.Int).annotate({ description: "How many recent messages read returns (default 10)" }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      "For send and create: the provider/model the worker runs this task on, optionally with a reasoning variant (provider/model#high). Without it a new worker runs on your own model; pass it whenever the operator asks for another model. A role with a model list accepts only models from that list; a role the operator pinned to one model cannot be changed.",
  }),
  tools: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      'For send and create: narrow the worker to these tools for this task (e.g. ["read", "grep", "glob"] for a pure investigation). Only for roles that allow it; ["all"] restores the role\'s full set.',
  }),
  mode: Schema.optionalKey(Schema.String).annotate({
    description:
      "For send, create and set_mode: a work mode id (auto, fast, coding, research, planning, review, debug, design, ops). A mode changes how the worker works and may make it read-only; it never widens the role's permissions. Use auto to clear the override.",
  }),
})

export const Output = Schema.Struct({
  output: Schema.String,
  sessionID: Schema.optionalKey(SessionSchema.ID),
})

/**
 * A delegated task runs an explicit reasoning level, never the provider's silent default: a model
 * that offers variants must be named with one, as `provider/model#variant` or through the role's
 * own variant, and an unknown one is refused with the list to choose from.
 */
export const resolveVariant = Effect.fnUntraced(function* (
  ref: Model.Ref,
  role: Orchestra.Role | undefined,
  available: ReadonlyArray<{ readonly providerID: string; readonly id: string; readonly variants: ReadonlyArray<{ readonly id: string }> }>,
) {
  const chosen: string | undefined = ref.variant ?? role?.variant
  const withVariant = (variant: string | undefined) =>
    variant === undefined || ref.variant === variant
      ? ref
      : Model.Ref.make({ ...ref, variant: Model.VariantID.make(variant) })
  const known = available.find((item) => item.providerID === ref.providerID && item.id === ref.id)
  // A model without variants runs exactly as before, with or without a role variant.
  if (!known || known.variants.length === 0) return ref
  const names = known.variants.map((variant) => variant.id as string)
  if (chosen === undefined)
    return yield* new ToolFailure({
      message: `This model requires a reasoning variant: pass ${ref.providerID}/${ref.id}#<id> or set role.variant. Available: ${names.join(", ")}`,
    })
  if (!names.includes(chosen))
    return yield* new ToolFailure({
      message: `Variant "${chosen}" is not available for "${ref.providerID}/${ref.id}". Available: ${names.join(", ")}`,
    })
  return withVariant(chosen)
})

const modelRef = (model: Model.Ref) => `${model.providerID}/${model.id}`
const refWithVariant = (model: Model.Ref) => `${modelRef(model)}${model.variant ? `#${model.variant}` : ""}`
const baseOf = (reference: string) => reference.split("#")[0]

export interface RoutedWorkerModel {
  readonly model: string
  readonly variant?: string
}

// The Smart Token Router applied to a worker: classify the task, then buy the cheapest candidate
// that can run the tier's reasoning variant. Pure, because the tool reads the policy, the Feature
// picks and the catalog before calling it; a pinned role, empty text and an empty catalog all
// return undefined, which keeps whatever model the caller already had.
export function routeWorkerModel(input: {
  readonly role: Orchestra.Role
  readonly text: string
  readonly mode?: string
  readonly candidates: ReadonlyArray<Model.Ref>
  readonly catalog: ReadonlyArray<ModelRouter.CatalogModel>
}): RoutedWorkerModel | undefined {
  if (!input.text.trim() || input.catalog.length === 0 || input.candidates.length === 0) return undefined
  // A role the operator pinned to one model has nothing to route between.
  if (input.role.model && !input.role.models?.length) return undefined
  // A role's own model list names the exact reasoning levels allowed there, so its variants stay;
  // without such a list the tier chooses the variant, so candidates carry none.
  const candidates = [
    ...new Set(input.candidates.map((ref) => (input.role.models?.length ? refWithVariant(ref) : modelRef(ref)))),
  ]
  const decision = ModelRouter.classify({
    task: input.text,
    // The display name stays out: it is prose, and "Auditor" would count as an audit keyword for
    // every role that happens to be called that.
    role: `${input.role.id} ${input.role.category}`,
    ...(input.mode ? { mode: input.mode } : {}),
  })
  const routed = ModelRouter.route({
    tier: decision.tier,
    candidates,
    catalog: input.catalog,
    tokens: Token.estimate(input.text),
  })
  return { model: routed.model, ...(routed.variant ? { variant: routed.variant } : {}) }
}

export const Plugin = {
  id: "orchestra.tool.orchestra",
  effect: Effect.fn("OrchestraTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const orchestra = yield* Orchestra.Service
    const forms = yield* Form.Service
    const catalog = yield* Effect.serviceOption(Model.Service)

    // A role the operator gave a model list keeps to that list and a pinned model is never overridden;
    // any other role may run on any model the catalog has, so the Orchestrator can honour a request for
    // a model other than its own.
    const requireModel = Effect.fnUntraced(function* (role: Orchestra.Role | undefined, model: string) {
      if (!role)
        return yield* new ToolFailure({ message: "This session has no team role, so it keeps its own model; omit model" })
      if (role.models?.length && !role.models.includes(model))
        return yield* new ToolFailure({ message: `${model} is not one of ${role.name}'s models: ${role.models.join(", ")}` })
      if (!role.models?.length && role.model)
        return yield* new ToolFailure({
          message: `${role.name} is pinned to ${role.model} by the operator; omit model`,
        })
      const ref = yield* Effect.try({
        try: () => Model.Ref.parse(model),
        catch: () => new ToolFailure({ message: `Invalid model "${model}". Use provider/model or provider/model#variant.` }),
      })
      const withRoleVariant =
        ref.variant === undefined && role.variant !== undefined
          ? Model.Ref.make({ ...ref, variant: Model.VariantID.make(role.variant) })
          : ref
      if (Option.isNone(catalog)) return withRoleVariant
      const available = yield* catalog.value.available()
      const known = available.find((item) => item.providerID === ref.providerID && item.id === ref.id)
      if (role.models?.length || !known) {
        if (role.models?.length || available.length === 0) return withRoleVariant
        return yield* new ToolFailure({
          message: `Model ${ref.providerID}/${ref.id} is not available. Some that are: ${available
            .slice(0, 20)
            .map((item) => `${item.providerID}/${item.id}`)
            .join(", ")}`,
        })
      }
      return yield* resolveVariant(ref, role, available)
    })

    // The Smart Token Router decides a model for a task the operator left open: it reads the task,
    // the role and the mode, picks a tier, and buys the cheapest model that can run that tier's
    // reasoning variant. An explicit model, a role pinned to one model and a missing catalog all
    // keep the previous behaviour instead of guessing.
    const routeModel = Effect.fnUntraced(function* (
      role: Orchestra.Role | undefined,
      text: string | undefined,
      mode: Mode.Spec | undefined,
    ) {
      if (!role || !text?.trim() || Option.isNone(catalog)) return undefined

      const policy = yield* Orchestra.workerPolicy
      const favorites = yield* Orchestra.workerFavorites
      const available = yield* catalog.value.available()
      // The candidates are the operator's own: Feature picks, the role's choice, the worker policy.
      const worker = Orchestra.workerModels(policy, role, { favorites, catalog: available })
      const refs = [worker.model, ...(worker.models ?? [])].filter((item): item is Model.Ref => item !== undefined)
      const allowed = (ref: Model.Ref) =>
        role.models?.length ? role.models.some((item) => baseOf(item) === modelRef(ref)) : true
      const routed = routeWorkerModel({
        role,
        text,
        ...(mode ? { mode: mode.id } : {}),
        candidates: refs.filter(allowed),
        catalog: available,
      })
      if (!routed) return undefined
      const known = available.find((item) => `${item.providerID}/${item.id}` === routed.model)
      if (!known) return undefined
      // The routed variant is the tier's; a role variant still applies when the tier named none.
      const variant =
        routed.variant ?? (role.variant && known.variants.some((item) => item.id === role.variant) ? role.variant : undefined)
      return Model.Ref.make({
        providerID: known.providerID,
        id: known.id,
        ...(variant ? { variant: Model.VariantID.make(variant) } : {}),
      })
    })

    // Every action runs on behalf of the project's main session and only
    // reaches sessions of the same project at the level the operator granted.
    const target = Effect.fnUntraced(function* (
      project: Orchestra.Project,
      sessionID: SessionSchema.ID | undefined,
      required: Orchestra.Access,
    ) {
      if (!sessionID) return yield* new ToolFailure({ message: "Pass the sessionID of the target session" })
      const session = yield* sessions
        .get(sessionID)
        .pipe(Effect.mapError(() => new ToolFailure({ message: `Session not found: ${sessionID}. Use the complete ID from the team roster.` })))
      const access = yield* orchestra.access(session.id)
      if (session.id === project.main || access === "hidden" || !(yield* orchestra.owns(project, session)))
        return yield* new ToolFailure({ message: `Session not found: ${sessionID}. Use the complete ID from the team roster.` })
      if (!Orchestra.allows(access, required))
        return yield* new ToolFailure({
          message: `Access to ${sessionID} is "${access}"; this action needs "${required}". The operator can raise it in the project panel.`,
        })
      return session
    })

    // The team as the orchestrator may see it, grouped by category in first-seen order.
    // A session's role is named by its role id, the one action create takes, not its agent id.
    const team = Effect.fnUntraced(function* (project: Orchestra.Project) {
      const members = yield* orchestra.sessions(project.id).pipe(Effect.orDie)
      const access = yield* orchestra.accessMany(members.map((session) => session.id))
      const categories = yield* orchestra.categories(members.map((session) => session.id))
      const roles = yield* orchestra.roles()
      return members
        .filter((session) => access[session.id] !== "hidden")
        .map((session) => {
          const role = roles.find((item) => item.agent === session.agent)
          return {
            session,
            access: access[session.id],
            category: categories[session.id] ?? "Other",
            role: role?.id ?? session.agent ?? "default",
            mode: Mode.fromMetadata(session.metadata)?.id ?? (role ? Mode.defaultForRole(role)?.id : undefined),
          }
        })
    })

    const grouped = <T extends { category: string }>(rows: ReadonlyArray<T>, line: (row: T) => string) =>
      [...new Set(rows.map((row) => row.category))]
        .map((category) =>
          [`${category}:`, ...rows.filter((row) => row.category === category).map((row) => `- ${line(row)}`)].join(
            "\n",
          ),
        )
        .join("\n")

    const list = Effect.fnUntraced(function* (project: Orchestra.Project) {
      const rows = yield* team(project)
      if (rows.length === 0) return "No team sessions in this project yet. Create one with action create."
      const active = yield* sessions.active
      const pending = yield* Effect.forEach(rows, (row) => orchestra.pending(row.session.id))
      const outcomes = yield* orchestra.outcomes(project.id)
      const now = Date.now()
      return grouped(
        rows.map((row, index) => ({
          ...row,
          sent: pending[index],
          outcome: outcomes[row.session.id]?.outcome,
        })),
        (row) =>
          [
            `${row.session.title ?? "(untitled)"} ${row.session.id}`,
            `role ${row.role}`,
            ...(row.mode ? [`mode ${row.mode}`] : []),
            active.has(row.session.id) ? "running" : "idle",
            `access ${row.access}`,
            ...(row.outcome ? [`last report ${row.outcome}`] : []),
            ...(row.sent === undefined
              ? []
              : [`task outstanding (sent ${Math.round((now - row.sent) / 60_000)} min ago)`]),
          ].join(" · "),
      )
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, core: true },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const project = yield* orchestra.mainOf(context.sessionID)
              if (!project)
                return yield* new ToolFailure({ message: "Only a project's main session can manage sessions" })

        // Clean up sessionID if passed with quotes, backticks or formatting
        if (input.sessionID) {
          const cleaned = input.sessionID.trim().replace(/^[`*"]+|[`*"]+$/g, "")
          if (cleaned !== input.sessionID) {
            ;(input as any).sessionID = cleaned as SessionSchema.ID
          }
        }

        // A common slip: the model puts the target session ID in `text` and a
        // placeholder or nothing in `sessionID`. Recover by using `text` as the ID when it
        // names a real session.
        if (input.text?.trim().startsWith("ses_")) {
          const candidate = input.text.trim().replace(/^[`*"]+|[`*"]+$/g, "") as SessionSchema.ID
          if (input.sessionID) {
            const current = yield* sessions.get(input.sessionID).pipe(Effect.option)
            if (current._tag === "None") {
              const fallback = yield* sessions.get(candidate).pipe(Effect.option)
              if (fallback._tag === "Some") {
                ;(input as any).sessionID = candidate
                ;(input as any).text = undefined
              }
            }
          } else if (input.action !== "create" && input.action !== "send") {
            const fallback = yield* sessions.get(candidate).pipe(Effect.option)
            if (fallback._tag === "Some") {
              ;(input as any).sessionID = candidate
              ;(input as any).text = undefined
            }
          }
        }

              const dispatch = (sessionID: SessionSchema.ID, text: string) =>
                orchestra.dispatch({ project, sessionID, text }).pipe(
                  Effect.mapError((error) => new ToolFailure({ message: `Could not send task: ${error.message}`, error })),
                )
              const roles = yield* orchestra.roles()
              // A mode changes how a session works, not what its role allows. `auto` clears the
              // stored override so the role's default applies again.
              const requireMode = Effect.fnUntraced(function* (id: string | undefined) {
                if (!id?.trim()) return undefined
                const mode = Mode.of(id)
                if (!mode)
                  return yield* new ToolFailure({
                    message: `Unknown work mode ${id}. Modes: ${Mode.list().join(", ")}`,
                  })
                return mode
              })
              const setMode = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, mode: Mode.Spec) {
                const session = yield* sessions
                  .get(sessionID)
                  .pipe(Effect.mapError(() => new ToolFailure({ message: `Session not found: ${sessionID}. Use the complete ID from the team roster.` })))
                const metadata = { ...(session.metadata ?? {}) }
                if (mode.id === "auto") delete metadata[Mode.MetadataKey]
                else metadata[Mode.MetadataKey] = mode.id
                yield* sessions.setMetadata({ sessionID, metadata }).pipe(Effect.orDie)
              })
              // New workers start in their role's default mode; an existing worker keeps the
              // mode the operator or the Orchestrator already chose unless one is passed now.
              const applyMode = Effect.fnUntraced(function* (
                session: SessionSchema.Info,
                role: Orchestra.Role | undefined,
                requested: Mode.Spec | undefined,
              ) {
                if (requested) return yield* setMode(session.id, requested)
                if (Mode.fromMetadata(session.metadata) || !role) return
                const fallback = Mode.defaultForRole(role)
                if (fallback) yield* setMode(session.id, fallback)
              })
              // The Orchestrator's automatic choices for one task: a model from the role's list
              // and a narrower tool set. Both are checked against what the operator allowed.
              const choose = Effect.fnUntraced(function* (
                role: Orchestra.Role | undefined,
                text?: string,
                mode?: Mode.Spec,
              ) {
                const model = input.model?.trim()
                  ? yield* requireModel(role, input.model.trim())
                  : yield* routeModel(role, text, mode)
                const tools = input.tools?.map((tool) => tool.trim()).filter(Boolean)
                if (tools && !role?.autoTools)
                  return yield* new ToolFailure({
                    message: `${role?.name ?? "This session"} does not let the Orchestrator change its tools; omit tools`,
                  })
                const outside = tools?.filter(
                  (tool) => tool !== "all" && role?.tools && !Orchestra.toolAllowed(role.tools, tool),
                )
                if (outside?.length)
                  return yield* new ToolFailure({
                    message: `${role?.name} may not use ${outside.join(", ")}; its tools are ${role?.tools?.join(", ")}`,
                  })
                return {
                  model,
                  permissions: tools ? (tools.includes("all") ? [] : Orchestra.toolRules(tools)) : undefined,
                }
              })
              const apply = Effect.fnUntraced(function* (
                sessionID: SessionSchema.ID,
                choice: { model?: Model.Ref; permissions?: Permission.Ruleset },
              ) {
                if (choice.model) yield* sessions.switchModel({ sessionID, model: choice.model }).pipe(Effect.orDie)
                if (choice.permissions)
                  yield* sessions.setPermissions({ sessionID, permissions: choice.permissions }).pipe(Effect.orDie)
              })
              const busy = (sessionID: SessionSchema.ID) =>
                Effect.gen(function* () {
                  if ((yield* orchestra.pending(sessionID)) === undefined) return
                  return yield* new ToolFailure({
                    message: `Session ${sessionID} already has an outstanding task. Wait for its <team-report> before sending another.`,
                  })
                })

              switch (input.action) {
                case "list":
                  return { output: yield* list(project) }
                case "read": {
                  const session = yield* target(project, input.sessionID, "read")
                  const isPending = (yield* orchestra.pending(session.id)) !== undefined
                  const messages = yield* sessions
                    .messages({ sessionID: session.id, limit: input.limit ?? 10, order: "desc" })
                    .pipe(Effect.mapError((error) => new ToolFailure({ message: "Could not read the session", error })))
                  let text = messages.toReversed().flatMap(render).join("\n\n") || "The session has no messages yet."
                  if (isPending) {
                    text += "\n\n[NOTICE: This worker is currently actively executing a task. Do NOT poll this session with repeated read or list calls. Its <team-report> will be delivered to you automatically upon completion. End your turn now and wait.]"
                  }
                  return { sessionID: session.id, output: text }
                }
                case "send": {
                  const session = yield* target(project, input.sessionID, "write")
                  if (!input.text?.trim()) return yield* new ToolFailure({ message: "Pass the message as text" })
                  yield* busy(session.id)
                  const role = roles.find((item) => item.agent === session.agent)
                  const mode = yield* requireMode(input.mode)
                  yield* apply(
                    session.id,
                    yield* choose(
                      role,
                      input.text,
                      mode ?? Mode.fromMetadata(session.metadata) ?? (role ? Mode.defaultForRole(role) : undefined),
                    ),
                  )
                  yield* applyMode(session, role, mode)
                  yield* dispatch(session.id, input.text)
                  return {
                    sessionID: session.id,
                    output: `Sent to ${session.title ?? session.id}. Its report will arrive here when it finishes. Stop and wait for the report now; do NOT poll with read or list.`,
                  }
                }
                case "create": {
                  const role = roles.find((item) => item.id === input.role)
                  // A role is required: without one the session runs the default agent under
                  // whatever title the model invents ("Architect"), a member the roster never had.
                  if (!role)
                    return yield* new ToolFailure({
                      message: `${input.role ? `Unknown role ${input.role}` : "Pass a role"}. Roles: ${roles.map((role) => role.id).join(", ")}`,
                    })
                  const mode = yield* requireMode(input.mode)
                  const choice = yield* choose(role, input.text, mode ?? Mode.defaultForRole(role))

                  // Reuse the project's existing worker by role before creating anything.
                  // A new instance is an explicit opt-in, not the default response to a new task.
                  if (!input.newInstance) {
                    const rows = yield* team(project)
                    const matching = rows.filter((row) => row.role === role.id)
                    if (matching.length > 0) {
                      const pending = new Set<string>()
                      for (const row of matching) {
                        if ((yield* orchestra.pending(row.session.id)) !== undefined) pending.add(row.session.id)
                      }
                      const reusable = reusableWorker(rows, role.id, pending)
                      if (reusable.session) {
                        const existing = reusable.session.session
                        yield* apply(existing.id, choice)
                        yield* applyMode(existing, role, mode)
                        if (input.text?.trim()) yield* dispatch(existing.id, input.text)
                        return {
                          sessionID: existing.id,
                          output: input.text?.trim()
                            ? `Reused existing ${role.name} session ${existing.title ?? existing.id}; task queued. Its report will arrive here when it finishes. Stop and wait for the report now; do NOT poll with read or list.`
                            : `Reused existing ${role.name} session ${existing.title ?? existing.id}. No new session was created; use action send to assign work.`,
                        }
                      }
                      if (reusable.writable.length === 0) {
                        return yield* new ToolFailure({
                          message: `An existing ${role.name} session has no write access. Do not create a duplicate to bypass permissions; ask the operator to raise its access to write or full.`,
                        })
                      }
                      return yield* new ToolFailure({
                        message: `All existing ${role.name} sessions have an outstanding task. Wait for a <team-report> before sending more work. No duplicate session was created.`,
                      })
                    }
                  }

                  // A role without its own model runs on the operator's Feature picks, then on the
                  // `orchestra.worker` policy, then on the orchestrator's model, the one the operator
                  // picked, rather than the server's first catalog model. An explicit task model still
                  // wins.
                  const main = yield* sessions.get(context.sessionID).pipe(Effect.option)
                  const favorites = yield* Orchestra.workerFavorites
                  const available = Option.isNone(catalog) ? [] : yield* catalog.value.available()
                  const worker = Orchestra.workerModels(yield* Orchestra.workerPolicy, role, { favorites, catalog: available })
                  // The core service holds the project lifecycle lock across ownership, creation,
                  // access and category writes; removal cannot leave a half-created member behind.
                  const created = yield* orchestra
                    .createMember({
                      project,
                      title: input.title?.trim() || undefined,
                      agent: role.agent,
                      model: choice.model ?? worker.model ?? Option.getOrUndefined(main)?.model,
                      models: worker.models,
                      category: input.category,
                    })
                    .pipe(
                      Effect.mapError((error) => new ToolFailure({ message: `Could not create a session: ${error.message}`, error })),
                    )
                  if (choice.permissions)
                    yield* sessions.setPermissions({ sessionID: created.id, permissions: choice.permissions }).pipe(Effect.orDie)
                  yield* applyMode(created, role, mode)
                  if (input.text?.trim()) yield* dispatch(created.id, input.text)
                  return {
                    sessionID: created.id,
                    output: `Created ${created.id}${input.text?.trim() ? "; task queued. Its report will arrive here when it finishes. Stop and wait for the report now; do NOT poll with read or list." : ""}.`,
                  }
                }
                case "answer": {
                  const session = yield* target(project, input.sessionID, "write")
                  const answers = input.answers ?? []
                  if (answers.length === 0) return yield* new ToolFailure({ message: "Pass answers, one list per question" })
                  // The worker's oldest open question; the human may already have answered it in the worker.
                  const form = (yield* forms.list({ sessionID: session.id })).find(
                    (item) => item.metadata?.kind === "question",
                  )
                  if (!form)
                    return yield* new ToolFailure({
                      message: `${session.title ?? session.id} has no open question; it may already have been answered or dismissed.`,
                    })
                  if (answers.length !== form.fields.length)
                    return yield* new ToolFailure({
                      message: `The question has ${form.fields.length} part(s); pass exactly that many answers, in order.`,
                    })
                  const formatAnswer = (field: Form.Field, values: ReadonlyArray<string> | undefined) => {
                    const list = values ?? []
                    if (field.type === "multiselect") return [...list]
                    if (field.type === "boolean") {
                      const raw = (list[0] ?? "").trim().toLowerCase()
                      return raw === "true" || raw === "yes" || raw === "1" || raw === "y"
                    }
                    if (field.type === "number" || field.type === "integer") {
                      const num = Number(list[0])
                      return Number.isFinite(num) ? num : (list[0] ?? "")
                    }
                    return list.join(", ")
                  }
                  // The worker's transcript shows who answered, so an AI decision is never mistaken for the operator's.
                  const asked = form.metadata?.tool as { messageID?: string; id?: string } | undefined
                  if (asked?.messageID && asked.id)
                    FormDecision.note(FormDecision.key(asked.messageID, asked.id), {
                      by: `${project.name} Orchestrator`,
                      ...(input.reason?.trim() ? { reason: input.reason.trim().slice(0, 300) } : {}),
                    })
                  yield* forms
                    .reply({
                      id: form.id,
                      answer: Object.fromEntries(
                        form.fields.map((field, index) => [
                          field.key,
                          formatAnswer(field, answers[index]),
                        ]),
                      ),
                    })
                    .pipe(Effect.mapError((error) => new ToolFailure({ message: `Could not answer: ${error.message}`, error })))
                  return {
                    sessionID: session.id,
                    output: `Answered ${session.title ?? session.id}'s question; it continues its task and its report will arrive here.`,
                  }
                }
                case "set_mode": {
                  const session = yield* target(project, input.sessionID, "write")
                  const mode = yield* requireMode(input.mode)
                  if (!mode) return yield* new ToolFailure({ message: "Pass mode to set_mode" })
                  yield* setMode(session.id, mode)
                  return {
                    sessionID: session.id,
                    output: `${session.title ?? session.id} now works in the ${mode.name} mode (${mode.id}) from its next task.`,
                  }
                }
                case "stop": {
                  const session = yield* target(project, input.sessionID, "full")
                  const stopped = yield* sessions.interrupt(session.id)
                  return { sessionID: session.id, output: stopped ? "Stopped." : "The session was not running." }
                }
              }
            }).pipe(
              Effect.map((output) => ({
                output,
                content: output.output,
                metadata: output.sessionID ? { sessionID: output.sessionID } : {},
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)

    // The tool only exists for the project's main session; every other session
    // never sees it, so it cannot be prompted into managing its siblings.
    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        if (!event.tools[name]) return
        if (!(yield* orchestra.mainOf(event.sessionID))) delete event.tools[name]
      })
    // The main session also gets its team roster with every request. Status is left
    // out: it changes during a turn, and the stable roster keeps the prompt cacheable.
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        yield* hook(event)
        if (!event.tools[name]) return
        const project = yield* orchestra.mainOf(event.sessionID)
        if (!project) return
        const rows = yield* team(project)
        const roles = yield* orchestra.roles()
        const playbook = yield* orchestra.playbook(project.id)
        const outcomes = yield* orchestra.outcomes(project.id)
        event.system.push({
          type: "text",
          text: [
            `# Your team — project "${project.name}" (${project.directory})`,
            rows.length === 0
              ? "The team has no sessions yet. No session exists until you create it with the sessions tool, action create."
              : [
                  "These are all the sessions of the team; no other session exists. Name and address them only by these titles and IDs.",
                  grouped(
                    rows,
                    (row) =>
                      [
                        `${row.session.title ?? "(untitled)"} ${row.session.id}`,
                        `role ${row.role}`,
                        ...(row.mode ? [`mode ${row.mode}`] : []),
                        `access ${row.access}`,
                        ...(outcomes[row.session.id] ? [`last report ${outcomes[row.session.id]?.outcome}`] : []),
                      ].join(" · "),
                  ),
                ].join("\n"),
            "",
            "Team workflow rules (mandatory):",
            "- Reuse an existing session with the needed role via action send; do not create a duplicate just because the task is new or a worker is busy.",
            "- Each session has a work mode (auto, fast, coding, research, planning, review, debug, design, ops). Set it with action set_mode or pass mode to send/create. A mode changes how the worker works and may make it read-only; it never widens the role's permissions.",
            "- Copy the complete session ID exactly from this roster. Never truncate, infer, or substitute an ID.",
            "- Sending a task ends this model turn while the worker runs; a task-linked <team-report> wakes you again. Do not tell the user the task is complete merely because send succeeded.",
            "- After each <team-report>, compare the worker's evidence with the original acceptance criteria. outcome=partial, incomplete, failed, or stopped means the task is still open unless explicitly blocked/cancelled (outcome=unknown: judge the report text itself): inspect the report and send a specific follow-up to the same worker once its previous task is no longer outstanding. outcome=complete is evidence to review, not a substitute for checking the criteria.",
            "- A <team-question> means a worker is blocked waiting for an answer. Answer it with action answer when the task, the playbook or the operator's instructions settle it, and pass reason: one short sentence on why, which the operator sees next to your answer. Ask the operator only when the decision is genuinely theirs.",
            "- If a sessions tool call fails, inspect its exact error and use list/read to verify IDs and whether a task is outstanding. Fix the arguments or underlying cause before retrying; never repeat the identical failed call.",
            "- Do not call HTTP endpoints directly or guess /api/orchestra routes. If a tool/API error occurs, report its exact message and do not create a replacement session as a workaround.",
            "",
            ...(playbook
              ? [
                  "",
                  `# Team playbook — "${playbook.name}"`,
                  "This project was opened with this team. Follow its playbook unless the operator asks otherwise; scale it down for small requests.",
                  playbook.text,
                ]
              : []),
            "",
            "Roles you can create a session with (action create, role id):",
            ...roles.map((role) => `- ${role.id} (${role.name}, ${role.category}${role.readOnly ? ", read-only" : ""}): ${role.description}${setup(role)}`),
          ].join("\n"),
        })
      }),
    )
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}

// How a role is set up, when the operator changed anything the Orchestrator has to respect.
function setup(role: Orchestra.Role) {
  const parts = [
    `mode ${role.mode ?? Mode.defaultForRole(role)?.id ?? "auto"}`,
    role.models?.length
      ? `model: you choose per task from ${role.models.join(", ")}`
      : role.model
        ? `model ${role.model}`
        : "model: your own unless you pass model",
    role.tools ? `tools: ${role.tools.join(", ")}` : "",
    role.autoTools ? "you may narrow its tools per task" : "",
    role.hub ? `hub categories: ${role.hub.join(", ") || "none"}` : "",
    role.registry ? `registry programs: ${role.registry.join(", ") || "none"}` : "",
  ].filter(Boolean)
  return parts.length > 0 ? ` [${parts.join("; ")}]` : ""
}

function render(message: SessionMessage.Info) {
  if (message.type === "user") return [`[user] ${message.text}`]
  if (message.type === "synthetic") return [`[note] ${message.text}`]
  if (message.type !== "assistant") return []
  const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
  const tools = message.content.flatMap((part) => (part.type === "tool" ? [part.name] : []))
  return [`[assistant] ${text}${tools.length > 0 ? `\n(tools: ${tools.join(", ")})` : ""}`]
}
