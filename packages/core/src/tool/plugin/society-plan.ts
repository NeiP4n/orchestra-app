export * as SocietyPlanTool from "./society-plan.js"

import { ToolFailure } from "@orchestra/ai"
import type { Context } from "@orchestra/plugin/effect/plugin"
import { Federation as FederationSchema } from "@orchestra/schema/federation"
import { Model } from "@orchestra/schema/model"
import { Money } from "@orchestra/schema/money"
import { Effect, Option, Schema } from "effect"
import { Federation } from "../../federation.js"
import { KV } from "../../kv.js"
import { Orchestra } from "../../orchestra.js"
import { Project } from "../../project.js"
import { Session } from "../../session.js"
import { Database } from "../../database/database.js"
import { SessionPlan } from "../../session/plan.js"
import { SessionSchema } from "../../session/schema.js"
import { SessionStats } from "../../session/stats.js"

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
})

export const Input = Schema.Struct({
  action: Schema.Literals(["status", "apply"]),
  chats: Schema.optionalKey(Schema.Array(Chat)).annotate({
    description: "For apply: one entry per chat to configure. Omitted fields keep their current setting.",
  }),
  budget: Schema.optionalKey(Schema.Number).annotate({
    description:
      "For apply: the Society's spend limit in USD, saved on the group; status reports spend against it. Omitted keeps the current budget.",
  }),
})

export const Output = Schema.Struct({ output: Schema.String })

const guide = [
  "society_plan reads and sets the Society's chats: the context threshold where each chat compacts, its prompt caching, and the model it runs on.",
  "The context threshold must be set in absolute token numbers (300k, 500k, 900k, 300000, 900000); do not use percentages.",
  "Apply saves every decision as data (and the budget on the group), so status shows what was planned even after chats are recreated; apply does not only whisper settings into a prompt.",
  "Only the Society's planner project and the Society chat may use it. Use status before apply, then apply once with every chat you decided; do not plan chat by chat across many calls.",
].join("\n")

// Planner decisions, saved as data under federation/society-plan/<group>/<project|society>/<role>.
// Apply merges into the stored decision, so a later call that only changes the model keeps the
// context threshold and cache choice decided earlier.
const PLAN_PREFIX = "federation/society-plan/"
const PlanDecision = Schema.Struct({
  model: Schema.optional(Schema.String),
  context: Schema.optional(
    Schema.Union([Schema.Number, Schema.String, Schema.Struct({ percent: Schema.Number, tokens: Schema.Number })]),
  ),
  cache: Schema.optional(Schema.Boolean),
})
const decodeDecision = Schema.decodeUnknownOption(PlanDecision)

