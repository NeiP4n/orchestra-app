import { RGBA, type TerminalColors } from "@opentui/core"
import { ansiToRgba, tint } from "./color"

const PRIMARY_TEXT_CONTRAST = 4.5
const MUTED_TEXT_CONTRAST = 3.5

function luminance(color: RGBA) {
  const channel = (value: number) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/** WCAG contrast ratio after compositing a translucent foreground over an opaque terminal background. */
export function contrastRatio(foreground: RGBA, background: RGBA) {
  const visible = RGBA.fromValues(
    foreground.r * foreground.a + background.r * (1 - foreground.a),
    foreground.g * foreground.a + background.g * (1 - foreground.a),
    foreground.b * foreground.a + background.b * (1 - foreground.a),
    1,
  )
  const fg = luminance(visible)
  const bg = luminance(background)
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
}

/** Keep the authored hue where possible; otherwise move the smallest distance toward black or white. */
function readableColor(foreground: RGBA, background: RGBA, minimum: number) {
  if (contrastRatio(foreground, background) >= minimum) return foreground

  const base = {
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a),
  }
  const toward = (pole: number) => {
    for (let step = 1; step <= 100; step++) {
      const amount = step / 100
      const candidate = RGBA.fromValues(
        base.r + (pole - base.r) * amount,
        base.g + (pole - base.g) * amount,
        base.b + (pole - base.b) * amount,
        1,
      )
      if (contrastRatio(candidate, background) >= minimum) return { color: candidate, amount }
    }
  }

  const dark = toward(0)
  const light = toward(1)
  if (dark && light) return dark.amount <= light.amount ? dark.color : light.color
  if (dark ?? light) return (dark ?? light)!.color
  return contrastRatio(RGBA.fromValues(0, 0, 0, 1), background) >=
    contrastRatio(RGBA.fromValues(1, 1, 1, 1), background)
    ? RGBA.fromValues(0, 0, 0, 1)
    : RGBA.fromValues(1, 1, 1, 1)
}

/** Whether preserving the terminal's own foreground would leave normal text readable. */
export function terminalDefaultForegroundReadable(colors: TerminalColors, minimum = PRIMARY_TEXT_CONTRAST) {
  const background = colors.defaultBackground ?? colors.palette[0]
  const foreground = colors.defaultForeground ?? colors.palette[7]
  if (!background || !foreground) return false
  return contrastRatio(RGBA.fromHex(foreground), RGBA.fromHex(background)) >= minimum
}

export function terminalMode(colors: TerminalColors): "dark" | "light" | undefined {
  const bg = colors.defaultBackground
  if (!bg) return
  const { r, g, b } = RGBA.fromHex(bg)
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.5 ? "light" : "dark"
}

