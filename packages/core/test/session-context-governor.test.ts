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
const shot = (id: string) =>
  Message.make({
    id: `i${id}`,
    role: "tool",
    content: [
      {
        type: "tool-result",
        id,
        name: "desktop_screenshot",
        result: { type: "content", value: [{ type: "file", uri: `data:image/png;base64,${"A".repeat(4_000)}`, mime: "image/png" }] },
      },
    ],
  })

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
  test("is on unless the config or the environment switches it off", () => {
    SessionContextGovernor.configure(undefined)
    expect(SessionContextGovernor.policy()).toBeDefined()
    SessionContextGovernor.configure(false)
    expect(SessionContextGovernor.policy()).toBeUndefined()
    SessionContextGovernor.configure(true)
    expect(SessionContextGovernor.policy()).toBeDefined()
    SessionContextGovernor.configure(undefined)
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

  test("elides old results that carry an image instead of re-sending the base64 on every step", () => {
    const govern = SessionContextGovernor.make()
    const messages = [
      user("go"),
      ...Array.from({ length: 8 }, (_, index) => [
        call(`i${index}`, "desktop_screenshot"),
        shot(`i${index}`),
      ]).flat(),
    ]
    const governed = govern({ sessionID: "s", key: "k", messages, policy })

    const old = governed.slice(0, governed.length - policy.keep)
    expect(elided(old).length).toBeGreaterThan(0)
    expect(elided(old)[0]?.result.value).toContain("image or other binary payload")
    expect(elided(governed.slice(-policy.keep))).toHaveLength(0)
    expect(JSON.stringify(governed).length).toBeLessThan(JSON.stringify(messages).length / 2)
  })

  test("never elides errors, decisions, the rulebook, or short output", () => {
    const govern = SessionContextGovernor.make()
    const messages = [
      user("go"),
      call("e"),
      result("e", big, "read", "error"),
      call("q", "question"),
      result("q", big, "question"),
      call("r", "rules"),
      result("r", big, "rules"),
      call("t"),
      result("t", "short"),
      ...conversation(6).slice(1),
    ]
    const governed = govern({ sessionID: "s", key: "k", messages, policy })
    const [error, question, rules, short] = resultsOf(governed)
    expect(error.result.value).toBe(big)
    expect(question.result.value).toBe(big)
    expect(rules.result.value).toBe(big)
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

  test("elides old bulky tool-call arguments: the planner's briefs are the prompt", () => {
    const govern = SessionContextGovernor.make()
    // A planner dispatching a 4k brief to a worker, eight times, each
    // returning a 4k report — the Б14 shape (78k → 672k input in ~7 min).
    // With result-only elision the calls alone would keep ~9k tokens.
    const brief = "brief ".repeat(650)
    const dispatch = (id: string, name = "send") =>
      Message.make({
        id: `d${id}`,
        role: "assistant",
        content: [{ type: "tool-call", id, name, input: { task: brief, worker: `worker-${id}` } }],
      })
    const messages = [
      user("plan the app"),
      ...Array.from({ length: 8 }, (_, index) => [dispatch(String(index)), result(String(index), big)]).flat(),
    ]
    const governed = govern({ sessionID: "s", key: "k", messages, policy })

    const calls = (list: ReadonlyArray<Message>) =>
      list.flatMap((message) => message.content.flatMap((part) => (part.type === "tool-call" ? [part] : [])))
    const old = governed.slice(0, governed.length - policy.keep)
    const elidedCalls = calls(old).filter(
      (part) => typeof part.input === "object" && part.input !== null && "_elided" in part.input,
    )
    expect(elidedCalls.length).toBeGreaterThan(0)
    expect(elidedCalls[0]?.name).toBe("send")
    // The recent window still carries the full brief; the model is acting on it now.
    const recent = calls(governed.slice(-policy.keep))
    expect(recent.every((part) => typeof part.input === "object" && part.input !== null && "task" in part.input)).toBe(true)

    // Measured on this transcript (chars / 3.5 ≈ tokens, the governor's own estimate):
    // raw 18_647 tokens, results-only governor 11_824, calls+results 6_033 —
    // a 68% cut of the request, and 49% less than the results-only governor.
    const tokens = (list: ReadonlyArray<Message>) => JSON.stringify(list).length / 3.5
    expect(tokens(governed)).toBeLessThan(tokens(messages) * 0.4)
    expect(JSON.stringify(governed).length).toBeLessThan(JSON.stringify(messages).length / 2)
  })

  test("keeps the arguments of calls that carry decisions (dod, rules)", () => {
    const govern = SessionContextGovernor.make()
    const bigInput = { brief: "x".repeat(4_000) }
    const decision = (id: string, name: string) =>
      Message.make({ id: `c${id}`, role: "assistant", content: [{ type: "tool-call", id, name, input: bigInput }] })
    const messages = [
      user("go"),
      decision("d", "dod"),
      result("d", big, "dod"),
      decision("r", "rules"),
      result("r", big, "rules"),
      ...conversation(6).slice(1),
    ]
    const governed = govern({ sessionID: "s", key: "k", messages, policy })
    const calls = governed.flatMap((message) =>
      message.content.flatMap((part) => (part.type === "tool-call" ? [part] : [])),
    )
    expect(calls.filter((part) => part.name === "dod" || part.name === "rules").every((part) => part.input === bigInput)).toBe(
      true,
    )
  })

  test("keeps a separate mark for each session and each agent", () => {
    const govern = SessionContextGovernor.make()
    govern({ sessionID: "a", key: "k", messages: conversation(8), policy })
    expect(elided(govern({ sessionID: "b", key: "k", messages: conversation(2), policy }))).toHaveLength(0)
    expect(elided(govern({ sessionID: "a", key: "other", messages: conversation(2), policy }))).toHaveLength(0)
  })
})
