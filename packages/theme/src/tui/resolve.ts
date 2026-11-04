import { RGBA } from "@opentui/core"
import { Schema } from "effect"
import { expandTheme, mergeTheme } from "./expand.js"
import {
  ActionState,
  ActionVariant,
  FeedbackKind,
  HueStep,
  SurfaceName,
  ThemeDefinition,
  ThemeDocument,
} from "./schema.js"
import type {
  ActionStateKey,
  ActionStates,
  HueScale,
  Mode,
  ResolvedActionState,
  ResolvedTheme,
  ResolvedThemeTokens,
  StatefulColor,
  StatefulColorDefinition,
  ThemeTokensDefinition,
} from "./index.js"
import { selectThemeMode, themeModes } from "./select.js"

type ResolvedHue = ResolvedThemeTokens["hue"] & Readonly<Record<string, HueScale>>

const decodeThemeDefinitionSchema = Schema.decodeUnknownSync(ThemeDefinition, { reportInput: true })
const decodeThemeDocumentSchema = Schema.decodeUnknownSync(ThemeDocument, { reportInput: true })

function decodeThemeDefinition(input: unknown) {
  try {
    return decodeThemeDefinitionSchema(input)
  } catch (error) {
    throw themeDecodeError(error, "theme")
  }
}

export function themeDecodeError(error: unknown, name: string) {
  const message = Schema.isSchemaError(error) ? error.message : String(error)
  const value = /got ("[^"]*"|\S+)/.exec(message)?.[1] ?? "value"
  return new Error(`Invalid theme: ${name} ${value} is an invalid value`, { cause: error })
}

export function parseThemeDocument(input: unknown, name = "theme") {
  try {
    const document = decodeThemeDocumentSchema(input)
    themeModes(document).forEach((mode) => resolveThemeDocument(document, mode))
    return document
  } catch (error) {
    throw themeDecodeError(error, name)
  }
}

export function resolveThemeDocument(document: ThemeDocument, mode?: Mode) {
  const selected = selectThemeMode(document, mode)
  const definition = expandTheme(selected.theme)
  return resolveExpandedTheme(definition)
}

export function resolveTheme(definition: ThemeDefinition): ResolvedTheme {
  return resolveExpandedTheme(expandTheme(decodeThemeDefinition(definition)))
}

function resolveExpandedTheme(definition: ThemeDefinition): ResolvedTheme {
  const hue = resolveHue(definition.hue)
  const categorical = definition.categorical.map((name) => {
    const scale = hue[name]
    if (!scale) throw new Error(`Categorical hue "${name}" was not found`)
    return scale
  })
  const hueSteps = compileHueSteps(hue)
  const base = tokens(definition)
  const views = {} as Record<SurfaceName, ResolvedTheme>
  const view = (tokens: ThemeTokensDefinition): ResolvedTheme => ({
    ...resolveView(tokens, hue, categorical, hueSteps),
    surface: (name) => views[name],
  })
  views.dialog = definition["@dialog"] ? view(contextualize(base, definition["@dialog"])) : view(base)
  return view(base)
}

function tokens(definition: ThemeDefinition): ThemeTokensDefinition {
  return {
    text: definition.text,
    background: definition.background,
    border: definition.border,
    scrollbar: definition.scrollbar,
    diff: definition.diff,
    syntax: definition.syntax,
    markdown: definition.markdown,
  }
}

function contextualize(base: ThemeTokensDefinition, override: ThemeTokensDefinition) {
  const result = mergeTheme(base, override)
  const text = result["text"] as NonNullable<ThemeTokensDefinition["text"]>
  const background = result["background"] as NonNullable<ThemeTokensDefinition["background"]>
  return {
    ...result,
    text: { ...text, action: contextualActions(base.text?.action, override.text?.action) },
    background: { ...background, action: contextualActions(base.background?.action, override.background?.action) },
  } as ThemeTokensDefinition
}

function contextualActions(
  base: Partial<Record<ActionVariant, StatefulColorDefinition>> | undefined,
  surface: Partial<Record<ActionVariant, StatefulColorDefinition>> | undefined,
) {
  return Object.fromEntries(
    ActionVariant.literals.map((variant) => {
      const baseVariant = base?.[variant]
      const surfaceVariant = surface?.[variant]
      return [
        variant,
        Object.fromEntries(
          (["base", ...ActionState.literals] as readonly ResolvedActionState[]).map((state) => {
            const key = state === "base" ? undefined : (`$${state}` as ActionStateKey)
            return [
              key ?? "base",
              (key ? surfaceVariant?.[key] : undefined) ??
                surfaceVariant?.base ??
                (key ? baseVariant?.[key] : undefined) ??
                baseVariant?.base,
            ]
          }),
        ),
      ]
    }),
  )
}

