import { describe, expect, test } from "bun:test"
import { BrowserBridge } from "../src/browser/bridge"
import { BrowserPage } from "../src/browser/page"
import { Cdp } from "../src/browser/cdp"
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

describe("screencast", () => {
  const fake = () => {
    const sent: string[] = []
    const socket: Cdp.Socket = {
      send: (data) => {
        const message = JSON.parse(data) as { id: number; method: string }
        sent.push(message.method)
        queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ id: message.id, result: {} }) }))
      },
      close: () => {},
      onmessage: null,
      onclose: null,
      onerror: null,
      onopen: null,
    }
    return { sent, socket }
  }

  test("frames reach the listener, each is acknowledged, and stopping ends the stream", async () => {
    const { sent, socket } = fake()
    const pending = Cdp.connect(() => socket, "ws://x")
    socket.onopen?.()
    const client = await pending
    const frames: Cdp.Frame[] = []
    const stop = await Cdp.startScreencast(client, { width: 640, height: 400 }, (frame) => frames.push(frame))
    socket.onmessage?.({
      data: JSON.stringify({
        method: "Page.screencastFrame",
        params: { data: "AAAA", sessionId: 7, metadata: { deviceWidth: 640, deviceHeight: 400 } },
      }),
    })
    await Promise.resolve()
    expect(frames).toEqual([{ data: "AAAA", width: 640, height: 400 }])
    expect(sent).toContain("Page.startScreencast")
    expect(sent).toContain("Page.screencastFrameAck")
    stop()
    socket.onmessage?.({
      data: JSON.stringify({ method: "Page.screencastFrame", params: { data: "BBBB", sessionId: 8 } }),
    })
    expect(frames.length).toBe(1)
  })
})
