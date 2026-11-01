import {
  buildPageContextPayload,
  buildSelectionPayload,
  checkServerStatus,
  createSession,
  DEFAULT_SERVER_URL,
  detectActiveServer,
  getStoredServerPassword,
  getStoredServerUrl,
  getStoredSessionId,
  listSessions,
  sendPrompt,
  setStoredServerUrl,
  setStoredSessionId,
} from "./bridge"
import { type AiActivityEvent, ZenRpcClient } from "./rpc-client"

type WebExtGlobal = {
  runtime?: {
    onInstalled?: { addListener: (cb: () => void) => void }
    onMessage?: {
      addListener: (cb: (msg: unknown, sender: unknown, sendResponse: (res?: unknown) => void) => boolean | void) => void
    }
    onConnect?: {
      addListener: (cb: (port: { name?: string; onDisconnect?: { addListener: (cb: () => void) => void } }) => void) => void
    }
    sendMessage?: (message: unknown) => Promise<unknown>
  }
  contextMenus?: {
    create: (props: Record<string, unknown>, cb?: () => void) => void
    removeAll: (cb?: () => void) => void
    onClicked?: {
      addListener: (cb: (info: { menuItemId: string; selectionText?: string; pageUrl?: string }, tab?: { id?: number; title?: string; url?: string }) => void) => void
    }
  }
  alarms?: {
    create: (name: string, alarmInfo: { periodInMinutes?: number; delayInMinutes?: number }) => void
    get: (name: string, cb: (alarm: unknown) => void) => void
    onAlarm?: {
      addListener: (cb: (alarm: { name?: string }) => void) => void
    }
  }
  tabs?: {
    query: (queryInfo: { active: boolean; currentWindow?: boolean }) => Promise<Array<{ id?: number; title?: string; url?: string }>>
    sendMessage?: (tabId: number, message: unknown) => Promise<unknown>
  }
  action?: {
    setBadgeText?: (details: { text: string }) => void
    setBadgeBackgroundColor?: (details: { color: string }) => void
  }
}

const api = (typeof globalThis !== "undefined"
  ? ((globalThis as unknown as { browser?: WebExtGlobal }).browser ?? (globalThis as unknown as { chrome?: WebExtGlobal }).chrome)
  : undefined) as WebExtGlobal | undefined

const MENU_SEND_SELECTION = "orchestra-send-selection"
const MENU_ANALYZE_PAGE = "orchestra-analyze-page"

const recentAiActivities: AiActivityEvent[] = []
const MAX_ACTIVITIES = 30

function recordActivity(activity: AiActivityEvent) {
  recentAiActivities.unshift(activity)
  if (recentAiActivities.length > MAX_ACTIVITIES) {
    recentAiActivities.pop()
  }
}

function setBadge(text: string, color = "#5b89f7") {
  try {
    api?.action?.setBadgeText?.({ text })
    api?.action?.setBadgeBackgroundColor?.({ color })
    if (text) {
      setTimeout(() => {
        api?.action?.setBadgeText?.({ text: "" })
      }, 3000)
    }
  } catch {
    // Ignore badge errors if action API is restricted
  }
}

function setupContextMenus() {
  if (!api?.contextMenus) return

  try {
    api.contextMenus.removeAll?.(() => {
      try {
        api.contextMenus?.create?.({
          id: MENU_SEND_SELECTION,
          title: "Send selection to Orchestra",
          contexts: ["selection"],
        })

        api.contextMenus?.create?.({
          id: MENU_ANALYZE_PAGE,
          title: "Analyze page with Orchestra",
          contexts: ["page", "selection"],
        })
      } catch (err) {
        console.warn("[Orchestra Zen] setupContextMenus create error:", err)
      }
    })
  } catch (err) {
    console.warn("[Orchestra Zen] setupContextMenus removeAll error:", err)
  }
}

