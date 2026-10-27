import { describe, expect, test } from "bun:test"
import { BudgetGuard, enforceBudget, estimatePromptTokens } from "../src/instructions/budget"

describe("BudgetGuard Token Estimator & Budget Enforcer", () => {
  test("accurately estimates prompt tokens for ASCII, Cyrillic, and code syntax", () => {
    // Empty text
    expect(estimatePromptTokens("")).toBe(0)

    // ASCII text
    const asciiText = "Hello world from Orchestra AI platform"
    const asciiTokens = estimatePromptTokens(asciiText)
    expect(asciiTokens).toBeGreaterThan(5)
    expect(asciiTokens).toBeLessThan(15)

    // Cyrillic text has higher token density
    const cyrillicText = "Привет мир от платформы оркестровки"
    const cyrillicTokens = estimatePromptTokens(cyrillicText)
    expect(cyrillicTokens).toBeGreaterThan(10)

    // Code syntax with symbols
    const codeSnippet = "const map: Map<string, Array<number>> = new Map(); if (x >= 10 && y <= 20) { fn(); }"
    const codeTokens = estimatePromptTokens(codeSnippet)
    expect(codeTokens).toBeGreaterThan(20)
  })

  test("returns original text unmodified when within budget", () => {
    const text = "<instructions>\nKeep all code modular and clean.\n</instructions>"
    const tokens = estimatePromptTokens(text)
    const result = enforceBudget(text, tokens + 50)

    expect(result.truncated).toBe(false)
    expect(result.text).toBe(text)
    expect(result.estimatedTokens).toBe(tokens)
  })

  test("truncates instructions exceeding maxTokens and appends marker", () => {
    const longInstructions = Array.from(
      { length: 50 },
      (_, i) => `Instruction line ${i}: Always follow architecture patterns and run tests.`,
    ).join("\n")

    const limit = 40
    const result = enforceBudget(longInstructions, limit)

    expect(result.truncated).toBe(true)
    expect(result.estimatedTokens).toBeLessThanOrEqual(limit)
    expect(result.text).toContain("<!-- [Truncated: context budget limit reached] -->")
  })

  test("preserves XML tag structure and balances unclosed tags upon truncation", () => {
    const xmlPrompt = [
      "<instructions>",
      "  <guidelines>",
      "    <rule>Rule 1: Always check boundaries.</rule>",
      "    <rule>Rule 2: Never leak credentials or secrets.</rule>",
      "    <rule>Rule 3: Ensure test coverage across packages.</rule>",
      "    <rule>Rule 4: Handle all errors gracefully.</rule>",
      "  </guidelines>",
      "  <context>",
      "    Detailed context information that exceeds the allocated context budget limit...",
      "  </context>",
      "</instructions>",
    ].join("\n")

    // Force truncation within the <guidelines> or <context> block
    const maxTokens = 25
    const result = enforceBudget(xmlPrompt, maxTokens)

    expect(result.truncated).toBe(true)
    expect(result.estimatedTokens).toBeLessThanOrEqual(maxTokens)

    // Check tag balance in truncated text
    const text = result.text
    if (text.includes("<instructions>")) {
      expect(text).toContain("</instructions>")
    }
    if (text.includes("<guidelines>")) {
      expect(text).toContain("</guidelines>")
    }
  })

  test("closes unclosed Markdown code fence blocks upon truncation", () => {
    const markdownPrompt = [
      "Here is the sample code block:",
      "```typescript",
      "export function doWork() {",
      "  const a = 1;",
      "  const b = 2;",
      "  return a + b;",
      "}",
      "```",
      "And another long code section:",
      "```typescript",
      "export function longRun() {",
      "  // Many lines of complex code",
      "  console.log('line 1');",
      "  console.log('line 2');",
      "  console.log('line 3');",
    ].join("\n")

    const maxTokens = 30
    const result = enforceBudget(markdownPrompt, maxTokens)

    expect(result.truncated).toBe(true)
    expect(result.estimatedTokens).toBeLessThanOrEqual(maxTokens)

    // Code block must be closed properly (even number of ``` fences)
    const fences = (result.text.match(/```/g) || []).length
    expect(fences % 2).toBe(0)
  })

  test("BudgetGuard namespace exports match expected api", () => {
    expect(BudgetGuard.estimatePromptTokens).toBeDefined()
    expect(BudgetGuard.enforceBudget).toBeDefined()
  })
})
