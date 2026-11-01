import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Mode } from "@orchestra/schema/mode"
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
