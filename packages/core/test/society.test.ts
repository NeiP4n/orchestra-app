import { describe, expect, test } from "bun:test"
import { Model } from "@orchestra/schema/model"
import { Provider } from "@orchestra/schema/provider"
import { Society } from "@orchestra/core/society"
import { SessionPlan } from "@orchestra/core/session/plan"
import { denyRulesForServers, mcpDenyRules, withoutMcpDenyRules } from "@orchestra/core/tool/plugin/orchestra"

// B10: the Society's numbers, model table and readiness verdict, in code —
// not in a prompt. The dry run in federation.test.ts exercises the same
// values through the real Federation service; these tests pin the pure
// rules so a regression reads as a wrong number, not a vague status line.

const catalog = (ids: ReadonlyArray<string>): ReadonlyArray<Model.Info> =>
  ids.map((id) => Model.Info.default(Provider.ID.make("anymodel"), Model.ID.make(id)))

describe("Society size", () => {
  test("targets 30 living agents and requires more than 20", () => {
    expect(Society.SOCIETY_SIZE).toBe(30)
    expect(Society.SOCIETY_MIN_AGENTS).toBe(21)
  })
})

describe("Society model table", () => {
  test("the six dead models are never a primary or a fallback", () => {
    for (const id of [
      "anymodel-reasoner",
      "anymodel-v4.1-flash",
      "fable-5.1",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6.1-sol",
    ]) {
      expect(Society.isDeadModelId(id)).toBe(true)
    }
    for (const id of [
      "anymodel-coder",
      "gpt-6-luna",
      "sonnet-5",
      "sonnet-5.5",
      "opus-5",
      "opus-5.5",
      "gemini-3.5-flash-lite",
      "gemini-3.6-flash",
      "gemini-3.8-flash",
      "gemini-4-argon",
      "grok-4.7",
    ]) {
      expect(Society.isDeadModelId(id)).toBe(false)
    }
    // anymodel-v4.1-flash is dead in all three test rounds: it is never the
    // fallback anywhere, and the fallback is a working model.
    expect(Society.FALLBACK_MODEL_ID).toBe("sonnet-5")
    expect(Society.isDeadModelId(Society.FALLBACK_MODEL_ID)).toBe(false)
  })

  test("the catalog lists all 14 Anymodel models from the 2026-11-07 listing (down from 17: anymodel-coder, anymodel-reasoner and anymodel-v4.1-flash left /models)", () => {
    expect(Society.ANYMODEL_MODEL_IDS).toEqual([
      "fable-5.1",
      "gemini-3.5-flash-lite",
      "gemini-3.6-flash",
      "gemini-3.8-flash",
      "gemini-4-argon",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-6.1-sol",
      "grok-4.7",
      "opus-5",
      "opus-5.5",
      "sonnet-5",
      "sonnet-5.5",
    ])
    expect(new Set(Society.ANYMODEL_MODEL_IDS).size).toBe(Society.ANYMODEL_MODEL_IDS.length)
    // Every id the table names — tiers, fallback and the dead list — must
    // exist in the catalog, so no fallback can point at a model the account
    // does not have. One exception: the cheap tier is anymodel-coder, which
    // left /models but still answers live chat (2026-11-07, run10) — it must
    // be chat-verified, never silently dropped. Two more exceptions, the
    // other way: anymodel-reasoner and anymodel-v4.1-flash left /models and
    // are dead in chat, so they must be dead and absent from the catalog.
    for (const id of [
      Society.STRONG_MODEL_ID,
      Society.MID_MODEL_ID,
      Society.FALLBACK_MODEL_ID,
      Society.CHEAP_FLASH_MODEL_ID,
      Society.REASONING_MODEL_ID,
    ]) {
      expect(Society.ANYMODEL_MODEL_IDS).toContain(id)
    }
    expect(Society.isChatVerifiedModelId(Society.CHEAP_MODEL_ID)).toBe(true)
    expect(Society.ANYMODEL_MODEL_IDS).not.toContain(Society.CHEAP_MODEL_ID)
    for (const id of ["anymodel-reasoner", "anymodel-v4.1-flash"]) {
      expect(Society.isDeadModelId(id)).toBe(true)
      expect(Society.ANYMODEL_MODEL_IDS).not.toContain(id)
    }
    for (const id of ["fable-5.1", "gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol"]) {
      expect(Society.isDeadModelId(id)).toBe(true)
      expect(Society.ANYMODEL_MODEL_IDS).toContain(id)
    }
  })

  test("the models checked 2026-11-07 are absent from the catalog, never a tier or fallback", () => {
    // gpt-6.1-terra, mistral-large-4 and ripple-65b are not at Anymodel yet
    // (live /models listing, 2026-11-07, 14 models), and neither are the
    // run7 models deepseek-v4.1-flash-1017, deepseek-v4.1-flash and
    // glm-5.3-flash (checked the same day, same listing): no catalog id and
    // no tier, fallback or dead id may name one, so a worker can never be
    // dispatched to a model the account does not have. When one arrives,
    // this test fails and forces the catalog update with a worker role and
    // a fallback.
    for (const id of Society.ANYMODEL_MODEL_IDS) {
      expect(Society.matchesAbsentModelMarker(id)).toBe(false)
    }
    for (const id of [
      Society.STRONG_MODEL_ID,
      Society.MID_MODEL_ID,
      Society.CHEAP_MODEL_ID,
      Society.FALLBACK_MODEL_ID,
      Society.CHEAP_FLASH_MODEL_ID,
      Society.REASONING_MODEL_ID,
      ...Society.DEAD_MODEL_IDS,
    ]) {
      expect(Society.matchesAbsentModelMarker(id)).toBe(false)
    }
    expect(Society.matchesAbsentModelMarker("gpt-6.1-terra")).toBe(true)
    expect(Society.matchesAbsentModelMarker("mistral-large-4")).toBe(true)
    expect(Society.matchesAbsentModelMarker("ripple-65b")).toBe(true)
    expect(Society.matchesAbsentModelMarker("deepseek-v4.1-flash-1017")).toBe(true)
    expect(Society.matchesAbsentModelMarker("deepseek-v4.1-flash")).toBe(true)
    expect(Society.matchesAbsentModelMarker("glm-5.3-flash")).toBe(true)
    // The marker must not catch the models that ARE there: gpt-6.1-sol is
    // a Sol, not a Terra — and anymodel-v4.1-flash is Anymodel's own model,
    // not DeepSeek, so the "deepseek" marker must not catch it either.
    expect(Society.matchesAbsentModelMarker("gpt-6.1-sol")).toBe(false)
    expect(Society.matchesAbsentModelMarker("anymodel-v4.1-flash")).toBe(false)
  })

  test("strong, mid and cheap tiers name the verified working models", () => {
    expect(Society.modelIdForTier("strong")).toBe("opus-5.5")
    expect(Society.modelIdForTier("mid")).toBe("sonnet-5.5")
    expect(Society.modelIdForTier("cheap")).toBe("anymodel-coder")
  })

  test("the new profiles name the models the 2026-11-06 chat test verified alive", () => {
    expect(Society.CHEAP_FLASH_MODEL_ID).toBe("gemini-3.8-flash")
    expect(Society.REASONING_MODEL_ID).toBe("grok-4.7")
    expect(Society.isDeadModelId(Society.CHEAP_FLASH_MODEL_ID)).toBe(false)
    expect(Society.isDeadModelId(Society.REASONING_MODEL_ID)).toBe(false)
  })

  test("quality work runs cheap, planning runs strong, the rest runs mid", () => {
    expect(Society.tierForCategory("Quality")).toBe("cheap")
    expect(Society.tierForCategory("QUALITY")).toBe("cheap")
    expect(Society.tierForCategory("Planning")).toBe("strong")
    expect(Society.tierForCategory("Build")).toBe("mid")
    expect(Society.tierForCategory(undefined)).toBe("mid")
  })

  test("resolves a tier model from the catalog, never inventing a provider id", () => {
    const models = catalog(["opus-5.5", "sonnet-5.5", "anymodel-coder", "sonnet-5"])
    expect(Society.resolveSocietyModel("strong", models)).toEqual(
      Model.Ref.make({ id: Model.ID.make("opus-5.5"), providerID: Provider.ID.make("anymodel") }),
    )
    expect(Society.resolveSocietyModel("cheap", models)?.id).toBe(Model.ID.make("anymodel-coder"))
    expect(Society.resolveSocietyModel("fallback", models)?.id).toBe(Model.ID.make("sonnet-5"))
    // A tier whose model the account does not have resolves to nothing, so
    // the caller falls through instead of running a model that is not there.
    expect(Society.resolveSocietyModel("strong", catalog(["sonnet-5"]))).toBeUndefined()
    expect(Society.resolveSocietyModel("mid", undefined)).toBeUndefined()
  })

  test("the cheap tier still resolves anymodel-coder while Anymodel is in the catalog, even though it left /models", () => {
    // anymodel-coder left the /models listing on 2026-11-07 (run10) but
    // still answers live chat: the cheap tier must keep resolving it while
    // the catalog holds any Anymodel model at all (the key exists), instead
    // of silently falling through to the Orchestrator's flagship.
    const withoutCoder = catalog(["opus-5.5", "sonnet-5.5", "sonnet-5"])
    expect(Society.resolveSocietyModel("cheap", withoutCoder)).toEqual(
      Model.Ref.make({ id: Model.ID.make("anymodel-coder"), providerID: Provider.ID.make("anymodel") }),
    )
    // No Anymodel model in the catalog at all means no provider to call:
    // the cheap tier stays unresolved instead of inventing one.
    const otherProvider = [Model.Info.default(Provider.ID.make("lix"), Model.ID.make("lix-test-model"))]
    expect(Society.resolveSocietyModel("cheap", otherProvider)).toBeUndefined()
    expect(Society.resolveSocietyModel("cheap", [])).toBeUndefined()
    // A dead model that left the listing is never revived this way.
    expect(Society.isChatVerifiedModelId("anymodel-reasoner")).toBe(false)
    expect(Society.isChatVerifiedModelId("anymodel-v4.1-flash")).toBe(false)
  })
})

