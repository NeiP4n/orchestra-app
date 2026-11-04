import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { RGBA, type TerminalColors } from "@opentui/core"
import { allThemes, hasTheme, getOrchestraTheme, legacyThemeMigration, parseTheme, resolveTheme } from "../src/theme"
import { resolveThemeDocument, themeModes } from "@orchestra/theme/tui"
import { discoverThemes } from "../src/theme/discovery"
import { configDirectories } from "../src/util/config-directories"
import { contrastRatio, generateSystem, terminalDefaultForegroundReadable, terminalMode } from "../src/theme/system"
import draculaSource from "../src/theme/assets/dracula.json" with { type: "json" }
import type { ThemeV1Json } from "@orchestra/theme/tui/v1"
import { tmpdir } from "./fixture/fixture"

const opencodeV1 = draculaSource as ThemeV1Json

test("rejects unrecognized theme structures", () => {
  expect(() => parseTheme({})).toThrow()
  expect(() => parseTheme({ version: 3 })).toThrow("Invalid theme")
})

test("registers orchestra as a native V2 theme", () => {
  expect(allThemes().orchestra).toBe(getOrchestraTheme())
  expect(parseTheme(getOrchestraTheme()).base).toBeDefined()
})

test("opencode is no longer a built-in theme, but its stored name migrates to orchestra", () => {
  expect(allThemes().opencode).toBeUndefined()
  expect(hasTheme("opencode")).toBe(false)
  expect(legacyThemeMigration("opencode")).toBe("orchestra")
  expect(legacyThemeMigration("orchestra")).toBeUndefined()
  expect(legacyThemeMigration("missing-theme")).toBeUndefined()
})

test("detects V1 themes from their theme field and caches migrations", () => {
  const unversioned = structuredClone(opencodeV1)
  const explicit = { ...structuredClone(opencodeV1), version: 1 }
  const first = parseTheme(unversioned, "unversioned")
  const second = parseTheme(explicit, "explicit")

  expect(first.base).toBeDefined()
  expect(second.base).toBeDefined()
  expect(parseTheme(unversioned, "unversioned")).toBe(first)
  expect(parseTheme(explicit, "explicit")).toBe(second)
})

test("decodes native V2 themes lazily once", () => {
  const source = {
    base: getOrchestraTheme().base,
    light: { ...getOrchestraTheme().light, categorical: ["red"] },
  } as const

  const document = parseTheme(source)
  expect(document.light?.categorical).toEqual(["red"])
  expect(parseTheme(source)).toBe(document)
})

test("rejects invalid V2 themes when parsing", () => {
  expect(() => parseTheme({ light: { categorical: [] } }, "invalid-v2")).toThrow(
    "Invalid theme: invalid-v2",
  )
})

test("rejects invalid V1 themes when parsing", () => {
  const source = structuredClone(opencodeV1)
  source.defs = { ...source.defs, one: "two", two: "one" }
  source.theme.primary = "one"

  expect(() => parseTheme(source)).toThrow("Circular color reference")
})

test("replacement sources receive independent parse caches", () => {
  const first = structuredClone(opencodeV1)
  const second = structuredClone(opencodeV1)
  second.theme.primary = "#123456"

  const previous = parseTheme(first)
  const next = parseTheme(second)
  expect(next).not.toBe(previous)
  expect(parseTheme(second)).toBe(next)
})

test("hasTheme checks theme presence", () => {
  expect(hasTheme("missing-theme")).toBe(false)
  expect(hasTheme("orchestra")).toBe(true)
  expect(hasTheme("opencode")).toBe(false)
})

test("resolveTheme rejects circular color refs", () => {
  const item = structuredClone(opencodeV1)
  item.defs = { ...item.defs, one: "two", two: "one" }
  item.theme.primary = "one"
  expect(() => resolveTheme(item, "dark")).toThrow("Circular color reference")
})

test("resolveTheme preserves full theme numeric color and marker semantics", () => {
  const item = structuredClone(opencodeV1)
  item.theme.primary = 6
  delete item.theme.selectedListItemText

  const theme = resolveTheme(item, "dark")
  expect(theme.primary.intent).toBe("rgb")
  expect(theme.selectedListItemText).toBe(theme.background)
  expect(theme._hasSelectedListItemText).toBe(false)
})

