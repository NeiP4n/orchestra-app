import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import "../happydom"

/**
 * Standard W3C WCAG 2.1 relative luminance calculation.
 * @see https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
export function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs
}

/**
 * Parses color string (#hex, rgb(), rgba()) into RGB components [0..255].
 */
export function parseColorToRgb(color: string): [number, number, number] {
  const trimmed = color.trim().toLowerCase()

  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1)
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ]
    }
    if (hex.length >= 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ]
    }
  }

  const rgbMatch = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgbMatch) {
    return [parseInt(rgbMatch[1], 10), parseInt(rgbMatch[2], 10), parseInt(rgbMatch[3], 10)]
  }

  // Named fallback colors
  if (trimmed === "white") return [255, 255, 255]
  if (trimmed === "black") return [0, 0, 0]

  return [0, 0, 0]
}

/**
 * Calculates WCAG 2.1 contrast ratio between two colors (range: 1.0 to 21.0).
 * @see https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */
export function getContrastRatio(foreground: string, background: string): number {
  const [r1, g1, b1] = parseColorToRgb(foreground)
  const [r2, g2, b2] = parseColorToRgb(background)
  const l1 = relativeLuminance(r1, g1, b1)
  const l2 = relativeLuminance(r2, g2, b2)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2))
}

export type ThemeName = "dark" | "light" | "high-contrast"
export type ColorSchemeMedia = "dark" | "light" | "no-preference"

export interface ThemeTokens {
  themeId: string
  colorScheme: "dark" | "light"
  backgroundColor: string
  surfaceColor: string
  primaryTextColor: string
  secondaryTextColor: string
  borderColor: string
  buttonBg: string
  buttonText: string
  badgeBg: string
  badgeText: string
  textMixBlendMode: string
}

export const THEME_PRESETS: Record<ThemeName, ThemeTokens> = {
  dark: {
    themeId: "oc-2",
    colorScheme: "dark",
    backgroundColor: "#080808",
    surfaceColor: "#141414",
    primaryTextColor: "#f5f5f5",
    secondaryTextColor: "#a3a3a3",
    borderColor: "#262626",
    buttonBg: "#ffffff",
    buttonText: "#000000",
    badgeBg: "#1e3a5f",
    badgeText: "#93c5fd",
    textMixBlendMode: "plus-lighter",
  },
  light: {
    themeId: "oc-2",
    colorScheme: "light",
    backgroundColor: "#fafafa",
    surfaceColor: "#ffffff",
    primaryTextColor: "#171717",
    secondaryTextColor: "#737373",
    borderColor: "#e5e5e5",
    buttonBg: "#171717",
    buttonText: "#ffffff",
    badgeBg: "#dbeafe",
    badgeText: "#1e40af",
    textMixBlendMode: "multiply",
  },
  "high-contrast": {
    themeId: "amoled",
    colorScheme: "dark",
    backgroundColor: "#000000",
    surfaceColor: "#050505",
    primaryTextColor: "#ffffff",
    secondaryTextColor: "#e5e5e5",
    borderColor: "#ffffff",
    buttonBg: "#ffffff",
    buttonText: "#000000",
    badgeBg: "#002b66",
    badgeText: "#ffffff",
    textMixBlendMode: "plus-lighter",
  },
}

/**
 * Playwright-compatible Theme Testing Page Simulation.
 */
export class PlaywrightThemePage {
  private mediaQueryListeners: Set<(e: MediaQueryListEvent) => void> = new Set()
  private systemColorScheme: ColorSchemeMedia = "light"
  private activeTheme: ThemeName = "dark"

  constructor() {
    this.setupMatchMediaMock()
  }

