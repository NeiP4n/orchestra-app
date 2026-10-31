import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  type BrowserLike,
  formatActionSummary,
  handleRpcAction,
  resolveTargetTabId,
  ZenRpcClient,
} from "../src/rpc-client"

describe("RPC Bridge Client & Actions", () => {
  let mockTabs: Array<{
    id: number
    title: string
    url: string
    active: boolean
    audible: boolean
    mutedInfo?: { muted?: boolean }
  }>

  let mockBrowser: BrowserLike
  let executedScripts: Array<{ tabId: number; funcName: string; args?: unknown[] }>
  let updatedTabs: Array<{ tabId: number; props: Record<string, unknown> }>
  let createdTabs: Array<Record<string, unknown>>
  let removedTabs: number[]

  beforeAll(() => {
    mockTabs = [
      { id: 101, title: "YouTube Music", url: "https://music.youtube.com", active: false, audible: true },
      { id: 102, title: "GitHub Orchestra", url: "https://github.com/org/repo", active: true, audible: false },
    ]

    executedScripts = []
    updatedTabs = []
    createdTabs = []
    removedTabs = []

    mockBrowser = {
      tabs: {
        query: async (queryInfo) => {
          if (queryInfo.audible) {
            return mockTabs.filter((t) => t.audible)
          }
          if (queryInfo.active) {
            return mockTabs.filter((t) => t.active)
          }
          return mockTabs
        },
        update: async (tabId, props) => {
          updatedTabs.push({ tabId, props })
          return { id: tabId, ...props }
        },
        create: async (props) => {
          createdTabs.push(props)
          return { id: 999, ...props }
        },
        remove: async (tabId) => {
          removedTabs.push(tabId)
        },
      },
      scripting: {
        executeScript: async (injection) => {
          executedScripts.push({
            tabId: injection.target.tabId,
            funcName: injection.func.name,
            args: injection.args,
          })

          // Mock return value based on injection function intent
          const funcStr = injection.func.toString()
          if (funcStr.includes("document.title") && funcStr.includes("innerText")) {
            return [{
              result: {
                title: "Mock Page Title",
                url: "https://mock.example.com",
                innerText: "Simulated page body text",
                selection: "Selected text excerpt",
              },
            }]
          }
          if (funcStr.includes("window.eval")) {
            return [{ result: "eval_success_42" }]
          }
          if (funcStr.includes("el.click()")) {
            return [{ result: { clicked: true, tagName: "BUTTON", text: "Submit" } }]
          }
          if (funcStr.includes("dispatchEvent")) {
            return [{ result: { typed: true, length: 12 } }]
          }
          if (funcStr.includes("media.play") || funcStr.includes("media.pause")) {
            return [{ result: { command: injection.args?.[0] ?? "toggle", paused: false } }]
          }

          return [{ result: { executed: true } }]
        },
      },
    }
  })

  describe("resolveTargetTabId", () => {
    it("should return explicit tabId if valid number", async () => {
      const id = await resolveTargetTabId(mockBrowser, 42)
      expect(id).toBe(42)
    })

    it("should resolve active tab id when tabId is omitted", async () => {
      const id = await resolveTargetTabId(mockBrowser)
      expect(id).toBe(102)
    })
  })

  describe("handleRpcAction", () => {
    it("should execute 'tabs' action and return tab list", async () => {
      const result = (await handleRpcAction("tabs", {}, mockBrowser)) as Array<{
        id: number
        title: string
        url: string
        active: boolean
        audible: boolean
      }>

      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBe(2)
      expect(result[0]?.id).toBe(101)
      expect(result[0]?.title).toBe("YouTube Music")
      expect(result[0]?.audible).toBe(true)
      expect(result[1]?.active).toBe(true)
    })

    it("should execute 'read' action on target tab", async () => {
      const result = (await handleRpcAction("read", { tabId: 101 }, mockBrowser)) as {
        title: string
        url: string
        innerText: string
        selection: string
      }

      expect(result.title).toBe("Mock Page Title")
      expect(result.innerText).toBe("Simulated page body text")
      expect(result.selection).toBe("Selected text excerpt")
      expect(executedScripts.some((s) => s.tabId === 101)).toBe(true)
    })

    it("should execute 'eval' action with code parameter", async () => {
      const result = await handleRpcAction("eval", { code: "1 + 1", tabId: 102 }, mockBrowser)
      expect(result).toBe("eval_success_42")
      expect(executedScripts.some((s) => s.args?.[0] === "1 + 1")).toBe(true)
    })

    it("should throw error on 'eval' when code is missing", async () => {
      expect(handleRpcAction("eval", {}, mockBrowser)).rejects.toThrow("Code parameter required")
    })

    it("should execute 'click' action with selector", async () => {
      const result = (await handleRpcAction("click", { selector: "#submit-btn" }, mockBrowser)) as {
        clicked: boolean
      }
      expect(result.clicked).toBe(true)
      expect(executedScripts.some((s) => s.args?.[0] === "#submit-btn")).toBe(true)
    })

    it("should execute 'type' action into form input", async () => {
      const result = (await handleRpcAction("type", { selector: "input.search", text: "Orchestra" }, mockBrowser)) as {
        typed: boolean
      }
      expect(result.typed).toBe(true)
    })

    it("should execute 'navigate' action with existing tab", async () => {
      await handleRpcAction("navigate", { tabId: 101, url: "https://newurl.org" }, mockBrowser)
      expect(updatedTabs.some((u) => u.tabId === 101 && u.props.url === "https://newurl.org")).toBe(true)
    })

    it("should execute 'navigate' action with new tab if no tabId provided", async () => {
      await handleRpcAction("navigate", { url: "https://create.tab" }, mockBrowser)
      expect(createdTabs.some((c) => c.url === "https://create.tab")).toBe(true)
    })

    it("should execute 'activate' action", async () => {
      await handleRpcAction("activate", { tabId: 101 }, mockBrowser)
      expect(updatedTabs.some((u) => u.tabId === 101 && u.props.active === true)).toBe(true)
    })

    it("should execute 'close' action", async () => {
      const result = (await handleRpcAction("close", { tabId: 101 }, mockBrowser)) as { closed: boolean; tabId: number }
      expect(result.closed).toBe(true)
      expect(removedTabs).toContain(101)
    })

    it("should execute 'media' action prioritizing audible tab", async () => {
      const result = (await handleRpcAction("media", { action: "pause" }, mockBrowser)) as { command: string }
      expect(result.command).toBe("pause")
      // Tab 101 is audible in our fixture
      expect(executedScripts.some((s) => s.tabId === 101 && s.args?.[0] === "pause")).toBe(true)
    })

    it("should throw on unsupported action", async () => {
      expect(handleRpcAction("unknown_command", {}, mockBrowser)).rejects.toThrow("Unsupported RPC action")
    })
  })

  describe("formatActionSummary", () => {
    it("should format clear summaries for activity feed", () => {
      expect(formatActionSummary("tabs")).toBe("Inspected open tabs")
      expect(formatActionSummary("read", { tabId: 101 })).toContain("101")
      expect(formatActionSummary("click", { selector: "#play" })).toContain("#play")
      expect(formatActionSummary("media", { action: "pause" })).toContain("pause")
    })
  })

  describe("ZenRpcClient WebSocket lifecycle", () => {
    let wsServer: ReturnType<typeof Bun.serve>
    let wsServerUrl: string
    const serverReceived: unknown[] = []
    let serverWs: { send: (data: string) => void } | null = null

    beforeAll(() => {
      wsServer = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req, server) {
          if (server.upgrade(req, { data: undefined })) return undefined
          return new Response("Upgrade failed", { status: 400 })
        },
        websocket: {
          open(ws) {
            serverWs = ws
          },
          message(_ws, message) {
            try {
              serverReceived.push(JSON.parse(String(message)))
            } catch {
              serverReceived.push(message)
            }
          },
        },
      })
      wsServerUrl = `ws://127.0.0.1:${wsServer.port}`
    })

    afterAll(() => {
      wsServer.stop(true)
    })

    it("should connect, send handshake, and reply to RPC requests", async () => {
      const client = new ZenRpcClient(wsServerUrl, mockBrowser)
      client.start()

      // Wait for handshake
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (serverReceived.some((m) => typeof m === "object" && m && (m as { type?: string }).type === "hello")) {
            clearInterval(interval)
            resolve()
          }
        }, 20)
      })

      expect(client.isConnected).toBe(true)

      // Send RPC command from server to extension client
      serverWs?.send(JSON.stringify({ id: "req_tabs_1", action: "tabs" }))

      // Wait for response
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (serverReceived.some((m) => typeof m === "object" && m && (m as { id?: string }).id === "req_tabs_1")) {
            clearInterval(interval)
            resolve()
          }
        }, 20)
      })

      const reply = serverReceived.find(
        (m) => typeof m === "object" && m && (m as { id?: string }).id === "req_tabs_1",
      ) as { id: string; success: boolean; result: Array<unknown> }

      expect(reply.success).toBe(true)
      expect(Array.isArray(reply.result)).toBe(true)
      expect(reply.result.length).toBe(2)

      // Send invalid RPC command from server
      serverWs?.send(JSON.stringify({ id: "req_bad_1", action: "nonexistent_action" }))

      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (serverReceived.some((m) => typeof m === "object" && m && (m as { id?: string }).id === "req_bad_1")) {
            clearInterval(interval)
            resolve()
          }
        }, 20)
      })

      const errReply = serverReceived.find(
        (m) => typeof m === "object" && m && (m as { id?: string }).id === "req_bad_1",
      ) as { id: string; success: boolean; error: string }

      expect(errReply.success).toBe(false)
      expect(errReply.error).toContain("Unsupported RPC action")

      client.stop()
      expect(client.isConnected).toBe(false)
    })
  })

  describe("ZenRpcClient HTTP Polling & Heartbeat fallback", () => {
    let fallbackServer: ReturnType<typeof Bun.serve>
    let fallbackHttpUrl: string
    const heartbeatsReceived: unknown[] = []
    const httpResultsReceived: Array<{ id: string; success: boolean; result?: unknown }> = []
    let pendingPollRequest: { id: string; action: string; params?: Record<string, unknown> } | null = null

    beforeAll(() => {
      fallbackServer = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          const url = new URL(req.url)

          if (req.method === "POST" && url.pathname === "/heartbeat") {
            const body = await req.json()
            heartbeatsReceived.push(body)
            return Response.json({ ok: true, timestamp: Date.now() })
          }

          if (req.method === "GET" && url.pathname === "/poll") {
            if (pendingPollRequest) {
              const reqToSend = pendingPollRequest
              pendingPollRequest = null
              return Response.json(reqToSend)
            }
            return new Response(null, { status: 204 })
          }

          if (req.method === "POST" && url.pathname === "/result") {
            const body = (await req.json()) as { id: string; success: boolean; result?: unknown }
            httpResultsReceived.push(body)
            return Response.json({ received: true })
          }

          return new Response("Not Found", { status: 404 })
        },
      })

      fallbackHttpUrl = `http://127.0.0.1:${fallbackServer.port}`
    })

    afterAll(() => {
      fallbackServer.stop(true)
    })

    it("should send heartbeat and execute RPC requests via HTTP polling when WS is offline", async () => {
      // Point WS to an unavailable port to trigger HTTP fallback
      const offlineWsUrl = "ws://127.0.0.1:59989"
      const client = new ZenRpcClient(offlineWsUrl, mockBrowser, fallbackHttpUrl)

      pendingPollRequest = {
        id: "poll_action_123",
        action: "tabs",
      }

      client.start()

      // Wait for heartbeat or poll result
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (
            heartbeatsReceived.length > 0 &&
            httpResultsReceived.some((r) => r.id === "poll_action_123")
          ) {
            clearInterval(interval)
            resolve()
          }
        }, 50)
      })

      expect(client.isConnected).toBe(true)
      expect(client.isWsConnected).toBe(false)
      expect(heartbeatsReceived.some((h) => (h as { client?: string }).client === "zen-extension")).toBe(true)

      const executedResult = httpResultsReceived.find((r) => r.id === "poll_action_123")
      expect(executedResult?.success).toBe(true)
      expect(Array.isArray(executedResult?.result)).toBe(true)
      expect((executedResult?.result as Array<unknown>).length).toBe(2)

      client.stop()
      expect(client.isConnected).toBe(false)
    })
  })
})
