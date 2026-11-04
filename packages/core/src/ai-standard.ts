export * as AiStandard from "./ai-standard.js"

import { Agent } from "@orchestra/schema/agent"
import { Model } from "./model.js"

// THE SINGLE AI STANDARD
// ======================
// This module is the one place that decides how AI runs in Orchestra when the
// operator does not say otherwise. The operator's whole job is to state the
// task (and keep a shortlist of favorite models in the picker's Feature
// section). Everything else — which agent runs, which model it runs, which
// variant, what MCP/tools and rules apply, and what budget the run gets — is
// decided here or by the module this standard points at, never by asking the
// operator to configure agents, MCP servers, rules, or budgets by hand.
//
// The standard, in order:
//
// 1. An explicit choice made for one task wins over everything below. It is a
//    per-task override, not a setting: nothing here persists it.
// 2. The operator's favorites come next. The agent and model for a run are
//    picked FROM the favorites (see `pickAgent` and `decideModel`); the
//    favorites are ranked for the work at hand — depth work (planning,
//    review, architecture, debugging) takes the highest-effort variant of the
//    priciest reasoning first, speed work takes the cheapest adequate model
//    first (see `rankFavorites`).
// 3. A favorite that is known to be unavailable (its provider refused it, or
//    a caller reports it in `unavailable`) is skipped, never retried blindly.
//    When EVERY favorite is unavailable the run falls back to the role's own
//    model, then to the worker policy, then to inheriting the caller's model
//    — in that order — so a task still runs instead of failing on preference.
// 4. A role's own model and the `orchestra.worker` policy remain as the
//    fallback chain under the favorites, because they are how teams encode
//    craft knowledge; they never outrank the operator's favorites.
// 5. MCP servers and tools are NOT the operator's job: a role's tool list is
//    derived from its work (the role profiles own that mapping), and the
//    permission ruleset for a role is built by `Orchestra.toolRules`. This
//    standard only fixes the principle: no run may require the operator to
//    pick MCP servers or approve a tool list before a task can start.
// 6. Rules are standing knowledge, not configuration: the rulebook
//    (`Rules`) is written by the crew as it learns and applies to every
//    session automatically. The operator may read and edit it, but no run
//    waits on rule setup.
// 7. Budget is a step ceiling, and it is not a spending cap. The standard
//    supplies the default ceiling by effort class (`budgetFor`): the runner
//    applies it through `stepCeilings` whenever the agent itself configures
//    no steps, and never above a ceiling the agent or the mode configures.
//    Whether ceilings bite at all is a deployment switch (`Limits`:
//    ORCHESTRA_ENFORCE_LIMITS) — with enforcement off, no ceiling applies,
//    including this one. Nothing here limits money: a step can cost cents
//    or dollars, and no token or currency budget exists in the system.
//    Cost pressure comes from ranking (speed work prefers cheaper models),
//    not from a guaranteed cap. The operator still fills no budget form.
// 8. When nothing at all is configured — no favorites, no role model, no
//    policy — the run inherits the caller's model and the default agent
//    (`build`, else the first selectable primary agent). Zero configuration
//    must always be a working state.
//
// Changing the standard means changing this file; callers (`Orchestra.
// workerModels`, federation, the forges) consume it and must not re-encode
// their own copy of the priority chain.

/** Whether the work rewards thinking time (depth) or turnaround (speed). */
export type Effort = "depth" | "speed"

// Planning, review and architecture work needs depth; build, test and quick fixes need speed.
// The role's category and name say which side of that line it sits on.
export const effortFor = (hint: string | undefined): Effort =>
  hint !== undefined && /plan|architect|review|strateg|analys|audit|design|debug|admin/i.test(hint) ? "depth" : "speed"

/** The stable identity of a model choice, ignoring which variant runs. */
export const keyOf = (model: Model.Ref) => `${model.providerID}/${model.id}`

// Highest effort first for depth, cheapest effort first for speed.
const DepthVariants = ["max", "high", "medium", "low", "fast", "minimal"] as const
const SpeedVariants = ["fast", "minimal", "low", "medium", "high", "max"] as const

const infoOf = (model: Model.Ref, catalog: ReadonlyArray<Model.Info> | undefined) =>
  catalog?.find((item) => item.providerID === model.providerID && item.id === model.id)