describe("Society readiness", () => {
  const built = {
    agents: 30,
    alive: 30,
    withModel: 30,
    budgetChats: 3,
    stage: "planned" as const,
  }

  test("a Society of 30 living agents with models, a plan and a budget is ready", () => {
    expect(Society.readiness(built)).toEqual({ ready: true, missing: [] })
  })

  test("21 living agents is ready too: 30 is a target, not an exact count", () => {
    expect(Society.readiness({ ...built, agents: 21, alive: 21, withModel: 21 }).ready).toBe(true)
  })

  test("20 agents, a missing agent, a model-less agent, no plan and no budget are each named", () => {
    expect(Society.readiness({ ...built, agents: 20, alive: 20, withModel: 20 }).missing).toContain(
      "20/21 agents (target 30)",
    )
    expect(Society.readiness({ ...built, alive: 29 }).missing).toContain("1 agent(s) missing")
    expect(Society.readiness({ ...built, withModel: 28 }).missing).toContain("2 agent(s) without a model")
    expect(Society.readiness({ ...built, stage: "generated" }).missing).toContain(
      "society_plan apply never ran (generation is generated)",
    )
    expect(Society.readiness({ ...built, stage: undefined }).missing).toContain("society_plan apply never ran")
    expect(Society.readiness({ ...built, budgetChats: 0 }).missing).toContain("no chat has a recorded budget")
  })

  test("a founded Society stalls after the timeout, a generated one never does", () => {
    const now = Date.now()
    expect(
      Society.generationStalled(
        { stage: "founded", updated: now - Society.SOCIETY_GENERATION_TIMEOUT_MS - 1, kickoffDelivered: false },
        now,
      ),
    ).toBe(true)
    expect(
      Society.generationStalled(
        { stage: "founded", updated: now, kickoffDelivered: false },
        now,
      ),
    ).toBe(false)
    expect(
      Society.generationStalled(
        { stage: "generated", updated: now - Society.SOCIETY_GENERATION_TIMEOUT_MS - 1, kickoffDelivered: true },
        now,
      ),
    ).toBe(false)
  })

  test("generation and society-plan records round-trip through their encoding", () => {
    const generation = Society.decodeGeneration(
      Society.encodeGeneration({ stage: "planned", updated: 42, kickoffDelivered: true, goal: "Ship it" }),
    )
    expect(generation._tag).toBe("Some")
    const plan = Society.decodeSocietyPlan(
      Society.encodeSocietyPlan({ model: "anymodel/sonnet-5", budget: 1_000_000, mcp: ["context7"] }),
    )
    expect(plan._tag).toBe("Some")
  })
})

