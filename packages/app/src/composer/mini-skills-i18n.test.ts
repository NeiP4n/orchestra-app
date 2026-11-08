import { describe, expect, test } from "bun:test"
import { flatten } from "@solid-primitives/i18n"
import en from "@/runtime/i18n/en"
import { dict as ui } from "@orchestra/ui/i18n/en"
import { dict as ru } from "@/runtime/i18n/ru"

// Regression guard: #27 added these keys and #28 accidentally removed them,
// which left the hide/show buttons without an accessible name. The rendered
// name proof lives in component-tests/composer.spec.ts; this unit guard pins
// the exact English strings and the base-merge fallback that serves them to
// locales without their own translations.
describe("mini skills hide/show translations", () => {
  test("en defines the exact non-empty hide/show control names", () => {
    expect(en["composer.miniSkills.hide"]).toBe("Hide mini skills")
    expect(en["composer.miniSkills.show"]).toBe("Show mini skills")
  })

  test("a locale without the keys inherits the English names through the base merge", () => {
    expect("composer.miniSkills.hide" in ru).toBe(false)
    expect("composer.miniSkills.show" in ru).toBe(false)

    const base = flatten({ ...en, ...ui })
    const merged = { ...base, ...flatten(ru) }

    expect(merged["composer.miniSkills.hide"]).toBe("Hide mini skills")
    expect(merged["composer.miniSkills.show"]).toBe("Show mini skills")
  })
})
