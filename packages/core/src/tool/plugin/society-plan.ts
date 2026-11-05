export * as SocietyPlanTool from "./society-plan.js"

import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { Federation as FederationSchema } from "@orchestra/schema/federation"
import { Model } from "@orchestra/schema/model"
import { Effect, Option, Result, Schema } from "effect"
import { Federation } from "../../federation.js"
import { Orchestra } from "../../orchestra.js"
import { Session } from "../../session.js"
import { SessionPlan } from "../../session/plan.js"
import { SessionSchema } from "../../session/schema.js"

export const name = "society_plan"

const Chat = Schema.Struct({
  project: Schema.String.annotate({
    description: 'Project id or name from status, or "society" for the Society\'s own chat.',
  }),
  role: Schema.optionalKey(Schema.String).annotate({
    description:
      "Optional agent role (e.g. 'tester', 'reviewer', 'backend-developer') or session title to match within the project; omitted targets all chats in the project.",
  }),
  model: Schema.optionalKey(Schema.String).annotate({
    description: "Optional provider/model (or provider/model#variant) every chat of that project runs on.",
  }),
  context: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])).annotate({
    description:
      "Optional context threshold where automatic compaction starts: absolute tokens (300k, 500k, 900k, 300000, 900000); do not use percentages. 0 means the whole window.",
  }),
  cache: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Optional prompt caching for the project's chats: false turns it off, true restores the default.",
  }),
  budget: Schema.optionalKey(Schema.Number).annotate({
    description:
      "Optional token budget for the chat, a whole number of tokens above 0. It is stored on the chat and checked by societyStatus, not buried in prose: a Society with no recorded budget is not ready.",
  }),
  mcp: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "Optional MCP servers assigned to the whole Society at once with this apply — one assignment the projects share, not a fresh assignment per task per project. An empty list assigns no MCP.",
  }),
})

export const Input = Schema.Struct({
  action: Schema.Literals(["status", "apply"]),
  chats: Schema.optionalKey(Schema.Array(Chat)).annotate({
    description: "For apply: one entry per chat to configure. Omitted fields keep their current setting.",
  }),
})

export const Output = Schema.Struct({ output: Schema.String })

const guide = [
  "society_plan reads and sets the Society's chats: the context threshold where each chat compacts, its prompt caching, the model it runs on, its token budget and the MCP servers assigned to the whole Society at once.",
  "The context threshold must be set in absolute token numbers (300k, 500k, 900k, 300000, 900000); do not use percentages.",
  "The budget is a whole number of tokens above 0, stored on the chat and checked by societyStatus; a Society with no recorded budget is not ready.",
  "apply is all-or-nothing: every chat is validated before anything changes, and a failure halfway rolls the changed chats back. The applied plan is stored per project, so workers created later inherit the same model, context, cache, budget and MCP assignment.",
  "Only the Society's planner project and the Society chat may use it. Use status before apply, then apply once with every chat you decided; do not plan chat by chat across many calls.",
].join("\n")

