import { describe, expect, test } from "bun:test"
import { BrowserBridge } from "../src/browser/bridge"
import { BrowserPage } from "../src/browser/page"
import { Cdp } from "../src/browser/cdp"
import { WindowCapture } from "../src/browser/window-capture"
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

describe("taking control of the page", () => {
  test("text is inserted, named keys are key events, terminal combinations are not forwarded", () => {
    expect(Cdp.keySteps({ name: "a", sequence: "a" })).toEqual([{ method: "Input.insertText", params: { text: "a" } }])
    expect(Cdp.keySteps({ name: "п", sequence: "п" })[0]?.params).toEqual({ text: "п" })
    expect(Cdp.keySteps({ name: "space", sequence: " " })[0]?.params).toEqual({ text: " " })
    const enter = Cdp.keySteps({ name: "return", sequence: "\r" })
    expect(enter.map((step) => (step.params as Record<string, unknown>).type)).toEqual(["keyDown", "keyUp"])
    expect((enter[0]?.params as Record<string, unknown>).windowsVirtualKeyCode).toBe(13)
    expect(Cdp.keySteps({ name: "c", sequence: "\x03", ctrl: true })).toEqual([])
    expect(Cdp.keySteps({ name: "f5", sequence: "\x1b[15~" })).toEqual([])
  })
})

describe("window capture (Windows helper protocol)", () => {
  test("helper lines are parsed into frames and status", () => {
    expect(WindowCapture.parseLine("F 640 400 QUJD")).toEqual({ type: "frame", width: 640, height: 400, data: "QUJD" })
    expect(WindowCapture.parseLine("S ok attached")).toEqual({ type: "status", ok: true, text: "attached" })
    expect(WindowCapture.parseLine("S err no Chrome window")).toEqual({
      type: "status",
      ok: false,
      text: "no Chrome window",
    })
    expect(WindowCapture.parseLine("noise").type).toBe("other")
  })

  test("commands carry the pane's pixels, text and named keys", () => {
    expect(WindowCapture.attachCommand(42, { width: 1000.4, height: 640 })).toBe("attach 42 -32000 -32000 1000 640")
    expect(WindowCapture.mouseCommand({ kind: "down", x: 10.2, y: 20.7, button: "right" })).toBe("mouse rdown 10 21")
    expect(WindowCapture.mouseCommand({ kind: "wheel", x: 1, y: 2, deltaY: -120 })).toBe("mouse wheelup 1 2")
    expect(WindowCapture.keyCommands({ name: "return", sequence: "\r" })).toEqual(["key 13 down", "key 13 up"])
    expect(WindowCapture.keyCommands({ name: "a", sequence: "a" })).toEqual(["char 97"])
    expect(WindowCapture.keyCommands({ name: "п", sequence: "п" })).toEqual(["char 1087"])
    expect(WindowCapture.keyCommands({ name: "c", sequence: "\x03", ctrl: true })).toEqual([])
  })

  test("the helper script is plain ASCII (Windows PowerShell reads it as ANSI) and uses the window APIs", () => {
    expect(/^[\x00-\x7f]*$/.test(WindowCapture.SCRIPT)).toBe(true)
    for (const part of ["PrintWindow", "Chrome_WidgetWin_1", "0x80", "[Cap]::Run()"])
      expect(WindowCapture.SCRIPT).toContain(part)
  })

  test("start resolves when the helper attaches, forwards commands, and rejects with its reason otherwise", async () => {
    const written: string[] = []
    let line: (value: string) => void = () => {}
    let exit: () => void = () => {}
    const make = () => ({
      write: (value: string) => void written.push(value),
      kill: () => {},
      onLine: (listener: (value: string) => void) => void (line = listener),
      onExit: (listener: () => void) => void (exit = listener),
    })
    const pending = WindowCapture.start(make, 7, { width: 800, height: 500 })
    expect(written[0]).toBe("attach 7 -32000 -32000 800 500")
    line("S ok attached")
    const controller = await pending
    const frames: unknown[] = []
    controller.watch({ width: 900, height: 600 }, (frame) => frames.push(frame))
    line("F 900 600 QUJD")
    controller.mouse({ kind: "move", x: 5, y: 6 })
    expect(written.slice(1)).toEqual(["size 900 600", "mouse move 5 6"])
    expect(frames).toEqual([{ data: "QUJD", width: 900, height: 600 }])

    const failing = WindowCapture.start(make, 8, { width: 800, height: 500 })
    line("S err no Chrome window for that process")
    await expect(failing).rejects.toThrow("no Chrome window")
    void exit
  })
})
