import { describe, expect, test } from "bun:test"
import { dict as english } from "./en"
import { dict as russian } from "./ru"

const placeholders = (text: string) => [...text.matchAll(/\{+\w+\}+/g)].map((match) => match[0]).sort()

describe("Russian interface translations", () => {
  test("covers every English app key with a nonempty Russian entry", () => {
    const missing = Object.keys(english).filter((key) => !Object.hasOwn(russian, key))

    expect(missing).toEqual([])

    for (const [key, text] of Object.entries(russian)) {
      expect(text.trim(), key).not.toBe("")
    }
  })

  test("preserves interpolation tokens in every translated app entry", () => {
    const translations: Record<string, string> = russian

    for (const [key, text] of Object.entries(english)) {
      expect(placeholders(translations[key] ?? ""), key).toEqual(placeholders(text))
    }
  })

  test("translates the reported settings and mini-skill controls", () => {
    expect(russian["settings.general.row.animations.title"]).toBe("Анимации")
    expect(russian["settings.general.row.theme.reset.title"]).toBe("Сбросить тему")
    expect(russian["composer.miniSkills.add"]).toBe("Добавить мини-навык")
    expect(russian["composer.miniSkills.position.above"]).toBe("Над запросом")
    expect(russian["composer.miniSkills.position.below"]).toBe("Под запросом")
  })
})
