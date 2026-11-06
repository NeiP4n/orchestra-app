import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { Recovery } from "../src/recovery.js"

// T3-6: the recovery chat input is capped — an unbounded transcript is an unbounded
// model context, paid for by the operator.
describe("Recovery.RecoveryChatMessage", () => {
  const decode = (input: unknown) => Option.isSome(Schema.decodeUnknownOption(Recovery.RecoveryChatMessage)(input))

  test("accepts a short message", () => {
    expect(decode({ role: "user", content: "Orchestra is broken" })).toBe(true)
  })

  test("refuses content over 8000 characters", () => {
    expect(decode({ role: "user", content: "x".repeat(8001) })).toBe(false)
    expect(decode({ role: "user", content: "x".repeat(8000) })).toBe(true)
  })
})

describe("Recovery chat transcript", () => {
  const decode = (input: unknown) => Option.isSome(Schema.decodeUnknownOption(Recovery.RecoveryChatTranscript)(input))

  test("refuses more than 20 messages", () => {
    const messages = Array.from({ length: 21 }, () => ({ role: "user" as const, content: "hi" }))
    expect(decode(messages)).toBe(false)
    expect(decode(messages.slice(0, 20))).toBe(true)
  })
})
