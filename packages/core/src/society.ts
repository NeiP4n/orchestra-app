export * as Society from "./society.js"

import { Schema } from "effect"
import { Model } from "./model.js"

// Б10: the Society's numbers, model table and generation state, in one place
// so no caller re-encodes them. The planner builds the Society; this module
// is what the code checks against, not the prompt.

// The Society's target size. "30" is approximate, not exact: the real
// requirement is MORE THAN 20 living agents, so readiness counts living
// agents against the minimum and reports progress towards the target.
export const SOCIETY_SIZE = 30
export const SOCIETY_MIN_AGENTS = 21

// A founded Society whose planner never generated anything is stalled after
// this long: the planner is presumed lost (restart, crash, held) and the
// Society is resumed instead of left frozen.
export const SOCIETY_GENERATION_TIMEOUT_MS = 30 * 60 * 1000

// The Anymodel model table, verified 2026-11-05 in three chat-test rounds
// against https://anymodel.ghostly.su/v1/models (12 models). Model ids are
// matched against the catalog, so the provider id comes from what the
// account actually has instead of a hardcoded guess.
export const STRONG_MODEL_ID = "opus-5.5"
export const MID_MODEL_ID = "sonnet-5.5"
export const CHEAP_MODEL_ID = "anymodel-coder"
export const FALLBACK_MODEL_ID = "sonnet-5"

// Dead in all three rounds (mostly timeouts — provider overload, not a
// single outage): never a primary, never a fallback, anywhere.
export const DEAD_MODEL_IDS: ReadonlyArray<string> = [
  "anymodel-reasoner",
  "anymodel-v4.1-flash",
  "fable-5.1",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6.1-sol",
]

export const isDeadModelId = (id: string) => DEAD_MODEL_IDS.includes(id.trim().toLowerCase())
export const isDeadSocietyModel = (model: Model.Ref) => isDeadModelId(model.id)

export type ModelTier = "strong" | "mid" | "cheap"

export const modelIdForTier = (tier: ModelTier) =>
  tier === "strong" ? STRONG_MODEL_ID : tier === "mid" ? MID_MODEL_ID : CHEAP_MODEL_ID

// Quality work (testing, review, audit) runs on cheap models; planning runs
// on strong ones; everything else on a mid-tier model. The category is the
// role's own, matched ignoring case.
export function tierForCategory(category: string | undefined): ModelTier {
  const normalized = category?.trim().toLowerCase() ?? ""
  if (normalized === "quality") return "cheap"
  if (normalized === "planning") return "strong"
  return "mid"
}

// A tier model from the catalog, with the provider id the catalog gives it;
// undefined when the account does not have that model, so callers fall
// through to the next choice instead of inventing a provider.
export function resolveSocietyModel(
  tier: ModelTier | "fallback",
  catalog: ReadonlyArray<Model.Info> | undefined,
): Model.Ref | undefined {
  const wanted = tier === "fallback" ? FALLBACK_MODEL_ID : modelIdForTier(tier)
  const info = catalog?.find((item) => item.id.toLowerCase() === wanted)
  if (!info) return undefined
  return Model.Ref.make({ id: info.id, providerID: info.providerID })
}

// ---------------------------------------------------------------------------
// Generation state: where a Society stands between "founded" and "ready".
// It lives in the federation KV store, so a restart does not lose it, and
// the planner's own tool calls move it forward: generate records
// "generated", society_plan apply records "planned".
// ---------------------------------------------------------------------------

export type GenerationStage = "founded" | "generated" | "planned"

export const Generation = Schema.Struct({
  stage: Schema.Literals(["founded", "generated", "planned"]),
  updated: Schema.Number,
  kickoffDelivered: Schema.Boolean,
  goal: Schema.optional(Schema.String),
})
export interface Generation extends Schema.Schema.Type<typeof Generation> {}
export const decodeGeneration = Schema.decodeUnknownOption(Generation)
export const encodeGeneration = Schema.encodeSync(Generation)

export const generationStalled = (generation: Generation, now: number) =>
  generation.stage === "founded" && now - generation.updated > SOCIETY_GENERATION_TIMEOUT_MS

// ---------------------------------------------------------------------------
// A society_plan apply, stored per project so workers created later get the
// same model, context threshold, cache switch and budget the planner set.
// ---------------------------------------------------------------------------

export const SocietyPlan = Schema.Struct({
  model: Schema.optional(Schema.String),
  context: Schema.optional(Schema.Json),
  cache: Schema.optional(Schema.Boolean),
  budget: Schema.optional(Schema.Number),
  // The MCP servers assigned to the whole Society at once, by society_plan
  // apply. Per-task distribution still happens at dispatch, but it starts
  // from this one assignment instead of being re-decided per task.
  mcp: Schema.optional(Schema.Array(Schema.String)),
})
export interface SocietyPlan extends Schema.Schema.Type<typeof SocietyPlan> {}
export const decodeSocietyPlan = Schema.decodeUnknownOption(SocietyPlan)
export const encodeSocietyPlan = Schema.encodeSync(SocietyPlan)

// ---------------------------------------------------------------------------
// Readiness: a Society counts as built when it has more than 20 living
// agents, every one of them with a model, the planner ran society_plan
// apply, and at least one chat carries a recorded budget. The missing list
// names exactly what is still open, so status can say it in one line.
// ---------------------------------------------------------------------------

export interface ReadinessInput {
  readonly agents: number
  readonly alive: number
  readonly withModel: number
  readonly budgetChats: number
  readonly stage: GenerationStage | undefined
}

export function readiness(input: ReadinessInput): {
  readonly ready: boolean
  readonly missing: ReadonlyArray<string>
} {
  const missing: string[] = []
  if (input.agents < SOCIETY_MIN_AGENTS)
    missing.push(`${input.agents}/${SOCIETY_MIN_AGENTS} agents (target ${SOCIETY_SIZE})`)
  if (input.alive < input.agents) missing.push(`${input.agents - input.alive} agent(s) missing`)
  if (input.withModel < input.agents) missing.push(`${input.agents - input.withModel} agent(s) without a model`)
  if (input.stage !== "planned")
    missing.push(
      input.stage === undefined
        ? "society_plan apply never ran"
        : `society_plan apply never ran (generation is ${input.stage})`,
    )
  if (input.budgetChats === 0) missing.push("no chat has a recorded budget")
  return { ready: missing.length === 0, missing }
}
