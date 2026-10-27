export * as ActionSnippets from "./snippets.js"

import { Effect, Schema } from "effect"
import { Instruction } from "@orchestra/schema/instruction"
import { Instructions } from "./index.js"

export const key = Instruction.Key.make("core/action-snippets")

export interface Snippet {
  readonly name: string
  readonly template: string
  readonly description: string
  readonly requiredTool?: string
  readonly tags?: ReadonlyArray<string>
  readonly stack?: ReadonlyArray<string>
  readonly priority?: number
}

export interface RankingContext {
  readonly availableTools?: ReadonlySet<string> | ReadonlyArray<string>
  readonly activeTools?: ReadonlySet<string> | ReadonlyArray<string>
  readonly projectStack?: ReadonlySet<string> | ReadonlyArray<string>
  readonly query?: string
  readonly limit?: number
}

export const defaultSnippets: ReadonlyArray<Snippet> = [
  {
    name: "test-target",
    template: "bun test packages/<pkg>/test/<name>.test.ts",
    description: "Run targeted test file directly without running the entire suite",
    stack: ["bun", "typescript"],
    tags: ["test", "bun", "typescript"],
  },
  {
    name: "package-typecheck",
    template: "bun run typecheck (in packages/<pkg>)",
    description: "Fast package-scoped type checking via tsgo",
    stack: ["bun", "typescript", "tsgo"],
    tags: ["typecheck", "bun", "typescript"],
  },
  {
    name: "workspace-check",
    template: "bun run check (from repository root)",
    description: "Canonical full lint and typecheck verification across monorepo",
    stack: ["bun"],
    tags: ["lint", "check", "bun"],
  },
  {
    name: "client-generate",
    template: "bun run generate (in packages/client)",
    description: "Regenerate client SDK after server/protocol HTTP API updates",
    stack: ["bun", "client", "sdk"],
    tags: ["client", "sdk", "codegen"],
  },
  {
    name: "bg-process",
    template: "tools['desktop-commander'].start_process({ command, workdir }) -> read_process_output({ session_id })",
    description: "Execute interactive or long-running command asynchronously",
    requiredTool: "desktop-commander",
    stack: ["desktop-commander", "process"],
    tags: ["process", "async", "terminal"],
  },
  {
    name: "narrow-search",
    template: "grep({ pattern, path: '<dir>', include: '*.ts', limit: 30 })",
    description: "Token-efficient code search restricted to relevant file types and matches",
    requiredTool: "grep",
    stack: ["grep", "search"],
    tags: ["search", "grep", "code"],
  },
  {
    name: "bounded-read",
    template: "read({ path: '<file>', offset: 1, limit: 60 })",
    description: "Read targeted file slice instead of spending context on massive files",
    requiredTool: "read",
    stack: ["read", "filesystem"],
    tags: ["read", "filesystem", "file"],
  },
]

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function deduplicateSnippets(snippets: ReadonlyArray<Snippet>): ReadonlyArray<Snippet> {
  const seenNames = new Set<string>()
  const seenTemplates = new Set<string>()
  const result: Snippet[] = []

  for (const snip of snippets) {
    const normalizedName = snip.name.trim().toLowerCase()
    const normalizedTemplate = snip.template.trim()
    if (seenNames.has(normalizedName) || seenTemplates.has(normalizedTemplate)) {
      continue
    }
    seenNames.add(normalizedName)
    seenTemplates.add(normalizedTemplate)
    result.push(snip)
  }

  return result
}

