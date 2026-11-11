import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { ToolGuidance } from "@orchestra/core/instructions/guidance"
import { ActionSnippets } from "@orchestra/core/instructions/snippets"
import { Instructions } from "@orchestra/core/instructions/index"
import { readInitial } from "./lib/instructions"

describe("ToolGuidance instructions", () => {
  test("renders default intent-to-tool routing rules", () => {
    const text = ToolGuidance.render()
    expect(text).toContain("<tool-routing>")
    expect(text).toContain("Intent-to-Tool Routing:")
    expect(text).toContain("Code search & AST navigation -> symbols, grep, glob")
    expect(text).toContain("Git & VCS operations -> hub")
    expect(text).not.toContain("serena_*")
    expect(text).toContain("Current information, unfamiliar libraries & APIs -> research, websearch, webfetch")
    expect(text).not.toContain("context7")
    expect(text).toContain("</tool-routing>")
  })

  test("asks a vague request as one compact form instead of a long generated prompt", () => {
    const text = ToolGuidance.render()
    expect(text).toContain("A vague or underspecified request -> question")
    expect(text).toContain("at most three short questions")
    expect(text).toContain("Never answer a vague request by generating a long prompt")
  })

  test("routes unanswered external facts to search and the browser, including asking a web AI", () => {
    const text = ToolGuidance.render()
    expect(text).toContain("Gemini, ChatGPT, DeepSeek, Qwen")
    expect(text).toContain("cite the URL you used")
    expect(text).toContain("use the browser and ask there")
  })

  test("a missing capability is installed and inspected without handing work to the user", () => {
    const text = ToolGuidance.render()
    expect(text).toContain("Never ask the user to install, enable or verify it")
    expect(text).toContain("mcp_forge action='list'")
  })

  test("renders custom routing rules when provided", () => {
    const text = ToolGuidance.render([
      {
        intent: "Custom Task",
        tools: ["custom_tool"],
        guidance: "Execute specialized routine.",
      },
    ])
    expect(text).toContain("- Custom Task -> custom_tool: Execute specialized routine.")
  })

  test("loads as valid Instructions.List source and renders initial text", async () => {
    const source = ToolGuidance.make()
    const result = await Effect.runPromise(readInitial(source))
    expect(result.text).toContain("<tool-routing>")
    expect(result.text).toContain("Intent-to-Tool Routing:")
    expect(result.text).toContain("symbols, grep, glob")
  })

  test("renders update text when guidance changes", async () => {
    const source = ToolGuidance.make()
    const previous = { [ToolGuidance.key]: "old guidance" }
    const delta = { [ToolGuidance.key]: Option.some("new guidance") }
    const updated = Instructions.renderUpdate(source, previous, delta)
    expect(updated).toContain("The tool routing guidance has been updated; follow the new routes:")
    expect(updated).toContain("new guidance")
  })
})

describe("ToolGuidance availability filtering", () => {
  test("advertises only routes whose tools are actually available", () => {
    const text = ToolGuidance.render(ToolGuidance.defaultRules, ["grep", "read"])
    expect(text).toContain("Code search & AST navigation")
    expect(text).not.toContain("Current information, unfamiliar libraries & APIs")
    expect(text).not.toContain("Live pages, web apps & browser flows")
    expect(text).not.toContain("Binary analysis")
  })

  test("prefix patterns match installed MCP tool names", () => {
    const text = ToolGuidance.render([{ intent: "Live pages, web apps & browser flows", tools: ["fixture_*"], guidance: "Fixture prefix matching only." }], ["fixture_navigate"])
    expect(text).toContain("Live pages, web apps & browser flows")
    expect(text).not.toContain("Code search & AST navigation")
  })

  test("no available tools renders no guidance at all", () => {
    expect(ToolGuidance.render(ToolGuidance.defaultRules, [])).toBe("")
    expect(ToolGuidance.render(ToolGuidance.defaultRules, ["no_such_tool"])).toBe("")
  })
})

describe("ActionSnippets instructions", () => {
  test("renders default monorepo parameterized snippets", () => {
    const text = ActionSnippets.render()
    expect(text).toContain("<action-snippets>")
    expect(text).toContain("Parametrized shortcuts for common monorepo actions:")
    expect(text).toContain("test-target [bun test packages/<pkg>/test/<name>.test.ts]")
    expect(text).toContain("package-typecheck [bun run typecheck (in packages/<pkg>)]")
    expect(text).toContain("workspace-check [bun run check (from repository root)]")
    expect(text).toContain("client-generate [bun run generate (in packages/client)]")
    expect(text).toContain("bg-process [shell({ command, workdir, background: true }) -> output streams to the file named in the result; completion arrives as a notification]")
    expect(text).toContain("narrow-search [grep({ pattern, path: '<dir>', include: '*.ts', limit: 30 })]")
    expect(text).toContain("bounded-read [read({ path: '<file>', offset: 1, limit: 60 })]")
    expect(text).toContain("</action-snippets>")
  })

  test("renders custom action snippets when provided", () => {
    const text = ActionSnippets.render([
      {
        name: "custom-action",
        template: "custom action template",
        description: "Custom action description",
      },
    ])
    expect(text).toContain("- custom-action [custom action template]: Custom action description")
  })

  test("loads as valid Instructions.List source and renders initial text", async () => {
    const source = ActionSnippets.make()
    const result = await Effect.runPromise(readInitial(source))
    expect(result.text).toContain("<action-snippets>")
    expect(result.text).toContain("Parametrized shortcuts for common monorepo actions:")
    expect(result.text).toContain("package-typecheck")
  })

  test("renders update text when snippets change", async () => {
    const source = ActionSnippets.make()
    const previous = { [ActionSnippets.key]: "old snippets" }
    const delta = { [ActionSnippets.key]: Option.some("new snippets") }
    const updated = Instructions.renderUpdate(source, previous, delta)
    expect(updated).toContain("The action snippets have been updated; use the new shortcuts:")
    expect(updated).toContain("new snippets")
  })
})
