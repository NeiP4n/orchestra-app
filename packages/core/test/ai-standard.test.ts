import { describe, expect, test } from "bun:test"
import { Agent } from "@orchestra/schema/agent"
import { Model } from "@orchestra/schema/model"
import { Money } from "@orchestra/schema/money"
import { Provider } from "@orchestra/schema/provider"
import { ProviderCooldown } from "@orchestra/ai"
import { AiStandard } from "@orchestra/core/ai-standard"
import { Orchestra } from "@orchestra/core/orchestra"

const ref = (model: string) => Model.Ref.parse(model)
const shown = (model: Model.Ref) => `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`

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

describe("AiStandard.effortFor", () => {
  test("planning, review and debugging work is depth; the rest is speed", () => {
    expect(AiStandard.effortFor("Quality Auditor")).toBe("depth")
    expect(AiStandard.effortFor("Planning Architect")).toBe("depth")
    expect(AiStandard.effortFor("Build Builder")).toBe("speed")
    expect(AiStandard.effortFor(undefined)).toBe("speed")
  })
})

describe("AiStandard.rankFavorites", () => {
  test("depth work ranks the highest-effort variant first", () => {
    const ranked = AiStandard.rankFavorites([ref("opencode/kimi-free"), ref("zen/glm-4.6")], "depth", catalog)
    expect(ranked.map(shown)).toEqual(["zen/glm-4.6#high", "opencode/kimi-free"])
  })

  test("speed work ranks the cheapest model first and resolves its cheapest variant", () => {
    const ranked = AiStandard.rankFavorites([ref("zen/glm-4.6"), ref("opencode/big-pickle")], "speed", catalog)
    expect(ranked.map(shown)).toEqual(["zen/glm-4.6#low", "opencode/big-pickle"])
  })

  test("a pinned variant is never re-ranked away", () => {
    const ranked = AiStandard.rankFavorites([ref("zen/glm-4.6#low")], "depth", catalog)
    expect(ranked.map(shown)).toEqual(["zen/glm-4.6#low"])
  })
})

describe("AiStandard.downProviders", () => {
  test("reports only the catalog providers inside a recorded cooldown", () => {
    // A provider id no other test uses, so the 60 s cooldown this records
    // cannot leak into another test's catalog.
    const testCatalog = [modelInfo("down-provider-test", "model-a"), modelInfo("opencode", "kimi-free")]
    expect(AiStandard.downProviders(testCatalog)).toEqual([])
    ProviderCooldown.noteProviderDown("down-provider-test")
    expect(AiStandard.downProviders(testCatalog)).toEqual(["down-provider-test"])
    expect(AiStandard.downProviders(undefined)).toEqual([])
  })
})

describe("AiStandard.decideModel", () => {
  test("an explicit task model wins over the favorites", () => {
    const decision = AiStandard.decideModel({
      explicit: ref("opencode/big-pickle"),
      favorites: [ref("zen/glm-4.6")],
      effort: "speed",
      catalog,
    })
    expect(decision.source).toBe("task")
    expect(decision.model && shown(decision.model)).toBe("opencode/big-pickle")
    expect(decision.fallbacks.map(shown)).toEqual(["zen/glm-4.6#low"])
  })

  test("favorites lead, then the role model, then the policy chain", () => {
    const decision = AiStandard.decideModel({
      favorites: [ref("opencode/kimi-free")],
      roleModel: ref("zen/glm-4.6"),
      policy: [ref("opencode/big-pickle")],
      effort: "speed",
      catalog,
    })
    expect(decision.source).toBe("favorite")
    expect(decision.model && shown(decision.model)).toBe("opencode/kimi-free")
    expect(decision.fallbacks.map(shown)).toEqual(["zen/glm-4.6", "opencode/big-pickle"])
  })

  test("an unavailable favorite is skipped and reported, the next favorite runs", () => {
    const decision = AiStandard.decideModel({
      favorites: [ref("opencode/kimi-free"), ref("zen/glm-4.6")],
      effort: "speed",
      catalog,
      unavailable: [ref("opencode/kimi-free")],
    })
    expect(decision.source).toBe("favorite")
    expect(decision.model && shown(decision.model)).toBe("zen/glm-4.6#low")
    expect(decision.skipped.map(shown)).toEqual(["opencode/kimi-free"])
    expect(decision.fallbacks).toEqual([])
  })

  test("when every favorite is unavailable the role model takes over", () => {
    const decision = AiStandard.decideModel({
      favorites: [ref("opencode/kimi-free"), ref("zen/glm-4.6")],
      roleModel: ref("opencode/big-pickle"),
      effort: "speed",
      catalog,
      unavailable: [ref("opencode/kimi-free"), ref("zen/glm-4.6")],
    })
    expect(decision.source).toBe("role")
    expect(decision.model && shown(decision.model)).toBe("opencode/big-pickle")
    expect(decision.skipped).toHaveLength(2)
  })

  test("when everything is unavailable the run inherits the caller's model", () => {
    const decision = AiStandard.decideModel({
      favorites: [ref("opencode/kimi-free")],
      roleModel: ref("opencode/big-pickle"),
      policy: [ref("zen/glm-4.6")],
      effort: "speed",
      unavailable: [ref("opencode/kimi-free"), ref("opencode/big-pickle"), ref("zen/glm-4.6")],
    })
    expect(decision.source).toBe("none")
    expect(decision.model).toBeUndefined()
    expect(decision.fallbacks).toEqual([])
  })

  test("zero configuration is a working state: no model, no fallbacks", () => {
    const decision = AiStandard.decideModel({ effort: "speed" })
    expect(decision).toEqual({ fallbacks: [], source: "none", skipped: [] })
  })

  test("fallbacks never repeat the starting model or each other", () => {
    const decision = AiStandard.decideModel({
      favorites: [ref("opencode/kimi-free"), ref("opencode/kimi-free")],
      roleModel: ref("opencode/kimi-free"),
      effort: "speed",
      catalog,
    })
    expect(decision.fallbacks).toEqual([])
  })
})

