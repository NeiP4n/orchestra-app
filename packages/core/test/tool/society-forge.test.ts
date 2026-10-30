import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SocietyForgeTool } from "@orchestra/core/tool/plugin/society-forge"

const decode = Schema.decodeUnknownSync(SocietyForgeTool.Input)

describe("society forge input", () => {
  test("founds a Society from a goal alone", () => {
    expect(decode({ action: "found", goal: "release a mobile fishing game" })).toEqual({
      action: "found",
      goal: "release a mobile fishing game",
    })
  })

  test("takes an optional name and folder", () => {
    expect(decode({ action: "found", goal: "g", name: "Fishing", directory: "C:\work" })).toMatchObject({
      name: "Fishing",
      directory: "C:\work",
    })
  })

  test("still lists and generates, and rejects other actions", () => {
    expect(decode({ action: "list" })).toEqual({ action: "list" })
    expect(decode({ action: "generate", goal: "g" })).toMatchObject({ action: "generate" })
    expect(() => decode({ action: "delete" })).toThrow()
  })
})
