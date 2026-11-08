import { describe, expect, test } from "bun:test"
import { Cdp } from "@orchestra/core/browser/cdp"
import { Chrome } from "@orchestra/core/browser/chrome"

describe("Chrome discovery and launch", () => {
  test("candidates follow the platform and an override comes first", () => {
    expect(Chrome.candidates("linux", {})[0]).toBe("/usr/bin/google-chrome")
    expect(Chrome.candidates("darwin", {})[0]).toContain("Google Chrome.app")
    const win = Chrome.candidates("win32", {
      PROGRAMFILES: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\m\\AppData\\Local",
    })
    expect(win[0]).toBe("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
    expect(win[1]).toContain("AppData")
    expect(Chrome.candidates("linux", { ORCHESTRA_CHROME_PATH: "/x/chrome" })[0]).toBe("/x/chrome")
  })

  test("Edge is only a fallback after every Chrome path", () => {
    const win = Chrome.candidates("win32", {
      PROGRAMFILES: "C:\\Program Files",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    })
    const edge = win.findIndex((file) => file.endsWith("msedge.exe"))
    expect(edge).toBeGreaterThan(win.findLastIndex((file) => file.endsWith("chrome.exe")))
    expect(win[edge]).toBe("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe")
    expect(
      Chrome.find((file) => file.endsWith("msedge.exe"), "win32", { "PROGRAMFILES(X86)": "C:\\Program Files (x86)" }),
    ).toContain("msedge.exe")
  })

  test("find returns the first installed candidate", () => {
    expect(Chrome.find((file) => file === "/usr/bin/chromium", "linux", {})).toBe("/usr/bin/chromium")
    expect(Chrome.find(() => false, "linux", {})).toBeUndefined()
  })

  test("a profile dir stays inside the root and refuses odd ids", () => {
    expect(Chrome.profileDir("/data", "brw_ab12", (...p) => p.join("/"))).toBe("/data/browser-profiles/brw_ab12")
    for (const bad of ["", "../x", "a/b", "a b", "x".repeat(65)])
      expect(() => Chrome.profileDir("/data", bad)).toThrow()
  })

  test("launch args use a dedicated profile and a free debugging port", () => {
    const args = Chrome.launchArgs({ profileDir: "/p", headless: true })
    expect(args).toContain("--remote-debugging-port=0")
    expect(args).toContain("--user-data-dir=/p")
    expect(args).toContain("--headless=new")
    expect(Chrome.launchArgs({ profileDir: "/p" })).not.toContain("--headless=new")
  })

  test("a headless session is low-memory, windowless and sized for its pane", () => {
    const args = Chrome.launchArgs({ profileDir: "/p", headless: true, width: 900, height: 420 })
    for (const flag of [
      "--headless=new",
      "--disable-gpu",
      "--disable-extensions",
      "--renderer-process-limit=1",
      "--window-size=900,420",
    ])
      expect(args).toContain(flag)
    expect(args.some((arg) => arg.startsWith("--js-flags=--max-old-space-size="))).toBe(true)
    expect(Chrome.launchArgs({ profileDir: "/p" })).not.toContain("--disable-gpu")
  })

  test("a visible window has no low-memory flags, and tabs are reopened from their addresses", () => {
    const args = Chrome.launchArgs({
      profileDir: "/p",
      urls: ["https://a.test/", "javascript:alert(1)", "http://b.test/", "file:///x"],
    })
    expect(args).not.toContain("--headless=new")
    expect(args).not.toContain("--disable-gpu")
    expect(args.slice(-2)).toEqual(["https://a.test/", "http://b.test/"])
    expect(Chrome.launchArgs({ profileDir: "/p", urls: ["file:///x"] }).at(-1)).toBe("about:blank")
  })

  test("a profile left by an unclean stop is marked clean, and Chrome is told not to offer a restore", () => {
    const args = Chrome.launchArgs({ profileDir: "/p" })
    expect(args).toContain("--disable-session-crashed-bubble")
    expect(args).toContain("--hide-crash-restore-bubble")
    const fixed = JSON.parse(
      Chrome.cleanExitPreferences('{"profile":{"exit_type":"Crashed","exited_cleanly":false,"name":"x"},"a":1}')!,
    )
    expect(fixed).toEqual({ profile: { exit_type: "Normal", exited_cleanly: true, name: "x" }, a: 1 })
    expect(JSON.parse(Chrome.cleanExitPreferences("{}")!)).toEqual({
      profile: { exit_type: "Normal", exited_cleanly: true },
    })
    expect(Chrome.cleanExitPreferences('{"profile":{"exit_type":"Normal","exited_cleanly":true}}')).toBeUndefined()
    expect(Chrome.cleanExitPreferences("not json")).toBeUndefined()
  })

  test("the active port file is parsed and bad content is ignored", () => {
    expect(Chrome.parseActivePort("9222\n/devtools/browser/abc\n")).toEqual({
      port: 9222,
      path: "/devtools/browser/abc",
    })
    expect(Chrome.parseActivePort("9222\r\n/x")).toEqual({ port: 9222, path: "/x" })
    expect(Chrome.parseActivePort("")).toBeUndefined()
    expect(Chrome.parseActivePort("nope")).toBeUndefined()
    expect(Chrome.parseActivePort("70000")).toBeUndefined()
  })

  test("only web addresses open, and a bare host gets https", () => {
    expect(Chrome.normalizeUrl("example.com/a")).toBe("https://example.com/a")
    expect(Chrome.normalizeUrl("http://localhost:3000")).toBe("http://localhost:3000/")
    for (const bad of ["file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "   "])
      expect(() => Chrome.normalizeUrl(bad)).toThrow()
  })

  const deps = (files: Record<string, string>, exits = false) => {
    const killed: string[] = []
    const removed: string[] = []
    return {
      killed,
      removed,
      deps: {
        spawn: () => ({
          pid: 42,
          kill: () => void killed.push("k"),
          once: (_: "exit", cb: () => void) => void (exits && cb()),
        }),
        readFile: (file: string) => files[file],
        sleep: async () => {},
        mkdir: () => {},
        remove: (file: string) => void removed.push(file),
      } satisfies Chrome.Deps,
    }
  }

  test("launch clears a stale port file and returns the new port", async () => {
    const file = "/p/DevToolsActivePort"
    const setup = deps({ [file]: "51234\n/devtools/browser/zz" })
    const running = await Chrome.launch(setup.deps, { exe: "chrome", profileDir: "/p" })
    expect(setup.removed.some((item) => item.endsWith("DevToolsActivePort"))).toBe(true)
    expect(running.pid).toBe(42)
    running.close()
    expect(setup.killed).toEqual(["k"])
  })

  test("launch fails when Chrome exits or never reports a port", async () => {
    await expect(Chrome.launch(deps({}, true).deps, { exe: "chrome", profileDir: "/p" })).rejects.toThrow("closed")
    const slow = deps({})
    await expect(Chrome.launch(slow.deps, { exe: "chrome", profileDir: "/p", timeoutMs: 0 })).rejects.toThrow("in time")
    expect(slow.killed).toEqual(["k"])
  })
})

class FakeSocket implements Cdp.Socket {
  onmessage: Cdp.Socket["onmessage"] = null
  onclose: Cdp.Socket["onclose"] = null
  onerror: Cdp.Socket["onerror"] = null
  onopen: Cdp.Socket["onopen"] = null
  sent: { id: number; method: string; params: unknown }[] = []
  constructor(readonly reply: (message: { id: number; method: string }) => unknown) {
    queueMicrotask(() => this.onopen?.())
  }
  send(data: string) {
    const message = JSON.parse(data)
    this.sent.push(message)
    const reply = this.reply(message)
    if (reply !== undefined)
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, ...(reply as object) }) }))
  }
  close() {
    this.onclose?.()
  }
}

