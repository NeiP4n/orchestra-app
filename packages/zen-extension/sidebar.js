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
} from "./src/bridge.js"

// DOM Elements
const statusBadge = document.getElementById("statusBadge")
const statusText = document.getElementById("statusText")
const toggleSettingsBtn = document.getElementById("toggleSettingsBtn")
const settingsPanel = document.getElementById("settingsPanel")
const serverUrlInput = document.getElementById("serverUrlInput")
const serverPasswordInput = document.getElementById("serverPasswordInput")
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
const sessionSelect = document.getElementById("sessionSelect")
const sessionCountEl = document.getElementById("sessionCount")
const newSessionBtn = document.getElementById("newSessionBtn")
const emptySessionsView = document.getElementById("emptySessionsView")
const sessionPickerRow = document.getElementById("sessionPickerRow")
const createFirstSessionBtn = document.getElementById("createFirstSessionBtn")
const promptInput = document.getElementById("promptInput")
const sendPromptBtn = document.getElementById("sendPromptBtn")
const feedbackBanner = document.getElementById("feedbackBanner")
const feedbackMessage = document.getElementById("feedbackMessage")

let currentServerUrl = DEFAULT_SERVER_URL
let currentPassword = ""
let activeTabContext = { title: "Current Page", url: "about:blank" }

function showFeedback(message, isError = false) {
  if (!feedbackBanner || !feedbackMessage) return
  feedbackMessage.textContent = message
  feedbackBanner.className = isError ? "alert-box alert-error" : "alert-box alert-success"
  feedbackBanner.classList.remove("hidden")
  setTimeout(() => {
    feedbackBanner.classList.add("hidden")
  }, 4000)
}

function updateStatusUI(state, text) {
  if (!statusBadge || !statusText) return
  statusBadge.className = `status-badge ${state}`
  statusText.textContent = text
}

async function fetchActiveTab() {
  const browserApi = typeof globalThis !== "undefined"
    ? ((globalThis.browser ?? globalThis.chrome))
    : undefined

  if (browserApi?.tabs?.query) {
    try {
      const tabs = await browserApi.tabs.query({ active: true, currentWindow: true })
      if (tabs && tabs[0]) {
        activeTabContext = {
          title: tabs[0].title || "Untitled Page",
          url: tabs[0].url || "about:blank",
        }
      }
    } catch {
      // Fallback
    }
  }

  if (tabTitleEl) tabTitleEl.textContent = activeTabContext.title
  if (tabUrlEl) tabUrlEl.textContent = activeTabContext.url
}

async function refreshSessions() {
  const result = await listSessions(currentServerUrl, currentPassword)
  if (!result.success || result.sessions.length === 0) {
    emptySessionsView?.classList.remove("hidden")
    sessionPickerRow?.classList.add("hidden")
    if (sessionCountEl) sessionCountEl.textContent = "0 sessions"
    return
  }

  emptySessionsView?.classList.add("hidden")
  sessionPickerRow?.classList.remove("hidden")
  if (sessionCountEl) sessionCountEl.textContent = `${result.sessions.length}`

  if (sessionSelect) {
    sessionSelect.innerHTML = ""
    const savedId = await getStoredSessionId()
    let hasSelected = false

    for (const session of result.sessions) {
      const opt = document.createElement("option")
      opt.value = session.id
      opt.textContent = session.title || session.id
      if (session.id === savedId) {
        opt.selected = true
        hasSelected = true
      }
      sessionSelect.appendChild(opt)
    }

    if (!hasSelected && result.sessions[0]) {
      sessionSelect.value = result.sessions[0].id
      await setStoredSessionId(result.sessions[0].id)
    }
  }
}

async function handleCreateSession() {
  const title = `Zen: ${activeTabContext.title.slice(0, 30)}`
  const res = await createSession(title, currentServerUrl, currentPassword)
  if (res.success && res.sessionID) {
    await setStoredSessionId(res.sessionID)
    await refreshSessions()
    showFeedback("New session created")
  } else {
    showFeedback(`Failed to create session: ${res.error || "Unknown error"}`, true)
  }
}

async function handleSendPage() {
  const sessionId = sessionSelect?.value
  if (!sessionId) {
    showFeedback("Please select or create an active session first", true)
    return
  }

  const prompt = buildPageContextPayload({
    title: activeTabContext.title,
    url: activeTabContext.url,
  })

  sendPageBtn.disabled = true
  sendPageBtn.textContent = "Sending page..."
  try {
    const res = await sendPrompt(sessionId, prompt, currentServerUrl, currentPassword)
    if (res.success) {
      showFeedback("Page context sent to Orchestra")
    } else {
      showFeedback(`Failed to send: ${res.error}`, true)
    }
  } finally {
    sendPageBtn.disabled = false
    sendPageBtn.textContent = "Send current page to Orchestra"
  }
}