function terminalColors(defaultBackground: string | null, palette: Array<string | null> = []): TerminalColors {
  return {
    palette,
    defaultForeground: null,
    defaultBackground,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
}

test("terminalMode derives mode from refreshed background", () => {
  expect(terminalMode(terminalColors("#fbf1c7"))).toBe("light")
  expect(terminalMode(terminalColors("#1a1b26"))).toBe("dark")
})

test("terminalMode does not derive mode from ANSI slot zero", () => {
  expect(terminalMode(terminalColors(null, ["#000000"]))).toBeUndefined()
})

test("system theme keeps grayscale surfaces finite when the UI mode disagrees with the terminal", () => {
  const cases = [
    { mode: "light" as const, background: "#000000", foreground: "#ffffff" },
    { mode: "dark" as const, background: "#ffffff", foreground: "#000000" },
  ]
  for (const item of cases) {
    const colors = {
      ...terminalColors(item.background),
      defaultBackground: item.background,
      defaultForeground: item.foreground,
    }
    const generated = generateSystem(colors, item.mode)
    for (const color of [
      generated.theme.backgroundPanel,
      generated.theme.backgroundElement,
      generated.theme.backgroundMenu,
      generated.theme.borderSubtle,
      generated.theme.border,
      generated.theme.borderActive,
    ]) {
      expect(Number.isFinite(color.r)).toBe(true)
      expect(Number.isFinite(color.g)).toBe(true)
      expect(Number.isFinite(color.b)).toBe(true)
    }
  }
})

test("generated system theme repairs terminal colors that would make text disappear", () => {
  const cases = [
    { mode: "dark", background: "#000000", foreground: "#000000" },
    { mode: "light", background: "#ffffff", foreground: "#ffffff" },
    { mode: "dark", background: "#111111", foreground: "#111111" },
    { mode: "light", background: "#f5f5f5", foreground: "#f5f5f5" },
  ] as const

  for (const item of cases) {
    const colors = {
      ...terminalColors(item.background),
      defaultBackground: item.background,
      defaultForeground: item.foreground,
    }
    expect(terminalDefaultForegroundReadable(colors)).toBe(false)

    const generated = generateSystem(colors, item.mode)
    const theme = resolveThemeDocument(parseTheme(generated, `system-${item.mode}`), item.mode)
    const background = RGBA.fromHex(item.background)

    expect(contrastRatio(theme.text.base, background)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(theme.text.muted, background)).toBeGreaterThanOrEqual(3.5)
    expect(contrastRatio(theme.markdown.text, background)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(theme.markdown.link, background)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(generated.theme.selectedListItemText, generated.theme.primary)).toBeGreaterThanOrEqual(4.5)
  }
})

test("custom theme precedence follows directory order", async () => {
  await using tmp = await tmpdir()
  const global = path.join(tmp.path, "global")
  const project = path.join(tmp.path, "project")
  await mkdir(path.join(global, "themes"), { recursive: true })
  await mkdir(path.join(project, "themes"), { recursive: true })
  await writeFile(path.join(global, "themes", "custom.json"), JSON.stringify({ source: "global" }))
  await writeFile(path.join(project, "themes", "custom.json"), JSON.stringify({ source: "project" }))

  await expect(discoverThemes([global, project])).resolves.toEqual({ custom: { source: "project" } })
})

test("built-in theme names a color for every execution backend in both modes", () => {
  const document = getOrchestraTheme()
  for (const mode of ["light", "dark"] as const) {
    const theme = resolveThemeDocument(document, mode)
    expect(theme.text.backend?.bash).toBeDefined()
    expect(theme.text.backend?.nu).toBeDefined()
    expect(theme.text.backend?.pwsh).toBeDefined()
    // a badge is only useful if the backends do not all look the same
    expect(theme.text.backend?.nu).not.toEqual(theme.text.backend?.pwsh)
    expect(theme.text.backend?.bash).not.toEqual(theme.text.backend?.nu)
  }
})

test("a theme without the backend role resolves and leaves the fallback in charge", () => {
  const source: Record<string, unknown> = { ...structuredClone(getOrchestraTheme()) }
  const base = { ...(source.base as Record<string, unknown>) }
  const text = { ...(base.text as Record<string, unknown>) }
  delete text.backend
  base.text = text
  source.base = base

  const document = parseTheme(source, "no-backend")
  const theme = resolveThemeDocument(document, "dark")
  expect(theme.text.backend).toBeUndefined()
  expect(theme.text.muted).toBeDefined()
})

test("theme directories include global config before project directories", async () => {
  await using tmp = await tmpdir()
  const global = path.join(tmp.path, "global")
  const project = path.join(tmp.path, "repo", "package")
  await mkdir(path.join(global, "themes"), { recursive: true })
  await mkdir(path.join(project, ".opencode", "themes"), { recursive: true })
  await writeFile(path.join(global, "themes", "global.json"), JSON.stringify({ source: "global" }))
  await writeFile(path.join(project, ".opencode", "themes", "project.json"), JSON.stringify({ source: "project" }))

  await expect(discoverThemes(configDirectories(global, project))).resolves.toEqual({
    global: { source: "global" },
    project: { source: "project" },
  })
})

test("every registered built-in theme parses and resolves in every mode it declares", () => {
  const sources = allThemes()
  const names = Object.keys(sources).filter((name) => name !== "system")
  expect(names.length).toBeGreaterThan(10)
  for (const name of names) {
    const document = parseTheme(sources[name], name)
    const modes = themeModes(document)
    expect(modes.length).toBeGreaterThan(0)
    for (const mode of modes) {
      const resolved = resolveThemeDocument(document, mode)
      expect(resolved.text.base, `${name}/${mode} text`).toBeDefined()
      expect(resolved.background.base, `${name}/${mode} background`).toBeDefined()
      expect(resolved.border.base, `${name}/${mode} border`).toBeDefined()
      expect(resolved.text.muted, `${name}/${mode} muted text`).toBeDefined()
    }
  }
})
