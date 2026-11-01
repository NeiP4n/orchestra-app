import {
  buildPageContextPayload,
  checkServerStatus,
  createSession,
  DEFAULT_SCAN_PORTS,
  DEFAULT_SERVER_URL,
  detectActiveServer,
  getStoredServerPassword,
  getStoredServerUrl,
  getStoredSessionId,
  listSessions,
  sendPrompt,
  setStoredServerPassword,
  setStoredServerUrl,
  setStoredSessionId,
} from "./bridge.js"

// DOM Elements
const statusBadge = document.getElementById("statusBadge")
const statusText = document.getElementById("statusText")
const rpcBadge = document.getElementById("rpcBadge")
const rpcStatusText = document.getElementById("rpcStatusText")
const toggleSettingsBtn = document.getElementById("toggleSettingsBtn")
const settingsPanel = document.getElementById("settingsPanel")
const serverUrlInput = document.getElementById("serverUrlInput") as HTMLInputElement | null
const serverPasswordInput = document.getElementById("serverPasswordInput") as HTMLInputElement | null
const autoDetectBtn = document.getElementById("autoDetectBtn")
const saveSettingsBtn = document.getElementById("saveSettingsBtn")
const authNotice = document.getElementById("authNotice")
const detectedPortNote = document.getElementById("detectedPortNote")

const loadingSkeleton = document.getElementById("loadingSkeleton")
const serverErrorState = document.getElementById("serverErrorState")
const retryServerBtn = document.getElementById("retryServerBtn")
const scanPortsFromErrorBtn = document.getElementById("scanPortsFromErrorBtn")

const activeContent = document.getElementById("activeContent")
const tabTitleEl = document.getElementById("tabTitle")
const tabUrlEl = document.getElementById("tabUrl")
const sendPageBtn = document.getElementById("sendPageBtn")
const sessionSelect = document.getElementById("sessionSelect") as HTMLSelectElement | null
const sessionCountEl = document.getElementById("sessionCount")
const newSessionBtn = document.getElementById("newSessionBtn")
const emptySessionsView = document.getElementById("emptySessionsView")
const sessionPickerRow = document.getElementById("sessionPickerRow")
const createFirstSessionBtn = document.getElementById("createFirstSessionBtn")
const promptInput = document.getElementById("promptInput") as HTMLTextAreaElement | null
const sendPromptBtn = document.getElementById("sendPromptBtn")
const feedbackBanner = document.getElementById("feedbackBanner")
const feedbackMessage = document.getElementById("feedbackMessage")

const aiActivityEmpty = document.getElementById("aiActivityEmpty")
const aiActivityList = document.getElementById("aiActivityList")
const clearActivityBtn = document.getElementById("clearActivityBtn")

let currentServerUrl = DEFAULT_SERVER_URL
let currentPassword = ""
let activeTabContext = { title: "Current Page", url: "about:blank" }

function showFeedback(message: string, isError = false) {
  if (!feedbackBanner || !feedbackMessage) return
  feedbackMessage.textContent = message
  feedbackBanner.className = isError ? "alert-box alert-error" : "alert-box alert-success"
  feedbackBanner.classList.remove("hidden")
  setTimeout(() => {
    feedbackBanner.classList.add("hidden")
  }, 4000)
}

function updateStatusUI(state: "loading" | "online" | "offline", text: string) {
  if (!statusBadge || !statusText) return
  statusBadge.className = `status-badge ${state}`
  statusText.textContent = text
}

function updateRpcStatus(connected: boolean) {
  if (!rpcBadge || !rpcStatusText) return
  if (connected) {
    rpcBadge.className = "status-badge online"
    rpcStatusText.textContent = "AI Bridge: Connected"
  } else {
    rpcBadge.className = "status-badge offline"
    rpcStatusText.textContent = "AI Bridge: Disconnected"
  }
}

