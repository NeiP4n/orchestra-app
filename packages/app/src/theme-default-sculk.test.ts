import { beforeEach, describe, expect, test } from "bun:test"

// The served web UI defaults to the sculk theme (the TUI look), the same as the desktop shell.
// A stored theme always wins; even an untagged surface starts on the current TUI default.
const preload = await Bun.file(new URL("../public/orchestra-theme-preload.js", import.meta.url)).text()

const html = await Bun.file(new URL("../index.html", import.meta.url)).text()

const entry = await Bun.file(new URL("./entry.tsx", import.meta.url)).text()

const run = () => Function(preload)()

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  // SAFETY: the preload reads only matches; this fixture never exposes the omitted MediaQueryList members.
  Object.defineProperty(window, "matchMedia", {
    value: () => ({ matches: true }) as MediaQueryList,
    configurable: true,
  })
})

const optIn = () => {
  const meta = document.createElement("meta")
  meta.setAttribute("name", "orchestra-default-theme")
  meta.setAttribute("content", "sculk")
  document.head.appendChild(meta)
}

describe("web default theme", () => {
  test("index.html opts the web UI in to sculk before the preload script runs", () => {
    const meta = html.indexOf('name="orchestra-default-theme" content="sculk"')
    const script = html.indexOf("orchestra-theme-preload.js")
    expect(meta).toBeGreaterThan(-1)
    expect(meta).toBeLessThan(script)
  })

  test("the preload paints sculk on the web when the page opts in and nothing is stored", () => {
    optIn()
    run()
    expect(document.documentElement.dataset.theme).toBe("sculk")
  })

  test("a stored theme wins over the opt-in, so oc-2 and orchestra stay selectable", () => {
    optIn()

    for (const id of ["oc-2", "orchestra"]) {
      localStorage.setItem("opencode-theme-id", id)
      run()
      expect(document.documentElement.dataset.theme).toBe(id)
    }
  })

  test("a page without the tag still uses the current sculk default", () => {
    run()
    expect(document.documentElement.dataset.theme).toBe("sculk")
  })

  test("the web entry passes sculk to the theme provider", () => {
    expect(entry).toContain('<AppBaseProviders locale={locale} defaultTheme="sculk">')
  })
})
