import { describe, expect, test } from "bun:test"
import { Agent } from "@orchestra/schema/agent"
import { Money } from "@orchestra/schema/money"
import { Provider } from "@orchestra/schema/provider"
import { SessionMessage } from "@orchestra/schema/session-message"
import { AbsolutePath } from "@orchestra/core/schema"
import { Location } from "@orchestra/core/location"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { SessionStats } from "@orchestra/core/session/stats"
import { Session } from "@orchestra/core/session"
import { Model } from "@orchestra/core/model"
import { Tool } from "@orchestra/core/tool"
import { BudgetTool } from "@orchestra/core/tool/plugin/budget"
import { DateTime, Effect, Layer } from "effect"
import { location } from "./fixture/location"
import { it } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const sessionID = Session.ID.make("ses_budget_test")
const glm = { id: Model.ID.make("glm-4.6"), providerID: Provider.ID.make("zen") }
const opus = { id: Model.ID.make("opus-4"), providerID: Provider.ID.make("anthropic") }

const assistant = (input: {
  id: string
  model: Model.Ref
  cost: number
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(input.id),
    type: "assistant",
    agent: Agent.ID.make("build"),
    model: input.model,
    content: [],
    cost: Money.USD.make(input.cost),
    tokens: input.tokens,
    time: { created: DateTime.makeUnsafe(Date.UTC(2026, 9, 31)) },
  })

const empty = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const priced = (total: number) => ({ ...empty, input: total })

// Two calls on one model, one of them with a reasoning variant, and one call on another model.
const messages: ReadonlyArray<SessionMessage.Info> = [
  SessionMessage.User.make({
    id: SessionMessage.ID.make("msg_user"),
    type: "user",
    text: "spend my budget",
    time: { created: DateTime.makeUnsafe(Date.UTC(2026, 9, 31)) },
  }),
  assistant({ id: "msg_glm_1", model: glm, cost: 0.5, tokens: priced(1_000) }),
  assistant({
    id: "msg_glm_2",
    model: { ...glm, variant: Model.VariantID.make("high") },
    cost: 0.25,
    tokens: priced(500),
  }),
  assistant({ id: "msg_opus", model: opus, cost: 2, tokens: priced(2_000) }),
]

describe("SessionStats.sessionBudget spend", () => {
  test("aggregates requests, tokens and cost per model and folds a variant into its base model", () => {
    const report = SessionStats.sessionBudget(messages)
    expect(report.stepCount).toBe(3)
    expect(report.spend.models.map((line) => `${line.model.providerID}/${line.model.id}`)).toEqual([
      "zen/glm-4.6",
      "anthropic/opus-4",
    ])
    const glmLine = report.spend.models[0]
    expect(glmLine.requests).toBe(2)
    expect(glmLine.model.variant).toBeUndefined()
    expect(glmLine.tokens.input).toBe(1_500)
    expect(glmLine.cost).toBe(Money.USD.make(0.75))
    expect(report.spend.models[1].requests).toBe(1)
    expect(report.spend.requests).toBe(3)
    expect(report.spend.tokens.input).toBe(3_500)
    expect(report.spend.cost).toBe(Money.USD.make(2.75))
    expect(report.sessionTokens.total).toBe(3_500)
    // Without limits the report shows spend only, never an invented remainder.
    expect(report.spend.limit).toBeUndefined()
    expect(report.spend.remaining).toBeUndefined()
    expect(glmLine.limit).toBeUndefined()
  })

  test("reports what is left of each model's budget", () => {
    const report = SessionStats.sessionBudget(messages, undefined, {
      limits: [
        { model: "zen/glm-4.6", tokens: 2_000 },
        { model: "anthropic/opus-4", tokens: 1_500 },
      ],
    })
    const [glmLine, opusLine] = report.spend.models
    expect(glmLine.limit).toBe(2_000)
    expect(glmLine.remaining).toBe(500)
    // Spend above the budget leaves nothing, never a negative remainder.
    expect(opusLine.limit).toBe(1_500)
    expect(opusLine.remaining).toBe(0)
    expect(report.spend.limit).toBe(3_500)
    expect(report.spend.remaining).toBe(500)
  })

  test("keeps a partial limit out of the total", () => {
    const report = SessionStats.sessionBudget(messages, undefined, {
      limits: [{ model: "zen/glm-4.6", tokens: 2_000 }],
    })
    expect(report.spend.models[0].remaining).toBe(500)
    expect(report.spend.models[1].remaining).toBeUndefined()
    expect(report.spend.limit).toBeUndefined()
    expect(report.spend.remaining).toBeUndefined()
  })
})