describe("Society budget", () => {
  test("a budget is a positive whole number of tokens, nothing else", () => {
    expect(SessionPlan.parseBudget(1_000_000)).toBe(1_000_000)
    expect(SessionPlan.parseBudget("1_000_000")).toBe(1_000_000)
    expect(SessionPlan.parseBudget(" 500000 ")).toBe(500000)
    expect(SessionPlan.parseBudget(0)).toBeUndefined()
    expect(SessionPlan.parseBudget(-5)).toBeUndefined()
    expect(SessionPlan.parseBudget(1.5)).toBeUndefined()
    expect(SessionPlan.parseBudget("abc")).toBeUndefined()
    expect(SessionPlan.parseBudget(undefined)).toBeUndefined()
  })
})

describe("MCP deny replacement on a reused worker", () => {
  const known = ["context7", "playwright", "serena"]

  test("a second dispatch replaces the first task's denies instead of appending them", () => {
    const first = mcpDenyRules({ servers: ["context7"], maxCalls: 5, perServer: {} }, known)
    expect(first.map((rule) => rule.action)).toEqual(["playwright_*", "serena_*"])
    // The worker runs task one, then task two allows playwright and denies
    // context7: only the new set may remain, and the ruleset must not grow.
    const operatorRule = { action: "read", resource: "*", effect: "allow" as const }
    const afterFirst = [...first, operatorRule]
    const second = mcpDenyRules({ servers: ["playwright"], maxCalls: 5, perServer: {} }, known)
    const afterSecond = [...withoutMcpDenyRules(afterFirst, first), ...second]
    expect(afterSecond.map((rule) => rule.action)).toEqual(["read", "context7_*", "serena_*"])
    expect(afterSecond).toContain(operatorRule)
  })

  test("allowing every server takes the old denies off and adds nothing", () => {
    const first = mcpDenyRules({ servers: [], maxCalls: 0, perServer: {} }, known)
    expect(withoutMcpDenyRules(first, first)).toEqual([])
    expect(mcpDenyRules({ servers: "all", maxCalls: 5, perServer: {} }, known)).toEqual([])
  })

  test("deny rules for exactly these servers, sorted and deduplicated", () => {
    expect(denyRulesForServers(["serena", "context7", "serena"]).map((rule) => rule.action)).toEqual([
      "context7_*",
      "serena_*",
    ])
    expect(denyRulesForServers([])).toEqual([])
  })
})
