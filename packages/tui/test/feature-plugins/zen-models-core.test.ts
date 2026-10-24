import { describe, expect, test } from "bun:test"
import type { ModelInfo } from "@orchestra/client"
import { classifyFailure, freeZenModels } from "../../src/feature-plugins/system/zen-models-core"

const model = (modelID: string, input: number, extra: Partial<ModelInfo> = {}) =>
  ({
    id: modelID,
    modelID,
    providerID: "opencode",
    name: modelID,
    capabilities: {},
    variants: [],
    time: { released: 0 },
    cost: [{ input, output: input }],
    status: "active",
    enabled: true,
    limit: { context: 1, output: 1 },
    ...extra,
  }) as unknown as ModelInfo

describe("free Zen models", () => {
  test("keeps enabled zero-cost Zen models, newest first", () => {
    const result = freeZenModels([
      model("old-free", 0, { time: { released: 1 } }),
      model("paid", 3),
      model("new-free", 0, { time: { released: 2 } }),
      model("other-provider", 0, { providerID: "openrouter" }),
      model("disabled", 0, { enabled: false }),
      model("deprecated", 0, { status: "deprecated" }),
    ])
    expect(result.map((item) => item.modelID)).toEqual(["new-free", "old-free"])
  })
})

describe("check failures", () => {
  test("reports Zen's free usage refusal as a limit", () => {
    expect(classifyFailure("Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go").state).toBe("limit")
    expect(classifyFailure("Rate limit exceeded. Please try again later.").state).toBe("limit")
  })

  test("reports connection and model failures as errors", () => {
    const result = classifyFailure("Transport: ECONNREFUSED: Unable to connect")
    expect(result).toEqual({ state: "error", detail: "Transport: ECONNREFUSED: Unable to connect" })
  })
})
