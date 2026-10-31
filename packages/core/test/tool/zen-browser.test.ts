import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { ZenBridgeServer } from "../../src/zen/bridge-server.js"
import {
  getZenBridgeServer,
  name,
  Plugin,
  renderResult,
  run,
  setZenBridgeServer,
  validate,
} from "../../src/tool/plugin/zen-browser.js"

describe("zen_browser unit tests", () => {
  test("tool name is zen_browser", () => {
    expect(name).toBe("zen_browser")
  })

  test("validate checks required fields", () => {
    expect(validate({ action: "eval" })).toBe('zen_browser action "eval" requires "code"')
    expect(validate({ action: "eval", code: "   " })).toBe('zen_browser action "eval" requires "code"')
    expect(validate({ action: "eval", code: "window.location" })).toBeUndefined()

    expect(validate({ action: "click" })).toBe('zen_browser action "click" requires "selector"')
    expect(validate({ action: "click", selector: "#btn" })).toBeUndefined()

    expect(validate({ action: "type" })).toBe('zen_browser action "type" requires "selector"')
    expect(validate({ action: "type", selector: "input" })).toBeUndefined()

    expect(validate({ action: "navigate" })).toBe('zen_browser action "navigate" requires "url"')
    expect(validate({ action: "navigate", url: "https://zen-browser.app" })).toBeUndefined()

    expect(validate({ action: "tabs" })).toBeUndefined()
    expect(validate({ action: "media" })).toBeUndefined()
    expect(validate({ action: "status" })).toBeUndefined()
  })

  test("renderResult formats various types", () => {
    expect(renderResult("status", null)).toBe("OK")
    expect(renderResult("status", undefined)).toBe("OK")
    expect(renderResult("status", "custom message")).toBe("custom message")

    // tabs
    expect(renderResult("tabs", { tabs: [] })).toBe("No open tabs.")
    const tabsReport = renderResult("tabs", {
      tabs: [
        { id: 1, title: "Zen Home", url: "https://zen-browser.app", active: true },
        { id: 2, title: "GitHub", url: "https://github.com", active: false },
      ],
    })
    expect(tabsReport).toContain("Open tabs (2):")
    expect(tabsReport).toContain("* Tab #1 [active]: Zen Home")
    expect(tabsReport).toContain("https://zen-browser.app")
    expect(tabsReport).toContain("* Tab #2: GitHub")

    // read
    const readReport = renderResult("read", {
      title: "Zen Features",
      url: "https://zen-browser.app/features",
      text: "Zen is a Firefox-based browser with workspaces.",
    })
    expect(readReport).toContain("Title: Zen Features")
    expect(readReport).toContain("URL: https://zen-browser.app/features")
    expect(readReport).toContain("Zen is a Firefox-based browser with workspaces.")

    // eval
    expect(renderResult("eval", { result: 42 })).toBe("42")
    expect(renderResult("eval", { result: true })).toBe("true")
    expect(renderResult("eval", { result: null })).toBe("null")
    expect(renderResult("eval", { result: undefined })).toBe("undefined")
    expect(renderResult("eval", { result: { a: 1 } })).toContain('"a": 1')

    // objects
    expect(renderResult("click", { clicked: true, tabId: 1 })).toContain('"clicked": true')
  })

  test("graceful offline handling when bridge is not connected", async () => {
    const offlineBridge = new ZenBridgeServer({ port: 59999 })
    const prevBridge = getZenBridgeServer()
    setZenBridgeServer(offlineBridge)

    try {
      // status action
      const statusRes = await Effect.runPromise(run({ action: "status" }))
      expect(statusRes.output).toContain("Zen Browser bridge is running on port 59999")
      expect(statusRes.output).toContain("no Zen Browser extension is currently connected")

      // tabs action
      const tabsRes = await Effect.runPromise(run({ action: "tabs" }))
      expect(tabsRes.output).toContain("Zen Browser bridge is running on port 59999")
      expect(tabsRes.output).toContain("no Zen Browser extension is currently connected")

      // read action
      const readRes = await Effect.runPromise(run({ action: "read" }))
      expect(readRes.output).toContain("Zen Browser bridge is running on port 59999")

      // eval action
      const evalRes = await Effect.runPromise(run({ action: "eval", code: "document.title" }))
      expect(evalRes.output).toContain("Zen Browser bridge is running on port 59999")

      // media action
      const mediaRes = await Effect.runPromise(run({ action: "media", command: "play" }))
      expect(mediaRes.output).toContain("Zen Browser bridge is running on port 59999")
    } finally {
      offlineBridge.stop()
      setZenBridgeServer(prevBridge)
    }
  })
})

