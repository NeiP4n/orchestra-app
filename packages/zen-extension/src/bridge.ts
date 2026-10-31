/**
 * Orchestra WebExtension Bridge for Zen Browser
 * Handles communication with local Orchestra daemon / HTTP API, port scanning, and authentication.
 */

export const DEFAULT_SERVER_URL = "http://127.0.0.1:4096"
export const FALLBACK_SERVER_URL = "http://localhost:4096"
export const DEFAULT_SCAN_PORTS = [4096, 4444, 49375, 64022]

export interface ServerStatus {
  readonly online: boolean
  readonly version?: string
  readonly requiresAuth?: boolean
  readonly error?: string
}

export interface DetectionResult {
  readonly found: boolean
  readonly url: string
  readonly port?: number
  readonly version?: string
  readonly requiresAuth?: boolean
}

export interface SessionSummary {
  readonly id: string
  readonly title?: string
}

export interface SessionListResult {
  readonly success: boolean
  readonly sessions: readonly SessionSummary[]
  readonly error?: string
}

export interface CreateSessionResult {
  readonly success: boolean
  readonly sessionID?: string
  readonly error?: string
}

export interface SendPromptResult {
  readonly success: boolean
  readonly error?: string
}

export interface PageContext {
  readonly title: string
  readonly url: string
  readonly text?: string
  readonly selection?: string
}

/**
 * Construct Basic or Bearer authorization header for Orchestra API.
 */
export function buildAuthHeader(password?: string): string | undefined {
  if (!password || !password.trim()) return undefined
  const trimmed = password.trim()
  if (trimmed.startsWith("Basic ") || trimmed.startsWith("Bearer ")) {
    return trimmed
  }
  const credential = trimmed.includes(":") ? trimmed : `:${trimmed}`
  const encoded = typeof btoa === "function" ? btoa(credential) : Buffer.from(credential).toString("base64")
  return `Basic ${encoded}`
}

/**
 * Format a text selection excerpt into an Orchestra prompt payload.
 */
export function buildSelectionPayload(selectionText: string, pageUrl: string, pageTitle: string): string {
  const cleanSelection = selectionText.trim()
  const titlePart = pageTitle ? ` from "${pageTitle}"` : ""
  return `Here is a selection${titlePart} (${pageUrl}):\n\n> ${cleanSelection.split("\n").join("\n> ")}\n\nPlease analyze this excerpt and help me with it.`
}

/**
 * Format page context (URL, title, extracted text) into an Orchestra prompt payload.
 */
export function buildPageContextPayload(pageContent: { title: string; url: string; text?: string }): string {
  const cleanTitle = pageContent.title.trim()
  const cleanUrl = pageContent.url.trim()
  const bodyPart = pageContent.text ? `\n\nPage text excerpt:\n${pageContent.text.slice(0, 4000)}` : ""
  return `Please analyze the current web page in Zen Browser:\n- Title: ${cleanTitle}\n- URL: ${cleanUrl}${bodyPart}`
}

/**
 * Internal timeout helper for fetch requests.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 4000,
  customFetch: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await customFetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Check if the local Orchestra service is running and responsive on the specified URL.
 */
export async function checkServerStatus(
  serverUrl = DEFAULT_SERVER_URL,
  password?: string,
  customFetch: typeof fetch = fetch,
): Promise<ServerStatus> {
  try {
    const headers: Record<string, string> = {}
    const auth = buildAuthHeader(password)
    if (auth) headers["Authorization"] = auth

    const res = await fetchWithTimeout(`${serverUrl}/api/info`, { method: "GET", headers }, 2500, customFetch)
    if (res.status === 401) {
      return { online: true, requiresAuth: true, error: "Authentication required" }
    }
    if (!res.ok) {
      return { online: false, error: `HTTP ${res.status}: ${res.statusText}` }
    }
    const data = (await res.json()) as { version?: string; status?: string }
    return { online: true, version: data.version ?? "unknown", requiresAuth: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { online: false, error: message }
  }
}

/**
 * Detect active local Orchestra server by scanning standard/candidate ports.
 */
export async function detectActiveServer(
  ports: readonly number[] = DEFAULT_SCAN_PORTS,
  password?: string,
  customFetch: typeof fetch = fetch,
): Promise<DetectionResult> {
  for (const port of ports) {
    const candidateUrl = `http://127.0.0.1:${port}`
    const status = await checkServerStatus(candidateUrl, password, customFetch)
    if (status.online) {
      return {
        found: true,
        url: candidateUrl,
        port,
        version: status.version,
        requiresAuth: status.requiresAuth,
      }
    }
  }
  return { found: false, url: DEFAULT_SERVER_URL }
}

/**
 * Fetch available sessions from the local Orchestra server.
 */
export async function listSessions(
  serverUrl = DEFAULT_SERVER_URL,
  password?: string,
  customFetch: typeof fetch = fetch,
): Promise<SessionListResult> {
  try {
    const headers: Record<string, string> = {}
    const auth = buildAuthHeader(password)
    if (auth) headers["Authorization"] = auth

    const res = await fetchWithTimeout(`${serverUrl}/api/session`, { method: "GET", headers }, 4000, customFetch)
    if (res.status === 401) {
      return { success: false, sessions: [], error: "HTTP 401: Authentication required" }
    }
    if (!res.ok) {
      return { success: false, sessions: [], error: `HTTP ${res.status}: ${res.statusText}` }
    }
    const data = (await res.json()) as Array<{ id: string; title?: string }>
    const sessions = (Array.isArray(data) ? data : []).map((s) => ({
      id: s.id,
      title: s.title || `Session ${s.id.slice(0, 8)}`,
    }))
    return { success: true, sessions }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, sessions: [], error: message }
  }
}

