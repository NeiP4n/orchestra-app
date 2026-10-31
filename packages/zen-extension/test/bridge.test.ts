import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  buildPageContextPayload,
  buildSelectionPayload,
  checkServerStatus,
  createSession,
  listSessions,
  sendPrompt,
} from "../src/bridge"

describe("Orchestra Bridge Client", () => {
  let mockServer: ReturnType<typeof Bun.serve>
  let serverUrl: string
  const receivedPrompts: Array<{ sessionID: string; text: string }> = []
  const createdSessions: Array<{ title?: string }> = []

  let errorServer: ReturnType<typeof Bun.serve>
  let errorServerUrl: string

  beforeAll(() => {
    errorServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" })
      },
    })
    errorServerUrl = `http://127.0.0.1:${errorServer.port}`

    mockServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url)

        if (req.method === "GET" && url.pathname === "/api/info") {
          return Response.json({
            version: "2.1.0",
            status: "ready",
            identity: "orchestra-test-daemon",
          })
        }

        if (req.method === "GET" && url.pathname === "/api/session") {
          return Response.json([
            { id: "ses_alpha", title: "Alpha Session" },
            { id: "ses_beta", title: "Beta Session" },
          ])
        }

        if (req.method === "POST" && url.pathname === "/api/session") {
          return req.json().then((body: { title?: string }) => {
            createdSessions.push(body)
            return Response.json({
              id: "ses_generated_123",
              title: body.title ?? "Untitled",
            })
          })
        }

        const promptMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/prompt$/)
        if (req.method === "POST" && promptMatch) {
          const sessionID = promptMatch[1]
          return req.json().then((body: { text?: string }) => {
            if (!body.text) {
              return new Response(JSON.stringify({ error: "Missing text" }), { status: 400 })
            }
            receivedPrompts.push({ sessionID, text: body.text })
            return Response.json({ success: true, enqueued: true })
          })
        }

        if (url.pathname === "/api/error-test") {
          return new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" })
        }

        return new Response("Not Found", { status: 404, statusText: "Not Found" })
      },
    })

    serverUrl = `http://127.0.0.1:${mockServer.port}`
  })

  afterAll(() => {
    mockServer.stop(true)
    errorServer.stop(true)
  })

  describe("Payload formatting", () => {
    it("should build structured selection payload with quote indentation and page link", () => {
      const payload = buildSelectionPayload(
        "First line\nSecond line",
        "https://example.com/docs",
        "Example Documentation",
      )

      expect(payload).toContain('from "Example Documentation"')
      expect(payload).toContain("(https://example.com/docs):")
      expect(payload).toContain("> First line\n> Second line")
      expect(payload).toContain("Please analyze this excerpt and help me with it.")
    })

    it("should handle missing page title gracefully", () => {
      const payload = buildSelectionPayload("Short excerpt", "https://zen-browser.app", "")
      expect(payload).toContain("Here is a selection (https://zen-browser.app):")
      expect(payload).toContain("> Short excerpt")
    })

    it("should build page context payload and truncate oversized body excerpts", () => {
      const longText = "a".repeat(6000)
      const payload = buildPageContextPayload({
        title: "Zen Browser Deep Dive",
        url: "https://zen-browser.app/features",
        text: longText,
      })

      expect(payload).toContain("Title: Zen Browser Deep Dive")
      expect(payload).toContain("URL: https://zen-browser.app/features")
      expect(payload).toContain("Page text excerpt:")
      // Body excerpt truncated to max 4000 characters
      expect(payload.length).toBeLessThan(4500)
    })
  })

  describe("Server communication", () => {
    it("should report online status and version when server is healthy", async () => {
      const status = await checkServerStatus(serverUrl)
      expect(status.online).toBe(true)
      expect(status.version).toBe("2.1.0")
      expect(status.error).toBeUndefined()
    })

    it("should list active sessions from Orchestra daemon", async () => {
      const result = await listSessions(serverUrl)
      expect(result.success).toBe(true)
      expect(result.sessions.length).toBe(2)
      expect(result.sessions[0]).toEqual({ id: "ses_alpha", title: "Alpha Session" })
      expect(result.sessions[1]).toEqual({ id: "ses_beta", title: "Beta Session" })
    })

    it("should create a new session", async () => {
      const result = await createSession("Zen Test Tab", serverUrl)
      expect(result.success).toBe(true)
      expect(result.sessionID).toBe("ses_generated_123")
      expect(createdSessions.some((s) => s.title === "Zen Test Tab")).toBe(true)
    })

    it("should send prompt into target session", async () => {
      const result = await sendPrompt("ses_alpha", "Analyze this design pattern", serverUrl)
      expect(result.success).toBe(true)
      expect(receivedPrompts.some((p) => p.sessionID === "ses_alpha" && p.text === "Analyze this design pattern")).toBe(
        true,
      )
    })

    it("should reject invalid prompt calls before making network requests", async () => {
      const emptySessionResult = await sendPrompt("", "Valid text", serverUrl)
      expect(emptySessionResult.success).toBe(false)
      expect(emptySessionResult.error).toContain("Session ID is required")

      const emptyTextResult = await sendPrompt("ses_alpha", "   ", serverUrl)
      expect(emptyTextResult.success).toBe(false)
      expect(emptyTextResult.error).toContain("Prompt text cannot be empty")
    })

    it("should handle HTTP 500 error gracefully", async () => {
      const result = await checkServerStatus(errorServerUrl)
      expect(result.online).toBe(false)
      expect(result.error).toContain("500")

      const promptRes = await sendPrompt("ses_1", "test prompt", errorServerUrl)
      expect(promptRes.success).toBe(false)
      expect(promptRes.error).toContain("500")
    })
  })

  describe("Offline resilience", () => {
    const offlineUrl = "http://127.0.0.1:59981" // intentionally unallocated port

    it("should gracefully report offline server status without throwing", async () => {
      const status = await checkServerStatus(offlineUrl)
      expect(status.online).toBe(false)
      expect(status.error).toBeDefined()
    })

    it("should handle listSessions failure when offline", async () => {
      const res = await listSessions(offlineUrl)
      expect(res.success).toBe(false)
      expect(res.sessions).toEqual([])
      expect(res.error).toBeDefined()
    })

    it("should handle createSession failure when offline", async () => {
      const res = await createSession("Offline test", offlineUrl)
      expect(res.success).toBe(false)
      expect(res.sessionID).toBeUndefined()
      expect(res.error).toBeDefined()
    })

    it("should handle sendPrompt failure when offline", async () => {
      const res = await sendPrompt("ses_any", "test", offlineUrl)
      expect(res.success).toBe(false)
      expect(res.error).toBeDefined()
    })
  })
})