export function scoreSnippet(snippet: Snippet, context: RankingContext): number {
  let score = snippet.priority ?? 0

  const availableSet = context.availableTools
    ? context.availableTools instanceof Set
      ? context.availableTools
      : new Set(context.availableTools)
    : undefined

  if (snippet.requiredTool && availableSet && !availableSet.has(snippet.requiredTool)) {
    return -1
  }

  const activeSet = context.activeTools
    ? context.activeTools instanceof Set
      ? context.activeTools
      : new Set(context.activeTools)
    : undefined

  if (activeSet) {
    if (snippet.requiredTool && activeSet.has(snippet.requiredTool)) {
      score += 15
    }
    for (const tool of activeSet) {
      const lower = tool.toLowerCase()
      if (snippet.template.toLowerCase().includes(lower)) score += 5
      if (snippet.description.toLowerCase().includes(lower)) score += 3
    }
  }

  const stackList: string[] = context.projectStack
    ? Array.from(context.projectStack).map((s) => s.toLowerCase().trim()).filter(Boolean)
    : []

  if (stackList.length > 0) {
    if (snippet.stack) {
      for (const st of snippet.stack) {
        if (stackList.includes(st.toLowerCase())) {
          score += 8
        }
      }
    }
    const textToMatch = `${snippet.name} ${snippet.template} ${snippet.description} ${(snippet.tags ?? []).join(" ")}`.toLowerCase()
    for (const keyword of stackList) {
      const regex = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i")
      if (regex.test(textToMatch)) {
        score += 4
      }
    }
  }

  if (context.query) {
    const queryTokens = context.query
      .toLowerCase()
      .split(/[^a-z0-9_-]+/i)
      .filter((t) => t.length > 2)
    const textToMatch = `${snippet.name} ${snippet.template} ${snippet.description}`.toLowerCase()
    for (const token of queryTokens) {
      if (textToMatch.includes(token)) {
        score += 3
      }
    }
  }

  return score
}

export function rankSnippets(
  snippets: ReadonlyArray<Snippet>,
  context: RankingContext = {},
): ReadonlyArray<Snippet> {
  const unique = deduplicateSnippets(snippets)

  const availableSet = context.availableTools
    ? context.availableTools instanceof Set
      ? context.availableTools
      : new Set(context.availableTools)
    : undefined

  const eligible = availableSet
    ? unique.filter((s) => !s.requiredTool || availableSet.has(s.requiredTool))
    : unique

  const scored = eligible
    .map((snippet) => ({
      snippet,
      score: scoreSnippet(snippet, context),
    }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score)

  const ranked = scored.map((item) => item.snippet)

  if (typeof context.limit === "number" && context.limit > 0) {
    return ranked.slice(0, context.limit)
  }

  return ranked
}

export function filterSnippetsForTools(
  snippets: ReadonlyArray<Snippet>,
  availableTools: ReadonlySet<string> | ReadonlyArray<string>,
): ReadonlyArray<Snippet> {
  const toolsSet = availableTools instanceof Set ? availableTools : new Set(availableTools)
  return snippets.filter((s) => !s.requiredTool || toolsSet.has(s.requiredTool))
}

function isRankingContext(value: unknown): value is RankingContext {
  return (
    typeof value === "object" &&
    value !== null &&
    !("has" in value) &&
    !Array.isArray(value) &&
    ("availableTools" in value ||
      "activeTools" in value ||
      "projectStack" in value ||
      "query" in value ||
      "limit" in value)
  )
}

export function render(
  snippets: ReadonlyArray<Snippet> = defaultSnippets,
  options?: ReadonlySet<string> | ReadonlyArray<string> | RankingContext,
): string {
  let effective: ReadonlyArray<Snippet>
  if (isRankingContext(options)) {
    effective = rankSnippets(snippets, options)
  } else if (options) {
    effective = filterSnippetsForTools(snippets, options)
  } else {
    effective = deduplicateSnippets(snippets)
  }

  if (effective.length === 0) return ""
  return [
    "<action-snippets>",
    "Parametrized shortcuts for common monorepo actions:",
    ...effective.map((snip) => `- ${snip.name} [${snip.template}]: ${snip.description}`),
    "</action-snippets>",
  ].join("\n")
}

export const make = (
  snippets: ReadonlyArray<Snippet> = defaultSnippets,
  options?: ReadonlySet<string> | ReadonlyArray<string> | RankingContext,
): Instructions.List => {
  const rendered = render(snippets, options)
  if (!rendered) return Instructions.empty
  return Instructions.make({
    key,
    codec: Schema.toCodecJson(Schema.String),
    read: Effect.succeed(rendered),
    render: {
      initial: (text) => text,
      changed: (_previous, text) =>
        ["The action snippets have been updated; use the new shortcuts:", text].join("\n"),
      removed: () => "Action snippets are no longer available.",
    },
  })
}
