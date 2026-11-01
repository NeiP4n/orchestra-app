import { expect, test } from "bun:test"
import { SessionSystemPrompt } from "@orchestra/core/session/system-prompt"

test("renders the default system prompt instructions", () => {
  const prompt = SessionSystemPrompt.make(["edit", "read", "shell"])
  expect(prompt).not.toContain("${ORCHESTRA_TOOL_GUIDANCE}")
  expect(prompt).toContain("Use the edit tool for targeted changes to existing text files")
})

test("every chat carries the truthfulness contract", () => {
  for (const tools of [[], ["read"], ["read", "edit", "shell", "browser"]]) {
    const prompt = SessionSystemPrompt.make(tools)
    expect(prompt).toContain("# Truthfulness — no simulation")
    expect(prompt).toContain("Every factual claim")
    expect(prompt).toContain("Never report a check as passing")
  }
})

test("the contract routes unresolved external facts to search and the browser", () => {
  expect(SessionSystemPrompt.TRUTHFULNESS).toContain("Gemini, ChatGPT, DeepSeek, Qwen")
  expect(SessionSystemPrompt.TRUTHFULNESS).toContain("cite the URL")
})
