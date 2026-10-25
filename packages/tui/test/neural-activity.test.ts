import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "@orchestra/client"
import { NeuralActivity } from "../src/component/neural-activity"

const event = (type: string, data: object) => ({ id: "evt_1", type, data }) as unknown as OpenCodeEvent

describe("NeuralActivity decisions and selection", () => {
  test("a question or permission request asks, and its resolution answers", () => {
    const activity = new NeuralActivity()
    activity.take(event("form.created", { form: { sessionID: "ses_a" } }))
    activity.take(event("permission.asked", { sessionID: "ses_b" }))
    activity.take(event("form.replied", { sessionID: "ses_a" }))
    activity.take(event("form.cancelled", { sessionID: "ses_a" }))
    activity.take(event("permission.replied", { sessionID: "ses_b" }))

    expect(activity.since(0).map((signal) => [signal.kind, signal.sessionID])).toEqual([
      ["ask", "ses_a"],
      ["ask", "ses_b"],
      ["answer", "ses_a"],
      ["answer", "ses_a"],
      ["answer", "ses_b"],
    ])
  })

  test("choosing a session fires its neuron and heats only that session", () => {
    const activity = new NeuralActivity()
    activity.select("ses_a")

    expect(activity.since(0)).toMatchObject([{ kind: "select", sessionID: "ses_a" }])
    expect(activity.level(["ses_a"])).toBeGreaterThan(0)
    expect(activity.level(["ses_b"])).toBe(0)
  })
})