export function generateSystem(colors: TerminalColors, mode: "dark" | "light") {
  const bg = RGBA.fromHex(colors.defaultBackground ?? colors.palette[0]!)
  const terminalForeground = RGBA.fromHex(colors.defaultForeground ?? colors.palette[7]!)
  const fg = readableColor(terminalForeground, bg, PRIMARY_TEXT_CONTRAST)
  const transparent = RGBA.fromValues(bg.r, bg.g, bg.b, 0)
  const isDark = mode === "dark"

  const col = (index: number) => {
    const value = colors.palette[index]
    const color = value ? RGBA.fromHex(value) : ansiToRgba(index)
    return readableColor(color, bg, PRIMARY_TEXT_CONTRAST)
  }

  const grays = generateGrayScale(bg, isDark)
  const textMuted = readableColor(generateMutedTextColor(bg, isDark), bg, MUTED_TEXT_CONTRAST)
  const ansiColors = {
    red: col(1),
    green: col(2),
    yellow: col(3),
    blue: col(4),
    magenta: col(5),
    cyan: col(6),
    redBright: col(9),
    greenBright: col(10),
  }

  const diffAlpha = isDark ? 0.22 : 0.14
  const diffAddedBg = tint(bg, ansiColors.green, diffAlpha)
  const diffRemovedBg = tint(bg, ansiColors.red, diffAlpha)
  const diffContextBg = grays[2]
  const diffAddedLineNumberBg = tint(diffContextBg, ansiColors.green, diffAlpha)
  const diffRemovedLineNumberBg = tint(diffContextBg, ansiColors.red, diffAlpha)

  return {
    theme: {
      primary: ansiColors.cyan,
      secondary: ansiColors.magenta,
      accent: ansiColors.cyan,
      error: ansiColors.red,
      warning: ansiColors.yellow,
      success: ansiColors.green,
      info: ansiColors.cyan,
      text: fg,
      textMuted,
      selectedListItemText: readableColor(bg, ansiColors.cyan, PRIMARY_TEXT_CONTRAST),
      background: transparent,
      backgroundPanel: grays[2],
      backgroundElement: grays[3],
      backgroundMenu: grays[3],
      borderSubtle: grays[6],
      border: grays[7],
      borderActive: grays[8],
      diffAdded: ansiColors.green,
      diffRemoved: ansiColors.red,
      diffContext: grays[7],
      diffHunkHeader: grays[7],
      diffHighlightAdded: ansiColors.greenBright,
      diffHighlightRemoved: ansiColors.redBright,
      diffAddedBg,
      diffRemovedBg,
      diffContextBg,
      diffLineNumber: textMuted,
      diffAddedLineNumberBg,
      diffRemovedLineNumberBg,
      markdownText: fg,
      markdownHeading: fg,
      markdownLink: ansiColors.blue,
      markdownLinkText: ansiColors.cyan,
      markdownCode: ansiColors.green,
      markdownBlockQuote: ansiColors.yellow,
      markdownEmph: ansiColors.yellow,
      markdownStrong: fg,
      markdownHorizontalRule: grays[7],
      markdownListItem: ansiColors.blue,
      markdownListEnumeration: ansiColors.cyan,
      markdownImage: ansiColors.blue,
      markdownImageText: ansiColors.cyan,
      markdownCodeBlock: fg,
      syntaxComment: textMuted,
      syntaxKeyword: ansiColors.magenta,
      syntaxFunction: ansiColors.blue,
      syntaxVariable: fg,
      syntaxString: ansiColors.green,
      syntaxNumber: ansiColors.yellow,
      syntaxType: ansiColors.cyan,
      syntaxOperator: ansiColors.cyan,
      syntaxPunctuation: fg,
    },
  }
}

function generateGrayScale(bg: RGBA, isDark: boolean): Record<number, RGBA> {
  const grays: Record<number, RGBA> = {}
  const bgR = bg.r * 255
  const bgG = bg.g * 255
  const bgB = bg.b * 255
  const luminance = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB

  for (let i = 1; i <= 12; i++) {
    const factor = i / 12

    // Handle terminal extremes independently of the selected UI mode. A user may
    // force light mode in a terminal whose actual background is black (or vice versa);
    // dividing by a zero luminance in that case creates NaN surfaces and broken borders.
    if (luminance < 10) {
      const gray = Math.floor(factor * 0.4 * 255)
      grays[i] = RGBA.fromInts(gray, gray, gray)
      continue
    }

    if (luminance > 245) {
      const gray = Math.floor(255 - factor * 0.4 * 255)
      grays[i] = RGBA.fromInts(gray, gray, gray)
      continue
    }

    const next = isDark ? luminance + (255 - luminance) * factor * 0.4 : luminance * (1 - factor * 0.4)
    const ratio = next / luminance
    grays[i] = RGBA.fromInts(
      Math.floor(Math.min(Math.max(bgR * ratio, 0), 255)),
      Math.floor(Math.min(Math.max(bgG * ratio, 0), 255)),
      Math.floor(Math.min(Math.max(bgB * ratio, 0), 255)),
    )
  }

  return grays
}

function generateMutedTextColor(bg: RGBA, isDark: boolean): RGBA {
  const luminance = 0.299 * bg.r * 255 + 0.587 * bg.g * 255 + 0.114 * bg.b * 255
  if (isDark) {
    const gray = luminance < 10 ? 180 : Math.min(Math.floor(160 + luminance * 0.3), 200)
    return RGBA.fromInts(gray, gray, gray)
  }

  const gray = luminance > 245 ? 75 : Math.max(Math.floor(100 - (255 - luminance) * 0.2), 60)
  return RGBA.fromInts(gray, gray, gray)
}
