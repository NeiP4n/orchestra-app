export * as KnowledgeMap from "./knowledge-map.js"

import { Effect } from "effect"
import type { KV } from "./kv.js"

// The knowledge map (approach idea #24): who is strong at what — by past tasks, not by
// words. One entry per agent per scope, with a score per area that moves only on verified
// outcomes: a DoD item verified DONE adds, a FAILED verification subtracts. The
// orchestrator reads it when assigning work, so strong agents land on hard tasks and a
// claim of skill with no record behind it counts for nothing.
//
// Storage is KV, keyed `knowledge-map/<scope>/<agent>`; `scope` is a project or society
// scope string (`project:<id>`, `society:<name>`), so maps never bleed across projects.
// Scores start at 0: an agent with no record is unknown, not average.
//
// The only writer wired in so far is the `dod` tool: on `verify`, a DONE item records a
// success and a FAILED item records a failure for the verifying agent, in the item's
// stage (its group on the board) as the area (see tool/plugin/dod.ts). `record` itself is also the API for the
// orchestrator's own outcomes — a task it assigned and watched finish. There is no
// consumer in the assignment path yet: no code assigns tasks by skill today, so
// `bestFor` is the query API waiting for that consumer (follow-up, not done here).
export interface SkillScore {
  /** 0–100, evidence only: +10 per DONE, +5 more when done on the first try, −5 per FAILED. */
  readonly score: number
  readonly tasks: number
  readonly firstTry: number
  readonly updatedAt: number
}

export interface AgentMap {
  readonly agent: string
  readonly name?: string
  readonly skills: Readonly<Record<string, SkillScore>>
}

export type Outcome = "done" | "failed"

export interface RecordInput {
  readonly agent: string
  readonly name?: string
  /** The area of the task — a DoD item's stage (its group), or "general" when it has none. */
  readonly area: string
  readonly outcome: Outcome
  /** The task was done on the first try, with no earlier failure in it. */
  readonly firstTry?: boolean
}

const PREFIX = "knowledge-map/"

const DONE_POINTS = 10
const FIRST_TRY_BONUS = 5
const FAILED_POINTS = 5
const MAX_SCORE = 100

export const keyFor = (scope: string, agent: string): string => `${PREFIX}${scope}/${agent}`

const isAgentMap = (value: unknown): value is AgentMap =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Partial<AgentMap>).agent === "string" &&
  typeof (value as Partial<AgentMap>).skills === "object" &&
  (value as Partial<AgentMap>).skills !== null

const empty = (agent: string, name?: string): AgentMap => ({ agent, ...(name ? { name } : {}), skills: {} })

/** Records one verified outcome for an agent in an area, and returns the agent's updated map. */
export const record = Effect.fn("KnowledgeMap.record")(function* (kv: KV.Interface, scope: string, input: RecordInput) {
  const key = keyFor(scope, input.agent)
  // A3-07: the read and the write happen in one immediate transaction
  // (KV.atomicUpdate): two parallel `verify` outcomes for one agent used to
  // race get-then-set and lose one of them.
  const written = yield* kv.atomicUpdate(key, (stored) => {
    const current = isAgentMap(stored) ? stored : empty(input.agent, input.name)
    const area = input.area.trim() || "general"
    const previous = current.skills[area] ?? { score: 0, tasks: 0, firstTry: 0, updatedAt: 0 }
    const firstTry = input.outcome === "done" && input.firstTry === true
    const next: SkillScore = {
      score: Math.min(
        MAX_SCORE,
        Math.max(0, previous.score + (input.outcome === "done" ? DONE_POINTS + (firstTry ? FIRST_TRY_BONUS : 0) : -FAILED_POINTS)),
      ),
      tasks: previous.tasks + 1,
      firstTry: previous.firstTry + (firstTry ? 1 : 0),
      updatedAt: Date.now(),
    }
    const updated: AgentMap = {
      agent: current.agent,
      ...(input.name ?? current.name ? { name: input.name ?? current.name } : {}),
      skills: { ...current.skills, [area]: next },
    }
    return updated as unknown as KV.Value
  })
  if (written === undefined) return yield* Effect.die(new Error(`KnowledgeMap.record lost the write for ${key}`))
  return written as unknown as AgentMap
})

/** One agent's map in a scope, or undefined when the agent has no record there. */
export const get = Effect.fn("KnowledgeMap.get")(function* (kv: KV.Interface, scope: string, agent: string) {
  const stored = yield* kv.get(keyFor(scope, agent))
  return isAgentMap(stored) ? stored : undefined
})

/** Every agent with a record in a scope. Corrupt entries are skipped, never fatal. */
export const list = Effect.fn("KnowledgeMap.list")(function* (kv: KV.Interface, scope: string) {
  // A3-06: `scan` defaults to 100 entries, so one page silently dropped
  // every agent past the hundredth. Page to the end of the cursor instead.
  const found: Array<KV.Entry> = []
  let after: string | undefined
  for (;;) {
    const page = yield* kv.scan({ prefix: `${PREFIX}${scope}/`, limit: 1000, ...(after ? { after } : {}) })
    found.push(...page.entries)
    if (page.next === undefined) break
    after = page.next
  }
  return found.filter((entry) => isAgentMap(entry.value)).map((entry) => entry.value as unknown as AgentMap)
})

/** The strongest agents in an area, best first: highest score, then most tasks. Agents with no record in the area are not ranked — unknown is not weak, and not strong either. */
export const bestFor = Effect.fn("KnowledgeMap.bestFor")(function* (
  kv: KV.Interface,
  scope: string,
  area: string,
  limit: number = 3,
) {
  const agents = yield* list(kv, scope)
  return agents
    .filter((agent) => agent.skills[area] !== undefined)
    .map((agent) => ({ agent: agent.agent, name: agent.name, score: agent.skills[area] as SkillScore }))
    .sort((a, b) => b.score.score - a.score.score || b.score.tasks - a.score.tasks)
    .slice(0, Math.max(0, limit))
})
