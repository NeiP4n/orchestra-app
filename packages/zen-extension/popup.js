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

const statusBadge = document.getElementById("statusBadge")
const statusText = document.getElementById("statusText")
const tabTitleEl = document.getElementById("tabTitle")
const tabUrlEl = document.getElementById("tabUrl")
const quickSendBtn = document.getElementById("quickSendBtn")
const quickFeedback = document.getElementById("quickFeedback")

let currentServerUrl = "http://127.0.0.1:4096"
let activeTab = { title: "Current Page", url: "about:blank" }

function showFeedback(text, isError = false) {
  if (!quickFeedback) return
  quickFeedback.textContent = text
  quickFeedback.className = isError ? "alert-box alert-error" : "alert-box alert-success"
  quickFeedback.classList.remove("hidden")
  setTimeout(() => quickFeedback.classList.add("hidden"), 3000)
}

async function init() {
  currentServerUrl = await getStoredServerUrl()
  const status = await checkServerStatus(currentServerUrl)

  if (statusBadge && statusText) {
    if (status.online) {
      statusBadge.className = "status-badge online"
      statusText.textContent = "Online"
    } else {
      statusBadge.className = "status-badge offline"
      statusText.textContent = "Offline"
      if (quickSendBtn) quickSendBtn.disabled = true
    }
  }

  const browserApi = typeof globalThis !== "undefined"
    ? ((globalThis.browser ?? globalThis.chrome))
    : undefined

  if (browserApi?.tabs?.query) {
    try {
      const tabs = await browserApi.tabs.query({ active: true, currentWindow: true })
      if (tabs && tabs[0]) {
        activeTab = {
          title: tabs[0].title || "Untitled",
          url: tabs[0].url || "about:blank",
        }
      }
    } catch {
      // fallback
    }
  }

  if (tabTitleEl) tabTitleEl.textContent = activeTab.title
  if (tabUrlEl) tabUrlEl.textContent = activeTab.url
}

quickSendBtn?.addEventListener("click", async () => {
  quickSendBtn.disabled = true
  quickSendBtn.textContent = "Sending..."
  try {
    let sessionId = await getStoredSessionId()
    if (!sessionId) {
      const list = await listSessions(currentServerUrl)
      if (list.success && list.sessions.length > 0 && list.sessions[0]) {
        sessionId = list.sessions[0].id
      } else {
        const created = await createSession("Zen Browser Session", currentServerUrl)
        if (created.success && created.sessionID) {
          sessionId = created.sessionID
          await setStoredSessionId(sessionId)
        }
      }
    }

    if (!sessionId) {
      showFeedback("Failed to obtain session", true)
      return
    }

    const payload = buildPageContextPayload(activeTab)
    const res = await sendPrompt(sessionId, payload, currentServerUrl)
    if (res.success) {
      showFeedback("Sent to Orchestra!")
    } else {
      showFeedback(`Error: ${res.error}`, true)
    }
  } catch (err) {
    showFeedback(String(err), true)
  } finally {
    quickSendBtn.disabled = false
    quickSendBtn.textContent = "Send Page to Orchestra"
  }
})

void init()
