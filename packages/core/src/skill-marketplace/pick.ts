export * as SkillMarketplacePick from "./pick.js"

import { SkillMarketplaceSearch } from "./search.js"
import { compose } from "./factory.js"
import type { Factory, JournalEntry, NativeSkill, Port, SkillRef, ValueVerdict } from "./types.js"

/**
 * `pickSkillsForTask` is the one function prompt-intake calls to get skills
 * for a task. It is the marketplace's answer to "which skills does this
 * task need", and it is deliberately narrow:
 *
 * - It reads only the compact index (name, purpose, ports, version, level).
 *   It never reads a skill's full text, never reaches the network, and never
 *   costs a model call. Searching the index is free.
 * - It takes the value verdict prompt-intake's value checker produced. A
 *   request the checker refused (duplicate, redundant, low-value) is not
 *   searched at all: the answer is the refusal, with the reason.
 * - When the caller names the outputs the task needs, it also composes a
 *   factory from the picked skills, so the answer is a working pipeline,
 *   not a list.
 *
 * prompt-intake owns understanding the prompt and judging its value; this
 * owns knowing which skills exist and how they fit together. The boundary
 * is this function.
 */

export interface PickInput {
  /** The task's goal, in the caller's own words. */
  readonly goal: string
  /** Extra context for ranking (the task's domain, constraints, prior steps). */
  readonly context: string | undefined
  /** The compact index to search. */
  readonly index: readonly SkillRef[]
  /** The outputs the task needs; when given, a factory is composed. */
  readonly outputs: readonly Port[] | undefined
  /** The inputs the caller already has, for the factory. */
  readonly inputs: readonly Port[] | undefined
  /** The value verdict from prompt-intake; a refusal skips the search. */
  readonly value: ValueVerdict | undefined
  /** How many skills to return at most. */
  readonly maxSkills: number | undefined
}

export interface Picked {
  /** The picked skills, best first, as compact refs — never full text. */
  readonly skills: readonly SkillRef[]
  /** The factory, when outputs were given and the composition succeeded. */
  readonly factory: Factory | undefined
  /** Why no factory was composed, when outputs were given and it failed. */
  readonly factoryFailure: string | undefined
  /** Set when the value checker refused the request: nothing was searched. */
  readonly skipped: string | undefined
  readonly journal: readonly JournalEntry[]
}

const NAME_WEIGHT = 100
const PURPOSE_WEIGHT = 10
const DEFAULT_MAX_SKILLS = 5

/**
 * Ranks the compact index against a goal. Name hits outrank purpose hits
 * by the same margin as the catalog search (`search.ts`): the name is the
 * only field written by hand.
 */
export const rank = (goal: string, context: string | undefined, index: readonly SkillRef[]): SkillRef[] => {
  const terms = [...new Set(SkillMarketplaceSearch.tokenize(`${goal} ${context ?? ""}`))]
  if (terms.length === 0) return []
  const scored = index.map((ref) => {
    const name = SkillMarketplaceSearch.tokenize(ref.name)
    const purpose = SkillMarketplaceSearch.tokenize(ref.purpose)
    const score =
      terms.reduce((sum, term) => sum + (name.includes(term) ? NAME_WEIGHT : 0), 0) +
      terms.reduce((sum, term) => sum + (purpose.includes(term) ? PURPOSE_WEIGHT : 0), 0)
    return { ref, score }
  })
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.ref.name.localeCompare(b.ref.name))
    .map((entry) => entry.ref)
}

export const pickSkillsForTask = (
  input: PickInput,
  available: readonly NativeSkill[],
): Picked => {
  if (input.value !== undefined && !input.value.proceed) {
    return {
      skills: [],
      factory: undefined,
      factoryFailure: undefined,
      skipped: input.value.reason ?? "The value checker refused this request.",
      journal: [
        {
          at: Date.now(),
          kind: "usage",
          skill: undefined,
          level: undefined,
          problem: "The request was refused by the value checker before any skill was searched.",
          decision: input.value.reason ?? "Skipped: low-value or duplicate request.",
        },
      ],
    }
  }
  const skills = rank(input.goal, input.context, input.index).slice(0, input.maxSkills ?? DEFAULT_MAX_SKILLS)
  if (input.outputs === undefined || input.outputs.length === 0)
    return { skills, factory: undefined, factoryFailure: undefined, skipped: undefined, journal: [] }
  const byName = new Map(available.map((skill) => [skill.manifest.name, skill]))
  const picked = skills
    .map((ref) => byName.get(ref.name))
    .filter((skill): skill is NativeSkill => skill !== undefined)
  const composed = compose(
    { outputs: input.outputs, inputs: input.inputs ?? [] },
    picked.length > 0 ? picked : available,
  )
  if (!composed.ok)
    return { skills, factory: undefined, factoryFailure: composed.reason, skipped: undefined, journal: composed.journal }
  return { skills, factory: composed.factory, factoryFailure: undefined, skipped: undefined, journal: composed.journal }
}
