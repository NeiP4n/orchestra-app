import { describe, expect, test } from "bun:test"

// Regression tests for the black-on-black bug: the non-v2 tokens used to
// switch to dark only inside `@media (prefers-color-scheme: dark)` nested in
// `:root`, so a dark app scheme on a light OS rendered light text tokens
// (--text-strong: #171717) on a dark v2 background. Dark tokens must now
// follow the app color scheme ([data-color-scheme="dark"]), with the OS
// media query only as a fallback before the app chooses a scheme.

const css = await Bun.file(new URL("../theme.css", import.meta.url)).text()

function extractBlock(source: string, selector: string): string {
  const start = source.indexOf(selector)
  if (start === -1) throw new Error(`selector not found: ${selector}`)
  const open = source.indexOf("{", start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++
    if (source[i] === "}") {
      depth--
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error(`unbalanced braces after ${selector}`)
}

function declarations(block: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const match of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(match[1], match[2].trim())
  }
  return map
}

const darkAttribute = extractBlock(css, ':root[data-color-scheme="dark"]')
const darkFallback = extractBlock(css, ':root:not([data-color-scheme="light"])')

describe("theme.css dark tokens", () => {
  test("dark tokens follow the app color scheme, not only the OS", () => {
    expect(darkAttribute).toContain("--text-strong")
    expect(darkFallback).toContain("--text-strong")
  })

  test("attribute and OS-fallback dark blocks define the same variables", () => {
    const attribute = declarations(darkAttribute)
    const fallback = declarations(darkFallback)
    expect([...attribute.keys()].sort()).toEqual([...fallback.keys()].sort())
    for (const [name, value] of attribute) {
      expect(fallback.get(name)).toBe(value)
    }
  })

  test("dark --text-strong is light text, light --text-strong is dark text", () => {
    const light = extractBlock(css, ":root")
    const lightDeclarations = declarations(light)
    expect(lightDeclarations.get("text-strong")).toBe("#171717")
    expect(declarations(darkAttribute).get("text-strong")).toBe("rgba(255, 255, 255, 0.936)")
  })

  test("the light :root block has no OS media query nested inside it", () => {
    const light = extractBlock(css, ":root")
    expect(light).not.toContain("@media")
  })
})
