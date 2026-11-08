import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Mode } from "@orchestra/schema/mode"
import { Model } from "../src/model.js"
import { OrchestraTool } from "../src/tool/plugin/orchestra.js"

const decode = Schema.decodeUnknownSync(OrchestraTool.Input)

describe("sessions mode interface", () => {
  test("accepts set_mode with an explicit mode", () => {
    const input = decode({ action: "set_mode", sessionID: "ses_test", mode: "planning" })
    expect(input.action).toBe("set_mode")
    expect(input.mode).toBe("planning")
  })

  test("accepts a mode on create and send", () => {
    expect(decode({ action: "create", role: "developer", mode: "fast" }).mode).toBe("fast")
    expect(decode({ action: "send", sessionID: "ses_test", text: "x", mode: "review" }).mode).toBe("review")
  })

  test("keeps the mode optional for the existing actions", () => {
    expect(decode({ action: "list" }).mode).toBeUndefined()
  })

  test("advertises every builtin mode instead of a stale hand-written list", () => {
    const advertised = OrchestraTool.description
    for (const mode of Mode.builtins.filter((item) => String(item.id) !== "jailbreak"))
      expect(advertised).toContain(String(mode.id))
    expect(advertised).not.toContain("jailbreak")
    expect(OrchestraTool.MODE_IDS).toContain("self-improvement")
    expect(OrchestraTool.MODE_IDS).toContain("architecture")
    expect(OrchestraTool.MODE_IDS).toContain("test")
  })
})

describe("worker models come from the models enabled in /models", () => {
  const ref = (value: string) => Model.Ref.parse(value)

  test("a model is accepted only when it is enabled, whatever its variant", () => {
    const enabled = [ref("opencode/kimi-k2.5-free"), ref("opencode/grok-code")]
    expect(OrchestraTool.inEnabled(enabled, ref("opencode/grok-code"))).toBe(true)
    expect(OrchestraTool.inEnabled(enabled, ref("opencode/grok-code#high"))).toBe(true)
    expect(OrchestraTool.inEnabled(enabled, ref("anthropic/claude-opus"))).toBe(false)
    expect(OrchestraTool.inEnabled([], ref("opencode/grok-code"))).toBe(false)
  })

  test("the free tiers are only suggestions and name nothing but free opencode models", () => {
    for (const tier of OrchestraTool.FREE_MODEL_TIERS)
      for (const model of tier.models) expect(model).toMatch(/^opencode\/.*(free|grok-code)$/)
    expect(OrchestraTool.guide).toContain("switched on in /models")
    expect(OrchestraTool.guide).toContain("Suggest, never assume")
  })
})
