import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { resolveTheme, selectTheme } from "@orchestra/theme/tui"
import { getOrchestraTheme } from "../../../src/theme"

for (const mode of ["light", "dark"] as const) {
  test(`direct literal target and token aliases share identity ${mode}`, () => {
    const base = selectTheme(getOrchestraTheme(), mode)
    const theme = resolveTheme({
      ...base,
      background: {
        ...base.background,
        base: "#123456",
        raised: { ...base.background.raised, base: "$background.base", high: "#123456" },
        formfield: { ...base.background.formfield, base: "$background.raised.base" },
      },
    })
    expect(theme.background.base.toInts()).toEqual([18,52,86,255])
    expect(theme.background.raised.base).toBe(theme.background.base)
    expect(theme.background.formfield.base).toBe(theme.background.base)
    // Equal independently authored literals remain independent; no value-based canonicalization.
    expect(theme.background.raised.high).not.toBe(theme.background.base)
    expect(theme.background.raised.high.equals(theme.background.base)).toBeTrue()
    expect(theme.source(theme.background.base)).toBeUndefined()
    const external = RGBA.fromInts(...theme.background.base.toInts())
    expect(theme.source(external)).toBeUndefined()
    expect(theme.increase(external)).toBe(external)
  })
}
