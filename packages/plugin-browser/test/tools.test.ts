import { expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { basename, dirname } from "node:path"
import { Effect } from "effect"
import { Browser } from "../src/rpc.js"
import { BrowserFiles } from "../src/files.js"
import { BrowserTools } from "../src/tools.js"

const tabID = Browser.TabID.make(`tab_${crypto.randomUUID()}`)
const navigate = (url: string) => BrowserTools.normalizeAction({ type: "navigate", tabID, url })

test("URL normalization rejects filesystem paths instead of treating them as hostnames", () => {
  for (const path of ["/tmp/page.html", "./page.html", "../page.html", "C:\\Users\\me\\page.html", "D:/page.html"])
    expect(() => navigate(path)).toThrow("Unsupported browser URL")
  expect(navigate("example.com/docs")).toEqual({ type: "navigate", tabID, url: "https://example.com/docs" })
  expect(navigate("localhost:8000")).toEqual({ type: "navigate", tabID, url: "http://localhost:8000/" })
  expect(BrowserTools.normalizeAction({ type: "tabs.open" })).toEqual({ type: "tabs.open" })
  expect(BrowserTools.normalizeAction({ type: "tabs.open", url: " " })).toEqual({
    type: "tabs.open",
    url: "about:blank",
  })
})

test("URL normalization fails fast when percent-encoding exceeds the command bound", () => {
  const input = `https://example.com/${"é".repeat(400)}`
  expect(input.length).toBeLessThan(2_048)
  expect(new URL(input).href.length).toBeGreaterThan(2_048)
  expect(() => navigate(input)).toThrow()
})

test("findTabWithURL matches the tab already showing a URL, ignoring slash and fragment", () => {
  const tab = (id: string, url: string): Browser.Tab => ({
    id: Browser.TabID.make(`tab_${id}`),
    url,
    title: "t",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    generation: 0,
  })
  const tabs = [tab("11111111-1111-1111-1111-111111111111", "https://example.com/docs"), tab("22222222-2222-2222-2222-222222222222", "https://other.example")]
  expect(BrowserTools.findTabWithURL(tabs, "https://example.com/docs/")?.url).toBe("https://example.com/docs")
  expect(BrowserTools.findTabWithURL(tabs, "https://example.com/docs#top")?.url).toBe("https://example.com/docs")
  expect(BrowserTools.findTabWithURL(tabs, "https://missing.example")).toBeUndefined()
  expect(BrowserTools.findTabWithURL([], "https://example.com/docs")).toBeUndefined()
})

test("saved capture names never escape their directory or name a Windows device", async () => {
  const file = (name: string) => ({
    id: Browser.FileID.make(`file_${crypto.randomUUID()}`),
    name,
    mime: "text/plain",
    data: new TextEncoder().encode(name),
  })
  const saved = await Effect.runPromise(
    BrowserFiles.save([file(".."), file("."), file("CON.txt"), file("lpt1"), file("report.html")]),
  )
  try {
    expect(saved.map((entry) => basename(entry.path))).toEqual([
      "capture",
      "capture",
      "capture",
      "capture",
      "report.html",
    ])
    expect(saved.map((entry) => entry.name)).toEqual(["..", ".", "CON.txt", "lpt1", "report.html"])
    expect(await Bun.file(saved[0]!.path).text()).toBe("..")
  } finally {
    await rm(dirname(dirname(saved[0]!.path)), { recursive: true, force: true })
  }
})