describe("zen_browser with mock connected extension", () => {
  let server: ZenBridgeServer
  let clientWs: WebSocket
  let serverPort: number

  beforeAll(async () => {
    server = new ZenBridgeServer({ port: 0 })
    server.start(0)
    serverPort = server.port
    setZenBridgeServer(server)

    clientWs = new WebSocket(`ws://127.0.0.1:${serverPort}`)

    await new Promise<void>((resolve, reject) => {
      clientWs.onopen = () => {
        // Send handshake hello
        clientWs.send(
          JSON.stringify({
            type: "hello",
            client: "zen-extension",
            version: "1.0.0",
          }),
        )
        resolve()
      }
      clientWs.onerror = (e) => reject(new Error(`WebSocket error: ${e}`))
    })

    clientWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          id?: string
          action?: string
          params?: Record<string, unknown>
        }
        if (!msg.id) return

        if (msg.action === "tabs") {
          clientWs.send(
            JSON.stringify({
              id: msg.id,
              success: true,
              result: {
                tabs: [
                  { id: 10, title: "Zen Browser", url: "https://zen-browser.app", active: true },
                  { id: 20, title: "Orchestra", url: "https://orchestra.ai", active: false },
                ],
              },
            }),
          )
          return
        }

        if (msg.action === "read") {
          clientWs.send(
            JSON.stringify({
              id: msg.id,
              success: true,
              result: {
                title: "Zen Browser",
                url: "https://zen-browser.app",
                text: "The browser for thinkers.",
              },
            }),
          )
          return
        }

        if (msg.action === "eval") {
          clientWs.send(
            JSON.stringify({
              id: msg.id,
              success: true,
              result: { result: "evaluated result" },
            }),
          )
          return
        }

        if (msg.action === "media") {
          clientWs.send(
            JSON.stringify({
              id: msg.id,
              success: true,
              result: { media: msg.params?.command ?? "play_pause", executed: true },
            }),
          )
          return
        }

        if (msg.action === "navigate") {
          clientWs.send(
            JSON.stringify({
              id: msg.id,
              success: true,
              result: { tabId: msg.params?.tabId ?? 10, url: msg.params?.url },
            }),
          )
          return
        }

        if (msg.action === "click") {
          if (msg.params?.selector === "#fail") {
            clientWs.send(
              JSON.stringify({
                id: msg.id,
                success: false,
                error: "Element #fail not found",
              }),
            )
            return
          }
          clientWs.send(
            JSON.stringify({
              id: msg.id,
              success: true,
              result: { clicked: true, tabId: 10 },
            }),
          )
          return
        }

        if (msg.action === "type") {
          clientWs.send(
            JSON.stringify({
              id: msg.id,
              success: true,
              result: { typed: true, tabId: 10 },
            }),
          )
          return
        }

        if (msg.action === "activate") {
          clientWs.send(
            JSON.stringify({
              id: msg.id,
              success: true,
              result: { activated: true, tabId: 20 },
            }),
          )
          return
        }

        if (msg.action === "close") {
          clientWs.send(
            JSON.stringify({
              id: msg.id,
              success: true,
              result: { closed: true, tabId: 20 },
            }),
          )
          return
        }

        // Default response
        clientWs.send(JSON.stringify({ id: msg.id, success: true, result: { action: msg.action } }))
      } catch (err) {
        console.error("Mock client onmessage error:", err)
      }
    }
  })

  afterAll(() => {
    try {
      clientWs.close()
    } catch {}
    server.stop()
  })

  test("status reports connected extension", async () => {
    const res = await Effect.runPromise(run({ action: "status" }))
    expect(res.output).toContain("Zen Browser connected (zen-extension v1.0.0)")
    expect(res.output).toContain(String(serverPort))
  })

  test("tabs lists open tabs", async () => {
    const res = await Effect.runPromise(run({ action: "tabs" }))
    expect(res.output).toContain("Open tabs (2):")
    expect(res.output).toContain("* Tab #10 [active]: Zen Browser")
    expect(res.output).toContain("https://zen-browser.app")
    expect(res.output).toContain("* Tab #20: Orchestra")
    expect(res.output).toContain("https://orchestra.ai")
  })

  test("read returns tab content", async () => {
    const res = await Effect.runPromise(run({ action: "read", tabId: 10 }))
    expect(res.output).toContain("Title: Zen Browser")
    expect(res.output).toContain("URL: https://zen-browser.app")
    expect(res.output).toContain("The browser for thinkers.")
  })

  test("eval executes JS in tab", async () => {
    const res = await Effect.runPromise(run({ action: "eval", code: "document.title" }))
    expect(res.output).toBe("evaluated result")
  })

  test("media controls playback", async () => {
    const res = await Effect.runPromise(run({ action: "media", command: "next" }))
    expect(res.output).toContain('"media": "next"')
    expect(res.output).toContain('"executed": true')
  })

  test("navigate navigates tab", async () => {
    const res = await Effect.runPromise(run({ action: "navigate", url: "https://example.com" }))
    expect(res.output).toContain("https://example.com")
  })

  test("click clicks element", async () => {
    const res = await Effect.runPromise(run({ action: "click", selector: "button.play" }))
    expect(res.output).toContain('"clicked": true')
  })

  test("type types text", async () => {
    const res = await Effect.runPromise(run({ action: "type", selector: "input.search", text: "search query" }))
    expect(res.output).toContain('"typed": true')
  })

  test("activate activates tab", async () => {
    const res = await Effect.runPromise(run({ action: "activate", tabId: 20 }))
    expect(res.output).toContain('"activated": true')
  })

  test("close closes tab", async () => {
    const res = await Effect.runPromise(run({ action: "close", tabId: 20 }))
    expect(res.output).toContain('"closed": true')
  })

  test("fails when required fields are missing", async () => {
    const evalExit = await Effect.runPromiseExit(run({ action: "eval" }))
    expect(Exit.isFailure(evalExit)).toBe(true)

    const clickExit = await Effect.runPromiseExit(run({ action: "click" }))
    expect(Exit.isFailure(clickExit)).toBe(true)

    const navExit = await Effect.runPromiseExit(run({ action: "navigate" }))
    expect(Exit.isFailure(navExit)).toBe(true)
  })

  test("fails with ToolFailure when extension reports error", async () => {
    const exit = await Effect.runPromiseExit(run({ action: "click", selector: "#fail" }))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("media defaults to play_pause when command is omitted", async () => {
    const res = await Effect.runPromise(run({ action: "media" }))
    expect(res.output).toContain('"media": "play_pause"')
  })

  test("Plugin metadata is correct", () => {
    expect(Plugin.id).toBe("orchestra.tool.zen-browser")
  })
})

