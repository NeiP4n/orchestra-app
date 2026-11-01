// Orchestra Zen Connector - Action Popup
// Self-contained connector status and active tab monitor (no external module imports)

const BRIDGE_STATUS_URL = "http://127.0.0.1:4097/status"

const statusBadge = document.getElementById("statusBadge")
const statusText = document.getElementById("statusText")
const bridgeStatus = document.getElementById("bridgeStatus")
const bridgeProto = document.getElementById("bridgeProto")
const tabTitle = document.getElementById("tabTitle")
const tabUrl = document.getElementById("tabUrl")

const webext = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : null

async function updateActiveTab() {
  if (!webext?.tabs?.query) {
    if (tabTitle) tabTitle.textContent = "Вкладки недоступны"
    if (tabUrl) tabUrl.textContent = "—"
    return
  }

  try {
    const tabs = await webext.tabs.query({ active: true, currentWindow: true })
    const active = tabs?.[0]
    if (active) {
      if (tabTitle) tabTitle.textContent = active.title || "(Без названия)"
      if (tabUrl) tabUrl.textContent = active.url || "about:blank"
    } else {
      if (tabTitle) tabTitle.textContent = "Нет активной вкладки"
      if (tabUrl) tabUrl.textContent = "—"
    }
  } catch (err) {
    if (tabTitle) tabTitle.textContent = "Ошибка получения вкладки"
    if (tabUrl) tabUrl.textContent = String(err)
  }
}

async function checkBridgeStatus() {
  let isBgConnected = false
  if (webext?.runtime?.sendMessage) {
    try {
      const bgResp = await webext.runtime.sendMessage({ type: "GET_RPC_STATUS" })
      if (bgResp && bgResp.connected) {
        isBgConnected = true
      }
    } catch {}
  }

  try {
    const res = await fetch(BRIDGE_STATUS_URL, {
      method: "GET",
      headers: { Origin: "moz-extension://zen-connector" },
    })

    if (!res.ok) {
      setOffline(`HTTP ${res.status}`)
      return
    }

    const data = await res.json()
    if (data && (data.connected || isBgConnected)) {
      setOnline(data)
    } else {
      setWaitingBridge(data)
    }
  } catch {
    if (isBgConnected) {
      setOnline({ clientInfo: { client: "zen-extension", version: "1.0.0" } })
    } else {
      setOffline("Порт 4097 не отвечает")
    }
  }
}

function setOnline(data) {
  if (statusBadge) {
    statusBadge.className = "status-badge online"
  }
  if (statusText) {
    statusText.textContent = "Подключено к Orchestra"
  }
  if (bridgeStatus) {
    bridgeStatus.textContent = "Подключено (порт 4097)"
    bridgeStatus.style.color = "var(--sculk-teal)"
  }
  if (bridgeProto) {
    const client = data?.clientInfo?.client || "zen-extension"
    const ver = data?.clientInfo?.version || "1.0.0"
    bridgeProto.textContent = `WebSocket / HTTP (${client} v${ver})`
    bridgeProto.style.color = "var(--sculk-text)"
  }
}

function setWaitingBridge(data) {
  if (statusBadge) {
    statusBadge.className = "status-badge offline"
  }
  if (statusText) {
    statusText.textContent = "Ожидание Orchestra"
  }
  if (bridgeStatus) {
    bridgeStatus.textContent = "Мост активен (порт 4097), ждёт расширение"
    bridgeStatus.style.color = "#f59e0b"
  }
  if (bridgeProto) {
    bridgeProto.textContent = "Слушает порт 4097"
    bridgeProto.style.color = "var(--sculk-muted)"
  }
}

function setOffline(reason) {
  if (statusBadge) {
    statusBadge.className = "status-badge offline"
  }
  if (statusText) {
    statusText.textContent = "Оффлайн"
  }
  if (bridgeStatus) {
    bridgeStatus.textContent = reason
    bridgeStatus.style.color = "#f43f5e"
  }
  if (bridgeProto) {
    bridgeProto.textContent = "Мост не запущен"
    bridgeProto.style.color = "var(--sculk-muted)"
  }
}

async function refresh() {
  await Promise.all([updateActiveTab(), checkBridgeStatus()])
}

// Initial load
void refresh()

// Auto-refresh every 2 seconds
setInterval(() => {
  void refresh()
}, 2000)
