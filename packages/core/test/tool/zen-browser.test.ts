import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@orchestra/core/effect/app-node-builder"
import { LayerNode } from "@orchestra/util/effect/layer-node"
import { makeLocationNode } from "@orchestra/util/effect/app-node"
import { Location } from "@orchestra/core/location"
import { Permission } from "@orchestra/core/permission"
import { Session } from "@orchestra/core/session"
import { Tool } from "@orchestra/core/tool"
import { AbsolutePath } from "@orchestra/core/schema"
import { location } from "../fixture/location"
import { withTempDir } from "../fixture/tmpdir"
import { it } from "../lib/effect"
import { permissionLayer } from "../lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "../lib/tool"
import { ZenBridgeServer } from "../../src/zen/bridge-server.js"
import {
  getZenBridgeServer,
  name,
  Output,
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
    expect(renderResult("eval", "ChatGPT")).toBe("ChatGPT")
    expect(renderResult("eval", undefined)).toBe("undefined")
    expect(renderResult("eval", null)).toBe("null")
    expect(renderResult("eval", { title: "ChatGPT", online: true })).toContain('"title": "ChatGPT"')

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

  test("navigate reuses the tab that already shows the URL instead of opening another", async () => {
    const res = await Effect.runPromise(run({ action: "navigate", url: "https://orchestra.ai" }))
    expect(res.output).toContain('"tabId": 20')
    expect(res.output).toContain("https://orchestra.ai")
  })

  test("navigate without a matching tab opens as before", async () => {
    const res = await Effect.runPromise(run({ action: "navigate", url: "https://new.example" }))
    expect(res.output).toContain('"tabId": 10')
  })

  test("navigate with an explicit tabId keeps it", async () => {
    const res = await Effect.runPromise(run({ action: "navigate", tabId: 20, url: "https://orchestra.ai" }))
    expect(res.output).toContain('"tabId": 20')
  })

  test("media defaults to play_pause when command is omitted", async () => {
    const res = await Effect.runPromise(run({ action: "media" }))
    expect(res.output).toContain('"media": "play_pause"')
  })

  test("Plugin metadata is correct", () => {
    expect(Plugin.id).toBe("orchestra.tool.zen-browser")
  })

  test("Plugin registration and execute return object conforming to Output schema", async () => {
    let capturedTool:
      | {
          name: string
          output: unknown
          execute: (
            val: unknown,
            context: unknown,
          ) => Effect.Effect<{ output: { output: string }; content: string }>
        }
      | undefined
    const mockCtx = {
      tool: {
        transform: (fn: (editor: { add: (tool: typeof capturedTool) => void }) => void) =>
          Effect.sync(() => {
            const editor = {
              add: (tool: typeof capturedTool) => {
                capturedTool = tool
              },
            }
            fn(editor)
          }),
      },
    }

    // The plugin asserts permission before it runs, so registration needs a
    // Permission service; the test allows everything.
    await Effect.runPromise(
      Effect.scoped(Plugin.effect(mockCtx as any)).pipe(
        Effect.provide(permissionLayer({ assert: () => Effect.void })),
      ),
    )
    expect(capturedTool).toBeDefined()
    expect(capturedTool?.name).toBe("zen_browser")
    expect(capturedTool?.output).toBe(Output)

    // Execute status action through capturedTool.execute
    const execRes = await Effect.runPromise(
      capturedTool!.execute({ action: "status" }, {
        sessionID: Session.ID.make("ses_zen_browser_test"),
        agent: toolIdentity.agent,
        messageID: toolIdentity.messageID,
        id: "call-zen-register",
      }),
    )
    expect(execRes).toHaveProperty("output")
    expect(execRes).toHaveProperty("content")
    expect(execRes.output).toHaveProperty("output")
    expect(typeof execRes.output.output).toBe("string")
    expect(execRes.content).toBe(execRes.output.output)
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

describe("HTTP Long-Polling and Heartbeat fallback", () => {
  let server: ZenBridgeServer
  let serverPort: number

  beforeAll(() => {
    server = new ZenBridgeServer({ port: 0 })
    server.start(0)
    serverPort = server.port
  })

  afterAll(() => {
    server.stop()
  })

  test("POST /heartbeat records clientInfo and marks connected = true", async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "zen-http-client", version: "3.2.1" }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; connected: boolean }
    expect(json.ok).toBe(true)
    expect(json.connected).toBe(true)

    const status = server.getStatus()
    expect(status.connected).toBe(true)
    expect(status.clientInfo?.client).toBe("zen-http-client")
    expect(status.clientInfo?.version).toBe("3.2.1")
  })

  test("GET /poll immediately returns queued RPC request", async () => {
    // Send heartbeat to ensure connected
    await fetch(`http://127.0.0.1:${serverPort}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "zen-http-client", version: "3.2.1" }),
    })

    // Initiate RPC call via HTTP queue
    const rpcPromise = server.sendRpc<{ tabId: number; title: string }>("tabs", { query: "active" })

    // Poller fetches the request
    const pollRes = await fetch(`http://127.0.0.1:${serverPort}/poll`)
    expect(pollRes.status).toBe(200)
    const rpcItem = (await pollRes.json()) as { id: string; action: string; params: { query: string } }
    expect(rpcItem.action).toBe("tabs")
    expect(rpcItem.params.query).toBe("active")

    // Post result back
    const resultRes = await fetch(`http://127.0.0.1:${serverPort}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: rpcItem.id,
        success: true,
        result: { tabId: 1, title: "Long Poll Active Tab" },
      }),
    })
    expect(resultRes.status).toBe(200)

    // RPC promise resolves with the result
    const result = await rpcPromise
    expect(result.tabId).toBe(1)
    expect(result.title).toBe("Long Poll Active Tab")
  })

  test("POST /result handles error response and rejects sendRpc", async () => {
    await fetch(`http://127.0.0.1:${serverPort}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "zen-http-client", version: "3.2.1" }),
    })

    const rpcPromise = server.sendRpc("eval", { code: "throw new Error('fail')" })
    // Attach error catcher to prevent unhandled rejection during HTTP dispatch
    const outcomePromise = rpcPromise.then(
      () => null,
      (err) => err,
    )

    const pollRes = await fetch(`http://127.0.0.1:${serverPort}/poll`)
    const rpcItem = (await pollRes.json()) as { id: string; action: string }

    await fetch(`http://127.0.0.1:${serverPort}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: rpcItem.id,
        success: false,
        error: "Execution failed in tab",
      }),
    })

    const err = await outcomePromise
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("Execution failed in tab")
  })

  test("end-to-end zen_browser tool execution via HTTP fallback", async () => {
    const prevBridge = getZenBridgeServer()
    setZenBridgeServer(server)

    try {
      // Send heartbeat
      await fetch(`http://127.0.0.1:${serverPort}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: "zen-extension-http", version: "2.5.0" }),
      })

      // Status check through tool
      const statusRes = await Effect.runPromise(run({ action: "status" }))
      expect(statusRes.output).toContain("Zen Browser connected (zen-extension-http v2.5.0)")

      // Execute tool tabs action
      const toolPromise = Effect.runPromise(run({ action: "tabs" }))

      // Poller receives request
      const pollRes = await fetch(`http://127.0.0.1:${serverPort}/poll`)
      const rpcItem = (await pollRes.json()) as { id: string; action: string }
      expect(rpcItem.action).toBe("tabs")

      // Send tabs result
      await fetch(`http://127.0.0.1:${serverPort}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: rpcItem.id,
          success: true,
          result: {
            tabs: [{ id: 101, title: "HTTP Workspace Tab", url: "https://zen-browser.app/workspaces", active: true }],
          },
        }),
      })

      // Tool outputs rendered tabs
      const toolOutput = await toolPromise
      expect(toolOutput.output).toContain("Open tabs (1):")
      expect(toolOutput.output).toContain("Tab #101 [active]: HTTP Workspace Tab")
    } finally {
      setZenBridgeServer(prevBridge)
    }
  })

  test("GET /poll times out and returns 204 No Content when queue is empty", async () => {
    const timeoutServer = new ZenBridgeServer({ port: 0 })
    timeoutServer.start(0)
    try {
      const pollRes = await fetch(`http://127.0.0.1:${timeoutServer.port}/poll`)
      expect(pollRes.status).toBe(204)
    } finally {
      timeoutServer.stop()
    }
  }, 10000)

  test("getStatus() reports connected: false when heartbeat expires", async () => {
    const expiryServer = new ZenBridgeServer({ port: 0 })
    expiryServer.start(0)
    try {
      // Send heartbeat
      await fetch(`http://127.0.0.1:${expiryServer.port}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: "zen-test", version: "1.0.0" }),
      })
      expect(expiryServer.getStatus().connected).toBe(true)

      // Manually advance lastSeen to more than 5000ms ago
      // @ts-expect-error accessing private for testing expiry
      expiryServer.lastSeen = Date.now() - 5001

      expect(expiryServer.getStatus().connected).toBe(false)
    } finally {
      expiryServer.stop()
    }
  })

  test("CORS: OPTIONS preflight returns 204 with moz-extension origin and allowed headers", async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/heartbeat`, {
      method: "OPTIONS",
      headers: {
        Origin: "moz-extension://a1b2c3d4-e5f6-7890-abcd-ef0123456789",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type, Authorization",
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe("moz-extension://a1b2c3d4-e5f6-7890-abcd-ef0123456789")
    expect(res.headers.get("access-control-allow-methods")).toContain("POST")
    expect(res.headers.get("access-control-allow-methods")).toContain("OPTIONS")
    expect(res.headers.get("access-control-allow-headers")).toContain("Content-Type")
  })

  test("CORS: POST /heartbeat and GET /poll allow null or extension origins", async () => {
    // null origin
    const nullRes = await fetch(`http://127.0.0.1:${serverPort}/heartbeat`, {
      method: "POST",
      headers: {
        Origin: "null",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ client: "zen-test", version: "1.0.0" }),
    })
    expect(nullRes.headers.get("access-control-allow-origin")).toBe("null")

    // moz-extension origin
    const extRes = await fetch(`http://127.0.0.1:${serverPort}/status`, {
      headers: {
        Origin: "moz-extension://test-extension-uuid",
      },
    })
    expect(extRes.headers.get("access-control-allow-origin")).toBe("moz-extension://test-extension-uuid")
  })
})

const zenPluginNode = makeLocationNode({
  name: "test/zen-browser-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(Plugin)),
  deps: [Tool.node, Permission.node],
})

const zenHarness = (directory: string, assert: Permission.Interface["assert"]) =>
  AppNodeBuilder.build(LayerNode.group([Tool.node, zenPluginNode]), [
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    ),
    Permission.node.replace(permissionLayer({ assert })),
  ])

const zenCall = (id: string) => ({
  sessionID: Session.ID.make("ses_zen_browser_test"),
  ...toolIdentity,
  call: {
    type: "tool-call" as const,
    id,
    name,
    input: { action: "navigate", url: "https://example.com" },
  },
})

describe("zen_browser permission gate", () => {
  it.live("a denied call never reaches the bridge", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const bridge = new ZenBridgeServer({ port: 59998 })
        const prev = getZenBridgeServer()
        setZenBridgeServer(bridge)
        try {
          const tools = yield* Tool.Service
          const denied = yield* executeTool(tools, zenCall("call-zen-deny"))
          expect(denied.status).toBe("error")
          expect(denied.error?.message).toContain("denied for this session")
          // It stopped at the permission gate, not at the bridge.
          expect(denied.error?.message).not.toContain("no Zen Browser extension is currently connected")
        } finally {
          bridge.stop()
          setZenBridgeServer(prev)
        }
      }).pipe(
        Effect.provide(
          zenHarness(
            directory,
            () =>
              Effect.fail(
                new Permission.BlockedError({
                  rules: [],
                  permission: "zen_browser",
                  resources: ["https://example.com"],
                  reason: "zen_browser is denied for this session",
                }),
              ),
          ),
        ),
      ),
    ),
  )

  it.live("an allowed call reaches the bridge and fails there, not at the gate", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const bridge = new ZenBridgeServer({ port: 59997 })
        const prev = getZenBridgeServer()
        setZenBridgeServer(bridge)
        try {
          const tools = yield* Tool.Service
          const allowed = yield* executeTool(tools, zenCall("call-zen-allow"))
          // The gate passed, so the call reached the bridge: with no extension connected
          // run() answers gracefully instead of failing at the gate.
          expect(allowed.status).toBe("completed")
          expect(
            (allowed.content ?? [])
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n"),
          ).toContain("no Zen Browser extension is currently connected")
        } finally {
          bridge.stop()
          setZenBridgeServer(prev)
        }
      }).pipe(Effect.provide(zenHarness(directory, () => Effect.void))),
    ),
  )
})