function resolveView(
  definition: ThemeTokensDefinition,
  hue: ResolvedThemeTokens["hue"],
  categorical: ResolvedThemeTokens["categorical"],
  hueSteps: Pick<ResolvedThemeTokens, "source" | "increase" | "decrease">,
): ResolvedThemeTokens {
  const source: Record<string, unknown> = { hue, ...definition }
  const resolved = ensureReadable(createResolver(source)(source, "theme") as ResolvedThemeTokens)
  return {
    ...resolved,
    hue,
    categorical,
    text: {
      ...resolved.text,
      action: statefulActions(resolved.text.action),
      formfield: statefulColor(resolved.text.formfield),
    },
    background: {
      ...resolved.background,
      action: statefulActions(resolved.background.action),
      formfield: statefulColor(resolved.background.formfield),
    },
    ...hueSteps,
  }
}

// ---------------------------------------------------------------------------
// Readability floor.
//
// A theme may subdue secondary text for hierarchy, but text that carries
// information must stay readable on the surface it renders on. Several shipped
// themes resolved far below that — light variants of dark-first palettes put
// body text near 1.2:1 and inline code near 1.1:1, which is functionally
// invisible. Resolution therefore repairs any text token that falls under its
// floor by blending it away from its background until the floor is met. A
// theme that already meets the floors resolves with its exact authored
// colors; the repair replaces only the offending token's value and never
// mutates the shared hue scales, so hue steps and increase/decrease keep
// referring to the authored palette.
//
// Floors (WCAG ratios): primary text 4.5 (normal text), subdued-but-read
// roles 3.5, and a 3.0 never-disappear floor for muted variants and for any
// text on the raised overlay surface, where themes legitimately compress
// the range.

const PRIMARY_TEXT = 4.5
const SUBDUED_TEXT = 3.5
const NEVER_DISAPPEAR = 3.0

function luminance(color: RGBA, over?: RGBA) {
  let [r, g, b] = [color.r, color.g, color.b]
  if (over && color.a < 1) {
    r = r * color.a + over.r * (1 - color.a)
    g = g * color.a + over.g * (1 - color.a)
    b = b * color.a + over.b * (1 - color.a)
  }
  const channel = (value: number) => (value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4))
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio, or undefined when the background is translucent and the ratio is unknowable. */
function contrast(foreground: RGBA, background: RGBA) {
  if (background.a < 1) return undefined
  const fg = luminance(foreground, background)
  const bg = luminance(background)
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
}

/** The foreground blended away from the background until it reaches the floor; untouched when it already does. */
function lift(foreground: RGBA, background: RGBA, floor: number): RGBA {
  const ratio = contrast(foreground, background)
  if (ratio === undefined || ratio >= floor) return foreground
  const base = {
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a),
  }
  // Blend toward the pole — black or white — that reaches the floor with the
  // smallest change. Picking by the foreground's current side fails when a
  // light theme authors white text on a near-white surface (and vice versa):
  // blending further toward that pole only collapses the ratio. And when a
  // token is checked against several surfaces in sequence, the smallest fix
  // keeps the earlier surfaces' floors intact instead of overshooting to the
  // far pole.
  const toward = (pole: number) => {
    for (let step = 1; step <= 20; step++) {
      const t = step / 20
      const candidate = RGBA.fromValues(
        base.r + (pole - base.r) * t,
        base.g + (pole - base.g) * t,
        base.b + (pole - base.b) * t,
        1,
      )
      if ((contrast(candidate, background) ?? 0) >= floor) return { candidate, t }
    }
    return undefined
  }
  const dark = toward(0)
  const light = toward(1)
  if (dark && light) return dark.t <= light.t ? dark.candidate : light.candidate
  if (dark ?? light) return (dark ?? light)!.candidate
  // A mid-luminance background can make the floor unreachable from either
  // pole; land on the pole with the better ratio rather than the authored one.
  return (contrast(RGBA.fromValues(0, 0, 0, 1), background) ?? 0) >= (contrast(RGBA.fromValues(1, 1, 1, 1), background) ?? 0)
    ? RGBA.fromValues(0, 0, 0, 1)
    : RGBA.fromValues(1, 1, 1, 1)
}

