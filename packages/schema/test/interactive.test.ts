import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Interactive } from "../src/interactive.js"

const decode = Schema.decodeUnknownSync(Interactive.Block)

describe("Interactive.Block", () => {
  test("accepts a valid decision, comparison, approval, plan and visualization", () => {
    expect(
      decode({
        type: "decision",
        title: "Choose an architecture",
        options: [
          { id: "mono", label: "Monolith", pros: ["Simpler"], recommended: true },
          { id: "micro", label: "Microservices", cons: ["More infrastructure"] },
        ],
      }).type,
    ).toBe("decision")
    expect(
      decode({
        type: "comparison",
        title: "Pick a database",
        items: [
          { id: "pg", name: "Postgres", rating: 5 },
          { id: "my", name: "MySQL", strengths: ["Familiar"] },
        ],
      }).type,
    ).toBe("comparison")
    expect(decode({ type: "approval", title: "Deploy", action: "Deploy v2 to production" }).type).toBe("approval")
    expect(
      decode({ type: "plan", title: "Roadmap", phases: [{ title: "Phase 1", tasks: [{ title: "Setup", status: "planned" }] }] }).type,
    ).toBe("plan")
    expect(
      decode({
        type: "visualization",
        title: "Latency",
        chart: { kind: "bar", series: [{ name: "ms", points: [{ label: "api", value: 42 }] }] },
      }).type,
    ).toBe("visualization")
  })

  test("rejects malformed payloads", () => {
    // unknown block type
    expect(() => decode({ type: "html", title: "x", html: "<script>alert(1)</script>" })).toThrow()
    // an executable payload smuggled as an extra field never survives decoding:
    // the decoder keeps only the declared fields, so nothing executable can
    // reach storage or a renderer
    const stripped = decode({ type: "approval", title: "x", action: "run", script: "rm -rf /" }) as unknown as Record<string, unknown>
    expect(stripped.script).toBeUndefined()
    expect(Object.keys(stripped).toSorted()).toEqual(["action", "title", "type"])
    // a decision needs at least two options
    expect(() => decode({ type: "decision", title: "x", options: [{ id: "a", label: "A" }] })).toThrow()
    // more than eight options are refused
    expect(() =>
      decode({
        type: "decision",
        title: "x",
        options: Array.from({ length: 9 }, (_, index) => ({ id: `o${index}`, label: `O${index}` })),
      }),
    ).toThrow()
    // rating is bounded to 0..5
    expect(() =>
      decode({
        type: "comparison",
        title: "x",
        items: [
          { id: "a", name: "A", rating: 9 },
          { id: "b", name: "B" },
        ],
      }),
    ).toThrow()
    // oversized strings are refused
    expect(() =>
      decode({
        type: "decision",
        title: "x".repeat(161),
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      }),
    ).toThrow()
    // plan task statuses are a closed set
    expect(() =>
      decode({ type: "plan", title: "x", phases: [{ title: "P", tasks: [{ title: "T", status: "done-ish" }] }] }),
    ).toThrow()
  })
})