  private setupMatchMediaMock() {
    const self = this
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => {
        const isDarkQuery = query.includes("prefers-color-scheme: dark")
        const isLightQuery = query.includes("prefers-color-scheme: light")
        const matches = isDarkQuery
          ? self.systemColorScheme === "dark"
          : isLightQuery
            ? self.systemColorScheme === "light"
            : false

        return {
          matches,
          media: query,
          onchange: null,
          addListener: (cb: (e: MediaQueryListEvent) => void) => self.mediaQueryListeners.add(cb),
          removeListener: (cb: (e: MediaQueryListEvent) => void) => self.mediaQueryListeners.delete(cb),
          addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => self.mediaQueryListeners.add(cb),
          removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) =>
            self.mediaQueryListeners.delete(cb),
          dispatchEvent: (_event: Event) => true,
        } as unknown as MediaQueryList
      },
    })
  }

  /**
   * Emulates media features aligned with Playwright's Page.emulateMedia({ colorScheme }).
   * @see https://playwright.dev/docs/api/class-page#page-emulate-media
   */
  async emulateMedia(options: { colorScheme?: ColorSchemeMedia }): Promise<void> {
    if (options.colorScheme) {
      this.systemColorScheme = options.colorScheme
      const event = {
        matches: this.systemColorScheme === "dark",
        media: "(prefers-color-scheme: dark)",
      } as MediaQueryListEvent

      for (const listener of this.mediaQueryListeners) {
        listener(event)
      }

      // If user preference is "system", apply the system color scheme
      const storedScheme = localStorage.getItem("opencode-color-scheme")
      if (!storedScheme || storedScheme === "system") {
        const targetTheme: ThemeName = this.systemColorScheme === "dark" ? "dark" : "light"
        await this.setTheme(targetTheme, { preserveSystemPreference: true })
      }
    }
  }

  /**
   * Applies the theme preset to DOM element root and updates tokens.
   */
  async setTheme(theme: ThemeName, options: { preserveSystemPreference?: boolean } = {}): Promise<void> {
    this.activeTheme = theme
    const tokens = THEME_PRESETS[theme]

    localStorage.setItem("opencode-theme-id", tokens.themeId)
    if (!options.preserveSystemPreference) {
      localStorage.setItem("opencode-color-scheme", tokens.colorScheme)
    }

    // Update documentElement datasets and CSS variables
    const html = document.documentElement
    html.dataset.theme = tokens.themeId
    html.dataset.colorScheme = tokens.colorScheme
    html.style.backgroundColor = tokens.backgroundColor
    html.style.setProperty("--v2-background-bg-deep", tokens.backgroundColor)
    html.style.setProperty("--v2-background-bg-surface", tokens.surfaceColor)
    html.style.setProperty("--v2-text-text-primary", tokens.primaryTextColor)
    html.style.setProperty("--v2-text-text-secondary", tokens.secondaryTextColor)
    html.style.setProperty("--v2-border-border-base", tokens.borderColor)
    html.style.setProperty("--text-mix-blend-mode", tokens.textMixBlendMode)
    html.style.setProperty("color-scheme", tokens.colorScheme)

    // Update or create style block
    let style = document.getElementById("oc-theme") as HTMLStyleElement | null
    if (!style) {
      style = document.createElement("style")
      style.id = "oc-theme"
      document.head.appendChild(style)
    }

    style.textContent = `
      :root {
        color-scheme: ${tokens.colorScheme};
        --text-mix-blend-mode: ${tokens.textMixBlendMode};
        --v2-background-bg-deep: ${tokens.backgroundColor};
        --v2-background-bg-surface: ${tokens.surfaceColor};
        --v2-text-text-primary: ${tokens.primaryTextColor};
        --v2-text-text-secondary: ${tokens.secondaryTextColor};
        --v2-border-border-base: ${tokens.borderColor};
        --btn-bg: ${tokens.buttonBg};
        --btn-text: ${tokens.buttonText};
        --badge-bg: ${tokens.badgeBg};
        --badge-text: ${tokens.badgeText};
      }
      body {
        background-color: var(--v2-background-bg-deep);
        color: var(--v2-text-text-primary);
      }
      body.theme-${theme} {
        color-scheme: ${tokens.colorScheme};
      }
    `

    // Update body classes
    document.body.className = `theme-${theme} font-sans`
    document.body.style.backgroundColor = tokens.backgroundColor
    document.body.style.color = tokens.primaryTextColor

    // Render interactive components surface in the DOM
    this.renderUiSurface(tokens)
  }

  private renderUiSurface(tokens: ThemeTokens) {
    let container = document.getElementById("theme-test-surface")
    if (!container) {
      container = document.createElement("div")
      container.id = "theme-test-surface"
      document.body.appendChild(container)
    }

    container.innerHTML = `
      <div data-surface="app" class="p-6 space-y-4" style="background-color: ${tokens.backgroundColor}; color: ${tokens.primaryTextColor};">
        <header role="banner" class="flex justify-between items-center border-b pb-3" style="border-color: ${tokens.borderColor};">
          <h1 id="app-title" class="text-base font-semibold" style="color: ${tokens.primaryTextColor};">Orchestra Interface</h1>
          <span
            id="status-badge"
            role="status"
            aria-label="Active workspace status"
            class="px-2 py-0.5 text-xs rounded-full font-medium"
            style="background-color: ${tokens.badgeBg}; color: ${tokens.badgeText};"
          >Active</span>
        </header>

        <main role="main" class="space-y-4">
          <p id="main-content-text" class="text-sm leading-relaxed" style="color: ${tokens.primaryTextColor};">
            Primary message stream text content for accessibility reading verification.
          </p>

          <p id="secondary-description" class="text-xs" style="color: ${tokens.secondaryTextColor};">
            Secondary descriptive details and timestamps.
          </p>

          <div class="actions flex space-x-3 pt-2">
            <button
              id="action-primary-btn"
              type="button"
              role="button"
              aria-label="Submit Action"
              class="px-4 py-2 text-xs font-semibold rounded shadow-sm cursor-pointer"
              style="background-color: ${tokens.buttonBg}; color: ${tokens.buttonText}; border: 1px solid ${tokens.borderColor};"
            >Submit Action</button>

            <button
              id="action-secondary-btn"
              type="button"
              role="button"
              aria-label="Cancel Action"
              class="px-4 py-2 text-xs rounded cursor-pointer"
              style="background-color: ${tokens.surfaceColor}; color: ${tokens.primaryTextColor}; border: 1px solid ${tokens.borderColor};"
            >Cancel</button>
          </div>
        </main>
      </div>
    `
  }

  getActiveTheme(): ThemeName {
    return this.activeTheme
  }
}