function ensureReadable(resolved: ResolvedThemeTokens): ResolvedThemeTokens {
  const base = resolved.background.base
  const raised = resolved.background.raised.base
  const high = resolved.background.raised.high
  const on = (color: RGBA, floor: number, surface: RGBA) => lift(color, surface, floor)
  const liftBase = (record: Readonly<Record<string, RGBA>>, floor: number, surface: RGBA) =>
    record?.base instanceof RGBA ? { ...record, base: lift(record.base, surface, floor) } : record
  // State text (buttons, form controls) renders on its OWN state background,
  // not on the page surface: lift every state against the matching background
  // state. Interactive states hold the primary floor; the disabled state is
  // intentionally subdued but must never disappear. An opaque state
  // background is the whole story — lifting afterwards against the page
  // surface would fight it (a light red button on a near-black page wants
  // opposite poles). A translucent one shows what is beneath the control, so
  // it is repaired against the composited surface over both plain
  // backgrounds the control can sit on.
  const composite = (top: RGBA, under: RGBA) =>
    RGBA.fromValues(
      top.r * top.a + under.r * (1 - top.a),
      top.g * top.a + under.g * (1 - top.a),
      top.b * top.a + under.b * (1 - top.a),
      1,
    )
  const onSurface = (color: RGBA, surface: RGBA, floor: number) =>
    surface.a >= 1 ? lift(color, surface, floor) : lift(color, composite(surface, base), floor)
  const liftStates = (
    textStates: Readonly<Record<string, RGBA>>,
    bgStates: Readonly<Record<string, RGBA>>,
  ): Readonly<Record<string, RGBA>> =>
    Object.fromEntries(
      Object.entries(textStates).map(([state, color]) => {
        const surface = bgStates[state]
        if (!(color instanceof RGBA) || !(surface instanceof RGBA)) return [state, color]
        const floor = state === "disabled" ? NEVER_DISAPPEAR : PRIMARY_TEXT
        if (surface.a >= 1) return [state, lift(color, surface, floor)]
        return [state, lift(lift(color, composite(surface, base), floor), composite(surface, raised), floor)]
      }),
    )
  return {
    ...resolved,
    text: {
      ...resolved.text,
      base: on(on(on(resolved.text.base, PRIMARY_TEXT, base), PRIMARY_TEXT, raised), NEVER_DISAPPEAR, high),
      muted: on(on(on(resolved.text.muted, PRIMARY_TEXT, base), PRIMARY_TEXT, raised), NEVER_DISAPPEAR, high),
      action: Object.fromEntries(
        Object.entries(resolved.text.action).map(([variant, states]) => [
          variant,
          liftStates(
            states as Readonly<Record<string, RGBA>>,
            resolved.background.action[variant as keyof typeof resolved.background.action] as Readonly<
              Record<string, RGBA>
            >,
          ),
        ]),
      ) as ResolvedThemeTokens["text"]["action"],
      formfield: (() => {
        const lifted = liftStates(
          resolved.text.formfield as Readonly<Record<string, RGBA>>,
          resolved.background.formfield as Readonly<Record<string, RGBA>>,
        )
        return liftBase(lifted, PRIMARY_TEXT, base)
      })() as ResolvedThemeTokens["text"]["formfield"],
      feedback: Object.fromEntries(
        FeedbackKind.literals.map((kind) => {
          const entry = resolved.text.feedback[kind]
          const own = resolved.background.feedback[kind].base
          return [
            kind,
            {
              base: onSurface(on(entry.base, PRIMARY_TEXT, base), own, PRIMARY_TEXT),
              muted: onSurface(on(entry.muted, NEVER_DISAPPEAR, base), own, NEVER_DISAPPEAR),
            },
          ]
        }),
      ) as ResolvedThemeTokens["text"]["feedback"],
      // Both roles are optional in the document schema: a theme written
      // before a role existed resolves without it, and the repair must not
      // invent it (components fall back on their own).
      backend: resolved.text.backend
        ? (Object.fromEntries(
            Object.entries(resolved.text.backend).map(([key, color]) => [
              key,
              color instanceof RGBA ? on(color, NEVER_DISAPPEAR, base) : color,
            ]),
          ) as ResolvedThemeTokens["text"]["backend"])
        : resolved.text.backend,
      neural: resolved.text.neural
        ? (Object.fromEntries(
            Object.entries(resolved.text.neural).map(([key, color]) => [
              key,
              color instanceof RGBA ? on(color, NEVER_DISAPPEAR, base) : color,
            ]),
          ) as ResolvedThemeTokens["text"]["neural"])
        : resolved.text.neural,
    },
    markdown: {
      ...resolved.markdown,
      text: on(resolved.markdown.text, PRIMARY_TEXT, base),
      code: on(on(resolved.markdown.code, PRIMARY_TEXT, base), PRIMARY_TEXT, raised),
      codeBlock: on(on(resolved.markdown.codeBlock, PRIMARY_TEXT, base), PRIMARY_TEXT, raised),
      linkText: on(resolved.markdown.linkText, PRIMARY_TEXT, base),
      blockQuote: on(resolved.markdown.blockQuote, SUBDUED_TEXT, base),
      heading: on(resolved.markdown.heading, NEVER_DISAPPEAR, base),
      link: on(resolved.markdown.link, NEVER_DISAPPEAR, base),
      emphasis: on(resolved.markdown.emphasis, NEVER_DISAPPEAR, base),
      strong: on(resolved.markdown.strong, NEVER_DISAPPEAR, base),
      horizontalRule: on(resolved.markdown.horizontalRule, NEVER_DISAPPEAR, base),
      listItem: on(resolved.markdown.listItem, NEVER_DISAPPEAR, base),
      listEnumeration: on(resolved.markdown.listEnumeration, NEVER_DISAPPEAR, base),
      image: on(resolved.markdown.image, NEVER_DISAPPEAR, base),
      imageText: on(resolved.markdown.imageText, NEVER_DISAPPEAR, base),
    },
    syntax: {
      ...resolved.syntax,
      comment: on(resolved.syntax.comment, SUBDUED_TEXT, base),
      punctuation: on(resolved.syntax.punctuation, PRIMARY_TEXT, base),
      keyword: on(resolved.syntax.keyword, NEVER_DISAPPEAR, base),
      function: on(resolved.syntax.function, NEVER_DISAPPEAR, base),
      variable: on(resolved.syntax.variable, NEVER_DISAPPEAR, base),
      string: on(resolved.syntax.string, NEVER_DISAPPEAR, base),
      number: on(resolved.syntax.number, NEVER_DISAPPEAR, base),
      type: on(resolved.syntax.type, NEVER_DISAPPEAR, base),
      operator: on(resolved.syntax.operator, NEVER_DISAPPEAR, base),
    },
    diff: {
      ...resolved.diff,
      text: {
        ...resolved.diff.text,
        added: on(resolved.diff.text.added, PRIMARY_TEXT, resolved.diff.background.added),
        removed: on(resolved.diff.text.removed, PRIMARY_TEXT, resolved.diff.background.removed),
        context: on(resolved.diff.text.context, PRIMARY_TEXT, resolved.diff.background.context),
        hunkHeader: on(resolved.diff.text.hunkHeader, SUBDUED_TEXT, resolved.diff.background.context),
      },
      lineNumber: {
        ...resolved.diff.lineNumber,
        text: onSurface(
          onSurface(on(resolved.diff.lineNumber.text, NEVER_DISAPPEAR, base), resolved.diff.lineNumber.background.added, NEVER_DISAPPEAR),
          resolved.diff.lineNumber.background.removed,
          NEVER_DISAPPEAR,
        ),
      },
    },
  }
}

