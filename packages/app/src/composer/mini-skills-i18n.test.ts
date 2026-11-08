import { describe, expect, test } from "bun:test"
import { flatten } from "@solid-primitives/i18n"
import en from "@/runtime/i18n/en"
import { dict as uiEn } from "@orchestra/ui/i18n/en"
import { dict as ru } from "@/runtime/i18n/ru"
import { dict as uiRu } from "@orchestra/ui/i18n/ru"

// Regression guard: #27 added these keys and #28 removed them while the
// hide/show controls still referenced them, which left both buttons without
// an accessible name. The rendered name proof lives in
// component-tests/composer.spec.ts; this unit guard pins the exact English
// strings and the production fallback seam: language.tsx builds
// base = flatten({ ...en, ...uiEn }) and merges a locale as
// { ...base, ...flatten({ ...appLocale, ...uiLocale }) }, so a locale without
// these keys keeps the English names. This mirrors that seam only; it does
// not claim completeness for any other key or locale.
describe("mini skills hide/show translations", () => {
  test("en defines the exact non-empty hide/show control names", () => {
    expect(en["composer.miniSkills.hide"]).toBe("Hide mini skills")
    expect(en["composer.miniSkills.show"]).toBe("Show mini skills")
  })

  test("a locale without the keys inherits the English names through the production base merge", () => {
    expect("composer.miniSkills.hide" in ru).toBe(false)
    expect("composer.miniSkills.show" in ru).toBe(false)
    expect("composer.miniSkills.hide" in uiRu).toBe(false)
    expect("composer.miniSkills.show" in uiRu).toBe(false)

    const base = flatten({ ...en, ...uiEn })
    const merged = { ...base, ...flatten({ ...ru, ...uiRu }) }

    expect(merged["composer.miniSkills.hide"]).toBe("Hide mini skills")
    expect(merged["composer.miniSkills.show"]).toBe("Show mini skills")
  })
})
