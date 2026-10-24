import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "@orchestra/schema/agent"
import { ConfigOrchestra } from "@orchestra/schema/config/orchestra"
import { Model } from "@orchestra/schema/model"
import { Orchestra } from "@orchestra/core/orchestra"
import type { Role } from "@orchestra/core/orchestra"

const role = (input: { category?: string; model?: string; models?: string[] } = {}): Role => ({
  id: "auditor",
  name: "Auditor",
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