// A model that offers reasoning variants must run one, so the pick resolves a variant whenever
// the catalog knows the model. A pinned variant always wins over the ranking.
function withVariant(model: Model.Ref, order: ReadonlyArray<string>, catalog: ReadonlyArray<Model.Info> | undefined) {
  if (model.variant !== undefined) return model
  const variant = order.find((id) => infoOf(model, catalog)?.variants.some((item) => item.id === id))
  return variant === undefined ? model : Model.Ref.make({ ...model, variant: Model.VariantID.make(variant) })
}

// How much effort the model's chosen variant stands for: lower is more thinking, and a model
// without variants ranks after every model that has them.
function effortOf(model: Model.Ref, order: ReadonlyArray<string>, catalog: ReadonlyArray<Model.Info> | undefined) {
  const variants = infoOf(model, catalog)?.variants ?? []
  const variant = model.variant ?? order.find((candidate) => variants.some((item) => item.id === candidate))
  const index = variant === undefined ? -1 : order.indexOf(variant)
  return index === -1 ? order.length : index
}

// The first price tier is what a call is billed at before any long-context surcharge. An
// unpriced model ranks after every priced one but keeps its own place among the others.
function priceOf(model: Model.Ref, catalog: ReadonlyArray<Model.Info> | undefined) {
  const tier = infoOf(model, catalog)?.cost[0]
  return tier === undefined ? Number.MAX_SAFE_INTEGER : tier.input + tier.output
}

/**
 * The operator's favorites, ranked for the work at hand and with a reasoning
 * variant resolved for each. Depth work puts the highest-effort model first;
 * speed work puts the cheapest model first. The input order is preserved
 * among models the ranking cannot tell apart.
 */
export function rankFavorites(
  favorites: ReadonlyArray<Model.Ref>,
  effort: Effort,
  catalog: ReadonlyArray<Model.Info> | undefined,
) {
  const order = effort === "depth" ? DepthVariants : SpeedVariants
  return favorites
    .map((model) => withVariant(model, order, catalog))
    .sort((left, right) =>
      effort === "depth" ? effortOf(left, order, catalog) - effortOf(right, order, catalog) : priceOf(left, catalog) - priceOf(right, catalog),
    )
}

export type ModelSource = "task" | "favorite" | "role" | "policy" | "none"

export interface ModelDecision {
  /** The model the run starts on; undefined means "inherit the caller's model". */
  readonly model?: Model.Ref
  /** Models the run may continue on when the starting one is refused, best first. */
  readonly fallbacks: ReadonlyArray<Model.Ref>
  /** Which step of the standard's priority chain produced `model`. */
  readonly source: ModelSource
  /** Favorites skipped because they were reported unavailable, in ranked order. */
  readonly skipped: ReadonlyArray<Model.Ref>
}

const sameModel = (a: Model.Ref, b: Model.Ref) => keyOf(a) === keyOf(b) && (a.variant ?? "") === (b.variant ?? "")

/**
 * The standard's model decision for one run. Priority: the task's explicit
 * model, then the ranked favorites, then the role's model, then the policy
 * chain (category policy before the general one — the caller passes them in
 * that order). Every other candidate becomes a fallback, deduplicated and
 * without repeating the starting model. Candidates reported `unavailable`
 * are dropped from the start position and from the fallbacks alike: a model
 * the provider just refused must not be the plan B either.
 */
