import { expect, test } from "bun:test"
import { selectTheme, selectThemeMode, supportsThemeMode, themeModes } from "@orchestra/theme/tui"
import { getOrchestraTheme } from "../../../src/theme"

test("selects complete light and dark themes independently", () => {
  const light = selectTheme(getOrchestraTheme(), "light")
  const dark = selectTheme(getOrchestraTheme(), "dark")
  expect(selectTheme(getOrchestraTheme())).toEqual(light)
  expect(light.hue).toEqual(getOrchestraTheme().light.hue)
  expect(dark.text).toEqual(getOrchestraTheme().base.text)
  expect(dark.hue).toEqual(getOrchestraTheme().dark.hue)
  expect(selectThemeMode(getOrchestraTheme(), "dark")).toEqual({ theme: dark, mode: "dark" })
})

test("selects the available mode when the requested mode is missing", () => {
  const lightOnly = { base: getOrchestraTheme().base, light: getOrchestraTheme().light } as const
  const darkOnly = { base: getOrchestraTheme().base, dark: getOrchestraTheme().dark } as const

  expect(themeModes(lightOnly)).toEqual(["light"])
  expect(themeModes(darkOnly)).toEqual(["dark"])
  expect(supportsThemeMode(lightOnly, "light")).toBeTrue()
  expect(supportsThemeMode(lightOnly, "dark")).toBeFalse()
  expect(selectThemeMode(lightOnly, "dark")).toEqual({ theme: selectTheme(getOrchestraTheme(), "light"), mode: "light" })
  expect(selectThemeMode(darkOnly, "light")).toEqual({ theme: selectTheme(getOrchestraTheme(), "dark"), mode: "dark" })
})
