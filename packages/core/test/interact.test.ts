import { describe, expect, test } from "bun:test"
import { Interactive } from "@orchestra/schema/interactive"
import { validateAnswer } from "../src/form"
import { renderVisualization, toFields, toModelContent, validateBlock } from "../src/tool/plugin/interact"

const decision: Interactive.Decision = {
  type: "decision",
  title: "Choose an architecture",
  options: [
    { id: "mono", label: "Monolith", pros: ["Simpler"], recommended: true },
    { id: "micro", label: "Microservices", cons: ["More infrastructure"] },
  ],
}

const approval: Interactive.Approval = {
  type: "approval",
  title: "Deploy v2",
  action: "Deploy v2 to production",
  risks: ["Downtime during rollout"],
  destructive: true,
}

describe("validateBlock", () => {
  test("accepts well-formed blocks", () => {
    expect(validateBlock(decision)).toBeUndefined()
    expect(validateBlock(approval)).toBeUndefined()
  })

  test("rejects duplicate option ids", () => {
    expect(
      validateBlock({ ...decision, options: [decision.options[0], { ...decision.options[1], id: "mono" }] }),
    ).toContain("Duplicate option id")
  })

  test("rejects non-http(s) links anywhere in the payload", () => {
    expect(
      validateBlock({
        ...decision,
        options: [{ ...decision.options[0], evidence: ["javascript:alert(1)"] }, decision.options[1]],
      }),
    ).toContain("Only http(s) links")
    expect(
      validateBlock({
        ...decision,
        options: [{ ...decision.options[0], evidence: ["https://example.com/report"] }, decision.options[1]],
      }),
    ).toBeUndefined()
    // plain words that merely contain a colon are not links
    expect(
      validateBlock({ ...decision, options: [{ ...decision.options[0], evidence: ["Report: all green"] }, decision.options[1]] }),
    ).toBeUndefined()
  })

  test("rejects oversized payloads", () => {
    const big: Interactive.Plan = {
      type: "plan",
      title: "Huge",
      phases: Array.from({ length: 12 }, (_, phase) => ({
        title: `Phase ${phase}`,
        tasks: Array.from({ length: 24 }, (_, task) => ({
          title: `Task ${task} ${"x".repeat(150)}`,
          status: "planned" as const,
        })),
      })),
    }
    expect(validateBlock(big)).toContain("too large")
  })
})

describe("toFields — blocks ride the existing form engine", () => {
  test("a decision becomes a choice field whose values are the option ids, plus a comment", () => {
    const fields = toFields(decision)
    expect(fields.map((field) => field.key)).toEqual(["choice", "comment"])
    const choice = fields[0]
    expect(choice.type).toBe("string")
    if (choice.type === "string") {
      expect(choice.options?.map((option) => option.value)).toEqual(["mono", "micro"])
      expect(choice.options?.[0].label).toContain("(Recommended)")
      expect(choice.custom).toBe(true)
    }
    // the form engine's own answer validation accepts a listed id and a custom answer
    expect(validateAnswer(fields, { choice: "mono" })).toBeUndefined()
    expect(validateAnswer(fields, { choice: "Something else entirely" })).toBeUndefined()
    expect(validateAnswer(fields, {})).toContain("Missing required")
  })

  test("an approval becomes a closed decision field: arbitrary decisions are rejected by form validation", () => {
    const fields = toFields(approval)
    expect(validateAnswer(fields, { decision: "approved" })).toBeUndefined()
    expect(validateAnswer(fields, { decision: "changes-requested", comment: "Add a rollback step" })).toBeUndefined()
    expect(validateAnswer(fields, { decision: "whatever" })).toContain("Invalid option")
  })
})

describe("toModelContent — the answer the model receives", () => {
  test("names the chosen option and carries the user's own words", () => {
    const content = toModelContent(decision, { selected: ["micro"], comment: "We expect growth" })
    expect(content).toContain('"Microservices"')
    expect(content).toContain("We expect growth")
  })

  test("approval outcomes are explicit and restate that permissions still apply", () => {
    expect(toModelContent(approval, { decision: "approved" })).toContain("approved")
    expect(toModelContent(approval, { decision: "approved" })).toContain("tool permissions still apply")
    expect(toModelContent(approval, { decision: "rejected", comment: "Too risky" })).toContain("Too risky")
  })
})

describe("renderVisualization — terminal-native fallback", () => {
  test("bar charts show every supplied value with a scaled bar", () => {
    const text = renderVisualization({
      type: "visualization",
      title: "Latency",
      chart: { kind: "bar", series: [{ name: "ms", points: [{ label: "api", value: 100 }, { label: "db", value: 50 }] }] },
    })
    expect(text).toContain("api")
    expect(text).toContain("100")
    expect(text).toContain("50")
    expect(text).toContain("█")
  })

  test("progress and metrics render their exact numbers; nothing is invented", () => {
    expect(
      renderVisualization({
        type: "visualization",
        title: "Build",
        chart: { kind: "progress", label: "Tests", value: 3, max: 4 },
      }),
    ).toContain("75% (3/4)")
    expect(
      renderVisualization({
        type: "visualization",
        title: "Usage",
        chart: { kind: "metrics", metrics: [{ label: "Tokens", value: "12k" }] },
      }),
    ).toContain("Tokens: 12k")
  })
})
