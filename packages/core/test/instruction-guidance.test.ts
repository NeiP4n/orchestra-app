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
    expect(text).toContain("Git & VCS operations -> git_*, hub")
    expect(text).toContain("Library documentation & external APIs -> context7")
    expect(text).toContain("Complex reasoning & architecture design -> sequential-thinking, memory")
    expect(text).toContain("Background processes & long-running jobs -> desktop-commander")
    expect(text).toContain("</tool-routing>")
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

describe("ActionSnippets instructions", () => {
  test("renders default monorepo parameterized snippets", () => {
    const text = ActionSnippets.render()
    expect(text).toContain("<action-snippets>")
    expect(text).toContain("Parametrized shortcuts for common monorepo actions:")
    expect(text).toContain("test-target [bun test packages/<pkg>/test/<name>.test.ts]")
    expect(text).toContain("package-typecheck [bun run typecheck (in packages/<pkg>)]")
    expect(text).toContain("workspace-check [bun run check (from repository root)]")
    expect(text).toContain("client-generate [bun run generate (in packages/client)]")
    expect(text).toContain("bg-process [tools['desktop-commander'].start_process({ command, workdir }) -> read_process_output({ session_id })]")
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
