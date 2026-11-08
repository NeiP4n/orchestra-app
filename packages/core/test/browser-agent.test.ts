import { describe, expect, test } from "bun:test"
import { BrowserBridge } from "../src/browser/bridge"
import { BrowserPage } from "../src/browser/page"
import { Chrome } from "../src/browser/chrome"
import { acts } from "../src/tool/plugin/browser"

describe("browser selection bridge", () => {
  test("the most specific project directory decides the session", () => {
    const map = { "/w/Work": "brw_a", "/w/Work/VsPlugin": "brw_b" }
    expect(BrowserBridge.selectedFor(map, "/w/Work/VsPlugin/src")).toBe("brw_b")
    expect(BrowserBridge.selectedFor(map, "/w/Work/notes")).toBe("brw_a")
    expect(BrowserBridge.selectedFor(map, "/w/Other")).toBeUndefined()
    expect(BrowserBridge.selectedFor(map, "/w/WorkSpace")).toBeUndefined()
  })

  test("Windows paths match regardless of slash and case", () => {
    const map = { "C:\\Users\\m\\WORKAI": "brw_w" }
    expect(BrowserBridge.selectedFor(map, "c:/users/m/workai/app")).toBe("brw_w")
  })

  test("a broken file reads as empty, and a selection is set or removed", () => {
    expect(BrowserBridge.parse("not json")).toEqual({})
    expect(BrowserBridge.parse("[1]")).toEqual({})
    expect(BrowserBridge.parse('{"a":"b","c":3}')).toEqual({ a: "b" })
    const set = BrowserBridge.withSelection({}, "/p", "brw_1")
    expect(set).toEqual({ "/p": "brw_1" })
    expect(BrowserBridge.withSelection(set, "/p", undefined)).toEqual({})
  })
})

describe("page scripts", () => {
  test("a hostile selector or text stays inside its string", () => {
    const hostile = `a"]; alert(1); //'\``
    for (const expression of [
      BrowserPage.clickExpression({ selector: hostile }),
      BrowserPage.clickExpression({ text: hostile }),
      BrowserPage.typeExpression({ selector: hostile, text: hostile }),
    ])
      expect(() => new Function(`return ${expression}`)).not.toThrow()
  })

  test("click needs a target", () => {
    expect(() => BrowserPage.clickExpression({})).toThrow()
  })
})

describe("tool rules", () => {
  test("only open, click and type ask first", () => {
    expect(["open", "click", "type"].every((action) => acts(action as never))).toBe(true)
    expect(["text", "info", "screenshot"].some((action) => acts(action as never))).toBe(false)
  })

  test("a Chrome that is already running is joined only when its port answers", async () => {
    const file = (text: string | undefined) => () => text
    const up = async () => true
    const down = async () => false
    expect(await Chrome.livePort(file("9333\n/devtools/browser/x"), up, "/p")).toBe(9333)
    expect(await Chrome.livePort(file("9333\n/devtools/browser/x"), down, "/p")).toBeUndefined()
    expect(await Chrome.livePort(file(undefined), up, "/p")).toBeUndefined()
  })
})
