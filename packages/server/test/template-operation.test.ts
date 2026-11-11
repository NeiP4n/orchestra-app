import { templateStage } from "@orchestra/core/project-template-errors"
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
  expect(messages).toEqual([["project template operation refused", { operation: "prepareSave", kind: result.kind, reason: result.message, stage: "skills" }]])
  expect(JSON.stringify({ result, messages })).not.toContain("PRIVATE_")
})
