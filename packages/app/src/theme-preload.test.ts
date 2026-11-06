import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/orchestra-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

const setSystemDark = (matches: boolean) =>
  Object.defineProperty(window, "matchMedia", {
    value: () => ({ matches }) as MediaQueryList,
    configurable: true,
  })

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  document.documentElement.style.removeProperty("background-color")
  document.documentElement.style.removeProperty("color")
  localStorage.clear()
  setSystemDark(false)
})

describe("theme preload", () => {
  test.each([
    { stored: undefined, systemDark: false, scheme: "light", background: "#fafafa", color: "#171717" },
    { stored: "dark", systemDark: false, scheme: "dark", background: "#080808", color: "#eeeeee" },
    { stored: "light", systemDark: true, scheme: "light", background: "#fafafa", color: "#171717" },
    { stored: "system", systemDark: true, scheme: "dark", background: "#080808", color: "#eeeeee" },
  ])(
    "paints the default theme in $scheme for stored scheme $stored (system dark: $systemDark)",
    ({ stored, systemDark, scheme, background, color }) => {
      setSystemDark(systemDark)

      if (stored) localStorage.setItem("opencode-color-scheme", stored)
      run()

      expect(document.documentElement.dataset.theme).toBe("oc-2")
      expect(document.documentElement.dataset.colorScheme).toBe(scheme)
      expect(document.documentElement.style.backgroundColor).toBe(background)
      // Inherited text must stay readable on the dark v2 background before
      // ThemeProvider mounts: no black text on a black background.
      expect(document.documentElement.style.color).toBe(color)
    },
  )

  test("defaults to sculk on desktop (window.electron present) with no stored theme", () => {
    Object.defineProperty(window, "electron", { value: {}, configurable: true })

    try {
      run()

      expect(document.documentElement.dataset.theme).toBe("sculk")
    } finally {
      // @ts-expect-error removing the test-only desktop marker
      delete window.electron
    }
  })

  test.each([
    { scheme: undefined, key: "opencode-theme-css-light", css: "--background-base:#fff;", expected: "light" },
    { scheme: "dark", key: "opencode-theme-css-dark", css: "--background-base:#010203;", expected: "dark" },
  ])("restores the cached $expected css of a custom theme", ({ scheme, key, css, expected }) => {
    localStorage.setItem("opencode-theme-id", "nightowl")

    if (scheme) localStorage.setItem("opencode-color-scheme", scheme)
    localStorage.setItem(key, css)
    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.documentElement.dataset.colorScheme).toBe(expected)
    expect(document.getElementById("orchestra-theme-preload")?.textContent).toContain(css)
  })
})
