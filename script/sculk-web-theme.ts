import source from "../packages/tui/src/theme/assets/v2/sculk.json" with { type: "json" }
import { parseThemeDocument, resolveThemeDocument, type ResolvedTheme } from "../packages/theme/src/tui/index.js"
import type { DesktopTheme, HexColor, ThemeVariant } from "../packages/ui/src/theme/types"

// TUI Sculk is the source of truth. The web JSON is generated, not hand-tuned.
function hex(value: string): HexColor {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error("Invalid built-in Sculk color")

  return `#${value.slice(1)}`
}

function color(value: ResolvedTheme["text"]["base"]): HexColor {
  return `#${value
    .toInts()
    .slice(0, 3)
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`
}

function variant(mode: "light" | "dark"): ThemeVariant {
  const { gray, cyan, accent } = source[mode].hue
  const tokens = resolveThemeDocument(parseThemeDocument(source, "sculk"), mode)
  const muted = color(tokens.text.muted)
  const bg = color(tokens.background.base)
  const ink = color(tokens.text.base)
  const signal = color(tokens.markdown.link)
  const amber = color(tokens.text.feedback.error.base)

  return {
    palette: {
      neutral: bg,
      ink,
      primary: signal,
      accent: hex(accent[200]),
      success: signal,
      warning: color(tokens.text.feedback.warning.base),
      error: amber,
      info: signal,
      interactive: signal,
      diffAdd: signal,
      diffDelete: amber,
    },
    overrides: {
      "background-base": bg,
      "background-strong": bg,
      "background-weak": hex(gray[700]),
      "background-stronger": hex(gray[900]),
      "text-base": ink,
      "text-strong": ink,
      "text-weak": muted,
      "syntax-comment": color(tokens.syntax.comment),
      "syntax-keyword": color(tokens.syntax.keyword),
      "syntax-function": color(tokens.syntax.function),
      "syntax-string": color(tokens.syntax.string),
      "syntax-primitive": color(tokens.syntax.number),
      "syntax-type": color(tokens.syntax.type),
      "syntax-variable": color(tokens.syntax.variable),
      "syntax-property": signal,
      "syntax-operator": color(tokens.syntax.operator),
      "syntax-punctuation": color(tokens.syntax.punctuation),
      "markdown-heading": color(tokens.markdown.heading),
      "markdown-text": ink,
      "markdown-link": signal,
      "markdown-link-text": signal,
      "markdown-code": signal,
      "markdown-code-block": ink,
      "icon-spark-base": amber,
    },
    v2Overrides: {
      "v2-neural-signal": color(tokens.text.neural?.signal ?? tokens.text.base),
      "v2-neural-synapse": color(tokens.text.neural?.synapse ?? tokens.border.base),
      "v2-neural-spark": color(tokens.text.neural?.spark ?? tokens.text.base),
      "v2-neural-dormant": color(tokens.text.neural?.dormant ?? tokens.text.muted),
      "v2-background-bg-base": bg,
      "v2-background-bg-deep": hex(gray[900]),
      "v2-background-bg-layer-01": bg,
      "v2-background-bg-layer-02": hex(cyan[800]),
      "v2-background-bg-layer-03": hex(gray[700]),
      "v2-background-bg-layer-04": hex(gray[600]),
      "v2-background-bg-contrast": hex(gray[700]),
      "v2-background-bg-inverse": ink,
      "v2-background-bg-accent": signal,
      "v2-background-bg-code-path": hex(cyan[800]),
      "v2-text-text-base": ink,
      "v2-text-text-muted": muted,
      "v2-text-text-faint": color(tokens.text.muted),
      "v2-text-text-inverse": bg,
      "v2-text-text-contrast": ink,
      "v2-text-text-accent": signal,
      "v2-text-text-accent-hover": hex(cyan[100]),
      "v2-text-text-code-accent": signal,
      "v2-text-text-code-path": signal,
      "v2-icon-icon-base": ink,
      "v2-icon-icon-muted": muted,
      "v2-icon-icon-inverse": bg,
      "v2-icon-icon-accent": signal,
      "v2-icon-icon-accent-hover": hex(cyan[100]),
      "v2-border-border-base": hex(cyan[700]),
      "v2-border-border-muted": hex(cyan[800]),
      "v2-border-border-strong": hex(cyan[400]),
      "v2-border-border-focus": signal,
      "v2-state-bg-success": bg,
      "v2-state-fg-success": signal,
      "v2-state-bg-danger": bg,
      "v2-state-fg-danger": amber,
      "v2-state-bg-info": bg,
      "v2-state-fg-info": signal,
      "v2-state-bg-warning": bg,
      "v2-state-fg-warning": color(tokens.text.feedback.warning.base),
    },
  }
}

export function buildSculkWebTheme(): DesktopTheme {
  return { name: "Sculk", id: "sculk", light: variant("light"), dark: variant("dark") }
}

export function sculkBootColors() {
  return {
    light: { background: hex(source.light.hue.gray[800]), color: hex(source.light.hue.gray[200]) },
    dark: { background: hex(source.dark.hue.gray[800]), color: hex(source.dark.hue.gray[200]) },
  }
}

if (import.meta.main) {
  await Bun.write(
    new URL("../packages/ui/src/theme/themes/sculk.json", import.meta.url),
    JSON.stringify(buildSculkWebTheme(), null, 2) + "\n",
  )

  const preload = new URL("../packages/app/public/orchestra-theme-preload.js", import.meta.url)
  const text = await Bun.file(preload).text()
  await Bun.write(
    preload,
    text.replace(
      /var sculkBoot = [\s\S]*?\n  var boot/,
      `var sculkBoot = JSON.parse('${JSON.stringify(sculkBootColors())}')\n  var boot`,
    ),
  )
}
