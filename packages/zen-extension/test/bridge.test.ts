import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  buildAuthHeader,
  buildPageContextPayload,
  buildSelectionPayload,
  checkServerStatus,
  createSession,
  detectActiveServer,
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

  let authServer: ReturnType<typeof Bun.serve>
  let authServerUrl: string
  const AUTH_SECRET = "zen-secret-token"

  beforeAll(() => {
    errorServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" })
      },
    })
    errorServerUrl = `http://127.0.0.1:${errorServer.port}`

    authServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const auth = req.headers.get("authorization")
        const expectedBasic = buildAuthHeader(AUTH_SECRET)
        const expectedBearer = `Bearer ${AUTH_SECRET}`

        if (auth !== expectedBasic && auth !== expectedBearer) {
          return new Response(JSON.stringify({ error: "Authentication required" }), {
            status: 401,
            statusText: "Unauthorized",
            headers: { "Content-Type": "application/json" },
          })
        }

        const url = new URL(req.url)
        if (url.pathname === "/api/info") {
          return Response.json({ version: "2.5.0-auth", status: "ready" })
        }
        if (url.pathname === "/api/session") {
          if (req.method === "POST") {
            return Response.json({ id: "ses_auth_created" })
          }
          return Response.json([{ id: "ses_auth_1", title: "Protected Session" }])
        }
        if (url.pathname.endsWith("/prompt")) {
          return Response.json({ success: true })
        }

        return new Response("Not Found", { status: 404 })
      },
    })
    authServerUrl = `http://127.0.0.1:${authServer.port}`

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

        return new Response("Not Found", { status: 404, statusText: "Not Found" })
      },
    })

    serverUrl = `http://127.0.0.1:${mockServer.port}`
  })

  afterAll(() => {
    mockServer.stop(true)
    errorServer.stop(true)
    authServer.stop(true)
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
      expect(payload.length).toBeLessThan(4500)
    })
  })

  describe("Authorization header generation", () => {
    it("should return undefined for empty or missing password", () => {
      expect(buildAuthHeader(undefined)).toBeUndefined()
      expect(buildAuthHeader("")).toBeUndefined()
      expect(buildAuthHeader("   ")).toBeUndefined()
    })

    it("should construct Basic auth header from raw password", () => {
      const header = buildAuthHeader("my-secret")
      expect(header).toBe(`Basic ${btoa(":my-secret")}`)
    })

    it("should construct Basic auth header from username:password", () => {
      const header = buildAuthHeader("admin:secret")
      expect(header).toBe(`Basic ${btoa("admin:secret")}`)
    })

    it("should preserve Bearer token prefix when supplied", () => {
      const header = buildAuthHeader("Bearer token_xyz_123")
      expect(header).toBe("Bearer token_xyz_123")
    })

    it("should preserve pre-encoded Basic header", () => {
      const header = buildAuthHeader("Basic dXNlcjpwYXNz")
      expect(header).toBe("Basic dXNlcjpwYXNz")
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

  describe("Authenticated server handling (401)", () => {
    it("should detect that authentication is required when password is not supplied", async () => {
      const status = await checkServerStatus(authServerUrl)
      expect(status.online).toBe(true)
      expect(status.requiresAuth).toBe(true)
      expect(status.error).toContain("Authentication required")
    })

    it("should succeed connecting to protected server when correct password is provided", async () => {
      const status = await checkServerStatus(authServerUrl, AUTH_SECRET)
      expect(status.online).toBe(true)
      expect(status.requiresAuth).toBe(false)
      expect(status.version).toBe("2.5.0-auth")
    })

    it("should reject listSessions on protected server without password", async () => {
      const res = await listSessions(authServerUrl)
      expect(res.success).toBe(false)
      expect(res.error).toContain("401")
    })

    it("should succeed listSessions on protected server with valid password", async () => {
      const res = await listSessions(authServerUrl, AUTH_SECRET)
      expect(res.success).toBe(true)
      expect(res.sessions.length).toBe(1)
      expect(res.sessions[0]?.id).toBe("ses_auth_1")
    })

    it("should succeed createSession and sendPrompt with valid password", async () => {
      const createRes = await createSession("Secret Session", authServerUrl, AUTH_SECRET)
      expect(createRes.success).toBe(true)
      expect(createRes.sessionID).toBe("ses_auth_created")

      const promptRes = await sendPrompt("ses_auth_1", "Secret prompt", authServerUrl, AUTH_SECRET)
      expect(promptRes.success).toBe(true)
    })
  })

  describe("Port auto-detection (detectActiveServer)", () => {
    it("should find active server across candidate ports", async () => {
      const mockPort = mockServer.port!
      const detection = await detectActiveServer([59981, 59982, mockPort, 59983])

      expect(detection.found).toBe(true)
      expect(detection.port).toBe(mockPort)
      expect(detection.url).toBe(`http://127.0.0.1:${mockPort}`)
      expect(detection.version).toBe("2.1.0")
      expect(detection.requiresAuth).toBe(false)
    })

    it("should detect active server even if it requires authentication (401)", async () => {
      const authPort = authServer.port!
      const detection = await detectActiveServer([59981, authPort, 59982])

      expect(detection.found).toBe(true)
      expect(detection.port).toBe(authPort)
      expect(detection.requiresAuth).toBe(true)
    })

    it("should report found=false when all candidate ports are offline", async () => {
      const detection = await detectActiveServer([59981, 59982, 59983])
      expect(detection.found).toBe(false)
      expect(detection.port).toBeUndefined()
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