function statefulActions(actions: Readonly<Record<ActionVariant, StatefulColor>>) {
  return Object.fromEntries(ActionVariant.literals.map((variant) => [variant, statefulColor(actions[variant])])) as Readonly<
    Record<ActionVariant, StatefulColor>
  >
}

function statefulColor(color: StatefulColor): StatefulColor {
  return {
    ...color,
    state: (states: ActionStates) => color[ActionState.literals.find((state) => states[state]) ?? "base"],
  }
}

function compileHueSteps(
  hue: ResolvedHue,
): Pick<ResolvedThemeTokens, "source" | "increase" | "decrease"> {
  const index = new WeakMap<RGBA, { hue: string; step: HueStep; position: number }>()
  for (const [name, scale] of Object.entries(hue)) {
    HueStep.literals.forEach((step, position) => index.set(scale[step], { hue: name, step, position }))
  }
  const shift = (color: RGBA, amount: number) => {
    const match = index.get(color)
    if (!match) return color
    const offset = Number.isFinite(amount) ? Math.trunc(amount) : 0
    const position = Math.max(0, Math.min(HueStep.literals.length - 1, match.position + offset))
    return hue[match.hue][HueStep.literals[position]]
  }
  return {
    source: (color) => {
      const match = index.get(color)
      return match ? { hue: match.hue, step: match.step } : undefined
    },
    increase: (color, amount = 1) => shift(color, amount),
    decrease: (color, amount = 1) => shift(color, -amount),
  }
}

