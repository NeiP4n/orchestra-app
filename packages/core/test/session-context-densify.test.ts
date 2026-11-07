import { describe, expect, test } from "bun:test"
import { Message } from "@orchestra/ai"
import { SessionContextDensify } from "../src/session/context-densify"

// A 1_000-row commit array, the shape the Headroom pilot measured upstream:
// repeated objects with identical keys (sha/author/date/subject + counters).
const commitRows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    sha: `a${String(index).padStart(39, "0")}`,
    author: ["alice", "bob", "carol"][index % 3],
    date: "2026-11-06",
    subject: `fix: change ${index}`,
    files_changed: (index % 17) + 1,
    additions: (index * 37) % 900,
    deletions: (index * 13) % 400,
    status: index % 3 === 0 ? "open" : "merged",
  }))

const result = (id: string, value: unknown, name = "read") =>
  Message.make({ id: `r${id}`, role: "tool", content: [{ type: "tool-result", id, name, result: { type: "text", value } }] })
const user = (text: string) => Message.make({ id: `u${text}`, role: "user", content: text })

describe("context densify", () => {
  test("is off by default and on with ORCHESTRA_CONTEXT_DENSIFY=1", () => {
    delete process.env.ORCHESTRA_CONTEXT_DENSIFY
    expect(SessionContextDensify.enabled()).toBe(false)
    process.env.ORCHESTRA_CONTEXT_DENSIFY = "1"
    expect(SessionContextDensify.enabled()).toBe(true)
    process.env.ORCHESTRA_CONTEXT_DENSIFY = "0"
    expect(SessionContextDensify.enabled()).toBe(false)
    delete process.env.ORCHESTRA_CONTEXT_DENSIFY
  })

  test("shrinks a repeated JSON array and expands back to the identical rows", () => {
    const rows = commitRows(1_000)
    const text = JSON.stringify(rows, null, 1)
    const densified = SessionContextDensify.densifyText(text)

    expect(densified.applied).toBe(true)
    expect(densified.savedChars).toBeGreaterThan(text.length * 0.5)
    expect(SessionContextDensify.expandDensified(densified.text)).toEqual(rows)
  })

  test("shrinks a single-key wrapper and keeps the key", () => {
    const rows = commitRows(100)
    const text = JSON.stringify({ results: rows })
    const densified = SessionContextDensify.densifyText(text)

    expect(densified.applied).toBe(true)
    expect(SessionContextDensify.expandDensified(densified.text)).toEqual({ results: rows })
  })

  test("factors repeated string columns and collapses consecutive repeats", () => {
    // Each row twice in a row: run-length dedup collapses the runs, and the
    // repeated SHAs/subjects are factored — the two mechanisms together.
    const rows = commitRows(200).flatMap((row) => [row, row])
    const text = JSON.stringify(rows, null, 1)
    const densified = SessionContextDensify.densifyText(text)

    expect(densified.applied).toBe(true)
    expect(densified.savedChars).toBeGreaterThan(text.length * 0.7)
    expect(SessionContextDensify.expandDensified(densified.text)).toEqual(rows)
  })

  test("keeps non-consecutive repeats in order (only runs collapse)", () => {
    // Same rows twice, but as two separate blocks: no run to collapse, so
    // only value factoring applies — the order must still round-trip exactly.
    const rows = [...commitRows(200), ...commitRows(200)]
    const text = JSON.stringify(rows, null, 1)
    const densified = SessionContextDensify.densifyText(text)

    expect(densified.applied).toBe(true)
    expect(SessionContextDensify.expandDensified(densified.text)).toEqual(rows)
  })

  test("shrinks newline-delimited JSON with the same keys", () => {
    const rows = commitRows(100)
    const text = rows.map((row) => JSON.stringify(row)).join("\n")
    const densified = SessionContextDensify.densifyText(text)

    expect(densified.applied).toBe(true)
    expect(SessionContextDensify.expandDensified(densified.text)).toEqual(rows)
  })

  test("leaves prose, code, small arrays and mixed-key arrays untouched", () => {
    const prose = "The whole application as one instruction map for an AI working in this repository. ".repeat(40)
    expect(SessionContextDensify.densifyText(prose).applied).toBe(false)
    expect(SessionContextDensify.densifyText("export const foo = 1\n".repeat(100)).applied).toBe(false)
    expect(SessionContextDensify.densifyText(JSON.stringify(commitRows(2), null, 1)).applied).toBe(false)
    const mixed = JSON.stringify([{ a: 1, b: 2 }, { a: 3 }, { a: 4, b: 5, c: 6 }]).repeat(200)
    expect(SessionContextDensify.densifyText(mixed).applied).toBe(false)
    // Booleans, numbers and null keep their exact types through the round trip.
    const typed = JSON.stringify(
      Array.from({ length: 100 }, (_, index) => ({ ok: index % 2 === 0, n: index, s: null })),
      null,
      1,
    )
    const densified = SessionContextDensify.densifyText(typed)
    expect(densified.applied).toBe(true)
    expect(SessionContextDensify.expandDensified(densified.text)).toEqual(JSON.parse(typed))
  })

  test("densifies tool results in a request and keeps every other message identical", () => {
    const rows = commitRows(200)
    const text = JSON.stringify(rows, null, 1)
    const messages = [user("go"), result("1", text), result("2", "small")]
    const { messages: densified, savedChars, densifiedParts } = SessionContextDensify.densifyMessages(messages)

    expect(densifiedParts).toBe(1)
    expect(savedChars).toBeGreaterThan(text.length * 0.5)
    expect(densified).toHaveLength(messages.length)
    expect(densified[0]).toBe(messages[0])
    expect(densified[2]).toBe(messages[2])
    // The original messages are untouched.
    expect(JSON.stringify(messages[1])).toContain("fix: change 199")
    const part = densified[1]?.content.find((item) => item.type === "tool-result")
    expect(part?.type).toBe("tool-result")
    if (part?.type !== "tool-result" || part.result.type !== "text" || typeof part.result.value !== "string") return
    expect(SessionContextDensify.expandDensified(part.result.value)).toEqual(rows)
  })

  test("never rewrites error results or provider-executed results", () => {
    const rows = commitRows(200)
    const text = JSON.stringify(rows, null, 1)
    const error = Message.make({
      id: "re",
      role: "tool",
      content: [{ type: "tool-result", id: "e", name: "read", result: { type: "error", value: text } }],
    })
    const hosted = Message.make({
      id: "rh",
      role: "tool",
      content: [{ type: "tool-result", id: "h", name: "web_search", providerExecuted: true, result: { type: "text", value: text } }],
    })
    const { messages: densified, densifiedParts } = SessionContextDensify.densifyMessages([error, hosted])
    expect(densifiedParts).toBe(0)
    expect(densified[0]).toBe(error)
    expect(densified[1]).toBe(hosted)
  })
})
