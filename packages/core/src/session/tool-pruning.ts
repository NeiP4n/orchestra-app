export * as ToolPruning from "./tool-pruning.js"

import { Tool } from "../tool.js"
import { SessionMessage } from "./message.js"

// TokenEconomizer tool pruning, native in the session runner (Б4): every
// loaded tool's definition is sent with every request, so a tool the session
// never calls is pure token burn on each step. The original plugin prunes a
// tool unused over p=10 prompts across at least m=2 sessions (or s=5
// sessions); here the scope is one session, and the clock is its own
// assistant turns: a tool not called for `unusedSteps` turns stops being
// advertised. The threshold is a number in config
// (`orchestra.autoloop.toolPruneUnusedSteps`, default 10), never a prompt
// hint — the runner reads it from the same config, the kernel default
// applies when no config is in context.
//
// Only `definitions` are pruned — the schemas actually sent with every
// request. The other surfaces already economise themselves, so this pilot
// does not touch them: non-core direct tools load on demand through the
// `tools` index (`ToolRouter`), and MCP/codemode tools ride as one
// `execute` definition plus a catalog summary capped at ~600 inline tokens
// (`CodeModeCatalog.summarize`, INLINE_BUDGET). Pruning the catalog text
// itself is a follow-up, not this pilot.
//
// Reversible by construction, with no stored state: the decision is a pure
// function of the session's visible history, recomputed on every step. A
// tool comes back as soon as the latest user message or the model's own
// latest text names it, and any call in history refreshes its last-use
// turn. Pruning is fail-safe: a false positive on the mention check only
// costs tokens, while hiding a tool the session needs would break work —
// so the check is deliberately loose (substring, case-insensitive).
//
// Two caveats, both by design. After a compaction the old calls are gone
// from visible history, so a tool used only before the compaction may look
// unused and get pruned until it is mentioned again. And `execute` (the
// gateway to every MCP/codemode tool) plus the `tools` index (the way back
// to on-demand tools) are never pruned: hiding them would blind the
// session instead of saving tokens.

/** Steps a tool may go unused before it stops being advertised (TokenEconomizer p=10). */
export const TOOL_PRUNE_UNUSED_STEPS_DEFAULT = 10

/** Tools the runner never prunes: the CodeMode gateway and the on-demand index. */
export const PROTECTED_TOOL_NAMES: ReadonlySet<string> = new Set(["execute", "tools"])

/** Assistant turns in the visible history, and the last turn each tool was called on (1-based). */
const toolUse = (messages: ReadonlyArray<SessionMessage.Info>) => {
  const used = new Map<string, number>()
  let turns = 0
  for (const message of messages) {
    if (message.type !== "assistant") continue
    turns += 1
    for (const part of message.content) {
      if (part.type === "tool") used.set(part.name, turns)
    }
  }
  return { used, turns }
}

/** The latest user words plus the model's latest text, lowercased: the restore signal. */
const latestText = (messages: ReadonlyArray<SessionMessage.Info>) => {
  let user = ""
  let assistant = ""
  for (const message of messages) {
    if (message.type === "user") user = message.text
    if (message.type === "assistant")
      assistant = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
  }
  return `${user}\n${assistant}`.toLowerCase()
}

export function pruneTools(
  tools: Tool.Snapshot,
  messages: ReadonlyArray<SessionMessage.Info>,
  options: {
    readonly unusedSteps?: number
    /** Extra names that never prune, e.g. the tools the session's mode requires. */
    readonly protectedNames?: ReadonlyArray<string> | ReadonlySet<string>
    /** The running agent's id. The Orchestrator's session lives for days and its tool set is small and all needed. */
    readonly agent?: string
  } = {},
): { readonly tools: Tool.Snapshot; readonly pruned: ReadonlyArray<string> } {
  // Never prune the Orchestrator: in its long main session every tool not called in the last 10 turns (sessions,
  // mcp_manager, ...) vanished, so it was left with the few it had just used and asked for tools it could not see.
  const unusedSteps = options.agent === "orchestrator" ? 0 : Math.max(0, options.unusedSteps ?? TOOL_PRUNE_UNUSED_STEPS_DEFAULT)
  if (unusedSteps === 0) return { tools, pruned: [] }
  const { used, turns } = toolUse(messages)
  const protectedNames = new Set([...PROTECTED_TOOL_NAMES, ...(options.protectedNames ?? [])])
  const mentioned = latestText(messages)
  const pruned: Array<string> = []
  const definitions = tools.definitions.filter((definition) => {
    if (protectedNames.has(definition.name)) return true
    if (mentioned.includes(definition.name.toLowerCase())) return true
    if (turns - (used.get(definition.name) ?? 0) < unusedSteps) return true
    pruned.push(definition.name)
    return false
  })
  if (pruned.length === 0) return { tools, pruned }
  return { tools: { ...tools, definitions }, pruned }
}
