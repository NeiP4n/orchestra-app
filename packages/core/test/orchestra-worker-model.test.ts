import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Agent } from "@orchestra/schema/agent"
import { Document, Info } from "@orchestra/schema/config"
import { ConfigOrchestra } from "@orchestra/schema/config/orchestra"
import { Model } from "@orchestra/schema/model"
import { Money } from "@orchestra/schema/money"
import { Provider } from "@orchestra/schema/provider"
import { Config } from "@orchestra/core/config"
import { Orchestra } from "@orchestra/core/orchestra"
import { resolveVariant, routeWorkerModel } from "@orchestra/core/tool/plugin/orchestra"
import type { Role } from "@orchestra/core/orchestra"
import { it } from "./lib/effect"

const role = (input: { id?: string; category?: string; name?: string; model?: string; models?: string[] } = {}): Role => ({
  id: input.id ?? "auditor",
  name: input.name ?? "Auditor",
  description: "Reviews code",
  rules: "Review",
  category: input.category ?? "Quality",
  readOnly: true,
  agent: Agent.ID.make("team-auditor"),
  origin: "custom",
  ...(input.model === undefined ? {} : { model: input.model }),
  ...(input.models === undefined ? {} : { models: input.models }),
})

const policy = (input: unknown): ConfigOrchestra.Worker => Schema.decodeUnknownSync(ConfigOrchestra.Worker)(input)

const ref = (model: Model.Ref) => `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`

// Comparisons use plain "provider/model" strings so a failure reads as a model list.
const shown = (choice: Orchestra.WorkerModelChoice) => ({
  ...(choice.model === undefined ? {} : { model: ref(choice.model) }),
  ...(choice.models === undefined ? {} : { models: choice.models.map(ref) }),
})

describe("Orchestra.workerModels", () => {
  test("keeps the Orchestrator's model when the operator set no policy", () => {
    expect(shown(Orchestra.workerModels(undefined, role()))).toEqual({})
    expect(shown(Orchestra.workerModels(policy({}), role()))).toEqual({})
  })

  test("applies the worker policy to a role that sets no model", () => {
    expect(shown(Orchestra.workerModels(policy({ model: "opencode/big-pickle" }), role()))).toEqual({
      model: "opencode/big-pickle",
    })
  })

  test("a role's own model wins over the worker policy", () => {
    expect(shown(Orchestra.workerModels(policy({ model: "opencode/big-pickle" }), role({ model: "zen/glm-4.6" })))).toEqual({
      model: "zen/glm-4.6",
    })
  })

  test("a category policy wins over the general one, ignoring case", () => {
    const worker = policy({
      model: "opencode/big-pickle",
      categories: { [role().category.toUpperCase()]: { model: "zen/glm-4.6" } },
    })
    expect(shown(Orchestra.workerModels(worker, role()))).toEqual({ model: "zen/glm-4.6" })
    expect(shown(Orchestra.workerModels(worker, role({ category: "Build" })))).toEqual({
      model: "opencode/big-pickle",
    })
  })

  test("collects the fallbacks without repeating the starting model", () => {
    const worker = policy({
      model: "opencode/big-pickle",
      models: ["opencode/minimax-free", { providerID: "opencode", model: "big-pickle" }],
      categories: { Quality: { models: ["zen/glm-4.6"] } },
    })
    expect(shown(Orchestra.workerModels(worker, role({ models: ["opencode/kimi-free"] })))).toEqual({
      model: "opencode/big-pickle",
      models: ["opencode/kimi-free", "zen/glm-4.6", "opencode/minimax-free"],
    })
  })

  test("offers a role's own model list as fallbacks when it names no starting model", () => {
    expect(shown(Orchestra.workerModels(undefined, role({ models: ["opencode/big-pickle#max", "opencode/kimi-free"] })))).toEqual({
      models: ["opencode/big-pickle#max", "opencode/kimi-free"],
    })
  })
})

