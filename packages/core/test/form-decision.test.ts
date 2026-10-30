import { expect, test } from "bun:test"
import { FormDecision } from "@orchestra/core/form-decision"

test("a note is delivered once to the question it was written for", () => {
  const id = FormDecision.key("msg_1", "call_1")
  FormDecision.note(id, { by: "Core Orchestrator", reason: "The playbook settles it." })
  expect(FormDecision.take(FormDecision.key("msg_1", "call_2"))).toBeUndefined()
  expect(FormDecision.take(id)).toEqual({ by: "Core Orchestrator", reason: "The playbook settles it." })
  expect(FormDecision.take(id)).toBeUndefined()
})

test("notes nobody reads age out instead of piling up", () => {
  for (let index = 0; index < 400; index++) FormDecision.note(FormDecision.key("msg", String(index)), { by: "x" })
  expect(FormDecision.take(FormDecision.key("msg", "0"))).toBeUndefined()
  expect(FormDecision.take(FormDecision.key("msg", "399"))).toEqual({ by: "x" })
})
