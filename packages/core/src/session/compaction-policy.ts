export * as CompactionPolicy from "./compaction-policy.js"

/**
 * Where automatic compaction starts for a chat: a share of the model's window, capped in tokens so a
 * very large window cannot let one chat grow past what is useful to carry. Written as session metadata
 * (`SessionPlan.CONTEXT_KEY`), so the operator can still change it per chat.
 */
export type Threshold = {
  readonly type: "tokens"
  readonly tokens: number
}

/** Analysis, architecture and review reason over the whole project, so they compact last. */
export const deepThreshold: Threshold = { type: "tokens", tokens: 900_000 }

/** Everyday implementation work sits in the middle. */
export const standardThreshold: Threshold = { type: "tokens", tokens: 500_000 }

/** Testing and debugging read logs and dumps, which burn context fast, so they compact early. */
export const leanThreshold: Threshold = { type: "tokens", tokens: 300_000 }

// Roles whose work is mostly reasoning over the whole project. "analyst" is the short name operators
// use for `product-analyst`.
const deep = new Set([
  "analyst",
  "product-analyst",
  "architect",
  "strategic-planner",
  "researcher",
  "deep-researcher",
  "designer",
  "reviewer",
  "counterexample-engineer",
  "security-auditor",
  "compatibility-engineer",
])

// Roles that mostly read test output, stack traces and profiles.
const lean = new Set(["tester", "debugger", "performance-engineer"])

/** The threshold of the project's own Orchestrator chat, which coordinates the whole team. */
export const mainThreshold: Threshold = deepThreshold

/**
 * The automatic compaction threshold of a team role or a member that runs it. Everything the table does
 * not name — including roles added to the roster later — keeps the standard middle instead of guessing.
 */
export function roleThreshold(role: { readonly id?: string; readonly agent?: string } | undefined): Threshold {
  const id = roleId(role)
  if (id !== undefined && deep.has(id)) return deepThreshold
  if (id !== undefined && lean.has(id)) return leanThreshold
  return standardThreshold
}

// Roles and members both carry their roster id as the agent they run on (`team-<role id>`); a bare
// `{ id }` is accepted for callers that only have the roster entry.
const ROLE_PREFIX = "team-"

function roleId(role: { readonly id?: string; readonly agent?: string } | undefined) {
  const agent = role?.agent
  if (agent !== undefined && agent.startsWith(ROLE_PREFIX)) return agent.slice(ROLE_PREFIX.length)
  return role?.id
}