describe("Orchestra.workerModels favorites", () => {
  const modelInfo = (providerID: string, id: string, input: { variants?: string[]; price?: number } = {}): Model.Info => ({
    ...Model.Info.default(Provider.ID.make(providerID), Model.ID.make(id)),
    ...(input.variants === undefined
      ? {}
      : { variants: input.variants.map((variant) => Model.Variant.make({ id: Model.VariantID.make(variant) })) }),
    ...(input.price === undefined
      ? {}
      : {
          cost: [
            {
              input: Money.USDPerMillionTokens.make(input.price),
              output: Money.USDPerMillionTokens.make(input.price),
              cache: { read: Money.USDPerMillionTokens.make(0), write: Money.USDPerMillionTokens.make(0) },
            },
          ],
        }),
  })
  const catalog = [
    modelInfo("zen", "glm-4.6", { variants: ["low", "high"], price: 0.6 }),
    modelInfo("opencode", "kimi-free", { price: 0 }),
    modelInfo("opencode", "big-pickle", { price: 3 }),
  ]
  const favorite = (model: string) => Model.Ref.parse(model)
  const guessed = (category: string, name: string) => role({ category, name })

  test("pinned models change nothing while Feature is empty", () => {
    const worker = policy({ model: "opencode/big-pickle" })
    expect(shown(Orchestra.workerModels(worker, role(), { favorites: [], catalog }))).toEqual({
      model: "opencode/big-pickle",
    })
  })

  test("a single pinned model is what every worker runs", () => {
    const favorites = [favorite("opencode/big-pickle")]

    expect(shown(Orchestra.workerModels(undefined, guessed("Planning", "Planner"), { favorites, catalog }))).toEqual({
      model: "opencode/big-pickle",
    })
    expect(shown(Orchestra.workerModels(undefined, guessed("Build", "Builder"), { favorites, catalog }))).toEqual({
      model: "opencode/big-pickle",
    })
  })

  test("a planning worker takes the pinned model that thinks hardest, at its high variant", () => {
    const favorites = [favorite("opencode/kimi-free"), favorite("zen/glm-4.6")]
    expect(shown(Orchestra.workerModels(undefined, guessed("Planning", "Planner"), { favorites, catalog }))).toEqual({
      model: "zen/glm-4.6#high",
      models: ["opencode/kimi-free"],
    })
  })

  test("a build worker takes the cheapest pinned model", () => {
    const favorites = [favorite("zen/glm-4.6"), favorite("opencode/big-pickle"), favorite("opencode/kimi-free")]
    expect(shown(Orchestra.workerModels(undefined, guessed("Build", "Builder"), { favorites, catalog }))).toEqual({
      model: "opencode/kimi-free",
      models: ["zen/glm-4.6#low", "opencode/big-pickle"],
    })
  })

  test("the Feature picks lead and the role and policy models stay as deeper fallbacks", () => {
    const worker = policy({ models: ["opencode/minimax-free"] })
    expect(
      shown(
        Orchestra.workerModels(worker, role({ model: "opencode/big-pickle", models: ["opencode/kimi-free"] }), {
          favorites: [favorite("zen/glm-4.6")],
          catalog,
        }),
      ),
    ).toEqual({
      model: "zen/glm-4.6#high",
      models: ["opencode/big-pickle", "opencode/kimi-free", "opencode/minimax-free"],
    })
  })

  test("a variant pinned in the config wins over the role's ranking", () => {
    expect(
      shown(Orchestra.workerModels(undefined, guessed("Planning", "Planner"), { favorites: [favorite("zen/glm-4.6#low")], catalog })),
    ).toEqual({ model: "zen/glm-4.6#low" })
  })

  test("without a catalog the shortlist keeps the operator's order", () => {
    const favorites = [favorite("opencode/kimi-free"), favorite("zen/glm-4.6")]
    expect(shown(Orchestra.workerModels(undefined, guessed("Planning", "Planner"), { favorites }))).toEqual({
      model: "opencode/kimi-free",
      models: ["zen/glm-4.6"],
    })
  })

  it.live("reads the pinned models from the orchestra config and hands them to a worker", () =>
    Effect.gen(function* () {
      const favorites = yield* Orchestra.workerFavorites
      expect(favorites.map(ref)).toEqual(["opencode/kimi-free", "zen/glm-4.6"])
      expect(shown(Orchestra.workerModels(undefined, guessed("Build", "Builder"), { favorites, catalog }))).toEqual({
        model: "opencode/kimi-free",
        models: ["zen/glm-4.6#low"],
      })
    }).pipe(
      Effect.provide(
        Config.testLayer([
          new Document({
            type: "document",
            info: new Info({ model_favorites: ["opencode/kimi-free", "zen/glm-4.6"] }),
          }),
        ]),
      ),
    ),
  )
})

describe("Orchestra.modelOf", () => {
  test("runs a role's model at the variant the role names", () => {
    expect(ref(Orchestra.modelOf({ ...role({ model: "zen/glm-4.6" }), variant: "high" })!)).toBe("zen/glm-4.6#high")
  })

  test("keeps a variant written into the model string", () => {
    expect(ref(Orchestra.modelOf({ ...role({ model: "zen/glm-4.6#max" }), variant: "high" })!)).toBe("zen/glm-4.6#max")
  })
})