async function handleSendPrompt() {
  const sessionId = sessionSelect?.value
  if (!sessionId) {
    showFeedback("Please select or create an active session first", true)
    return
  }

  const text = promptInput?.value?.trim()
  if (!text) return

  sendPromptBtn.disabled = true
  sendPromptBtn.textContent = "Sending..."
  try {
    const res = await sendPrompt(sessionId, text, currentServerUrl, currentPassword)
    if (res.success) {
      showFeedback("Prompt sent to agent")
      if (promptInput) promptInput.value = ""
    } else {
      showFeedback(`Error: ${res.error}`, true)
    }
  } finally {
    sendPromptBtn.disabled = false
    sendPromptBtn.textContent = "Send Prompt"
  }
}

async function scanPorts() {
  updateStatusUI("offline", "Scanning ports...")
  if (autoDetectBtn) {
    autoDetectBtn.disabled = true
    autoDetectBtn.textContent = "Scanning..."
  }
  if (scanPortsFromErrorBtn) {
    scanPortsFromErrorBtn.disabled = true
    scanPortsFromErrorBtn.textContent = "Scanning..."
  }

  try {
    const detection = await detectActiveServer(DEFAULT_SCAN_PORTS, currentPassword)
    if (detection.found) {
      currentServerUrl = detection.url
      await setStoredServerUrl(currentServerUrl)
      if (serverUrlInput) serverUrlInput.value = currentServerUrl
      if (detectedPortNote) detectedPortNote.textContent = `Active: :${detection.port}`
      showFeedback(`Detected active server on port ${detection.port}`)
      await connect(false)
    } else {
      showFeedback("No active Orchestra service found on standard ports", true)
      updateStatusUI("offline", "Offline")
    }
  } finally {
    if (autoDetectBtn) {
      autoDetectBtn.disabled = false
      autoDetectBtn.textContent = "Scan Ports"
    }
    if (scanPortsFromErrorBtn) {
      scanPortsFromErrorBtn.disabled = false
      scanPortsFromErrorBtn.textContent = "Auto-Scan Ports"
    }
  }
}

async function connect(tryAutoDetect = true) {
  loadingSkeleton?.classList.remove("hidden")
  serverErrorState?.classList.add("hidden")
  activeContent?.classList.add("hidden")
  authNotice?.classList.add("hidden")
  updateStatusUI("offline", "Checking...")

  currentServerUrl = await getStoredServerUrl()
  currentPassword = await getStoredServerPassword()
  if (serverUrlInput) serverUrlInput.value = currentServerUrl
  if (serverPasswordInput) serverPasswordInput.value = currentPassword

  let status = await checkServerStatus(currentServerUrl, currentPassword)

  if (!status.online && tryAutoDetect) {
    updateStatusUI("offline", "Auto-scanning...")
    const detection = await detectActiveServer(DEFAULT_SCAN_PORTS, currentPassword)
    if (detection.found) {
      currentServerUrl = detection.url
      await setStoredServerUrl(currentServerUrl)
      if (serverUrlInput) serverUrlInput.value = currentServerUrl
      if (detectedPortNote) detectedPortNote.textContent = `Auto-detected :${detection.port}`
      status = {
        online: true,
        version: detection.version,
        requiresAuth: detection.requiresAuth,
      }
    }
  }

  loadingSkeleton?.classList.add("hidden")

  if (!status.online) {
    updateStatusUI("offline", "Offline")
    serverErrorState?.classList.remove("hidden")
    return
  }

  let portLabel = ""
  try {
    const urlObj = new URL(currentServerUrl)
    portLabel = urlObj.port ? `:${urlObj.port}` : ""
  } catch {
    // ignore
  }

  if (status.requiresAuth && !currentPassword) {
    updateStatusUI("auth-required", `Password required ${portLabel}`)
    settingsPanel?.classList.remove("hidden")
    authNotice?.classList.remove("hidden")
    serverPasswordInput?.focus()
    return
  }

  updateStatusUI("online", `Online ${portLabel}`)
  activeContent?.classList.remove("hidden")

  await fetchActiveTab()
  await refreshSessions()
}

// Event Listeners
toggleSettingsBtn?.addEventListener("click", () => {
  settingsPanel?.classList.toggle("hidden")
})

autoDetectBtn?.addEventListener("click", () => void scanPorts())
scanPortsFromErrorBtn?.addEventListener("click", () => void scanPorts())

saveSettingsBtn?.addEventListener("click", async () => {
  const url = serverUrlInput?.value?.trim() || DEFAULT_SERVER_URL
  const pass = serverPasswordInput?.value?.trim() || ""

  currentServerUrl = url
  currentPassword = pass

  await setStoredServerUrl(url)
  await setStoredServerPassword(pass)
  showFeedback("Settings saved")
  await connect(false)
})

retryServerBtn?.addEventListener("click", () => void connect(true))
createFirstSessionBtn?.addEventListener("click", () => void handleCreateSession())
newSessionBtn?.addEventListener("click", () => void handleCreateSession())

sessionSelect?.addEventListener("change", (e) => {
  const target = e.target
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
void connect(true)
