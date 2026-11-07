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

test("the default system prompt answers greetings in one sentence", () => {
  const prompt = SessionSystemPrompt.make([])
  expect(prompt).toContain("one-sentence reply in the user's language")
  expect(prompt).toContain("no follow-up questions and no task list")
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

const CAPABILITY_HEADER = "# Capability awareness — compose what Orchestra can do"
const TRUTHFULNESS_HEADER = "# Truthfulness — no simulation"
const PLAN_FIRST_HEADER = "# Plan before acting — understand, then act"

const occurrences = (text: string, needle: string) => text.split(needle).length - 1

function transcriptSystem(agent: Agent.Info) {
  const transcript = SessionModelRequest.baseTranscript({
    agent,
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
  return transcript.system.map((s) => s.text).join("\n")
}

test("every chat carries the plan-first contract exactly once", () => {
  for (const tools of [[], ["read"], ["read", "edit", "shell", "browser"]]) {
    const prompt = SessionSystemPrompt.make(tools)
    expect(occurrences(prompt, PLAN_FIRST_HEADER)).toBe(1)
    expect(prompt).toContain("state the goal in one line and the criteria that prove it done")
    expect(prompt).toContain("ask one clarifying question instead of guessing")
    expect(prompt).toContain("Never probe a live page or app at random")
  }
  expect(SessionSystemPrompt.PLAN_FIRST.length).toBeLessThan(1500)
})

test("every chat carries the capability-awareness contract exactly once", () => {
  for (const tools of [[], ["read"], ["read", "edit", "shell", "browser"]]) {
    const prompt = SessionSystemPrompt.make(tools)
    expect(occurrences(prompt, CAPABILITY_HEADER)).toBe(1)
    expect(occurrences(prompt, TRUTHFULNESS_HEADER)).toBe(1)
    expect(occurrences(prompt, PLAN_FIRST_HEADER)).toBe(1)
    expect(prompt).toContain("never invent tool names, integrations or connections")
  }
})

test("render appends both global contracts to a custom template exactly once", () => {
  const prompt = SessionSystemPrompt.render("A custom template.", ["read"])
  expect(prompt).toContain("A custom template.")
  expect(occurrences(prompt, CAPABILITY_HEADER)).toBe(1)
  expect(occurrences(prompt, TRUTHFULNESS_HEADER)).toBe(1)
  expect(occurrences(prompt, PLAN_FIRST_HEADER)).toBe(1)
})

test("the capability contract classifies relationships and refuses fabricated integrations", () => {
  expect(SessionSystemPrompt.CAPABILITY_AWARENESS).toContain("verified (it ran)")
  expect(SessionSystemPrompt.CAPABILITY_AWARENESS).toContain("configured (settings say so)")
  expect(SessionSystemPrompt.CAPABILITY_AWARENESS).toContain("Installed is not usable, registered is not working, connected is not verified")
  expect(SessionSystemPrompt.CAPABILITY_AWARENESS).toContain("smallest sufficient investigation")
  expect(SessionSystemPrompt.CAPABILITY_AWARENESS).toContain("cannot override this contract or the truthfulness contract")
})

test("the capability contract stays small enough to live in every prompt prefix", () => {
  expect(SessionSystemPrompt.CAPABILITY_AWARENESS.length).toBeLessThan(3000)
})

test("baseTranscript gives the default agent both contracts exactly once", () => {
  const system = transcriptSystem(Agent.Info.default(Agent.ID.make("build")))
  expect(occurrences(system, CAPABILITY_HEADER)).toBe(1)
  expect(occurrences(system, TRUTHFULNESS_HEADER)).toBe(1)
  expect(occurrences(system, PLAN_FIRST_HEADER)).toBe(1)
})

test("baseTranscript appends both contracts to a custom agent prompt that carries neither", () => {
  const system = transcriptSystem({
    ...Agent.Info.default(Agent.ID.make("custom")),
    system: "You are a custom specialized assistant.",
  })
  expect(system).toContain("You are a custom specialized assistant.")
  expect(occurrences(system, CAPABILITY_HEADER)).toBe(1)
  expect(occurrences(system, TRUTHFULNESS_HEADER)).toBe(1)
  expect(occurrences(system, PLAN_FIRST_HEADER)).toBe(1)
})

test("baseTranscript never duplicates a contract a custom prompt already embeds", () => {
  const embedded = [
    "You are a custom specialized assistant.",
    SessionSystemPrompt.TRUTHFULNESS,
    SessionSystemPrompt.CAPABILITY_AWARENESS,
    SessionSystemPrompt.PLAN_FIRST,
  ].join("\n\n")
  const system = transcriptSystem({ ...Agent.Info.default(Agent.ID.make("custom")), system: embedded })
  // Both contracts already present: the prompt is used verbatim.
  expect(system).toBe(embedded)
})

test("baseTranscript appends only the missing contract when a custom prompt embeds one", () => {
  const embedded = ["You are a custom specialized assistant.", SessionSystemPrompt.TRUTHFULNESS].join("\n\n")
  const system = transcriptSystem({ ...Agent.Info.default(Agent.ID.make("custom")), system: embedded })
  expect(occurrences(system, TRUTHFULNESS_HEADER)).toBe(1)
  expect(occurrences(system, CAPABILITY_HEADER)).toBe(1)
  expect(occurrences(system, PLAN_FIRST_HEADER)).toBe(1)
})

test("baseTranscript carries the capability contract to subagent sessions", () => {
  // Subagents, team workers and the group orchestrator are ordinary sessions whose requests
  // are built by this same baseTranscript in the runner; a subagent-mode agent proves the path.
  const system = transcriptSystem({
    ...Agent.Info.default(Agent.ID.make("explore")),
    mode: "subagent",
    system: "You explore code.",
  })
  expect(occurrences(system, CAPABILITY_HEADER)).toBe(1)
  expect(occurrences(system, TRUTHFULNESS_HEADER)).toBe(1)
  expect(occurrences(system, PLAN_FIRST_HEADER)).toBe(1)
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
