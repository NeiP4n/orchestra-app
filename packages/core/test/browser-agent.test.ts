import { describe, expect, test } from "bun:test"
import { BrowserBridge } from "../src/browser/bridge"
import { BrowserPage } from "../src/browser/page"
import { Cdp } from "../src/browser/cdp"
import { BrowserTabs } from "../src/browser/tabs"
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

describe("tabs and the address bar", () => {
  const tab = (id: string) => ({ id, title: id, url: `https://${id}.test/`, wsUrl: `ws://x/${id}` })

  test("only real pages are tabs", () => {
    const list = BrowserTabs.parse([
      { id: "a", type: "page", url: "https://a.test/", title: "A", webSocketDebuggerUrl: "ws://x/a" },
      { id: "w", type: "service_worker", url: "https://a.test/sw.js", webSocketDebuggerUrl: "ws://x/w" },
      { id: "d", type: "page", url: "devtools://devtools/x", webSocketDebuggerUrl: "ws://x/d" },
      { id: "n", type: "page", url: "https://n.test/" },
    ])
    expect(list.map((item) => item.id)).toEqual(["a"])
  })

  test("closing a tab shows its right neighbour, else the left one", () => {
    const tabs = [tab("a"), tab("b"), tab("c")]
    expect(BrowserTabs.neighbour(tabs, "b")?.id).toBe("c")
    expect(BrowserTabs.neighbour(tabs, "c")?.id).toBe("b")
    expect(BrowserTabs.neighbour([tab("a")], "a")).toBeUndefined()
  })

  test("tab actions call Chrome's own endpoints", async () => {
    const calls: string[] = []
    const f = (async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${url.replace("http://127.0.0.1:9222", "")}`)
      return { json: async () => ({ id: "n", type: "page", url: "https://n.test/", webSocketDebuggerUrl: "ws://x/n" }) }
    }) as never
    expect((await BrowserTabs.create(9222, "https://n.test/", f)).id).toBe("n")
    await BrowserTabs.activate(9222, "n", f)
    await BrowserTabs.close(9222, "n", f)
    expect(calls).toEqual(["PUT /json/new?https%3A%2F%2Fn.test%2F", "GET /json/activate/n", "GET /json/close/n"])
  })

  test("the address bar opens addresses, searches the rest, and refuses other schemes", () => {
    expect(Chrome.omnibox("example.com")).toBe("https://example.com/")
    expect(Chrome.omnibox("localhost:3000/x")).toBe("http://localhost:3000/x")
    expect(Chrome.omnibox("muse ai")).toBe("https://www.google.com/search?q=muse%20ai")
    expect(Chrome.omnibox("cats")).toBe("https://www.google.com/search?q=cats")
    expect(() => Chrome.omnibox("javascript:alert(1)")).toThrow()
    expect(() => Chrome.omnibox("file:///etc/passwd")).toThrow()
    expect(() => Chrome.omnibox("  ")).toThrow()
  })
})
