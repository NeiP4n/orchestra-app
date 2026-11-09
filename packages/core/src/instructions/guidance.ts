export * as ToolGuidance from "./guidance.js"

import { Effect, Schema } from "effect"
import { Instruction } from "@orchestra/schema/instruction"
import { Instructions } from "./index.js"

export const key = Instruction.Key.make("core/tool-guidance")

export interface GuidanceRule {
  readonly intent: string
  readonly tools: ReadonlyArray<string>
  readonly guidance: string
}

export const defaultRules: ReadonlyArray<GuidanceRule> = [
  {
    intent: "Code search & AST navigation",
    tools: ["symbols", "grep", "glob"],
    guidance: "Pinpoint definitions, signatures and usages before reading files; avoid blind full-file reads.",
  },
  {
    intent: "Git & VCS operations",
    tools: ["hub"],
    guidance: "Prefer hub recipes over hand-written shell pipelines for registry-provided git work; plain shell git covers the rest.",
  },
  {
    intent: "Cross-file code navigation & refactors",
    tools: ["serena_*"],
    guidance:
      "Serena works through a session REPL: call its initial_instructions first, activate the project, then use the lsp facade (declarations, references, implementations, rename) through serena_repl for cross-file questions instead of grep-and-read; fall back to native symbols/grep when Serena is unavailable.",
  },
  {
    intent: "Library documentation & external APIs",
    tools: ["context7"],
    guidance:
      "Query context7 (resolve-library-id -> query-docs) instead of assuming obsolete API signatures. Mandatory Freshness: never write code from memory relying on outdated knowledge cutoff; verify current documentation before implementation.",
  },
  {
    intent: "Live pages, web apps & browser flows",
    tools: ["browser"],
    guidance: "Drive the page with these instead of reconstructing it from a fetch or curl: open the URL, read the accessibility tree or DOM, act, then assert on the result. A rendered page is evidence; a guessed one is not. When the answer needs another assistant's knowledge, open its chat (Gemini, ChatGPT, DeepSeek, Qwen) in the browser, ask it there, and cite the URL you used instead of paraphrasing from memory.",
  },
  {
    intent: "Current information, unfamiliar libraries & APIs",
    tools: ["research", "websearch", "webfetch", "deepwiki_*"],
    guidance: "Call research first: one call searches and reads the most relevant pages. Then read the primary source (official docs, changelog, source) before relying on the fact. If the source needs a signed-in or interactive assistant, use the browser and ask there; never answer a current-events or version question from memory.",
  },
  {
    intent: "Binary analysis, decompilation, APK reversing & native library inspection",
    tools: ["rea-anything_*", "rea_*"],
    guidance:
      "Use rea-anything tools (JADX, Ghidra, Hopper, APK inspector, native disassembly) to extract exact exported symbols, function signatures, struct layouts, and decompiled code before writing integration code. Never guess native function signatures, JNI exports, or undocumented protocols.",
  },
  {
    intent: "A vague or underspecified request",
    tools: ["question"],
    guidance:
      "Ask for the missing decisions in one compact form: at most three short questions, each with 3-4 options, the recommended label first and passed as the default; then continue with the answers. Never answer a vague request by generating a long prompt for the user to read.",
  },
  {
    intent: "A capability missing from this request",
    tools: ["tools", "execute", "mcp_forge"],
    guidance:
      "When the task needs a missing capability (external API, database, browser, or CLI tool), use mcp_forge (action='save') to synthesize and register the MCP server automatically on the fly, or load installed servers by name with `tools` (or find them inside `execute` with `search`). Never ask the user to install, enable or verify it, and never ask them to list MCP servers or read settings for you: mcp_forge action='list', `tools` and the config files answer that, and you inspect them yourself."
  },
]

export function filterRulesForTools(
  rules: ReadonlyArray<GuidanceRule>,
  availableTools: ReadonlySet<string> | ReadonlyArray<string>,
): ReadonlyArray<GuidanceRule> {
  const toolsSet = availableTools instanceof Set ? availableTools : new Set(availableTools)
  return rules.filter((rule) =>
    rule.tools.some((pattern) => {
      if (pattern.endsWith("*")) {
        const prefix = pattern.slice(0, -1)
        for (const t of toolsSet) {
          if (t.startsWith(prefix)) return true
        }
        return false
      }
      // A bare name also covers the MCP namespace of that server (context7 matches context7_*),
      // because the installed tool names carry the server as their prefix.
      if (toolsSet.has(pattern)) return true
      for (const t of toolsSet) {
        if (t.startsWith(`${pattern}_`)) return true
      }
      return false
    }),
  )
}

export function render(
  rules: ReadonlyArray<GuidanceRule> = defaultRules,
  availableTools?: ReadonlySet<string> | ReadonlyArray<string>,
): string {
  const effective = availableTools ? filterRulesForTools(rules, availableTools) : rules
  if (effective.length === 0) return ""
  return [
    "<tool-routing>",
    "Intent-to-Tool Routing:",
    ...effective.map((rule) => `- ${rule.intent} -> ${rule.tools.join(", ")}: ${rule.guidance}`),
    "</tool-routing>",
  ].join("\n")
}

export const make = (
  rules: ReadonlyArray<GuidanceRule> = defaultRules,
  availableTools?: ReadonlySet<string> | ReadonlyArray<string>,
): Instructions.List => {
  const rendered = render(rules, availableTools)
  if (!rendered) return Instructions.empty
  return Instructions.make({
    key,
    codec: Schema.toCodecJson(Schema.String),
    read: Effect.succeed(rendered),
    render: {
      initial: (text) => text,
      changed: (_previous, text) =>
        ["The tool routing guidance has been updated; follow the new routes:", text].join("\n"),
      removed: () => "Tool routing guidance is no longer active.",
    },
  })
}