describe("resolveVariant", () => {
  const catalog = (variants: string[]) => [
    { providerID: "zen", id: "glm-4.6", variants: variants.map((id) => ({ id })) },
    { providerID: "opencode", id: "kimi-free", variants: [] },
  ]
  const roleWith = (variant: string | undefined) => ({
    ...role({ model: "zen/glm-4.6" }),
    ...(variant === undefined ? {} : { variant }),
  })
  const resolve = (model: string, variant: string | undefined, available = catalog(["low", "high"])) =>
    Effect.runSync(resolveVariant(Model.Ref.parse(model), roleWith(variant), available))
  const failure = (model: string, variant: string | undefined, available = catalog(["low", "high"])) =>
    Effect.runSync(Effect.flip(resolveVariant(Model.Ref.parse(model), roleWith(variant), available)))

  test("refuses a model that offers variants when none is named", () => {
    expect(failure("zen/glm-4.6", undefined).message).toBe(
      "This model requires a reasoning variant: pass zen/glm-4.6#<id> or set role.variant. Available: low, high",
    )
  })

  test("refuses a variant the model does not offer", () => {
    expect(failure("zen/glm-4.6#max", undefined).message).toBe(
      'Variant "max" is not available for "zen/glm-4.6". Available: low, high',
    )
  })

  test("accepts the variant written into the model string", () => {
    expect(ref(resolve("zen/glm-4.6#high", undefined))).toBe("zen/glm-4.6#high")
  })

  test("takes the role's variant when the model string carries none", () => {
    expect(ref(resolve("zen/glm-4.6", "low"))).toBe("zen/glm-4.6#low")
  })

  test("leaves a model without variants exactly as it was", () => {
    expect(ref(resolve("opencode/kimi-free", undefined))).toBe("opencode/kimi-free")
    expect(ref(resolve("opencode/kimi-free", "high"))).toBe("opencode/kimi-free")
  })
})

describe("routeWorkerModel", () => {
  const catalog = [
    { providerID: "polza", id: "flash", variants: [{ id: "minimal" }, { id: "fast" }, { id: "low" }], cost: [{ input: 0.1, output: 0.4 }] },
    { providerID: "polza", id: "deepseek", variants: [{ id: "low" }, { id: "medium" }, { id: "high" }], cost: [{ input: 0.3, output: 1.2 }] },
    { providerID: "polza", id: "opus", variants: [{ id: "high" }, { id: "max" }], cost: [{ input: 3, output: 15 }] },
  ]
  const candidates = [Model.Ref.parse("polza/flash#low"), Model.Ref.parse("polza/deepseek#medium"), Model.Ref.parse("polza/opus#high")]

  test("routes a cheap task to the cheapest model with its cheapest variant", () => {
    expect(
      routeWorkerModel({ role: role({ id: "developer" }), text: "Исправь опечатку в README", candidates, catalog }),
    ).toEqual({ model: "polza/flash", variant: "minimal" })
  })

  test("routes architecture work to the cheapest model that can reason deeply", () => {
    expect(
      routeWorkerModel({
        role: role({ id: "architect" }),
        text: "Спроектируй контракты сервиса оплаты",
        mode: "architecture",
        candidates,
        catalog,
      }),
    ).toEqual({ model: "polza/deepseek", variant: "high" })
  })

  test("keeps the variant a role's own model list names", () => {
    expect(
      routeWorkerModel({
        role: role({ id: "architect", models: ["polza/opus#max"] }),
        text: "Исправь опечатку в README",
        candidates: [Model.Ref.parse("polza/opus#max")],
        catalog,
      }),
    ).toEqual({ model: "polza/opus", variant: "max" })
  })

  test("never reroutes a role the operator pinned to one model", () => {
    expect(
      routeWorkerModel({ role: role({ model: "polza/opus" }), text: "Исправь опечатку", candidates, catalog }),
    ).toBeUndefined()
  })

  test("leaves the current model alone when there is no task text or no catalog", () => {
    expect(routeWorkerModel({ role: role(), text: "  ", candidates, catalog })).toBeUndefined()
    expect(routeWorkerModel({ role: role(), text: "Исправь опечатку", candidates, catalog: [] })).toBeUndefined()
    expect(routeWorkerModel({ role: role(), text: "Исправь опечатку", candidates: [], catalog })).toBeUndefined()
  })
})