/**
 * Create a new Orchestra session for browser context.
 */
export async function createSession(
  title?: string,
  serverUrl = DEFAULT_SERVER_URL,
  password?: string,
  customFetch: typeof fetch = fetch,
): Promise<CreateSessionResult> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    const auth = buildAuthHeader(password)
    if (auth) headers["Authorization"] = auth

    const res = await fetchWithTimeout(
      `${serverUrl}/api/session`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ title: title ?? "Zen Browser Session" }),
      },
      5000,
      customFetch,
    )
    if (res.status === 401) {
      return { success: false, error: "HTTP 401: Authentication required" }
    }
    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}: ${res.statusText}` }
    }
    const data = (await res.json()) as { id?: string }
    if (!data.id) {
      return { success: false, error: "Server response missing session ID" }
    }
    return { success: true, sessionID: data.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, error: message }
  }
}

/**
 * Send a prompt message into an Orchestra session.
 */
export async function sendPrompt(
  sessionID: string,
  text: string,
  serverUrl = DEFAULT_SERVER_URL,
  password?: string,
  customFetch: typeof fetch = fetch,
): Promise<SendPromptResult> {
  if (!sessionID) {
    return { success: false, error: "Session ID is required" }
  }
  if (!text.trim()) {
    return { success: false, error: "Prompt text cannot be empty" }
  }
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    const auth = buildAuthHeader(password)
    if (auth) headers["Authorization"] = auth

    const res = await fetchWithTimeout(
      `${serverUrl}/api/session/${sessionID}/prompt`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ text }),
      },
      8000,
      customFetch,
    )
    if (res.status === 401) {
      return { success: false, error: "HTTP 401: Authentication required" }
    }
    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}: ${res.statusText}` }
    }
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, error: message }
  }
}

/**
 * Storage helpers for WebExtension context (supporting both browser and chrome namespaces).
 */
export function getExtensionStorage(): {
  get: (keys: string[]) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
} {
  const browserApi = typeof globalThis !== "undefined"
    ? ((globalThis as unknown as { browser?: unknown; chrome?: unknown }).browser
        ?? (globalThis as unknown as { chrome?: unknown }).chrome) as {
        storage?: {
          local?: {
            get: (keys: string[], cb?: (res: Record<string, unknown>) => void) => Promise<Record<string, unknown>> | void
            set: (items: Record<string, unknown>, cb?: () => void) => Promise<void> | void
          }
        }
      } | undefined
    : undefined

  return {
    async get(keys: string[]): Promise<Record<string, unknown>> {
      if (!browserApi?.storage?.local) return {}
      const res = browserApi.storage.local.get(keys)
      if (res && typeof (res as Promise<unknown>).then === "function") {
        return (await res) as Record<string, unknown>
      }
      return new Promise((resolve) => {
        browserApi.storage?.local?.get(keys, (items) => resolve(items ?? {}))
      })
    },
    async set(items: Record<string, unknown>): Promise<void> {
      if (!browserApi?.storage?.local) return
      const res = browserApi.storage.local.set(items)
      if (res && typeof (res as Promise<unknown>).then === "function") {
        await res
        return
      }
      return new Promise((resolve) => {
        browserApi.storage?.local?.set(items, () => resolve())
      })
    },
  }
}

export async function getStoredServerUrl(): Promise<string> {
  const storage = getExtensionStorage()
  const data = await storage.get(["serverUrl"])
  return typeof data.serverUrl === "string" && data.serverUrl ? data.serverUrl : DEFAULT_SERVER_URL
}

export async function setStoredServerUrl(url: string): Promise<void> {
  const storage = getExtensionStorage()
  await storage.set({ serverUrl: url })
}

export async function getStoredServerPassword(): Promise<string> {
  const storage = getExtensionStorage()
  const data = await storage.get(["serverPassword"])
  return typeof data.serverPassword === "string" ? data.serverPassword : ""
}

export async function setStoredServerPassword(password: string): Promise<void> {
  const storage = getExtensionStorage()
  await storage.set({ serverPassword: password })
}

export async function getStoredSessionId(): Promise<string | undefined> {
  const storage = getExtensionStorage()
  const data = await storage.get(["activeSessionId"])
  return typeof data.activeSessionId === "string" ? data.activeSessionId : undefined
}

export async function setStoredSessionId(id: string): Promise<void> {
  const storage = getExtensionStorage()
  await storage.set({ activeSessionId: id })
}