async function resolveServer(password?: string): Promise<{ url: string; online: boolean; requiresAuth?: boolean }> {
  let serverUrl = await getStoredServerUrl()
  let status = await checkServerStatus(serverUrl, password)

  if (!status.online) {
    const detection = await detectActiveServer(undefined, password)
    if (detection.found) {
      serverUrl = detection.url
      await setStoredServerUrl(serverUrl)
      status = { online: true, version: detection.version, requiresAuth: detection.requiresAuth }
    }
  }

  return { url: serverUrl, online: status.online, requiresAuth: status.requiresAuth }
}

async function ensureTargetSession(serverUrl: string, password?: string): Promise<string | undefined> {
  const storedId = await getStoredSessionId()
  if (storedId) {
    const listRes = await listSessions(serverUrl, password)
    if (listRes.success && listRes.sessions.some((s) => s.id === storedId)) {
      return storedId
    }
  }

  const listRes = await listSessions(serverUrl, password)
  if (listRes.success && listRes.sessions.length > 0) {
    const firstId = listRes.sessions[0]?.id
    if (firstId) {
      await setStoredSessionId(firstId)
      return firstId
    }
  }

  const createRes = await createSession("Zen Browser Session", serverUrl, password)
  if (createRes.success && createRes.sessionID) {
    await setStoredSessionId(createRes.sessionID)
    return createRes.sessionID
  }

  return undefined
}

async function handleContextMenuClick(
  info: { menuItemId: string; selectionText?: string; pageUrl?: string },
  tab?: { id?: number; title?: string; url?: string },
) {
  const password = await getStoredServerPassword()
  const server = await resolveServer(password)

  if (!server.online) {
    setBadge("ERR", "#ef4444")
    console.error("[Orchestra Zen] Cannot dispatch: local server is offline at", server.url)
    return
  }

  if (server.requiresAuth && !password) {
    setBadge("AUTH", "#f59e0b")
    console.error("[Orchestra Zen] Server requires authentication. Please configure password in settings.")
    return
  }

  const sessionID = await ensureTargetSession(server.url, password)
  if (!sessionID) {
    setBadge("ERR", "#ef4444")
    console.error("[Orchestra Zen] Failed to obtain an active Orchestra session")
    return
  }

  const pageUrl = tab?.url || info.pageUrl || "about:blank"
  const pageTitle = tab?.title || "Web Page"

  let prompt = ""
  if (info.menuItemId === MENU_SEND_SELECTION && info.selectionText) {
    prompt = buildSelectionPayload(info.selectionText, pageUrl, pageTitle)
  } else if (info.menuItemId === MENU_ANALYZE_PAGE) {
    prompt = buildPageContextPayload({
      title: pageTitle,
      url: pageUrl,
    })
  }

  if (!prompt) return

  setBadge("...", "#3b82f6")
  const result = await sendPrompt(sessionID, prompt, server.url, password)
  if (result.success) {
    setBadge("OK", "#10b981")
  } else {
    setBadge("FAIL", "#ef4444")
    console.error("[Orchestra Zen] sendPrompt error:", result.error)
  }
}

const KEEPALIVE_ALARM_NAME = "orchestra-keepalive"

function setupKeepAliveAlarm() {
  if (!api?.alarms) {
    console.warn("[Orchestra Zen] alarms API is not available")
    return
  }

  try {
    api.alarms.create(KEEPALIVE_ALARM_NAME, {
      periodInMinutes: 0.25, // every 15 seconds
    })
    console.log("[Orchestra Zen] Registered keepalive alarm (every 15s)")
  } catch (err) {
    console.error("[Orchestra Zen] Failed to register keepalive alarm:", err)
  }
}

