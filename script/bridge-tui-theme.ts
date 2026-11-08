#!/usr/bin/env bun
/**
 * bridge-tui-theme.ts — generate a Desktop theme JSON from a TUI v2 theme document.
 *
 * The TUI theme engine (packages/theme, documents like
 * packages/tui/src/theme/assets/v2/orchestra.json) is Orchestra's native,
 * richest theme format: full hue scales per mode plus semantic tokens with
 * "$hue.neutral.200"-style references. The desktop/web app consumes a much
 * smaller shape (packages/ui/src/theme/desktop-theme.schema.json): one
 * "palette" of seed colors per mode, from which packages/ui/src/theme/v2
 * generates the --v2-* CSS variable ramps.
 *
 * This script is the bridge: it resolves a TUI v2 document (base + light/dark
 * overlays, alias chains like "red": "$hue.orange") down to concrete hex
 * seeds and syntax overrides, and emits a desktop theme JSON.
 *
 * Mapping (evidence: the hand-ported packages/ui/src/theme/themes/sculk.json
 * follows this same mapping from packages/tui/src/theme/assets/v2/sculk.json):
 *
 *   neutral      := background.base          (sculk dark: exact match #050f15)
 *   ink          := text.base                (sculk both modes: exact match)
 *   primary      := hue.interactive.200      (sculk: hand-tuned ~interactive.200)
 *   interactive  := hue.interactive.200
 *   accent       := hue.accent.300           (sculk both modes: exact match)
 *   success      := hue.green.200   if green is a real scale, else FALLBACK
 *   warning      := hue.orange.200  if orange is a real scale, else FALLBACK
 *   error        := hue.red.200     if red is a real scale, else FALLBACK
 *   info         := hue.blue.200    if blue is a real scale, else FALLBACK
 *   diffAdd      := hue.green.300   if green is a real scale, else FALLBACK
 *   diffDelete   := hue.red.300     if red is a real scale, else FALLBACK
 *
 * TUI themes are allowed to alias semantic hues away (orchestra.json is a
 * cyan/orange duotone: green/red/blue all alias). A terminal can live with
 * that; the desktop needs distinguishable feedback states, so aliased
 * feedback hues fall back to the values the hand-porter invented for
 * sculk.json — already the established Orchestra desktop identity.
 *
 * Usage:
 *   bun script/bridge-tui-theme.ts <tui-v2-theme.json> [--id ID] [--name NAME] [--out PATH]
 *
 * Zero dependencies; also runs under `node` (v22.18+, type stripping).
 */
import { readFileSync, writeFileSync } from "node:fs"

type Json = Record<string, any>

const FEEDBACK_FALLBACK: Record<"light" | "dark", Record<string, string>> = {
  // Source: packages/ui/src/theme/themes/sculk.json (hand-picked Orchestra
  // desktop feedback hues, chosen when the TUI theme aliases the hue away).
  light: {
    success: "#12b57a",
    warning: "#c99a00",
    error: "#e0394d",
    info: "#1a8fd6",
    diffAdd: "#4fbf9b",
    diffDelete: "#d9475c",
  },
  dark: {
    success: "#3dffb0",
    warning: "#ffd75e",
    error: "#ff5c6a",
    info: "#38b6ff",
    diffAdd: "#2fcf9a",
    diffDelete: "#ff6b7d",
  },
}

function resolveRef(doc: Json, mode: string, value: unknown): unknown {
  // Follow "$a.b.c" references, mode overlay first, then base. A hue entry
  // may itself be an alias ("neutral": "$hue.gray"), so a walk can hit a
  // "$" string mid-path: re-anchor the remaining path onto that alias and
  // keep going ("$hue.neutral.800" -> "$hue.gray.800").
  let depth = 0
  while (typeof value === "string" && value.startsWith("$") && depth < 16) {
    depth++
    const parts = value.slice(1).split(".")
    let resolved: unknown
    for (const scope of [mode, "base"]) {
      let node: any = doc[scope]
      let i = 0
      while (i < parts.length && node && typeof node === "object" && parts[i]! in node) {
        node = node[parts[i]!]
        i++
      }
      if (i === parts.length) {
        resolved = node
        break
      }
      if (i > 0 && typeof node === "string" && node.startsWith("$")) {
        resolved = node + "." + parts.slice(i).join(".")
        break
      }
    }
    if (resolved === undefined) return undefined
    value = resolved
  }
  return value
}

