import { describe, expect, test } from "bun:test"
import {
  barCells,
  contextBreakdown,
  emptyTokens,
  groupOf,
  heaviestFirst,
  projectOf,
  sumOf,
  total,
  type Entry,
} from "../src/util/context-scope"

const tokens = (input: number, output = 0) => ({ ...emptyTokens(), input, output })
const project = (id: string, directory: string, created: number, main?: string) => ({
  id,
  name: id,
  directory,
  created,
  main,
})

describe("barCells", () => {
  test("shares the width by token kind and keeps every non-empty kind visible", () => {
    const cells = barCells({ ...emptyTokens(), input: 900, cacheRead: 99, output: 1 }, 1000, 20)
    expect(cells.map((item) => [item.kind.id, item.cells])).toEqual([
      ["input", 17],
      ["cacheRead", 2],
      ["output", 1],
    ])
  })

  test("never overflows the width", () => {
    const cells = barCells({ ...emptyTokens(), input: 5, cacheRead: 5, cacheWrite: 5, output: 5, reasoning: 5 }, 25, 6)
    expect(cells.reduce((count, item) => count + item.cells, 0)).toBeLessThanOrEqual(6)
  })

  test("draws nothing without a whole or a width", () => {
    expect(barCells(tokens(10), 0, 10)).toEqual([])
    expect(barCells(tokens(10), 10, 0)).toEqual([])
  })
})

describe("contextBreakdown", () => {
  test("reads the latest assistant message's tokens by kind", () => {
    const messages = [
      { id: "msg_1", type: "user" },
      {
        id: "msg_2",
        type: "assistant",
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 30, write: 6 } },
      },
    ] as unknown as Parameters<typeof contextBreakdown>[0]
    expect(contextBreakdown(messages)).toEqual({ input: 10, cacheRead: 30, cacheWrite: 6, output: 4, reasoning: 2 })
    expect(contextBreakdown([])).toBeUndefined()
  })
})

describe("projectOf and groupOf", () => {
  const projects = [project("outer", "/work", 1), project("inner", "/work/app", 2, "ses_main")]

  test("a main session belongs to its project, then the opener, then the deepest directory", () => {
    expect(projectOf({ sessionID: "ses_main", directory: "/work", projects, owner: undefined })?.id).toBe("inner")
    expect(projectOf({ sessionID: "ses_a", directory: "/work/app", projects, owner: "outer" })?.id).toBe("outer")
    expect(projectOf({ sessionID: "ses_b", directory: "/work/app/src", projects, owner: undefined })?.id).toBe("inner")
    expect(projectOf({ sessionID: "ses_c", directory: "/elsewhere", projects, owner: undefined })).toBeUndefined()
  })

  test("a group is the first one listing the project", () => {
    const groups = [{ name: "Shop", projects: ["a", "b"] }, { name: "Other", projects: ["c"] }]
    expect(groupOf("b", groups)?.name).toBe("Shop")
    expect(groupOf("z", groups)).toBeUndefined()
  })
})

describe("total and heaviestFirst", () => {
  const entries: Entry[] = [
    { id: "a", title: "A", tokens: tokens(10, 1), cost: 0.5 },
    { id: "b", title: "B", tokens: tokens(30, 2), cost: 0.25 },
  ]

  test("sums tokens and cost", () => {
    const sum = total(entries)
    expect(sumOf(sum.tokens)).toBe(43)
    expect(sum.cost).toBe(0.75)
    expect(sumOf(total([]).tokens)).toBe(0)
  })

  test("leads with the heaviest entry without reordering the input", () => {
    expect(heaviestFirst(entries).map((entry) => entry.id)).toEqual(["b", "a"])
    expect(entries.map((entry) => entry.id)).toEqual(["a", "b"])
  })
})