function appendActivity(activity: any) {
  if (!aiActivityList || !activity) return
  aiActivityEmpty?.classList.add("hidden")
  aiActivityList.classList.remove("hidden")

  const item = document.createElement("div")
  item.className = activity.success ? "activity-feed-item" : "activity-feed-item error"

  const textSpan = document.createElement("span")
  textSpan.className = "activity-feed-text"
  textSpan.textContent = `AI: ${activity.summary}`

  const timeSpan = document.createElement("span")
  timeSpan.className = "activity-feed-time"
  const date = activity.timestamp ? new Date(activity.timestamp) : new Date()
  timeSpan.textContent = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })

  item.appendChild(textSpan)
  item.appendChild(timeSpan)

  aiActivityList.insertBefore(item, aiActivityList.firstChild)

  while (aiActivityList.children.length > 25 && aiActivityList.lastChild) {
    aiActivityList.removeChild(aiActivityList.lastChild)
  }
}

async function sendSidebarHeartbeat(): Promise<boolean> {
  const candidateUrls = ["http://127.0.0.1:4097", "http://localhost:4097"]
  for (const base of candidateUrls) {
    try {
      const res = await fetch(`${base}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: "zen-extension-sidebar", version: "1.0.0" }),
      })
      if (res.ok) {
        updateRpcStatus(true)
        return true
      }
    } catch {
      // try next
    }
  }

  // Also query /status
  for (const base of candidateUrls) {
    try {
      const res = await fetch(`${base}/status`)
      if (res.ok) {
        const data = (await res.json()) as { connected?: boolean }
        if (data && typeof data.connected === "boolean") {
          updateRpcStatus(data.connected)
          if (data.connected) return true
        }
      }
    } catch {
      // try next
    }
  }

  return false
}

function initRpcListeners() {
  const browserApi = typeof globalThis !== "undefined"
    ? ((globalThis as any).browser ?? (globalThis as any).chrome)
    : undefined

  const checkStatus = () => {
    if (browserApi?.runtime?.sendMessage) {
      try {
        browserApi.runtime.sendMessage({ type: "GET_RPC_STATUS" }, (res: any) => {
          if (res && typeof res.connected === "boolean") {
            updateRpcStatus(res.connected)
          }
        })
        browserApi.runtime.sendMessage({ type: "GET_AI_ACTIVITIES" }, (res: any) => {
          if (res && Array.isArray(res.activities)) {
            for (const act of [...res.activities].reverse()) {
              appendActivity(act)
            }
          }
        })
      } catch {
        // ignore
      }
    }
  }

  // Initial checks
  checkStatus()
  void sendSidebarHeartbeat()

  // Periodically refresh status and send heartbeat to bridge server
  setInterval(() => {
    void sendSidebarHeartbeat()
    checkStatus()
  }, 2000)

  window.addEventListener("focus", () => void sendSidebarHeartbeat())
  document.addEventListener("click", () => void sendSidebarHeartbeat())

  if (browserApi?.runtime?.onMessage) {
    browserApi.runtime.onMessage.addListener((message: any) => {
      const msg = message
      if (msg?.type === "RPC_STATUS") {
        updateRpcStatus(Boolean(msg.connected))
      }
      if (msg?.type === "AI_ACTIVITY" && msg.activity) {
        appendActivity(msg.activity)
      }
    })
  }

  // Connect keep-alive port with background script to prevent background event page from stopping
  if (browserApi?.runtime?.connect) {
    try {
      const port = browserApi.runtime.connect({ name: "sidebar-keepalive" })
      window.addEventListener("beforeunload", () => {
        try {
          port?.disconnect?.()
        } catch {
          // ignore
        }
      })
    } catch {
      // ignore
    }
  }
}

function showLoadingSkeleton() {
  loadingSkeleton?.classList.remove("hidden")
  serverErrorState?.classList.add("hidden")
  activeContent?.classList.add("hidden")
  updateStatusUI("loading", "Connecting...")
}

function showServerError(message: string) {
  loadingSkeleton?.classList.add("hidden")
  serverErrorState?.classList.remove("hidden")
  activeContent?.classList.add("hidden")
  updateStatusUI("offline", "Disconnected")

  const errEl = document.getElementById("serverErrorMessage")
  if (errEl) errEl.textContent = message
}

function showActiveContent() {
  loadingSkeleton?.classList.add("hidden")
  serverErrorState?.classList.add("hidden")
  activeContent?.classList.remove("hidden")
  updateStatusUI("online", "Connected")
}

async function renderSessions(currentSessionId?: string) {
  if (!sessionSelect) return

  const result = await listSessions(currentServerUrl, currentPassword)
  const sessions = result.success ? result.sessions : []
  sessionSelect.innerHTML = ""

  if (sessions.length === 0) {
    sessionPickerRow?.classList.add("hidden")
    emptySessionsView?.classList.remove("hidden")
    if (sessionCountEl) sessionCountEl.textContent = "0"
    return
  }

  sessionPickerRow?.classList.remove("hidden")
  emptySessionsView?.classList.add("hidden")
  if (sessionCountEl) sessionCountEl.textContent = String(sessions.length)

  for (const s of sessions) {
    const opt = document.createElement("option")
    opt.value = s.id
    opt.textContent = s.title ? `${s.title} (${s.id.slice(0, 8)})` : `Session ${s.id.slice(0, 8)}`
    sessionSelect.appendChild(opt)
  }

  if (currentSessionId && sessions.some((s) => s.id === currentSessionId)) {
    sessionSelect.value = currentSessionId
  } else if (sessions[0]) {
    sessionSelect.value = sessions[0].id
    await setStoredSessionId(sessions[0].id)
  }
}

async function connect(initial = false) {
  showLoadingSkeleton()

  if (initial) {
    currentServerUrl = await getStoredServerUrl()
    currentPassword = await getStoredServerPassword()
    if (serverUrlInput) serverUrlInput.value = currentServerUrl
    if (serverPasswordInput) serverPasswordInput.value = currentPassword
  }

  const status = await checkServerStatus(currentServerUrl, currentPassword)

  if (!status.online) {
    showServerError(`Cannot connect to server at ${currentServerUrl}. Please verify Orchestra is running.`)
    return
  }

  if (status.requiresAuth) {
    authNotice?.classList.remove("hidden")
    showServerError(`Server at ${currentServerUrl} requires authentication. Enter password in Settings.`)
    return
  }

  authNotice?.classList.add("hidden")
  showActiveContent()

  const savedSessionId = await getStoredSessionId()
  await renderSessions(savedSessionId)
  await updateActiveTabUI()
}

async function updateActiveTabUI() {
  const browserApi = typeof globalThis !== "undefined"
    ? ((globalThis as any).browser ?? (globalThis as any).chrome)
    : undefined

  if (!browserApi?.tabs?.query) return

  try {
    const tabs = await browserApi.tabs.query({ active: true, currentWindow: true })
    const tab = tabs[0]
    if (tab && tab.url) {
      activeTabContext = {
        title: tab.title ?? "Current Page",
        url: tab.url,
      }
      if (tabTitleEl) tabTitleEl.textContent = activeTabContext.title
      if (tabUrlEl) tabUrlEl.textContent = activeTabContext.url
    }
  } catch (err) {
    console.warn("Failed to get active tab:", err)
  }
}

async function handleCreateSession() {
  showFeedback("Creating session...")
  const res = await createSession("Zen Browser Session", currentServerUrl, currentPassword)
  if (res.success && res.sessionID) {
    showFeedback("Session created!")
    await renderSessions(res.sessionID)
  } else {
    showFeedback(`Failed to create session: ${res.error ?? "unknown error"}`, true)
  }
}

async function handleSendPage() {
  const sessionId = sessionSelect?.value
  if (!sessionId) {
    showFeedback("Please select or create a session first", true)
    return
  }

  const browserApi = typeof globalThis !== "undefined"
    ? ((globalThis as any).browser ?? (globalThis as any).chrome)
    : undefined

  let pageText = ""
  if (browserApi?.tabs?.query && browserApi?.scripting?.executeScript) {
    try {
      const [activeTab] = await browserApi.tabs.query({ active: true, currentWindow: true })
      if (activeTab?.id) {
        const results = await browserApi.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: () => document.body?.innerText?.slice(0, 4000) ?? "",
        })
        pageText = (results?.[0] as any)?.result ?? ""
      }
    } catch {
      // Ignored
    }
  }

  const payload = buildPageContextPayload({
    title: activeTabContext.title,
    url: activeTabContext.url,
    text: pageText,
  })

  showFeedback("Sending page context to session...")
  const res = await sendPrompt(sessionId, payload, currentServerUrl, currentPassword)
  if (res.success) {
    showFeedback("Page context sent to Orchestra session!")
  } else {
    showFeedback(`Failed: ${res.error ?? "unknown error"}`, true)
  }
}

async function handleSendPrompt() {
  const sessionId = sessionSelect?.value
  if (!sessionId) {
    showFeedback("Please select or create a session first", true)
    return
  }

  const text = promptInput?.value?.trim()
  if (!text) {
    showFeedback("Prompt cannot be empty", true)
    return
  }

  if (sendPromptBtn) {
    sendPromptBtn.setAttribute("disabled", "true")
    sendPromptBtn.textContent = "Sending..."
  }

  showFeedback("Submitting prompt...")
  const res = await sendPrompt(sessionId, text, currentServerUrl, currentPassword)

  if (sendPromptBtn) {
    sendPromptBtn.removeAttribute("disabled")
    sendPromptBtn.textContent = "Send"
  }

  if (res.success) {
    showFeedback("Prompt accepted by Orchestra session!")
    if (promptInput) promptInput.value = ""
  } else {
    showFeedback(`Failed: ${res.error ?? "unknown error"}`, true)
  }
}

// Event Listeners
toggleSettingsBtn?.addEventListener("click", () => {
  settingsPanel?.classList.toggle("hidden")
})

saveSettingsBtn?.addEventListener("click", async () => {
  const newUrl = serverUrlInput?.value?.trim() ?? DEFAULT_SERVER_URL
  const newPassword = serverPasswordInput?.value?.trim() ?? ""

  await setStoredServerUrl(newUrl)
  await setStoredServerPassword(newPassword)
  currentServerUrl = newUrl
  currentPassword = newPassword

  showFeedback("Settings saved")
  settingsPanel?.classList.add("hidden")
  void connect()
})

autoDetectBtn?.addEventListener("click", async () => {
  if (autoDetectBtn) {
    autoDetectBtn.setAttribute("disabled", "true")
    autoDetectBtn.textContent = "Scanning..."
  }

  const result = await detectActiveServer(DEFAULT_SCAN_PORTS, currentPassword)

  if (autoDetectBtn) {
    autoDetectBtn.removeAttribute("disabled")
    autoDetectBtn.textContent = "Auto-detect"
  }

  if (result.found) {
    if (serverUrlInput) serverUrlInput.value = result.url
    if (detectedPortNote) {
      detectedPortNote.textContent = `Found server at ${result.url}`
      detectedPortNote.classList.remove("hidden")
    }
    showFeedback(`Found active server at ${result.url}`)
  } else {
    showFeedback("No server detected on standard ports (4096, 4444, 49375, 64022)", true)
  }
})

retryServerBtn?.addEventListener("click", () => void connect())
scanPortsFromErrorBtn?.addEventListener("click", () => {
  settingsPanel?.classList.remove("hidden")
  autoDetectBtn?.click()
})

newSessionBtn?.addEventListener("click", () => void handleCreateSession())
createFirstSessionBtn?.addEventListener("click", () => void handleCreateSession())

clearActivityBtn?.addEventListener("click", () => {
  if (aiActivityList) aiActivityList.innerHTML = ""
  aiActivityList?.classList.add("hidden")
  aiActivityEmpty?.classList.remove("hidden")
})

sessionSelect?.addEventListener("change", (e) => {
  const target = e.target as HTMLSelectElement | null
  if (target && target.value) {
    void setStoredSessionId(target.value)
  }
})

sendPageBtn?.addEventListener("click", () => void handleSendPage())
sendPromptBtn?.addEventListener("click", () => void handleSendPrompt())

promptInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    void handleSendPrompt()
  }
})

// Run on page load
initRpcListeners()
void connect(true)
