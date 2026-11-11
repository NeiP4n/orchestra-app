import { expect, test } from "bun:test"
import { buildSculkWebTheme, sculkBootColors } from "../../../../script/sculk-web-theme"
import source from "../../../tui/src/theme/assets/v2/sculk.json" with { type: "json" }
import web from "./themes/sculk.json" with { type: "json" }
import { resolveThemeVariantV2 } from "./v2/resolve"
import { parseThemeDocument, resolveThemeDocument } from "../../../theme/src/tui/index.js"
import { contrastRatio } from "./color"

// Any TUI palette edit must regenerate the web theme and pre-paint colors.
test("web Sculk is generated from the TUI source without a second hand-picked palette", () => {
  expect(JSON.stringify(web)).toBe(JSON.stringify(buildSculkWebTheme()))
})

test.each(["light", "dark"] as const)("Sculk %s chrome and accents use exact TUI tokens", (mode) => {
  const variant = buildSculkWebTheme()[mode]
  const tokens = resolveThemeVariantV2(variant, mode === "dark")
  const hue = source[mode].hue

  expect(tokens["v2-background-bg-base"]).toBe(hue.gray[800])
  expect(tokens["v2-background-bg-deep"]).toBe(hue.gray[900])
  expect(tokens["v2-text-text-base"]).toBe(hue.gray[200])

  const tui = resolveThemeDocument(parseThemeDocument(source, "sculk"), mode)

  const link = `#${tui.markdown.link
    .toInts()
    .slice(0, 3)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`

  expect(tokens["v2-text-text-accent"]).toBe(link)
  expect(tokens["v2-border-border-focus"]).toBe(link)
  expect(JSON.stringify(sculkBootColors()[mode])).toBe(
    JSON.stringify({ background: hue.gray[800], color: hue.gray[200] }),
  )
  expect(contrastRatio(sculkBootColors()[mode].color, sculkBootColors()[mode].background)).toBeGreaterThan(4.5)
})

test("pre-paint Sculk colors are generated from the same TUI source", async () => {
  const boot = await Bun.file(new URL("../../../app/public/orchestra-theme-preload.js", import.meta.url)).text()

  const generated = boot.match(/var sculkBoot = JSON\.parse\(\s*'([^']+)'\s*,?\s*\)/)?.[1]

  expect(generated).toBeDefined()
  expect(JSON.parse(generated!)).toEqual(sculkBootColors())
})

test.each(["light", "dark"] as const)("Sculk %s neural roles use the production TUI resolver", (mode) => {
  const tui = resolveThemeDocument(parseThemeDocument(source, "sculk"), mode)
  const tokens = resolveThemeVariantV2(buildSculkWebTheme()[mode], mode === "dark")

  for (const role of ["signal", "synapse", "spark", "dormant"] as const) {
    const rgba = tui.text.neural?.[role]
    expect(rgba).toBeDefined()

    const hex = `#${rgba!
      .toInts()
      .slice(0, 3)
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("")}`

    expect(tokens[`v2-neural-${role}`]).toBe(hex)
  }
})
