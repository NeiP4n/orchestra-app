import {
  buildPageContextPayload,
  buildSelectionPayload,
  checkServerStatus,
  createSession,
  getStoredServerUrl,
  getStoredSessionId,
  listSessions,
  sendPrompt,
  setStoredSessionId,
} from "./bridge"

type WebExtGlobal = {
  runtime?: {
    onInstalled?: { addListener: (cb: () => void) => void }
    onMessage?: {
      addListener: (cb: (msg: unknown, sender: unknown, sendResponse: (res?: unknown) => void) => boolean | void) => void
    }
  }
  contextMenus?: {
    create: (props: Record<string, unknown>, cb?: () => void) => void
    removeAll: (cb?: () => void) => void
    onClicked?: {
      addListener: (cb: (info: { menuItemId: string; selectionText?: string; pageUrl?: string }, tab?: { id?: number; title?: string; url?: string }) => void) => void
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

  api.contextMenus.removeAll?.(() => {
    api.contextMenus?.create({
      id: MENU_SEND_SELECTION,
      title: "Send selection to Orchestra",
      contexts: ["selection"],
    })

    api.contextMenus?.create({
      id: MENU_ANALYZE_PAGE,
      title: "Analyze page with Orchestra",
      contexts: ["page", "selection"],
    })
  })
}

async function ensureTargetSession(serverUrl: string): Promise<string | undefined> {
  const storedId = await getStoredSessionId()
  if (storedId) {
    const listRes = await listSessions(serverUrl)
    if (listRes.success && listRes.sessions.some((s) => s.id === storedId)) {
      return storedId
    }
  }

  const listRes = await listSessions(serverUrl)
  if (listRes.success && listRes.sessions.length > 0) {
    const firstId = listRes.sessions[0]?.id
    if (firstId) {
      await setStoredSessionId(firstId)
      return firstId
    }
  }

  const createRes = await createSession("Zen Browser Session", serverUrl)
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
  const serverUrl = await getStoredServerUrl()
  const status = await checkServerStatus(serverUrl)
  if (!status.online) {
    setBadge("ERR", "#ef4444")
    console.error("[Orchestra Zen] Cannot dispatch: local server is offline at", serverUrl)
    return
  }

  const sessionID = await ensureTargetSession(serverUrl)
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
  const result = await sendPrompt(sessionID, prompt, serverUrl)
  if (result.success) {
    setBadge("OK", "#10b981")
  } else {
    setBadge("FAIL", "#ef4444")
    console.error("[Orchestra Zen] sendPrompt error:", result.error)
  }
}

if (api?.runtime?.onInstalled) {
  api.runtime.onInstalled.addListener(() => {
    setupContextMenus()
  })
} else {
  setupContextMenus()
}

if (api?.contextMenus?.onClicked) {
  api.contextMenus.onClicked.addListener((info, tab) => {
    void handleContextMenuClick(info, tab)
  })
}

// Background message bus for sidebar / popup actions
if (api?.runtime?.onMessage) {
  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message as { type?: string; payload?: unknown }
    if (msg.type === "CHECK_STATUS") {
      void getStoredServerUrl().then((url) => checkServerStatus(url)).then(sendResponse)
      return true
    }
    if (msg.type === "GET_ACTIVE_TAB") {
      if (api.tabs?.query) {
        void api.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
          sendResponse(tabs[0] ?? null)
        })
        return true
      }
      sendResponse(null)
      return false
    }
    return false
  })
}
