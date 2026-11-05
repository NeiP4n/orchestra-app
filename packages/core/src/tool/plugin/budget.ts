export * as BudgetTool from "./budget.js"

import type { Context } from "@orchestra/plugin/effect/plugin"
import type { Budget } from "@orchestra/schema/session-stats"
import type { Tool } from "@orchestra/schema/tool"
import { TokenUsage } from "@orchestra/schema/token-usage"
import { ToolFailure } from "@orchestra/ai"
import { optional } from "@orchestra/schema/schema"
import { Effect, Option, Schema } from "effect"
import { Model } from "../../model.js"
import { Session } from "../../session.js"
import { KV } from "../../kv.js"
import { SessionStats } from "../../session/stats.js"
import { Token } from "../../util/token.js"

export const name = "budget"

// The session's token budget, set once and kept: a limit the model passes on one call still
// binds the next one, instead of evaporating with the call that named it.
const LIMITS_KEY = (sessionID: string) => `budget/limits/${sessionID}`

interface StoredBudget {
  readonly limits: Record<string, number>
  readonly by: string
  readonly at: number
}

const isStoredBudget = (value: unknown): value is StoredBudget =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Partial<StoredBudget>).limits === "object" &&
  (value as Partial<StoredBudget>).limits !== null &&
  Object.values((value as StoredBudget).limits).every((tokens) => typeof tokens === "number" && tokens > 0) &&
  typeof (value as Partial<StoredBudget>).by === "string" &&
  typeof (value as Partial<StoredBudget>).at === "number"

export const Input = Schema.Struct({
  action: Schema.Literals(["status", "forecast"]),
  /** Model to forecast for as provider/model; defaults to the session's model. */
  model: optional(Schema.String),
  /** Task whose size is estimated; four characters per token. */
  task: optional(Schema.String),
  /** Explicit token estimate of the task, instead of task. */
  tokens: optional(Schema.Number),
  /** Token allowance of the model; overrides limits and the catalog limit. */
  budget: optional(Schema.Number),
  /** Token allowance per provider/model, reported by status and used by forecast. Passed once,
      it is stored for the session, so later calls keep the same budget without passing it again. */
  limits: optional(Schema.Record(Schema.String, Schema.Number)),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  output: Schema.String,
})
export type Output = typeof Output.Type

export const description = [
  "Token spend of this session per model and whether a task still fits into a model's token budget. Read-only.",
  "",
  "Actions:",
  "  status — requests, tokens, cost per provider/model in this session, with the budget left when limits names them.",
  "  forecast — compare a task (task text or tokens) with the budget left for model; defaults to the session's model.",
  "",
  "A budget is the token allowance you pass in budget or limits. Without one, forecast falls back to the model's own",
  "catalog limit (input window when the provider declares one, else its context window), so it answers whether the",
  "task fits into one request rather than into a bought allowance. Spend is cumulative for the session, so an",
  "allowance covers everything the session already burned on that model.",
  "",
  "Limits passed once are stored for the session and keep applying to later calls. When the stored budget is",
  "spent, forecast refuses instead of reporting that the task does not fit: the budget is a limit, not a report.",
].join("\n")