export function decideModel(input: {
  readonly explicit?: Model.Ref
  readonly favorites?: ReadonlyArray<Model.Ref>
  readonly roleModel?: Model.Ref
  readonly policy?: ReadonlyArray<Model.Ref>
  readonly effort: Effort
  readonly catalog?: ReadonlyArray<Model.Info>
  readonly unavailable?: ReadonlyArray<Model.Ref>
}): ModelDecision {
  const unavailable = new Set((input.unavailable ?? []).map(keyOf))
  const down = (model: Model.Ref) => unavailable.has(keyOf(model))
  const ranked = rankFavorites(input.favorites ?? [], input.effort, input.catalog)
  const skipped = ranked.filter(down)
  const chain: ReadonlyArray<{ model: Model.Ref; source: ModelSource }> = [
    ...(input.explicit && !down(input.explicit) ? [{ model: input.explicit, source: "task" as const }] : []),
    ...ranked.filter((model) => !down(model)).map((model) => ({ model, source: "favorite" as const })),
    ...(input.roleModel && !down(input.roleModel) ? [{ model: input.roleModel, source: "role" as const }] : []),
    ...(input.policy ?? []).filter((model) => !down(model)).map((model) => ({ model, source: "policy" as const })),
  ]
  const [first, ...rest] = chain
  if (!first) return { fallbacks: [], source: "none", skipped }
  const fallbacks: Model.Ref[] = []
  for (const candidate of rest) {
    if (sameModel(candidate.model, first.model)) continue
    if (fallbacks.some((model) => sameModel(model, candidate.model))) continue
    fallbacks.push(candidate.model)
  }
  return { model: first.model, fallbacks, source: first.source, skipped }
}

export type AgentSource = "favorite" | "default" | "build" | "first" | "none"

export interface AgentDecision {
  readonly agent?: Agent.Info
  /** Which step of the standard's fallback chain produced `agent`. */
  readonly source: AgentSource
}

// Mirrors the Agent service's own rule for what an operator may run directly.
const selectable = (agent: Agent.Info) => (agent.mode !== "subagent" && !agent.hidden ? agent : undefined)

/**
 * The standard's agent decision: the agent is picked FROM the favorites —
 * the selectable primary agent whose own model is the highest-ranked
 * favorite wins. When no agent runs a favorite model, the configured
 * default agent wins, then `build`, then the first selectable agent. The
 * operator never picks an agent per task; maintaining the favorites is the
 * only input.
 */
export function pickAgent(input: {
  readonly agents: ReadonlyArray<Agent.Info>
  readonly favorites?: ReadonlyArray<Model.Ref>
  readonly defaultID?: Agent.ID
}): AgentDecision {
  const agents = input.agents.flatMap((agent) => {
    const found = selectable(agent)
    return found ? [found] : []
  })
  const favoriteKeys = (input.favorites ?? []).map(keyOf)
  const byFavorite = agents
    .filter((agent) => agent.model !== undefined && favoriteKeys.includes(keyOf(agent.model)))
    .toSorted(
      (a, b) => favoriteKeys.indexOf(keyOf(a.model as Model.Ref)) - favoriteKeys.indexOf(keyOf(b.model as Model.Ref)),
    )
  if (byFavorite[0]) return { agent: byFavorite[0], source: "favorite" }
  const configured = input.defaultID ? agents.find((agent) => agent.id === input.defaultID) : undefined
  if (configured) return { agent: configured, source: "default" }
  const build = agents.find((agent) => agent.id === "build")
  if (build) return { agent: build, source: "build" }
  if (agents[0]) return { agent: agents[0], source: "first" }
  return { source: "none" }
}

export interface Budget {
  /** Agent steps a run of this effort class may take before the ceiling applies. */
  readonly steps: number
  readonly source: "standard"
}

// The standard's step budget: depth work gets room to think, speed work is
// kept short. These are ceilings for `Limits.steps`, not operator-facing
// settings — `Limits` decides whether enforcement is on for a deployment,
// and a step ceiling is never a cap on spend (see point 7 above).
const BudgetByEffort: Record<Effort, number> = { depth: 120, speed: 40 }

export const budgetFor = (effort: Effort): Budget => ({ steps: BudgetByEffort[effort], source: "standard" })

/**
 * The step ceilings a run is judged against, in the runner's existing terms
 * (the smallest defined ceiling wins, through `Limits.steps`): the agent's
 * own configured steps, the mode's ceiling, and — only when the agent
 * configures no steps of its own — the standard's budget for the work's
 * effort class. An explicit agent ceiling is configuration, so the standard
 * never lowers it; the standard only fills the gap where nobody set one.
 */
export function stepCeilings(input: {
  readonly agentSteps?: number
  readonly modeSteps?: number
  readonly effort: Effort
}): ReadonlyArray<number | undefined> {
  return [
    input.agentSteps,
    input.modeSteps,
    input.agentSteps === undefined ? budgetFor(input.effort).steps : undefined,
  ]
}