function hex(doc: Json, mode: string, ref: string, label: string): string {
  const value = resolveRef(doc, mode, ref)
  if (typeof value !== "string" || !value.startsWith("#")) {
    throw new Error(`bridge-tui-theme: ${label} (${ref}) resolved to ${JSON.stringify(value)}, expected a hex color`)
  }
  return value
}

/** A hue is "real" when the mode defines it as a scale object, not a "$hue.x" alias. */
function realHue(doc: Json, mode: string, name: string): boolean {
  const scale = doc[mode]?.hue?.[name]
  return !!scale && typeof scale === "object"
}

function modePalette(doc: Json, mode: "light" | "dark"): Json {
  const fb = FEEDBACK_FALLBACK[mode]
  const pick = (hueName: string, step: string, fallback: string) =>
    realHue(doc, mode, hueName) ? hex(doc, mode, `$hue.${hueName}.${step}`, `${hueName}.${step}`) : fallback

  return {
    neutral: hex(doc, mode, "$background.base", "background.base"),
    ink: hex(doc, mode, "$text.base", "text.base"),
    primary: hex(doc, mode, "$hue.interactive.200", "interactive.200"),
    accent: realHue(doc, mode, "accent")
      ? hex(doc, mode, "$hue.accent.300", "accent.300")
      : hex(doc, mode, "$hue.interactive.200", "interactive.200"),
    success: pick("green", "200", fb.success),
    warning: pick("orange", "200", fb.warning),
    error: pick("red", "200", fb.error),
    info: pick("blue", "200", fb.info),
    interactive: hex(doc, mode, "$hue.interactive.200", "interactive.200"),
    diffAdd: pick("green", "300", fb.diffAdd),
    diffDelete: pick("red", "300", fb.diffDelete),
  }
}

/** TUI syntax tokens -> desktop v1 override token names (packages/ui/src/theme/resolve.ts). */
const SYNTAX_MAP: Record<string, string> = {
  comment: "syntax-comment",
  keyword: "syntax-keyword",
  string: "syntax-string",
  number: "syntax-primitive",
  type: "syntax-type",
  operator: "syntax-operator",
  punctuation: "syntax-punctuation",
  variable: "syntax-variable",
}

function modeOverrides(doc: Json, mode: "light" | "dark"): Json {
  const out: Record<string, string> = {}
  const muted = resolveRef(doc, mode, "$text.muted")
  if (typeof muted === "string" && muted.startsWith("#")) out["text-weak"] = muted
  for (const [tuiKey, desktopKey] of Object.entries(SYNTAX_MAP)) {
    const value = resolveRef(doc, mode, `$syntax.${tuiKey}`)
    if (typeof value === "string" && value.startsWith("#")) out[desktopKey] = value
  }
  return out
}

function main() {
  const args = process.argv.slice(2)
  const input = args[0]
  if (!input || input.startsWith("-")) {
    console.error("usage: bun script/bridge-tui-theme.ts <tui-v2-theme.json> [--id ID] [--name NAME] [--out PATH]")
    process.exit(1)
  }
  const opt = (flag: string) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }

  const doc: Json = JSON.parse(readFileSync(input, "utf8"))
  for (const key of ["base", "light", "dark"]) {
    if (!doc[key]) throw new Error(`bridge-tui-theme: ${input} is missing the "${key}" section — not a TUI v2 theme document`)
  }

  const id = opt("--id") ?? input.replace(/.*\//, "").replace(/\.json$/, "")
  const name = opt("--name") ?? id

  const theme = {
    $schema:
      "https://raw.githubusercontent.com/NeiP4n/orchestra-app/main/packages/ui/src/theme/desktop-theme.schema.json",
    name,
    id,
    light: { palette: modePalette(doc, "light"), overrides: modeOverrides(doc, "light") },
    dark: { palette: modePalette(doc, "dark"), overrides: modeOverrides(doc, "dark") },
  }

  const out = opt("--out")
  const json = JSON.stringify(theme, null, 2) + "\n"
  if (out) writeFileSync(out, json)
  else process.stdout.write(json)

  // Boot constants for packages/app/public/orchestra-theme-preload.js and the
  // <html>/<meta theme-color> fallbacks in packages/app/index.html: the
  // pre-paint background/text pair per mode.
  console.error(
    `bridge-tui-theme: ${id} boot colors — light bg=${theme.light.palette.neutral} fg=${theme.light.palette.ink}; ` +
      `dark bg=${theme.dark.palette.neutral} fg=${theme.dark.palette.ink}`,
  )
}

main()
