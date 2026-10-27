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
    tools: ["git_*", "hub"],
    guidance: "Prefer dedicated MCP git tools or hub recipes over hand-written shell pipelines.",
  },
  {
    intent: "Library documentation & external APIs",
    tools: ["context7"],
    guidance: "Query context7 (resolve-library-id -> query-docs) instead of assuming obsolete API signatures.",
  },
  {
    intent: "Complex reasoning & architecture design",
    tools: ["sequential-thinking", "memory"],
    guidance: "Structure hypotheses, step-by-step falsifications, and persist durable decisions in memory.",
  },
  {
    intent: "Background processes & long-running jobs",
    tools: ["desktop-commander"],
    guidance: "Use desktop-commander (start_process, read_process_output, interact_with_process, force_terminate) instead of blocking commands.",
  },
  {
    intent: "Live pages, web apps & browser flows",
    tools: ["browser", "playwright_*", "chrome-devtools_*", "puppeteer_*"],
    guidance: "Drive the page with these instead of reconstructing it from a fetch or curl: open the URL, read the accessibility tree or DOM, act, then assert on the result. A rendered page is evidence; a guessed one is not.",
  },
  {
    intent: "Current information, unfamiliar libraries & APIs",
    tools: ["research", "websearch", "webfetch", "deepwiki_*"],
    guidance: "Call research first: one call searches and reads the most relevant pages. Then read the primary source (official docs, changelog, source) before relying on the fact.",
  },
  {
    intent: "Binary analysis, decompilation, APK reversing & native library inspection",
    tools: ["rea-anything_*", "rea_*"],
    guidance:
      "Use rea-anything tools (JADX, Ghidra, Hopper, APK inspector, native disassembly) to extract exact exported symbols, function signatures, struct layouts, and decompiled code before writing integration code. Never guess native function signatures, JNI exports, or undocumented protocols.",
  },
  {
    intent: "A capability missing from this request",
    tools: ["tools", "execute", "mcp_forge"],
    guidance:
      "When the task needs a missing capability (external API, database, browser, or CLI tool), use mcp_forge (action='save') to synthesize and register the MCP server automatically on the fly, or load installed servers by name with `tools` (or find them inside `execute` with `search`).",
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