describe("AiStandard.pickAgent", () => {
  const agent = (id: string, input: { model?: string; mode?: Agent.Info["mode"]; hidden?: boolean } = {}): Agent.Info => ({
    ...Agent.Info.default(Agent.ID.make(id)),
    ...(input.model === undefined ? {} : { model: ref(input.model) }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
  })

  test("picks the agent running the highest-ranked favorite model", () => {
    const decision = AiStandard.pickAgent({
      agents: [agent("build", { model: "opencode/big-pickle" }), agent("plan", { model: "zen/glm-4.6" })],
      favorites: [ref("zen/glm-4.6"), ref("opencode/big-pickle")],
    })
    expect(decision.source).toBe("favorite")
    expect(decision.agent?.id).toBe(Agent.ID.make("plan"))
  })

  test("subagents and hidden agents are never picked, even on a favorite model", () => {
    const decision = AiStandard.pickAgent({
      agents: [
        agent("helper", { model: "zen/glm-4.6", mode: "subagent" }),
        agent("ghost", { model: "zen/glm-4.6", hidden: true }),
        agent("build", { model: "opencode/big-pickle" }),
      ],
      favorites: [ref("zen/glm-4.6")],
    })
    expect(decision.source).toBe("build")
    expect(decision.agent?.id).toBe(Agent.ID.make("build"))
  })

  test("falls back to the configured default, then build, then the first selectable agent", () => {
    const agents = [agent("plan"), agent("build")]
    expect(AiStandard.pickAgent({ agents, defaultID: Agent.ID.make("plan") })).toEqual({
      agent: agents[0],
      source: "default",
    })
    expect(AiStandard.pickAgent({ agents }).source).toBe("build")
    expect(AiStandard.pickAgent({ agents: [agent("plan")] }).source).toBe("first")
    expect(AiStandard.pickAgent({ agents: [] })).toEqual({ source: "none" })
  })
})

describe("AiStandard.budgetFor", () => {
  test("depth work gets a larger automatic step budget than speed work", () => {
    expect(AiStandard.budgetFor("depth")).toEqual({ steps: 120, source: "standard" })
    expect(AiStandard.budgetFor("speed")).toEqual({ steps: 40, source: "standard" })
  })
})

describe("AiStandard.stepCeilings", () => {
  test("an agent with no steps of its own gets the standard's budget for its effort class", () => {
    expect(AiStandard.stepCeilings({ effort: "depth" })).toEqual([undefined, undefined, 120])
    expect(AiStandard.stepCeilings({ effort: "speed", modeSteps: 25 })).toEqual([undefined, 25, 40])
  })

  test("a configured agent ceiling is never lowered by the standard", () => {
    expect(AiStandard.stepCeilings({ agentSteps: 500, effort: "speed" })).toEqual([500, undefined, undefined])
    expect(AiStandard.stepCeilings({ agentSteps: 10, modeSteps: 8, effort: "depth" })).toEqual([10, 8, undefined])
  })
})

describe("Orchestra.workerModels under the standard", () => {
  test("skips a favorite whose provider refused it and runs the next favorite", () => {
    const choice = Orchestra.workerModels(undefined, undefined, {
      favorites: [ref("opencode/kimi-free"), ref("zen/glm-4.6")],
      catalog,
      unavailable: [ref("opencode/kimi-free")],
    })
    expect(choice.model && shown(choice.model)).toBe("zen/glm-4.6#low")
    expect(choice.models).toBeUndefined()
  })

  test("falls back to the role chain when every favorite is unavailable", () => {
    const choice = Orchestra.workerModels(undefined, undefined, {
      favorites: [ref("opencode/kimi-free")],
      unavailable: [ref("opencode/kimi-free")],
    })
    expect(choice).toEqual({})
  })
})