describe("ZenBridgeServer direct tests", () => {
  let server: ZenBridgeServer
  let clientWs: WebSocket

  beforeAll(async () => {
    server = new ZenBridgeServer({ port: 0 })
    server.start(0)

    clientWs = new WebSocket(`ws://127.0.0.1:${server.port}`)
    await new Promise<void>((resolve, reject) => {
      clientWs.onopen = () => resolve()
      clientWs.onerror = (e) => reject(new Error(`WebSocket error: ${e}`))
    })
  })

  afterAll(() => {
    try {
      clientWs.close()
    } catch {}
    server.stop()
  })

  test("http /status and /health endpoints return json status", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/status`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { connected: boolean }
    expect(json.connected).toBe(true)

    const healthRes = await fetch(`http://127.0.0.1:${server.port}/health`)
    expect(healthRes.status).toBe(200)
  })

  test("sendRpc times out if client does not respond", async () => {
    let err: Error | null = null
    try {
      await server.sendRpc("unresponsive_action", {}, 50)
    } catch (e) {
      err = e as Error
    }
    expect(err).not.toBeNull()
    expect(err?.message).toContain('RPC action "unresponsive_action" timed out')
  })

  test("sendRpc rejects when bridge has no active connection", async () => {
    const isolatedServer = new ZenBridgeServer({ port: 0 })
    let err: Error | null = null
    try {
      await isolatedServer.sendRpc("test", {}, 100)
    } catch (e) {
      err = e as Error
    } finally {
      isolatedServer.stop()
    }
    expect(err).not.toBeNull()
    expect(err?.message).toContain("Zen Browser extension is not connected")
  })
})
