import { describe, expect, test } from "bun:test"
import type { ModelInfo } from "@orchestra/client"
import { modelKey, pickFallbackModel } from "../../src/feature-plugins/system/warp-fallback"

function model(modelID: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: modelID,
    modelID,
    providerID: "opencode",
    name: modelID,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 1 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 128_000, output: 8_000 },
    ...overrides,
  }
}

const current = { providerID: "opencode", id: "deepseek-v4.1-flash-free" }

describe("WARP model fallback after the free-tier address cap", () => {
  test("moves a capped chat to another free model of the same provider", () => {
    const picked = pickFallbackModel([model("deepseek-v4.1-flash-free"), model("nemotron-3-ultra-free")], current, new Set([modelKey(current)]))
    expect(picked?.modelID).toBe("nemotron-3-ultra-free")
  })

  test("skips paid, tool-less, disabled, deprecated and foreign models", () => {
    const picked = pickFallbackModel(
      [
        model("paid", { cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }] }),
        model("unpriced", { cost: [] }),
        model("no-tools", { capabilities: { tools: false, input: ["text"], output: ["text"] } }),
        model("disabled", { enabled: false }),
        model("old", { status: "deprecated" }),
        model("elsewhere", { providerID: "ollama" }),
      ],
      current,
      new Set(),
    )
    expect(picked).toBeUndefined()
  })

  test("never picks a model the cap already refused from this address", () => {
    const capped = new Set([modelKey(current), modelKey({ providerID: "opencode", id: "nemotron-3-ultra-free" })])
    expect(pickFallbackModel([model("nemotron-3-ultra-free")], current, capped)).toBeUndefined()
  })

  test("prefers the newest free model", () => {
    const picked = pickFallbackModel(
      [model("older-free", { time: { released: 1 } }), model("newer-free", { time: { released: 2 } })],
      current,
      new Set(),
    )
    expect(picked?.modelID).toBe("newer-free")
  })
})