export const Plugin = {
  id: "orchestra.tool.society-plan",
  effect: Effect.fn("SocietyPlanTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const orchestra = yield* Orchestra.Service
    const federation = yield* Federation.Service
    const kv = yield* KV.Service
    const database = yield* Database.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, guide, triggers: ["society.?plan|план общества|society plan"] },
          description: [
            "Set the Society's chats up: context threshold in tokens (e.g. 300k, 500k, 900k), prompt caching and model per project chat. Do not use percentages.",
            "status lists every chat of the Society with its model, context threshold, cache and spend, plus the stored plan, spend per project and for the whole Society, and the budget when one is set; apply changes the chats you name and saves the decisions.",
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
                const chat = scope.group.supervisor
                  ? yield* sessions.get(scope.group.supervisor).pipe(
                      Effect.map((session) => [describe("Society chat", session)]),
                      Effect.orElseSucceed(() => [] as string[]),
                    )
                  : []
                const planned = yield* storedDecisions(scope.group.name)
                const names = new Map(projects.map((item) => [item.id, item.name]))
                const spend = yield* Effect.forEach(scope.group.projects, (id) =>
                  Effect.gen(function* () {
                    // Federation keys projects by Orchestra IDs; sessions store
                    // the same "prj_..." strings under the core Project brand.
                    const report = yield* SessionStats.get({ projectID: Project.ID.make(id) }).pipe(
                      Effect.provideService(Database.Service, database),
                    )
                    const tokens = report.tokens.input + report.tokens.output + report.tokens.reasoning
                    return { name: names.get(id) ?? id, tokens, cost: report.cost }
                  }),
                )
                const societyTokens = spend.reduce((sum, item) => sum + item.tokens, 0)
                const societyCost = spend.reduce((sum, item) => sum + item.cost, 0)
                const budget = scope.group.budget
                return {
                  output: {
                    output: [
                      `Society "${scope.group.name}" · ${scope.role}`,
                      ...rows.flat(),
                      ...chat,
                      "Spend:",
                      ...spend.map((item) => `- ${item.name}: ${item.tokens} tokens · $${item.cost.toFixed(2)}`),
                      `- Society total: ${societyTokens} tokens · $${societyCost.toFixed(2)}`,
                      budget === undefined
                        ? undefined
                        : societyCost > budget
                          ? `Budget $${budget.toFixed(2)} · over by $${(societyCost - budget).toFixed(2)}`
                          : `Budget $${budget.toFixed(2)} · $${(budget - societyCost).toFixed(2)} left`,
                      planned.length ? "Planned:" : undefined,
                      ...planned.map((decision) => describeDecision(decision, names)),
                    ]
                      .filter((line): line is string => line !== undefined)
                      .join("\n"),
                  },
                }
              }

              const chats = input.chats ?? []
              if (chats.length === 0 && input.budget === undefined)
                return yield* new ToolFailure({ message: "apply needs chats." })
              const applied: string[] = []
              const failures: string[] = []
              if (input.budget !== undefined) {
                if (!Number.isFinite(input.budget) || input.budget <= 0) {
                  failures.push(`budget: "${input.budget}" is not a positive USD limit.`)
                } else {
                  yield* federation.setGroup({ ...scope.group, budget: Money.USD.make(input.budget) })
                  applied.push(`budget $${input.budget.toFixed(2)}`)
                }
              }
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
                // One representation for the threshold: session metadata and the
                // stored decision carry the same value.
                const contextValue =
                  threshold === undefined
                    ? undefined
                    : threshold.type === "tokens"
                      ? threshold.tokens
                      : threshold.type === "capped"
                        ? { percent: threshold.percent, tokens: threshold.tokens }
                        : `${threshold.percent}%`
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
                for (const session of targetSessions) {
                  const metadata = { ...(session.metadata ?? {}) }
                  if (contextValue !== undefined) metadata[SessionPlan.CONTEXT_KEY] = contextValue
                  if (chat.cache !== undefined) metadata[SessionPlan.CACHE_KEY] = chat.cache ? "auto" : "off"
                  if (chat.cache !== undefined || threshold !== undefined)
                    yield* sessions.setMetadata({ sessionID: session.id, metadata }).pipe(Effect.orDie)
                  if (Option.isSome(model))
                    yield* sessions
                      .switchModel({ sessionID: session.id, model: model.value })
                      .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void))
                }
                // The decision outlives the live chats: a later status (or a
                // recreated chat) still shows what the planner decided. Merge
                // into the stored decision so changing one field keeps the rest.
                const decisionKey = `${PLAN_PREFIX}${encodeURIComponent(scope.group.name)}/${encodeURIComponent(target.kind === "society" ? "society" : target.project.id)}/${encodeURIComponent(chat.role?.trim().toLowerCase() || "all")}`
                const previousDecision = Option.getOrUndefined(decodeDecision(yield* kv.get(decisionKey)))
                const decision = {
                  ...previousDecision,
                  ...(chat.model ? { model: chat.model } : {}),
                  ...(contextValue !== undefined ? { context: contextValue } : {}),
                  ...(chat.cache !== undefined ? { cache: chat.cache } : {}),
                }
                if (Object.keys(decision).length > 0)
                  yield* kv.set(decisionKey, Schema.encodeSync(PlanDecision)(decision))
                applied.push(
                  [
                    target.kind === "society"
                      ? "Society chat"
                      : chat.role
                        ? `${target.project.name} (${chat.role})`
                        : target.project.name,
                    threshold === undefined ? undefined : `context ${contextLabel(threshold)}`,
                    chat.cache === undefined ? undefined : `cache ${chat.cache ? "on" : "off"}`,
                    chat.model,
                  ]
                    .filter((item): item is string => item !== undefined)
                    .join(" · "),
                )
              }
              return {
                output: {
                  output: [
                    failures.length ? `Skipped ${failures.length} chat(s):` : undefined,
                    ...failures,
                    ...applied.map((line) => `- ${line}`),
                    applied.length ? "Every chat keeps these settings until you change them." : undefined,
                  ]
                    .filter((line): line is string => line !== undefined)
                    .join("\n"),
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
      return [
        `- ${owner} · ${session.title ?? session.id}`,
        session.model ? `${session.model.providerID}/${session.model.id}` : "default model",
        `context ${threshold === undefined ? "model limit" : contextLabel(threshold)}`,
        `cache ${cache ? "off" : "on"}`,
        `${session.tokens.input + session.tokens.output} tokens`,
        `$${session.cost.toFixed(2)}`,
      ].join(" · ")
    }

    type StoredDecision = Schema.Schema.Type<typeof PlanDecision> & { target: string; role: string }

    function storedDecisions(groupName: string) {
      return Effect.gen(function* () {
        const prefix = `${PLAN_PREFIX}${encodeURIComponent(groupName)}/`
        const entries: Array<{ key: string; value: unknown }> = []
        let after: string | undefined
        for (;;) {
          const page = yield* kv.scan({ prefix, after, limit: 1000 })
          entries.push(...page.entries)
          if (!page.next) break
          after = page.next
        }
        return entries.flatMap((entry): Array<StoredDecision> => {
          const decision = Option.getOrUndefined(decodeDecision(entry.value))
          if (!decision) return []
          const [target = "", role = ""] = entry.key
            .slice(prefix.length)
            .split("/")
            .map((part) => decodeURIComponent(part))
          return [{ ...decision, target, role }]
        })
      })
    }

    function describeDecision(decision: StoredDecision, names: Map<string, string>) {
      const owner = decision.target === "society" ? "Society chat" : (names.get(decision.target) ?? decision.target)
      const threshold = decision.context === undefined ? undefined : SessionPlan.parseThreshold(decision.context)
      return [
        `- ${owner}${decision.role === "all" ? "" : ` (${decision.role})`}`,
        decision.model,
        threshold === undefined ? undefined : `context ${contextLabel(threshold)}`,
        decision.cache === undefined ? undefined : `cache ${decision.cache ? "on" : "off"}`,
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
