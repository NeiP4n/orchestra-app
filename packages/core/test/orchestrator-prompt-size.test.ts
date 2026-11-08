import { describe, expect, test } from "bun:test"
import {
  ORCHESTRATOR_MANDATES,
  ORCHESTRATOR_SLIM_MODES,
  PROMPT_ORCHESTRATOR,
  PROMPT_ORCHESTRATOR_FULL,
  orchestratorMandatesFor,
} from "@orchestra/core/plugin/agent"
import { TEAM } from "@orchestra/core/plugin/team"

const words = (text: string) => text.split(/\s+/).filter(Boolean).length
const bullets = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 60)

// The base prompt was about 3,650 words before the specialist mandates moved out.
const BASE_WORD_LIMIT = 3300

const mandateHeadings = [
  "Binary Analysis & Reverse-Engineering Mandate",
  "Dynamic MCP & Tool Acquisition",
  "UI/UX Excellence & Visual Feedback Loop",
  "Adversarial Testing & Mutation Verification Mandate",
  "Continuous Link & Dependency Integrity Protocol",
  "Durable Architectural Memory (ADR)",
]

describe("orchestrator prompt size", () => {
  test("the base prompt stays under its word budget", () => {
    expect(words(PROMPT_ORCHESTRATOR)).toBeLessThanOrEqual(BASE_WORD_LIMIT)
  })

  test("each specialist mandate lives in exactly one place", () => {
    for (const heading of mandateHeadings) {
      expect(PROMPT_ORCHESTRATOR).not.toContain(heading)
      expect(ORCHESTRATOR_MANDATES).toContain(heading)
      expect(PROMPT_ORCHESTRATOR_FULL).toContain(heading)
    }
  })

  test("the full prompt is the base plus the mandates, and keeps the safety and stop rules", () => {
    expect(PROMPT_ORCHESTRATOR_FULL.startsWith("You are the Orchestrator")).toBe(true)
    expect(PROMPT_ORCHESTRATOR_FULL).toBe(`${PROMPT_ORCHESTRATOR}\n\n${ORCHESTRATOR_MANDATES}`)
    for (const text of [
      "Autonomous Dynamic Workflow",
      "Dynamic team sizing",
      "Research-First Mandate",
      "CRITICAL DOD VERIFICATION INVARIANT",
      "STRICT BAN ON SIMULATION FALLBACKS",
      "STRICT BAN ON FRAUDULENT TESTS",
      "Stop rules",
      "Never end a turn with only a promise",
    ])
      expect(PROMPT_ORCHESTRATOR).toContain(text)
  })

  test("only the light modes drop the mandates; every other mode gets the full set", () => {
    expect([...ORCHESTRATOR_SLIM_MODES]).toEqual(["fast", "research"])
    for (const id of ["fast", "research"]) expect(orchestratorMandatesFor(id)).toBeUndefined()
    for (const id of [undefined, "auto", "coding", "planning", "test", "architecture", "review", "debug", "design", "ops"])
      expect(orchestratorMandatesFor(id)).toBe(ORCHESTRATOR_MANDATES)
  })

  test("the briefing rule no longer contradicts the orientation limit", () => {
    expect(PROMPT_ORCHESTRATOR).toContain("Do not read extra files only to add line numbers")
    expect(PROMPT_ORCHESTRATOR).not.toContain("provide exact file paths, symbol outlines, and line numbers")
  })

  test("no rule line is repeated verbatim between the orchestrator prompts and the worker prompt", () => {
    const worker = new Set(bullets(TEAM))
    const repeated = bullets(PROMPT_ORCHESTRATOR_FULL).filter((line) => worker.has(line))
    expect(repeated).toEqual([])
  })
})
