export * as SkillMarketplaceSearch from "./search.js"

import { SkillMarketplace } from "@orchestra/schema/skill-marketplace"
import { SkillMarketplaceStore } from "./store.js"

type Skill = SkillMarketplaceStore.Skill
type SkillID = SkillMarketplaceStore.SkillID

/**
 * A name hit outranks a description hit by a wide margin: the catalog has thousands of rows
 * whose descriptions all say "use when…", and the name is the only field written by hand.
 */
export const NAME_WEIGHT = 100
export const DESCRIPTION_WEIGHT = 10
/** The whole query inside one field beats the same tokens scattered across fields. */
export const NAME_PHRASE_BONUS = 200
export const DESCRIPTION_PHRASE_BONUS = 20

export const DEFAULT_LIMIT = 10
export const MAX_LIMIT = 50

export interface Input {
  readonly query: string
  readonly limit?: number
  readonly language?: SkillMarketplace.ContentLanguage
  /**
   * Forwarded to the catalog only. The cached rows carry no category, so a caller that asks for
   * one cannot be answered from the cache — see the service, which treats this as a reason to ask.
   */
  readonly category?: string
  /** Forwarded to the catalog only, for the same reason as `category`. */
  readonly sortBy?: SkillMarketplace.SortOrder
}

export interface Hit {
  readonly skill: Skill
  readonly score: number
  readonly matched: {
    readonly name: ReadonlyArray<string>
    readonly description: ReadonlyArray<string>
  }
}

/**
 * Term → rows carrying it, split by the field it was found in. The split is what lets
 * ranking weight a name hit above a description hit without re-reading the rows per token.
 */
export interface Postings {
  readonly name: Map<string, SkillID[]>
  readonly description: Map<string, SkillID[]>
}

export const emptyPostings: Postings = { name: new Map(), description: new Map() }

/**
 * Lowercase, split on everything that is not a letter or a digit, drop one-character pieces.
 * Catalog names are kebab-case (`telegram-e2e-userbot`) and descriptions are plain sentences,
 * so this split is enough; stemming or phrase tables would only guess.
 */
export const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1)

export const build = (skills: ReadonlyMap<SkillID, Skill>): Postings => {
  const name = new Map<string, SkillID[]>()
  const description = new Map<string, SkillID[]>()
  for (const skill of skills.values()) {
    add(name, skill.id, tokenize(skill.name))
    add(description, skill.id, tokenize(`${skill.author} ${skill.description}`))
  }
  return { name, description }
}

const add = (into: Map<string, SkillID[]>, id: SkillID, terms: ReadonlyArray<string>) => {
  // A term repeated inside one row counts once: "the the the" must not outrank a rarer word.
  // Appending in place is the point: rebuilding the list per term copies it once per row that
  // carries it, which measured 45s for a hundred thousand rows against 1.4s here.
  for (const term of new Set(terms)) {
    const list = into.get(term)
    if (list === undefined) into.set(term, [id])
    else list.push(id)
  }
}

/** Ranks the indexed rows against one short natural-language query. Never touches the network. */
export const search = (input: Input, index: SkillMarketplaceStore.Index, postings: Postings): Hit[] => {
  const terms = [...new Set(tokenize(input.query))]
  if (terms.length === 0) return []
  const phrase = terms.join(" ")
  // Accumulated in a mutable draft because one row is touched once per term it matches, and
  // a readonly accumulator would reallocate a small object on every one of those touches.
  const drafts = new Map<SkillID, Draft>()
  for (const term of terms) {
    for (const [weight, field, source] of [
      [NAME_WEIGHT, "name", postings.name],
      [DESCRIPTION_WEIGHT, "description", postings.description],
    ] as const) {
      for (const id of source.get(term) ?? []) {
        const skill = index.skills.get(id)
        if (skill === undefined) continue
        if (input.language !== undefined && skill.contentLanguage !== input.language) continue
        const draft = drafts.get(id) ?? { skill, score: 0, name: [] as string[], description: [] as string[] }
        draft.score += weight
        draft[field].push(term)
        drafts.set(id, draft)
      }
    }
  }
  return [...drafts.values()]
    .map((draft): Hit => {
      const score =
        draft.score +
        (draft.name.join(" ").includes(phrase) ? NAME_PHRASE_BONUS : 0) +
        (draft.skill.description.toLowerCase().includes(phrase) ? DESCRIPTION_PHRASE_BONUS : 0)
      return { skill: draft.skill, score, matched: { name: draft.name, description: draft.description } }
    })
    .sort((a, b) => b.score - a.score || b.skill.stars - a.skill.stars || a.skill.id.localeCompare(b.skill.id))
    .slice(0, limit(input.limit))
}

type Draft = { skill: Skill; score: number; name: string[]; description: string[] }

/**
 * Rows per page the catalog will return. Kept here rather than taken from a live answer: the
 * import needs a bound before it has made a call.
 */
export const limit = (requested: number | undefined) =>
  Math.min(Math.max(Math.round(requested ?? DEFAULT_LIMIT), 1), MAX_LIMIT)