export const Plugin = {
  id: "orchestra.tool.budget",
  effect: Effect.fn("BudgetTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const kv = yield* KV.Service
    const catalog = yield* Effect.serviceOption(Model.Service)

    const run = Effect.fn("BudgetTool.run")(function* (input: Input, context: Tool.Context) {
      const messages = yield* sessions.messages({ sessionID: context.sessionID })
      // A limit named on one call still binds the next one: limits are stored per session
      // instead of evaporating with the call that named them. Passing limits again replaces
      // the stored budget, and the record says who set it and when.
      const stored = yield* kv
        .get(LIMITS_KEY(context.sessionID))
        .pipe(Effect.map((value) => (isStoredBudget(value) ? value : undefined)))
      const provenance =
        input.limits !== undefined
          ? { by: String(context.agent), at: Date.now() }
          : stored !== undefined
            ? { by: stored.by, at: stored.at }
            : undefined
      if (input.limits !== undefined && provenance !== undefined)
        yield* kv.set(LIMITS_KEY(context.sessionID), {
          limits: input.limits,
          by: provenance.by,
          at: provenance.at,
        } as unknown as KV.Value)
      const effective = input.limits ?? stored?.limits
      const limits = Object.entries(effective ?? {}).map(([model, tokens]) => ({ model, tokens }))
      const report = SessionStats.sessionBudget(messages, undefined, { limits })
      if (input.action === "status") return status(report.spend, provenance)

      const estimate = input.tokens ?? (input.task ? Token.estimate(input.task) : undefined)
      if (estimate === undefined) return yield* new ToolFailure({ message: "forecast needs task or tokens." })
      const requested = input.model
      const ref =
        requested === undefined
          ? (yield* sessions.get(context.sessionID)).model
          : yield* Effect.try({
              try: () => Model.Ref.parse(requested),
              catch: () =>
                new ToolFailure({ message: `Invalid model "${requested}"; use provider/model or provider/model#variant.` }),
            })
      if (!ref) return yield* new ToolFailure({ message: "This session has no model yet, so forecast needs model." })

      const key = `${ref.providerID}/${ref.id}`
      const used = report.spend.models.find((line) => `${line.model.providerID}/${line.model.id}` === key)?.tokens
      const allowed = input.budget ?? effective?.[key]
      const limit = allowed ?? (yield* catalogLimit(catalog, ref))
      if (limit === undefined)
        return yield* new ToolFailure({ message: `No budget is known for ${key}; pass budget or limits.` })

      const forecast = SessionStats.forecastBudget({
        estimate,
        limit,
        used: used ? TokenUsage.total(used) : 0,
      })
      // Nothing left is a refusal, not a report: a spent budget stops further work instead of
      // answering "it does not fit" while the session keeps spending anyway.
      if (forecast.remaining <= 0)
        return yield* new ToolFailure({
          message: `Budget exhausted for ${key}: ${Token.formatCount(forecast.used)} of ${Token.formatCount(forecast.limit)} tokens spent. The budget is a limit, not a report: no further work fits until the operator raises it.`,
        })
      return [
        `${key}: the task needs about ${Token.formatCount(forecast.estimate)} tokens.`,
        `Budget ${Token.formatCount(forecast.limit)}, ${Token.formatCount(forecast.used)} already spent, ${Token.formatCount(forecast.remaining)} left.`,
        forecast.fits
          ? `It fits: ${Token.formatCount(forecast.remaining - forecast.estimate)} tokens stay unused.`
          : `It does not fit: ${Token.formatCount(forecast.estimate - forecast.remaining)} tokens over the budget.`,
        allowed === undefined ? "The budget is the model's own request limit; pass budget for a bought allowance." : "",
      ]
        .filter((line) => line !== "")
        .join("\n")
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
            run(input, context).pipe(
              Effect.map((output) => ({ output: { output }, content: output })),
              Effect.mapError(failed),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

function status(spend: Budget, provenance?: { readonly by: string; readonly at: number }) {
  if (spend.models.length === 0) return "No model has spent tokens in this session yet."
  return [
    `This session: ${spend.requests} requests, ${Token.formatCount(TokenUsage.total(spend.tokens))} tokens, $${spend.cost.toFixed(4)}.`,
    ...spend.models.map((line) => {
      const tokens = line.tokens
      const left =
        line.limit === undefined
          ? "budget unknown"
          : `budget ${Token.formatCount(line.limit)}, ${Token.formatCount(line.remaining ?? 0)} left`
      return `- ${line.model.providerID}/${line.model.id}${line.model.variant ? `#${line.model.variant}` : ""}: ${line.requests} requests, ${Token.formatCount(TokenUsage.total(tokens))} tokens (in ${Token.formatCount(tokens.input)}, out ${Token.formatCount(tokens.output)}, reasoning ${Token.formatCount(tokens.reasoning)}, cache ${Token.formatCount(tokens.cache.read)}/${Token.formatCount(tokens.cache.write)}), $${line.cost.toFixed(4)}, ${left}`
    }),
    ...(provenance
      ? [`Stored budget set by ${provenance.by} at ${new Date(provenance.at).toISOString()}; passing limits again replaces it.`]
      : []),
  ].join("\n")
}

// The model's own token limit: providers that split the window declare the input side.
function catalogLimit(catalog: Option.Option<Model.Interface>, ref: Model.Ref) {
  if (Option.isNone(catalog)) return Effect.succeed<number | undefined>(undefined)
  return catalog.value.available().pipe(
    Effect.map((available) => {
      const known = available.find((item) => item.providerID === ref.providerID && item.id === ref.id)
      if (!known) return undefined
      return known.limit.input && known.limit.input > 0 ? known.limit.input : known.limit.context
    }),
  )
}

function failed(error: unknown) {
  if (error instanceof ToolFailure) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ToolFailure({ message: `Budget action failed: ${message}`, error })
}