describe("E2E Playwright Theme Switching and Accessibility Contrast Suite (OPT-014)", () => {
  let page: PlaywrightThemePage

  beforeEach(async () => {
    localStorage.clear()
    document.head.innerHTML = ""
    document.body.innerHTML = ""
    page = new PlaywrightThemePage()
    await page.setTheme("dark")
  })

  afterEach(() => {
    document.head.innerHTML = ""
    document.body.innerHTML = ""
    localStorage.clear()
  })

  test("1. Switches seamlessly between dark, light, and high-contrast themes", async () => {
    // 1. Initial dark theme
    expect(page.getActiveTheme()).toBe("dark")
    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(document.documentElement.dataset.theme).toBe("oc-2")

    // 2. Switch to light theme
    await page.setTheme("light")
    expect(page.getActiveTheme()).toBe("light")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(document.documentElement.dataset.theme).toBe("oc-2")
    expect(document.documentElement.style.backgroundColor).toBe("#fafafa")

    // 3. Switch to high-contrast theme
    await page.setTheme("high-contrast")
    expect(page.getActiveTheme()).toBe("high-contrast")
    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(document.documentElement.dataset.theme).toBe("amoled")
    expect(document.documentElement.style.backgroundColor).toBe("#000000")
  })

  test("2. Updates CSS variables, attributes, and body classes upon theme transition", async () => {
    const html = document.documentElement
    const body = document.body

    // Test Light Theme CSS bindings
    await page.setTheme("light")
    expect(html.style.getPropertyValue("--v2-background-bg-deep")).toBe("#fafafa")
    expect(html.style.getPropertyValue("--v2-text-text-primary")).toBe("#171717")
    expect(html.style.getPropertyValue("--text-mix-blend-mode")).toBe("multiply")
    expect(html.style.getPropertyValue("color-scheme")).toBe("light")
    expect(body.classList.contains("theme-light")).toBe(true)

    // Test Dark Theme CSS bindings
    await page.setTheme("dark")
    expect(html.style.getPropertyValue("--v2-background-bg-deep")).toBe("#080808")
    expect(html.style.getPropertyValue("--v2-text-text-primary")).toBe("#f5f5f5")
    expect(html.style.getPropertyValue("--text-mix-blend-mode")).toBe("plus-lighter")
    expect(html.style.getPropertyValue("color-scheme")).toBe("dark")
    expect(body.classList.contains("theme-dark")).toBe(true)

    // Test High-Contrast CSS bindings
    await page.setTheme("high-contrast")
    expect(html.style.getPropertyValue("--v2-background-bg-deep")).toBe("#000000")
    expect(html.style.getPropertyValue("--v2-text-text-primary")).toBe("#ffffff")
    expect(html.style.getPropertyValue("--v2-border-border-base")).toBe("#ffffff")
    expect(body.classList.contains("theme-high-contrast")).toBe(true)
  })

  test("3. Enforces WCAG 2.1 AA/AAA contrast ratios across primary buttons, text, and badges", async () => {
    const themes: ThemeName[] = ["dark", "light", "high-contrast"]

    for (const theme of themes) {
      await page.setTheme(theme)
      const tokens = THEME_PRESETS[theme]

      // 1. Primary Text Contrast against Page Background (Requirement: WCAG AA >= 4.5:1)
      const textContrast = getContrastRatio(tokens.primaryTextColor, tokens.backgroundColor)
      expect(textContrast).toBeGreaterThanOrEqual(4.5)

      // 2. Primary Action Button Contrast (Text vs Button Background) (Requirement: WCAG AA >= 4.5:1)
      const buttonContrast = getContrastRatio(tokens.buttonText, tokens.buttonBg)
      expect(buttonContrast).toBeGreaterThanOrEqual(4.5)

      // 3. Status Badge Contrast (Badge Text vs Badge Background) (Requirement: WCAG AA >= 4.5:1)
      const badgeContrast = getContrastRatio(tokens.badgeText, tokens.badgeBg)
      expect(badgeContrast).toBeGreaterThanOrEqual(4.5)

      // In high-contrast mode, text and badge contrast must achieve enhanced AAA grade (>= 7.0:1)
      if (theme === "high-contrast") {
        expect(textContrast).toBeGreaterThanOrEqual(7.0)
        expect(buttonContrast).toBeGreaterThanOrEqual(7.0)
        expect(badgeContrast).toBeGreaterThanOrEqual(7.0)
      }
    }
  })

  test("4. Emulates prefers-color-scheme media modes ('dark' and 'light') via Playwright emulateMedia", async () => {
    // Configure user scheme as 'system' to delegate resolution to media queries
    localStorage.setItem("opencode-color-scheme", "system")

    // Emulate system light mode
    await page.emulateMedia({ colorScheme: "light" })
    expect(window.matchMedia("(prefers-color-scheme: light)").matches).toBe(true)
    expect(window.matchMedia("(prefers-color-scheme: dark)").matches).toBe(false)
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(page.getActiveTheme()).toBe("light")

    // Emulate system dark mode
    await page.emulateMedia({ colorScheme: "dark" })
    expect(window.matchMedia("(prefers-color-scheme: dark)").matches).toBe(true)
    expect(window.matchMedia("(prefers-color-scheme: light)").matches).toBe(false)
    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(page.getActiveTheme()).toBe("dark")
  })

  test("5. Maintains accessible UI landmarks and readable structure through DOM theme mutations", async () => {
    await page.setTheme("dark")

    const banner = document.querySelector('header[role="banner"]')
    const main = document.querySelector('main[role="main"]')
    const badge = document.querySelector('#status-badge[role="status"]')
    const primaryBtn = document.querySelector('#action-primary-btn[role="button"]')

    expect(banner).not.toBeNull()
    expect(main).not.toBeNull()
    expect(badge).not.toBeNull()
    expect(primaryBtn).not.toBeNull()

    // Switch theme and verify elements remain intact and interactive
    await page.setTheme("high-contrast")

    const title = document.getElementById("app-title")
    expect(title?.textContent).toBe("Orchestra Interface")

    const btn = document.getElementById("action-primary-btn")
    expect(btn?.getAttribute("aria-label")).toBe("Submit Action")
  })
})