// Synchronous top-level alarm listener wakes up background script when alarm triggers
if (api?.alarms?.onAlarm) {
  api.alarms.onAlarm.addListener((alarm: { name?: string }) => {
    if (alarm.name === KEEPALIVE_ALARM_NAME) {
      console.log("[Orchestra Zen] Keepalive alarm tick: ensuring connection...")
      try {
        rpcClient?.ensureConnected?.()
      } catch (err) {
        console.error("[Orchestra Zen] Keepalive ensureConnected error:", err)
      }
      void (async () => {
        try {
          await fetch("http://127.0.0.1:4097/heartbeat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client: "zen-extension-alarm", version: "1.0.0" }),
          })
        } catch {
          // ignore
        }
      })()
    }
  })
}

// Synchronous top-level port listener keeps background active when sidebar or popup is open
if (api?.runtime?.onConnect) {
  api.runtime.onConnect.addListener((port: any) => {
    console.log(`[Orchestra Zen] Port connected: ${port?.name ?? "unknown"}`)
    port?.onDisconnect?.addListener(() => {
      console.log(`[Orchestra Zen] Port disconnected: ${port?.name ?? "unknown"}`)
    })
  })
}

// Initialize RPC client for autonomous AI control over Zen Browser
let rpcClient: ZenRpcClient | undefined

try {
  console.log("[Orchestra Zen] Starting ZenRpcClient on port 4097...")
  rpcClient = new ZenRpcClient({ port: 4097 })
  rpcClient.start()
  console.log("[Orchestra Zen] ZenRpcClient started successfully")
} catch (err) {
  console.error("[Orchestra Zen] Failed to initialize ZenRpcClient:", err)
}

try {
  setupKeepAliveAlarm()
} catch (err) {
  console.error("[Orchestra Zen] setupKeepAliveAlarm error:", err)
}

if (api?.runtime?.onInstalled) {
  api.runtime.onInstalled.addListener(() => {
    try {
      setupContextMenus()
    } catch (err) {
      console.warn("[Orchestra Zen] onInstalled setupContextMenus error:", err)
    }
  })
} else {
  try {
    setupContextMenus()
  } catch (err) {
    console.warn("[Orchestra Zen] setupContextMenus error:", err)
  }
}

if (api?.contextMenus?.onClicked) {
  api.contextMenus.onClicked.addListener((info: any, tab: any) => {
    try {
      void handleContextMenuClick(info, tab)
    } catch (err) {
      console.error("[Orchestra Zen] handleContextMenuClick error:", err)
    }
  })
}

// Background message bus for sidebar / popup actions and AI activity
if (api?.runtime?.onMessage) {
  api.runtime.onMessage.addListener((message: unknown, _sender: unknown, sendResponse: (res?: unknown) => void) => {
    const msg = message as { type?: string; payload?: unknown; activity?: AiActivityEvent }
    if (msg.type === "CHECK_STATUS") {
      void (async () => {
        try {
          const password = await getStoredServerPassword()
          const resolved = await resolveServer(password)
          sendResponse(resolved)
        } catch (err) {
          console.error("[Orchestra Zen] CHECK_STATUS error:", err)
          sendResponse({ url: DEFAULT_SERVER_URL, online: false })
        }
      })()
      return true
    }
    if (msg.type === "GET_ACTIVE_TAB") {
      if (api.tabs?.query) {
        void api.tabs.query({ active: true, currentWindow: true }).then((tabs: any[]) => {
          sendResponse(tabs[0] ?? null)
        }).catch((err: any) => {
          console.error("[Orchestra Zen] GET_ACTIVE_TAB error:", err)
          sendResponse(null)
        })
        return true
      }
      sendResponse(null)
      return false
    }
    if (msg.type === "GET_RPC_STATUS") {
      sendResponse({ connected: rpcClient?.isConnected ?? false })
      return false
    }
    if (msg.type === "GET_AI_ACTIVITIES") {
      sendResponse({ activities: recentAiActivities })
      return false
    }
    if (msg.type === "AI_ACTIVITY" && msg.activity) {
      recordActivity(msg.activity)
      return false
    }
    return false
  })
}
