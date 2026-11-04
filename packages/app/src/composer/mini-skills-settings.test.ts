import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import { INITIAL_MINI_SKILLS_SETTINGS, MiniSkillsPersistKey, MiniSkillsSettings } from "./mini-skills-settings"

const codec = Persistence.withInitial(MiniSkillsSettings, INITIAL_MINI_SKILLS_SETTINGS)
const decode = Schema.decodeUnknownSync(codec)
const encode = Schema.encodeUnknownSync(codec)

const item = { id: "custom", label: "Custom", icon: "⭐", instruction: "Do the custom thing." }

describe("composer mini skills settings persistence", () => {
  test("keeps the persisted key so existing user settings are not orphaned", () => {
    expect(MiniSkillsPersistKey).toBe("composer.mini-skills.v2")
  })

  test("defaults to the built-in mini skills when nothing is stored", () => {
    expect(decode({})).toEqual(INITIAL_MINI_SKILLS_SETTINGS)
  })

  test("legacy settings stored before the hide toggle gain hidden: false and keep their values", () => {
    expect(decode({ items: [item], placement: "below" })).toEqual({ items: [item], placement: "below", hidden: false })
  })

  test("a hidden bar stays hidden across a store round-trip", () => {
    const value = decode({ items: [item], placement: "above", hidden: true })

    expect(value.hidden).toBe(true)
    expect(decode(encode(value))).toEqual(value)
  })

  test("an invalid hidden value recovers to visible without discarding the other settings", () => {
    expect(decode({ items: [item], placement: "below", hidden: "yes" })).toEqual({
      items: [item],
      placement: "below",
      hidden: false,
    })
  })
})
