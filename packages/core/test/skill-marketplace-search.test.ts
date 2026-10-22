import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SkillMarketplace } from "@orchestra/schema/skill-marketplace"
import { SkillMarketplaceSearch } from "@orchestra/core/skill-marketplace/search"
import { SkillMarketplaceStore } from "@orchestra/core/skill-marketplace/store"
import { DECODED } from "./fixture/skill-marketplace"

/** A catalog row built through the contract, so a synthetic test row is a real one in shape. */
const row = (fields: Omit<Partial<SkillMarketplace.Skill>, "id"> & { id: string }) =>
  Schema.decodeUnknownSync(SkillMarketplace.Skill)({
    name: fields.id,
    author: "",
    description: "",
    contentLanguage: null,
    githubUrl: "",
    skillUrl: "",
    stars: 0,
    updatedAt: 0,
    ...fields,
  })

/** An index holding exactly these rows. */
const indexOf = (...rows: ReadonlyArray<SkillMarketplace.Skill>): SkillMarketplaceStore.Index => ({
  skills: new Map(rows.map((skill) => [skill.id, skill] as const)),
  degraded: false,
  damage: undefined,
})

const fixtureIndex: SkillMarketplaceStore.Index = {
  skills: new Map(DECODED.map((skill) => [skill.id, skill] as const)),
  degraded: false,
  damage: undefined,
}
const postings = SkillMarketplaceSearch.build(fixtureIndex.skills)
const search = (query: string, input: Partial<SkillMarketplaceSearch.Input> = {}) =>
  SkillMarketplaceSearch.search({ query, ...input }, fixtureIndex, postings)

describe("skill catalog search", () => {
  test("finds the real skill the catalog itself answered with", () => {
    const hits = search("secret scanning")

    // Both words are in the name of this row and in the description of no other indexed row.
    expect(hits[0]?.skill.name).toBe("openclaw-secret-scanning-maintainer")
    expect(hits[0]?.matched.name).toEqual(["secret", "scanning"])
    expect(hits).toHaveLength(1)
  })

  test("a name hit outranks a description hit", () => {
    const hits = search("react hooks")

    // `react-patterns` carries "react" in its name; the row below only mentions React in prose.
    expect(hits[0]?.skill.name).toBe("react-patterns")
    expect(hits[0]?.matched.name).toContain("react")
    const described = hits.filter((hit) => hit.matched.name.length === 0)
    expect(described.length).toBeGreaterThan(0)
    expect(described[0]?.matched.description).toContain("react")
    // The gap is what makes the name usable: every row whose prose mentions a word would
    // otherwise tie with the row actually named after it.
    expect(hits[0]!.score).toBeGreaterThan(described[0]!.score)
    expect(described[0]!.score).toBeLessThanOrEqual(SkillMarketplaceSearch.DESCRIPTION_WEIGHT)
  })

  test("the answer is total and repeatable when rows match equally", () => {
    // Two real rows with the same name and the same stars differ only in path, so ordering them
    // needs a last-resort tiebreak rather than luck.
    const first = search("react patterns").map((hit) => hit.skill.id)
    const second = search("react patterns").map((hit) => hit.skill.id)

    expect(new Set(first).size).toBe(first.length)
    expect(second).toEqual(first)
    expect(first).toHaveLength(search("react patterns", { limit: 50 }).length)
  })

  test("the whole query inside one field beats the same words scattered", () => {
    const hits = search("coding standards")

    expect(hits[0]?.skill.name).toBe("coding-standards")
    expect(hits[0]?.score).toBeGreaterThanOrEqual(
      SkillMarketplaceSearch.NAME_WEIGHT * 2 + SkillMarketplaceSearch.NAME_PHRASE_BONUS,
    )
    expect(hits[1]?.score).toBeLessThan(SkillMarketplaceSearch.NAME_WEIGHT * 2)
  })

  test("stars break a tie between rows that matched equally", () => {
    const state = indexOf(
      row({ id: "quiet", name: "same name", description: "same text", stars: 10 }),
      row({ id: "loud", name: "same name", description: "same text", stars: 900 }),
    )

    const hits = SkillMarketplaceSearch.search({ query: "same" }, state, SkillMarketplaceSearch.build(state.skills))

    // Equal scores, so the tiebreak decides; without it the order would be arbitrary.
    expect(hits[0]?.score).toBe(hits[1]?.score)
    expect(hits.map((hit): [string, number] => [hit.skill.id, hit.skill.stars])).toEqual([
      ["loud", 900],
      ["quiet", 10],
    ])
  })

  test("the language filter keeps out rows written in another language", () => {
    const japanese = search("coding standards", { language: "ja" })
    const english = search("coding standards", { language: "en" })

    // `coding-standards` is the real Japanese row in the fixture, and only it answers "ja".
    expect(japanese.map((hit) => hit.skill.name)).toEqual(["coding-standards"])
    expect(japanese[0]?.skill.contentLanguage).toBe("ja")
    expect(english.map((hit) => hit.skill.name)).not.toContain("coding-standards")
    expect(english.length).toBeGreaterThan(0)
  })

  test("a query with nothing in common answers nothing rather than everything", () => {
    expect(search("asdf qwerty zzz")).toEqual([])
    expect(search("   ")).toEqual([])
    expect(search("!")).toEqual([])
  })

  test("the limit caps the answer", () => {
    expect(search("react", { limit: 1 })).toHaveLength(1)
    // A nonsense limit is clamped rather than honoured: 0 rows would look like a broken index.
    expect(search("react", { limit: 0 })).toHaveLength(1)
    expect(search("react", { limit: 10_000 }).length).toBeLessThanOrEqual(SkillMarketplaceSearch.MAX_LIMIT)
  })

  test("tokenizing is case- and punctuation-blind, and drops single characters", () => {
    expect(SkillMarketplaceSearch.tokenize("React 18/19: hooks & state!")).toEqual([
      "react",
      "18",
      "19",
      "hooks",
      "state",
    ])
    expect(SkillMarketplaceSearch.tokenize("a b c")).toEqual([])
  })

  test("a word repeated inside one row does not outrank a rarer word", () => {
    // Neutral names, so only the descriptions differ: the repetition must not add weight.
    const state = indexOf(
      row({ id: "loud", name: "neutral", description: "repeated repeated repeated" }),
      row({ id: "quiet", name: "neutral", description: "repeated" }),
    )

    const hits = SkillMarketplaceSearch.search({ query: "repeated" }, state, SkillMarketplaceSearch.build(state.skills))

    // Saying the word once and saying it three times score the same: repetition is not evidence.
    const once = SkillMarketplaceSearch.DESCRIPTION_WEIGHT + SkillMarketplaceSearch.DESCRIPTION_PHRASE_BONUS
    expect(hits.map((hit): [string, number] => [hit.skill.id, hit.score])).toEqual([
      ["loud", once],
      ["quiet", once],
    ])
  })
})