describe("Cdp client", () => {
  test("replies are matched to their request ids", async () => {
    const socket = new FakeSocket((message) => ({ result: { echo: message.method } }))
    const client = await Cdp.connect(() => socket, "ws://x")
    const [a, b] = await Promise.all([client.send("A"), client.send("B")])
    expect(a).toEqual({ echo: "A" })
    expect(b).toEqual({ echo: "B" })
    expect(socket.sent.map((item) => item.id)).toEqual([1, 2])
  })

  test("a browser error rejects the call with its message", async () => {
    const client = await Cdp.connect(() => new FakeSocket(() => ({ error: { message: "bad url" } })), "ws://x")
    await expect(Cdp.navigate(client, "x")).rejects.toThrow("bad url")
  })

  test("a call with no reply times out and closing rejects what is pending", async () => {
    const socket = new FakeSocket(() => undefined)
    const client = await Cdp.connect(() => socket, "ws://x", { timeoutMs: 5 })
    await expect(client.send("Slow")).rejects.toThrow("timed out")
    const waiting = client.send("Later")
    client.close()
    await expect(waiting).rejects.toThrow("closed")
    await expect(client.send("After")).rejects.toThrow("closed")
  })

  test("page text and info read the evaluated value, and text is capped", async () => {
    const client = await Cdp.connect(
      () =>
        new FakeSocket((message) => ({
          result: { result: { value: message.method === "Runtime.evaluate" ? "hello world" : "" } },
        })),
      "ws://x",
    )
    expect(await Cdp.pageText(client)).toBe("hello world")
    expect(await Cdp.pageText(client, 5)).toBe("hello")
  })

  test("the first page target is chosen", () => {
    expect(
      Cdp.pageSocketUrl([
        { type: "service_worker", webSocketDebuggerUrl: "ws://sw" },
        { type: "page", webSocketDebuggerUrl: "ws://page" },
      ]),
    ).toBe("ws://page")
    expect(Cdp.pageSocketUrl([])).toBeUndefined()
  })
})