function resolveHue(definition: ThemeDefinition["hue"]) {
  const source = definition as Record<string, unknown>
  const cache = new Map<string, HueScale>()

  function resolve(name: string, stack: string[]): HueScale {
    const hit = cache.get(name)
    if (hit) return hit
    if (stack.includes(name)) throw new Error(`Circular hue reference: ${[...stack, name].join(" -> ")}`)
    const value = source[name]
    if (typeof value === "string") {
      const match = /^\$hue\.(.+)$/.exec(value)
      if (!match?.[1]) throw new Error(`Hue alias "${value}" must reference a hue scale`)
      if (source[match[1]] === undefined) throw new Error(`Hue alias "${value}" references a missing hue`)
      const target = resolve(match[1], [...stack, name])
      const result = Object.fromEntries(HueStep.literals.map((step) => [step, RGBA.clone(target[step])])) as HueScale
      cache.set(name, result)
      return result
    }
    if (!isRecord(value)) throw new Error(`Hue "${name}" was not found`)
    const result = Object.fromEntries(
      HueStep.literals.map((step) => {
        const color = value[step]
        if (typeof color !== "string" || !isHex(color)) throw new Error(`Invalid hue color at "hue.${name}.${step}"`)
        return [step, RGBA.fromHex(color)]
      }),
    ) as HueScale
    for (const step of Object.keys(value)) {
      if (!HueStep.literals.includes(Number(step) as HueStep))
        throw new Error(`Unknown hue step at "hue.${name}.${step}"`)
    }
    cache.set(name, result)
    return result
  }

  return Object.fromEntries(Object.keys(source).map((name) => [name, resolve(name, [])])) as ResolvedHue
}

function createResolver(source: Record<string, unknown>) {
  const cache = new Map<string, RGBA>()

  function resolve(value: unknown, path: string, stack: string[] = []): unknown {
    if (value instanceof RGBA) return value
    if (typeof value === "string") return resolveColor(value, path, stack)
    if (typeof value === "number") return value
    if (!isRecord(value)) throw new Error(`Invalid theme value at "${path}"`)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [resolvedKey(key), resolve(item, `${path}.${key}`, stack)]),
    )
  }

  function resolveColor(value: string, path: string, stack: string[]) {
    if (value === "transparent") return RGBA.fromInts(0, 0, 0, 0)
    if (isHex(value)) return RGBA.fromHex(value)
    if (!value.startsWith("$")) throw new Error(`Invalid color "${value}" at "${path}"`)
    const target = value.slice(1)
    const hit = cache.get(target)
    if (hit) return hit
    if (stack.includes(target)) throw new Error(`Circular theme reference: ${[...stack, target].join(" -> ")}`)
    const result = resolve(readColor(source, target), target, [...stack, target])
    if (!(result instanceof RGBA)) throw new Error(`Theme reference "${value}" at "${path}" is not a color`)
    cache.set(target, result)
    return result
  }

  return (value: unknown, path: string) => resolve(value, path)
}

function readColor(source: Record<string, unknown>, path: string) {
  const match = /^hue\.(.+)\.(100|200|300|400|500|600|700|800|900)$/.exec(path)
  if (!match?.[1] || !match[2]) return read(source, path)
  const scales = source.hue
  const scale = isRecord(scales) ? scales[match[1]] : undefined
  const color = isRecord(scale) ? scale[match[2]] : undefined
  if (color === undefined) throw new Error(`Theme reference "$${path}" was not found`)
  return color
}

function resolvedKey(key: string) {
  if (!key.startsWith("$")) return key
  const state = key.slice(1)
  return (ActionState.literals as readonly string[]).includes(state) ? state : key
}

function read(source: Record<string, unknown>, path: string) {
  const result = path.split(".").reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), source)
  if (result === undefined) throw new Error(`Theme reference "$${path}" was not found`)
  return result
}

function isHex(value: string) {
  return /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof RGBA)
}
