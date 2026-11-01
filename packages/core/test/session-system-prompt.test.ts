import { expect, test } from "bun:test"
import { SessionSystemPrompt } from "@orchestra/core/session/system-prompt"
import { SessionModelRequest } from "@orchestra/core/session/model-request"
import { Agent } from "@orchestra/core/agent"
import { Model } from "@orchestra/core/model"
import { Provider } from "@orchestra/core/provider"

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

test("truthfulness contract includes mandatory freshness and 2026 cutoff", () => {
  expect(SessionSystemPrompt.TRUTHFULNESS).toContain("The current year is 2026")
  expect(SessionSystemPrompt.TRUTHFULNESS).toContain("Mandatory Freshness & Knowledge Retrieval Mandate")
})

test("baseTranscript includes truthfulness contract even when agent.system is custom", () => {
  const customAgent: Agent.Info = {
    ...Agent.Info.default(Agent.ID.make("custom")),
    system: "You are a custom specialized assistant.",
  }
  const transcript = SessionModelRequest.baseTranscript({
    agent: customAgent,
    model: {
      ref: { providerID: Provider.ID.make("mock"), id: Model.ID.make("mock") },
      model: {
        provider: "mock",
        id: "mock",
        name: "mock",
        context: 1000,
        output: 1000,
        route: { provider: "mock" },
      },
    } as any,
    tools: { definitions: [], executors: new Map() } as any,
    initial: "",
    messages: [],
  })
  const systemText = transcript.system.map((s) => s.text).join("\n")
  expect(systemText).toContain("You are a custom specialized assistant.")
  expect(systemText).toContain("# Truthfulness — no simulation")
  expect(systemText).toContain("Mandatory Freshness & Knowledge Retrieval Mandate")
})