describe("SessionStats.forecastBudget", () => {
  test("fits a task into the budget left", () => {
    expect(SessionStats.forecastBudget({ estimate: 400, limit: 2_000, used: 1_500 })).toEqual({
      estimate: 400,
      limit: 2_000,
      used: 1_500,
      remaining: 500,
      fits: true,
    })
  })

  test("an estimate that exactly uses the remainder fits", () => {
    expect(SessionStats.forecastBudget({ estimate: 500, limit: 2_000, used: 1_500 }).fits).toBe(true)
  })

  test("reports one token over the remainder as not fitting", () => {
    expect(SessionStats.forecastBudget({ estimate: 501, limit: 2_000, used: 1_500 }).fits).toBe(false)
  })

  test("a model whose spend already passed its budget has nothing left", () => {
    const forecast = SessionStats.forecastBudget({ estimate: 1, limit: 1_000, used: 1_400 })
    expect(forecast.remaining).toBe(0)
    expect(forecast.fits).toBe(false)
  })
})

const pluginNode = makeLocationNode({
  name: "test/budget-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(BudgetTool.Plugin)),
  deps: [Tool.node, Session.node, Model.node],
})

const catalog = [{ ...glm, limit: { context: 200_000, output: 32_000 } }]

const harness = (models: ReadonlyArray<unknown> = catalog) =>
  AppNodeBuilder.build(LayerNode.group([Tool.node, pluginNode]), [
    Location.node.replace(
      Layer.succeed(
        Location.Service,
        Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
      ),
    ),
    // This tool only reads history and the model catalog; both boundaries are stubbed so the
    // test exercises the real aggregation, formatting and tool registration instead of storage.
    Session.node.replace(
      Layer.succeed(
        Session.Service,
        Session.Service.of({
          messages: () => Effect.succeed([...messages]),
          get: () => Effect.succeed({ model: glm }),
        } as unknown as Session.Interface),
      ),
    ),
    Model.node.replace(
      Layer.succeed(
        Model.Service,
        Model.Service.of({ available: () => Effect.succeed(models) } as unknown as Model.Interface),
      ),
    ),
  ])

const call = (input: Record<string, unknown>) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: `call-budget-${input.action}`, name: BudgetTool.name, input },
})

const text = (result: { readonly content?: ReadonlyArray<Tool.Content> }) =>
  (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")

describe("BudgetTool", () => {
  it.live("status reports spend per model without inventing a budget", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      const result = yield* executeTool(tools, call({ action: "status" }))
      expect(result.status).toBe("completed")
      const output = text(result)
      expect(output).toContain("This session: 3 requests, 3.5k tokens, $2.7500.")
      expect(output).toContain("zen/glm-4.6: 2 requests, 1.5k tokens")
      expect(output).toContain("anthropic/opus-4: 1 requests, 2.0k tokens")
      expect(output).toContain("budget unknown")
    }).pipe(Effect.provide(harness())),
  )

  it.live("status reports what is left when limits are given", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      const result = yield* executeTool(
        tools,
        call({ action: "status", limits: { "zen/glm-4.6": 2_000, "anthropic/opus-4": 1_500 } }),
      )
      const output = text(result)
      expect(output).toContain("budget 2.0k, 500 left")
      expect(output).toContain("budget 1.5k, 0 left")
    }).pipe(Effect.provide(harness())),
  )

  it.live("forecast says a task fits into the budget the caller states", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      const fits = yield* executeTool(tools, call({ action: "forecast", tokens: 400, budget: 2_000 }))
      expect(fits.status).toBe("completed")
      expect(text(fits)).toContain("It fits: 100 tokens stay unused.")

      const over = yield* executeTool(tools, call({ action: "forecast", tokens: 700, budget: 2_000 }))
      expect(text(over)).toContain("It does not fit: 200 tokens over the budget.")
    }).pipe(Effect.provide(harness())),
  )

  it.live("forecast estimates a task from its text and falls back to the model's catalog limit", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      const result = yield* executeTool(tools, call({ action: "forecast", task: "x".repeat(4_000) }))
      expect(result.status).toBe("completed")
      const output = text(result)
      expect(output).toContain("the task needs about 1.0k tokens")
      expect(output).toContain("Budget 200.0k, 1.5k already spent, 198.5k left.")
      expect(output).toContain("pass budget for a bought allowance")
    }).pipe(Effect.provide(harness())),
  )

  it.live("forecast refuses a task it cannot size", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      const result = yield* executeTool(tools, call({ action: "forecast", budget: 1_000 }))
      expect(result.status).toBe("error")
      expect(result.error?.message ?? "").toContain("forecast needs task or tokens")
    }).pipe(Effect.provide(harness())),
  )

  test("is registered in the internal pre list, the only place production loads it from", async () => {
    // A source check on purpose: deleting the line from `pre` leaves every other test green,
    // because they all register the plugin themselves.
    const source = await Bun.file(new URL("../src/plugin/internal.ts", import.meta.url)).text()
    const pre = /const pre = \[([\s\S]*?)\n\] as const/.exec(source)?.[1]

    expect(pre).not.toBeUndefined()
    expect(pre).toContain("BudgetTool.Plugin")
    expect(source).toContain('import { BudgetTool } from "../tool/plugin/budget.js"')
  })
})
