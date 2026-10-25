import { describe, expect, test } from "bun:test"
import { addTokens, emptyTokens, groupOf, heaviestFirst, projectOf, segments, total, type Entry } from "./scope"

const tokens = (input: number, output = 0) => ({ ...emptyTokens(), input, output })

const project = (id: string, directory: string, created: number, main?: string) => ({
  id,
  name: id,
  directory,
  created,
  main,
})

describe("segments", () => {
  test("keeps non-empty kinds in bar order as shares of the whole", () => {
    const result = segments({ input: 100, output: 50, reasoning: 0, cache: { read: 200, write: 0 } }, 1000)
    expect(result.map((item) => item.kind)).toEqual(["input", "cacheRead", "output"])
    expect(result.map((item) => item.share)).toEqual([0.1, 0.2, 0.05])
  })

  test("has no segments without a whole", () => {
    expect(segments(tokens(10), 0)).toEqual([])
  })

  test("never exceeds the whole", () => {
    expect(segments(tokens(500), 100)[0]?.share).toBe(1)
  })
})

describe("projectOf", () => {
  const projects = [project("outer", "/work", 1), project("inner", "/work/app", 2, "ses_main")]

  test("uses the project whose main session it is", () => {
    expect(projectOf({ sessionID: "ses_main", directory: "/work", projects, owners: {} })?.id).toBe("inner")
  })

  test("prefers the project that opened the session over the directory", () => {
    expect(projectOf({ sessionID: "ses_a", directory: "/work/app", projects, owners: { ses_a: "outer" } })?.id).toBe(
      "outer",
    )
  })

  test("falls back to the deepest project containing the directory", () => {
    expect(projectOf({ sessionID: "ses_b", directory: "/work/app/src", projects, owners: {} })?.id).toBe("inner")
    expect(projectOf({ sessionID: "ses_c", directory: "/elsewhere", projects, owners: {} })).toBeUndefined()
  })
})

describe("groupOf", () => {
  test("finds the group listing the project", () => {
    const groups = [{ name: "Shop", projects: ["a", "b"] }, { name: "Other", projects: ["c"] }]
    expect(groupOf("b", groups)?.name).toBe("Shop")
    expect(groupOf("z", groups)).toBeUndefined()
  })
})

describe("total", () => {
  const entries: Entry[] = [
    { id: "a", title: "A", tokens: tokens(10, 1), cost: 0.5 },
    { id: "b", title: "B", tokens: tokens(30, 2), cost: 0.25 },
  ]

  test("sums tokens and cost", () => {
    expect(total(entries)).toEqual({ tokens: addTokens(entries[0]!.tokens, entries[1]!.tokens), cost: 0.75 })
    expect(total([])).toEqual({ tokens: emptyTokens(), cost: 0 })
  })

  test("orders the heaviest entry first without changing the input", () => {
    expect(heaviestFirst(entries).map((entry) => entry.id)).toEqual(["b", "a"])
    expect(entries.map((entry) => entry.id)).toEqual(["a", "b"])
  })
})
