import { expect, test } from "bun:test"
import {
  decodeDuckDuckGo,
  parseDuckDuckGo,
  USER_AGENT,
} from "@orchestra/core/tool/plugin/open-search"

test("decodeDuckDuckGo extracts target url from uddg query parameter", () => {
  const url = decodeDuckDuckGo("//duckduckgo.com/l/?uddg=https%3A%2F%2Feffect.website%2Fdocs&rut=1")
  expect(url).toBe("https://effect.website/docs")
})

test("decodeDuckDuckGo leaves clean absolute urls intact", () => {
  const url = decodeDuckDuckGo("https://example.com/page")
  expect(url).toBe("https://example.com/page")
})

test("decodeDuckDuckGo discards empty or duckduckgo internal urls", () => {
  expect(decodeDuckDuckGo("")).toBeUndefined()
  expect(decodeDuckDuckGo("https://duckduckgo.com/about")).toBeUndefined()
})

test("parseDuckDuckGo extracts titles, links, and snippets from HTML", () => {
  const sampleHtml = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Feffect.website%2Fdocs">Effect Documentation</a>
      <a class="result__snippet">Build robust, type-safe software in TypeScript using Effect.</a>
    </div>
    <div class="result">
      <a class="result-link" href="https://github.com/Effect-TS/effect">GitHub - Effect-TS/effect</a>
      <a class="result__snippet">A fully-fledged functional standard library for TypeScript.</a>
    </div>
  `
  const results = parseDuckDuckGo(sampleHtml)
  expect(results.length).toBe(2)
  expect(results[0]).toEqual({
    title: "Effect Documentation",
    url: "https://effect.website/docs",
    snippet: "Build robust, type-safe software in TypeScript using Effect.",
  })
  expect(results[1]).toEqual({
    title: "GitHub - Effect-TS/effect",
    url: "https://github.com/Effect-TS/effect",
    snippet: "A fully-fledged functional standard library for TypeScript.",
  })
})

test("USER_AGENT is present and valid", () => {
  expect(USER_AGENT).toContain("Mozilla/5.0")
})

test("parseDuckDuckGo respects max limit", () => {
  const html = `
    <a class="result__a" href="https://example1.com">Title 1</a>
    <a class="result__a" href="https://example2.com">Title 2</a>
    <a class="result__a" href="https://example3.com">Title 3</a>
  `
  const results = parseDuckDuckGo(html, 2)
  expect(results.length).toBe(2)
  expect(results[0].url).toBe("https://example1.com/")
  expect(results[1].url).toBe("https://example2.com/")
})