export const Plugin = {
  id: "orchestra.tool.society-plan",
  effect: Effect.fn("SocietyPlanTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const orchestra = yield* Orchestra.Service
    const federation = yield* Federation.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, guide, triggers: ["society.?plan|план общества|society plan"] },
          description: [
            "Set the Society's chats up: context threshold in tokens (e.g. 300k, 500k, 900k), prompt caching, model, token budget and the MCP servers assigned to the whole Society at once per project chat. Do not use percentages.",
            "status lists every chat of the Society with its model, context threshold, cache, budget and spend; apply changes the chats you name, all-or-nothing, and stores the plan so workers created later inherit it.",
            "The planner decides these right after the goal, before the projects start working, so no chat overflows its window or spends on caching it never reuses.",
          ].join("\n"),
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const scope = yield* resolve(context.sessionID)
              const projects = yield* orchestra.projects()

              if (input.action === "status") {
                const rows = yield* Effect.forEach(scope.group.projects, (id) =>
                  Effect.gen(function* () {
                    const project = projects.find((item) => item.id === id)
                    const lines: string[] = []
                    for (const session of yield* projectSessions(id)) {
                      lines.push(describe(project?.name ?? id, session))
                    }
                    return lines
                  }),
                )
                // The stored plan each project carries for workers created
                // later: what apply decided, not just what live chats show.
                const plans = yield* Effect.forEach(
                  scope.group.projects,
                  (id) =>
                    Effect.gen(function* () {
                      const stored = yield* federation.societyPlanFor(id)
                      if (!stored) return undefined
                      const project = projects.find((item) => item.id === id)
                      return `- ${project?.name ?? id} plan: ${[
                        stored.model,
                        stored.context === undefined ? undefined : `context ${JSON.stringify(stored.context)}`,
                        stored.cache === undefined ? undefined : `cache ${stored.cache ? "on" : "off"}`,
                        stored.budget === undefined ? undefined : `budget ${stored.budget} tokens`,
                        stored.mcp === undefined
                          ? undefined
                          : `mcp ${stored.mcp.length ? stored.mcp.join(", ") : "none"}`,
                      ]
                        .filter((item): item is string => item !== undefined)
                        .join(" · ")}`
                    }),
                )
                const chat = scope.group.supervisor
                  ? yield* sessions.get(scope.group.supervisor).pipe(
                      Effect.map((session) => [describe("Society chat", session)]),
                      Effect.orElseSucceed(() => [] as string[]),
                    )
                  : []
                return {
                  output: {
                    output: [
                      `Society "${scope.group.name}" · ${scope.role}`,
                      ...rows.flat(),
                      ...plans.filter((line): line is string => line !== undefined),
                      ...chat,
                    ].join("\n"),
                  },
                }
              }

              const chats = input.chats ?? []
              if (chats.length === 0) return yield* new ToolFailure({ message: "apply needs chats." })
              // Phase 1 — validate everything before anything changes: a bad
              // model, threshold or budget in the last chat must not leave
              // the first ones half-applied. Reads here are side-effect-free.
              const failures: string[] = []
              const plans: Array<{
                label: string
                project: Orchestra.Project | undefined
                model: Model.Ref | undefined
                threshold: SessionPlan.Threshold | undefined
                cache: boolean | undefined
                budget: number | undefined
                mcp: ReadonlyArray<string> | undefined
                sessions: ReadonlyArray<SessionSchema.Info>
              }> = []
              for (const chat of chats) {
                const target = resolveTarget(chat.project, scope.group, projects)
                if (!target) {
                  failures.push(`${chat.project}: no project by that id or name in this Society.`)
                  continue
                }
                const model = chat.model
                  ? yield* Effect.try({
                      try: () => Model.Ref.parse(chat.model!),
                      catch: () => new ToolFailure({ message: `Invalid model "${chat.model}". Use provider/model.` }),
                    }).pipe(Effect.option)
                  : Option.none()
                if (chat.model && Option.isNone(model)) {
                  failures.push(`${chat.project}: invalid model "${chat.model}".`)
                  continue
                }
                const threshold = chat.context === undefined ? undefined : SessionPlan.parseThreshold(chat.context)
                if (chat.context !== undefined && threshold === undefined) {
                  failures.push(
                    `${chat.project}: "${String(chat.context)}" is neither a share of the window ("60%") nor a token count.`,
                  )
                  continue
                }
                const budget = chat.budget === undefined ? undefined : SessionPlan.parseBudget(chat.budget)
                if (chat.budget !== undefined && budget === undefined) {
                  failures.push(`${chat.project}: budget "${String(chat.budget)}" is not a whole number of tokens above 0.`)
                  continue
                }
                const mcp =
                  chat.mcp === undefined
                    ? undefined
                    : [...new Set(chat.mcp.map((server) => server.trim()).filter(Boolean))]
                const targetSessions = (
                  target.kind === "society"
                    ? scope.group.supervisor
                      ? yield* sessions
                          .get(scope.group.supervisor)
                          .pipe(Effect.map((item) => [item]), Effect.orElseSucceed(() => []))
                      : []
                    : yield* projectSessions(target.project.id)
                ).filter((session) => {
                  if (!chat.role || chat.role === "*" || chat.role.toLowerCase() === "all") return true
                  const roleName = chat.role.toLowerCase()
                  const agent = (session.agent ?? "").toLowerCase()
                  const title = (session.title ?? "").toLowerCase()
                  return (
                    agent.includes(roleName) ||
                    title.includes(roleName) ||
                    session.id.toLowerCase() === roleName
                  )
                })
                plans.push({
                  label:
                    target.kind === "society"
                      ? "Society chat"
                      : chat.role
                        ? `${target.project.name} (${chat.role})`
                        : target.project.name,
                  project: target.kind === "society" ? undefined : target.project,
                  model: Option.getOrUndefined(model),
                  threshold,
                  cache: chat.cache,
                  budget,
                  mcp,
                  sessions: targetSessions,
                })
              }
              if (failures.length > 0)
                return yield* new ToolFailure({
                  message: `apply changed nothing: ${failures.join(" ")} Fix the chats and apply again, all at once.`,
                })
              // Phase 2 — apply, remembering what each session had so a
              // failure halfway rolls the changed chats back instead of
              // leaving the Society half-configured.
              const mutated: Array<{ session: SessionSchema.Info; metadata: SessionSchema.Metadata; model: Model.Ref | undefined }> = []
              const outcome = yield* Effect.gen(function* () {
                for (const plan of plans) {
                  for (const session of plan.sessions) {
                    // Snapshot first: a switchModel that fails after
                    // setMetadata succeeded still leaves this session changed.
                    mutated.push({ session, metadata: { ...(session.metadata ?? {}) }, model: session.model })
                    const metadata = { ...(session.metadata ?? {}) }
                    if (plan.threshold !== undefined)
                      metadata[SessionPlan.CONTEXT_KEY] =
                        plan.threshold.type === "tokens"
                          ? plan.threshold.tokens
                          : plan.threshold.type === "capped"
                            ? { percent: plan.threshold.percent, tokens: plan.threshold.tokens }
                            : `${plan.threshold.percent}%`
                    if (plan.cache !== undefined) metadata[SessionPlan.CACHE_KEY] = plan.cache ? "auto" : "off"
                    if (plan.budget !== undefined) metadata[SessionPlan.BUDGET_KEY] = plan.budget
                    if (plan.threshold !== undefined || plan.cache !== undefined || plan.budget !== undefined)
                      yield* sessions.setMetadata({ sessionID: session.id, metadata })
                    if (plan.model)
                      yield* sessions.switchModel({ sessionID: session.id, model: plan.model })
                  }
                }
              }).pipe(Effect.result)
              if (Result.isFailure(outcome)) {
                for (const entry of mutated.toReversed()) {
                  yield* sessions
                    .setMetadata({ sessionID: entry.session.id, metadata: entry.metadata })
                    .pipe(Effect.ignore)
                  if (entry.model)
                    yield* sessions.switchModel({ sessionID: entry.session.id, model: entry.model }).pipe(Effect.ignore)
                }
                return yield* new ToolFailure({
                  message: `apply failed halfway (${String(outcome.failure)}) and rolled back the ${mutated.length} chat(s) it had already changed. Nothing is half-applied; fix the cause and apply again.`,
                })
              }
              // Phase 3 — store the plan per project, so workers created
              // later inherit it, and move the Society's generation forward:
              // society_plan apply ran. A record that fails is a warning,
              // not a reason to pretend the chats were not changed.
              const recordWarnings: string[] = []
              for (const plan of plans) {
                if (!plan.project) continue
                const record = yield* federation
                  .recordSocietyPlan(plan.project.id, {
                    ...(plan.model ? { model: `${plan.model.providerID}/${plan.model.id}` } : {}),
                    ...(plan.threshold !== undefined
                      ? {
                          context:
                            plan.threshold.type === "tokens"
                              ? plan.threshold.tokens
                              : plan.threshold.type === "capped"
                                ? { percent: plan.threshold.percent, tokens: plan.threshold.tokens }
                                : `${plan.threshold.percent}%`,
                        }
                      : {}),
                    ...(plan.cache !== undefined ? { cache: plan.cache } : {}),
                    ...(plan.budget !== undefined ? { budget: plan.budget } : {}),
                    ...(plan.mcp !== undefined ? { mcp: [...plan.mcp] } : {}),
                  })
                  .pipe(Effect.result)
                if (Result.isFailure(record))
                  recordWarnings.push(`${plan.project.name}: the stored plan could not be recorded (${String(record.failure)})`)
              }
              const generation = yield* federation
                .recordGeneration(scope.group.name, "planned")
                .pipe(Effect.result)
              if (Result.isFailure(generation))
                recordWarnings.push(`the generation stage could not be recorded (${String(generation.failure)})`)
              return {
                output: {
                  output: [
                    ...plans.map(
                      (plan) =>
                        `- ${[
                          plan.label,
                          plan.threshold === undefined ? undefined : `context ${contextLabel(plan.threshold)}`,
                          plan.cache === undefined ? undefined : `cache ${plan.cache ? "on" : "off"}`,
                          plan.model ? `${plan.model.providerID}/${plan.model.id}` : undefined,
                          plan.budget === undefined ? undefined : `budget ${plan.budget} tokens`,
                          plan.mcp === undefined
                            ? undefined
                            : `mcp ${plan.mcp.length ? plan.mcp.join(", ") : "none"}`,
                        ]
                          .filter((item): item is string => item !== undefined)
                          .join(" · ")}`,
                    ),
                    "Every chat keeps these settings until you change them. Workers created later inherit them from the stored plan.",
                    ...recordWarnings.map((warning) => `Warning: ${warning} — workers created later will not inherit the plan until apply runs again.`),
                  ].join("\n"),
                },
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `society_plan failed: ${String(error)}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)

    function contextLabel(threshold: SessionPlan.Threshold) {
      if (threshold.type === "percent") return `${threshold.percent}% of window`
      if (threshold.type === "capped") return `${threshold.percent}% of window (up to ${threshold.tokens} tokens)`
      return threshold.tokens === 0 ? "full window" : `${threshold.tokens} tokens`
    }

    function describe(owner: string, session: SessionSchema.Info) {
      const metadata = session.metadata ?? {}
      const threshold = SessionPlan.parseThreshold(metadata[SessionPlan.CONTEXT_KEY])
      const cache = metadata[SessionPlan.CACHE_KEY] === false || metadata[SessionPlan.CACHE_KEY] === "off"
      const budget = SessionPlan.parseBudget(metadata[SessionPlan.BUDGET_KEY])
      return [
        `- ${owner} · ${session.title ?? session.id}`,
        session.model ? `${session.model.providerID}/${session.model.id}` : "default model",
        `context ${threshold === undefined ? "model limit" : contextLabel(threshold)}`,
        `cache ${cache ? "off" : "on"}`,
        budget === undefined ? undefined : `budget ${budget} tokens`,
        `${session.tokens.input + session.tokens.output} tokens`,
        `$${session.cost.toFixed(2)}`,
      ]
        .filter((item): item is string => item !== undefined)
        .join(" · ")
    }

    function projectSessions(id: Orchestra.ProjectID) {
      return Effect.gen(function* () {
        const main = yield* orchestra.main(id).pipe(Effect.map((item) => [item]), Effect.orElseSucceed(() => []))
        const team = yield* orchestra.sessions(id).pipe(Effect.orElseSucceed(() => []))
        const seen = new Set<string>()
        return [...main, ...team].filter((session) => {
          if (seen.has(session.id)) return false
          seen.add(session.id)
          return true
        })
      })
    }

    function resolveTarget(
      value: string,
      group: Federation.Group,
      projects: ReadonlyArray<Orchestra.Project>,
    ): { kind: "society" } | { kind: "project"; project: Orchestra.Project } | undefined {
      const wanted = value.trim().toLowerCase()
      if (wanted === "society" || wanted === "chat" || wanted === "общество") return { kind: "society" }
      const project = group.projects
        .flatMap((id) => projects.find((item) => item.id === id) ?? [])
        .find((item) => item.id === value.trim() || item.name.trim().toLowerCase() === wanted)
      return project ? { kind: "project", project } : undefined
    }

    // The Society's planner and its own chat may plan; anyone else is told to ask their planner.
    function resolve(sessionID: Parameters<typeof sessions.get>[0]) {
      return Effect.gen(function* () {
        const groups = yield* federation.groups()
        const chat = groups.find(
          (group) =>
            group.supervisor === sessionID && FederationSchema.modeOf(group) === "council",
        )
        if (chat) return { group: chat, role: "society chat" as const }
        const project = yield* orchestra.mainOf(sessionID).pipe(Effect.orElseSucceed(() => undefined))
        if (!project)
          return yield* new ToolFailure({
            message:
              "society_plan works in a Society: from its planner project or from the Society chat. This session is neither.",
          })
        const planned = groups.find(
          (group) => FederationSchema.modeOf(group) === "council" && group.projects[0] === project.id,
        )
        if (planned) return { group: planned, role: `planner of ${project.name}` as const }
        return yield* new ToolFailure({
          message:
            "society_plan works in a Society: from its planner project or from the Society chat. This session is neither.",
        })
      })
    }
  }),
}
