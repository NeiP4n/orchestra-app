import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Federation } from "@orchestra/core/federation"

describe("Society folders", () => {
  test("every project of a Society lives inside the Society's one folder", () => {
    const root = path.join(path.sep, "srv", "societies")
    const society = Federation.societyDirectory("Моё Общество 1", root)
    expect(society).toBe(path.join(root, "моё-общество-1"))
    expect(Federation.societyProjectDirectory("Моё Общество 1", "Backend API", root)).toBe(path.join(society, "backend-api"))
  })

  test("a name with no usable characters still gets a stable folder", () => {
    const root = path.join(path.sep, "srv", "societies")
    expect(Federation.societyDirectory("***", root)).toBe(Federation.societyDirectory("***", root))
    expect(path.dirname(Federation.societyDirectory("***", root))).toBe(root)
  })
})
