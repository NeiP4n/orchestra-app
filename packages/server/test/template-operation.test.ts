import { templateStage, TemplateStageError } from "@orchestra/core/project-template-errors"
import { expect, test } from "bun:test"
import { InvalidRequestError } from "@orchestra/protocol/errors"
import { Effect, Logger } from "effect"
import { templateOperation } from "../src/handlers/template-operation"

async function refused(error: unknown) {
  const messages: unknown[] = []
  const result = await Effect.runPromise(
    templateOperation("prepareSave", async () => { throw error }).pipe(
      Effect.flip,
      Effect.provide(Logger.layer([Logger.make((entry) => { messages.push(entry.message) })], { mergeWithExisting: false })),
    ),
  )
  return { result, messages }
}

test("template ownership refusal logs the exact bounded public reason", async () => {
  const { result, messages } = await refused(new Error("Browser ownership or identity is invalid."))
  expect(result).toBeInstanceOf(InvalidRequestError)
  expect(result.kind).toBe("TEMPLATE_BROWSER_OWNER")
  expect(messages).toEqual([["project template operation refused", {
    operation: "prepareSave", kind: result.kind, reason: result.message,
  }]])
})

test("unknown exceptions and OS errors never leak their messages, causes or fields to logs", async () => {
  for (const error of [
    new Error("PRIVATE_CANARY https://private.invalid/path?key=PRIVATE_CANARY", { cause: new Error("PRIVATE_CAUSE") }),
    Object.assign(new Error("PRIVATE_CANARY /home/private/data"), { code: "EACCES", path: "/PRIVATE_PATH", token: "PRIVATE_TOKEN" }),
    { message: "PRIVATE_CANARY", kind: "TEMPLATE_BROWSER_OWNER" },
  ]) {
    const { result, messages } = await refused(error)
    expect(result).toBeInstanceOf(InvalidRequestError)
    expect(messages).toHaveLength(1)
    expect(JSON.stringify({ result, messages })).not.toMatch(/PRIVATE_|private\.invalid|\/home\/private/)
  }
})

test("successful template operations return unchanged and emit no warning", async () => {
  const messages: unknown[] = []
  const value = { token: "review-token" }
  const result = await Effect.runPromise(templateOperation("prepareSave", async () => value).pipe(
    Effect.provide(Logger.layer([Logger.make((entry) => { messages.push(entry.message) })], { mergeWithExisting: false })),
  ))
  expect(result).toBe(value)
  expect(messages).toEqual([])
})

test("stage diagnosis preserves public code and logs no nested exception content", async () => {
  let failure: unknown
  try { await templateStage("skills", async () => { throw Object.assign(new Error("PRIVATE_PATH PRIVATE_SECRET"), { code: "EACCES" }) }) } catch (error) { failure = error }
  const { result, messages } = await refused(failure)
  expect(result.kind).toBe("TEMPLATE_PERMISSION")
  expect(messages).toEqual([["project template operation refused", { operation: "prepareSave", kind: result.kind, reason: result.message, stage: "skills", reasonCode: "permission-denied" }]])
  expect(JSON.stringify({ result, messages })).not.toContain("PRIVATE_")
})

test("process substage logs only fixed reason codes and never nested fields", async () => {
  for (const stage of ["base-rules", "process-roles", "process-playbook", "skill-files", "session-models"] as const) {
    let failure: unknown
    try { await templateStage(stage, async () => { throw new Error("Absolute paths are not portable. No template was prepared.") }) } catch (error) { failure = error }
    const { result, messages } = await refused(failure)
    expect(messages).toEqual([["project template operation refused", { operation: "prepareSave", kind: result.kind, reason: result.message, stage, reasonCode: "path-not-portable" }]])
    expect(JSON.stringify(result)).not.toContain("reasonCode")
  }
})

test("corrupt stage and reason objects cannot smuggle new log fields", async () => {
  const error = Object.assign(new TemplateStageError("skills", new Error("PRIVATE_CANARY")), { stage: "PRIVATE_STAGE", reasonCode: "PRIVATE_REASON" })
  const { result, messages } = await refused(error)
  expect(JSON.stringify({ result, messages })).not.toContain("PRIVATE_")
  expect(messages).toEqual([["project template operation refused", { operation: "prepareSave", kind: result.kind, reason: result.message }]])
})

test("prepare-create role and model refusals identify a bounded cause, never role rules or identities", async () => {
  for (const [stage, reasonCode, expectedKind] of [
    ["roles", "session-role-missing", "TEMPLATE_SESSION_ROLE"],
    ["roles", "rule-role-missing", "TEMPLATE_RULE_ROLE"],
    ["roles", "core-role-different", "TEMPLATE_FAILED"],
    ["session-models", "model-unavailable", "TEMPLATE_FAILED"],
  ] as const) {
    const messages: unknown[] = []
    const error = new TemplateStageError(stage, new Error("PRIVATE_RULES PRIVATE_MODEL PRIVATE_SESSION"), reasonCode)
    const result = await Effect.runPromise(templateOperation("prepareCreate", async () => { throw error }).pipe(
      Effect.flip,
      Effect.provide(Logger.layer([Logger.make(entry => { messages.push(entry.message) })], { mergeWithExisting: false })),
    ))
    expect(result.kind).toBe(expectedKind)
    expect(messages).toEqual([["project template operation refused", {
      operation: "prepareCreate", kind: expectedKind, reason: result.message, stage, reasonCode,
    }]])
    expect(JSON.stringify({ messages, result })).not.toContain("PRIVATE_")
  }
})
