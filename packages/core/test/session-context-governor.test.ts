import { describe, expect, test } from "bun:test"
import { Message } from "@orchestra/ai"
import { SessionContextGovernor } from "../src/session/context-governor"

const policy = { soft: 2_000, keep: 4, min: 500 }
const big = "x".repeat(4_000)

const call = (id: string, name = "read") =>
  Message.make({ id: `a${id}`, role: "assistant", content: [{ type: "tool-call", id, name, input: { path: `file-${id}` } }] })
const result = (id: string, value: unknown, name = "read", type: "text" | "error" = "text") =>
  Message.make({ id: `r${id}`, role: "tool", content: [{ type: "tool-result", id, name, result: { type, value } }] })
const user = (text: string) => Message.make({ id: `u${text}`, role: "user", content: text })

// A conversation of `steps` read calls, each returning a bulky result.
const conversation = (steps: number) => [
  user("go"),
  ...Array.from({ length: steps }, (_, index) => [call(String(index)), result(String(index), big)]).flat(),
]

const resultsOf = (messages: ReadonlyArray<Message>) =>
  messages.flatMap((message) => message.content.flatMap((part) => (part.type === "tool-result" ? [part] : [])))
const elided = (messages: ReadonlyArray<Message>) =>
  resultsOf(messages).filter((part) => typeof part.result.value === "string" && part.result.value.includes("elided"))

describe("context governor", () => {
  test("is off unless the experiment is switched on", () => {
    expect(SessionContextGovernor.policy()).toBeUndefined()
  })

  test("leaves a request alone while it is below the soft limit", () => {
    const govern = SessionContextGovernor.make()
    const messages = [user("go"), call("1"), result("1", "small")]
    expect(govern({ sessionID: "s", key: "k", messages, policy })).toBe(messages)
  })

  test("elides old bulky output and keeps the recent window, the calls and the small results", () => {
    const govern = SessionContextGovernor.make()
    const messages = [...conversation(8), call("s"), result("s", "tiny")]
    const governed = govern({ sessionID: "s", key: "k", messages, policy })

    expect(governed).toHaveLength(messages.length)
    // Nothing but tool results changes: every call keeps its arguments.
    expect(governed.filter((message) => message.role !== "tool")).toEqual(
      messages.filter((message) => message.role !== "tool"),
    )
    const old = governed.slice(0, governed.length - policy.keep)
    expect(elided(old).length).toBeGreaterThan(0)
    expect(elided(governed.slice(-policy.keep))).toHaveLength(0)
    expect(resultsOf(governed).at(-1)?.result.value).toBe("tiny")
    // The original messages are untouched.
    expect(elided(messages)).toHaveLength(0)
    expect(JSON.stringify(governed).length).toBeLessThan(JSON.stringify(messages).length / 2)
  })

  test("never elides errors, decisions or short output", () => {
    const govern = SessionContextGovernor.make()
    const messages = [
      user("go"),
      call("e"),
      result("e", big, "read", "error"),
      call("q", "question"),
      result("q", big, "question"),
      call("t"),
      result("t", "short"),
      ...conversation(6).slice(1),
    ]
    const governed = govern({ sessionID: "s", key: "k", messages, policy })
    const [error, question, short] = resultsOf(governed)
    expect(error.result.value).toBe(big)
    expect(question.result.value).toBe(big)
    expect(short.result.value).toBe("short")
  })

  test("keeps the prefix byte-identical between jumps so the provider cache keeps hitting", () => {
    const govern = SessionContextGovernor.make()
    const first = govern({ sessionID: "s", key: "k", messages: conversation(8), policy })
    // One more step: the tail grows, the part already sent does not change by a byte.
    const next = govern({ sessionID: "s", key: "k", messages: conversation(9), policy })
    const sent = JSON.stringify(first.slice(0, first.length - policy.keep))
    expect(JSON.stringify(next).startsWith(sent.slice(0, -1))).toBe(true)
  })

  test("starts over when history is rewritten", () => {
    const govern = SessionContextGovernor.make()
    govern({ sessionID: "s", key: "k", messages: conversation(8), policy })
    // A compaction replaces the history with a short one.
    const rewritten = [user("summary"), call("n"), result("n", big)]
    expect(elided(govern({ sessionID: "s", key: "k", messages: rewritten, policy }))).toHaveLength(0)
  })

  test("keeps a separate mark for each session and each agent", () => {
    const govern = SessionContextGovernor.make()
    govern({ sessionID: "a", key: "k", messages: conversation(8), policy })
    expect(elided(govern({ sessionID: "b", key: "k", messages: conversation(2), policy }))).toHaveLength(0)
    expect(elided(govern({ sessionID: "a", key: "other", messages: conversation(2), policy }))).toHaveLength(0)
  })
})
