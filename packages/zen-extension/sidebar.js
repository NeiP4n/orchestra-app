import {
  buildPageContextPayload,
  checkServerStatus,
  createSession,
  getStoredServerUrl,
  getStoredSessionId,
  listSessions,
  sendPrompt,
  setStoredSessionId,
} from "./src/bridge.js"

// DOM Elements
const statusBadge = document.getElementById("statusBadge")
const statusText = document.getElementById("statusText")
const loadingSkeleton = document.getElementById("loadingSkeleton")
const serverErrorState = document.getElementById("serverErrorState")
const retryServerBtn = document.getElementById("retryServerBtn")
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

let currentServerUrl = "http://127.0.0.1:4096"
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

function updateStatusUI(online, version) {
  if (!statusBadge || !statusText) return
  if (online) {
    statusBadge.className = "status-badge online"
    statusText.textContent = version ? `Online (${version})` : "Online"
  } else {
    statusBadge.className = "status-badge offline"
    statusText.textContent = "Offline"
  }
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
  const result = await listSessions(currentServerUrl)
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
  const res = await createSession(title, currentServerUrl)
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
    const res = await sendPrompt(sessionId, prompt, currentServerUrl)
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
    const res = await sendPrompt(sessionId, text, currentServerUrl)
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

async function init() {
  loadingSkeleton?.classList.remove("hidden")
  serverErrorState?.classList.add("hidden")
  activeContent?.classList.add("hidden")
  updateStatusUI(false)

  currentServerUrl = await getStoredServerUrl()
  const status = await checkServerStatus(currentServerUrl)

  loadingSkeleton?.classList.add("hidden")
  if (!status.online) {
    serverErrorState?.classList.remove("hidden")
    updateStatusUI(false)
    return
  }

  updateStatusUI(true, status.version)
  activeContent?.classList.remove("hidden")

  await fetchActiveTab()
  await refreshSessions()
}

// Event Listeners
retryServerBtn?.addEventListener("click", () => void init())
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
void init()
