// src/bridge.ts
var DEFAULT_SERVER_URL = "http://127.0.0.1:4096";
var DEFAULT_SCAN_PORTS = [4096, 4444, 49375, 64022];
function buildAuthHeader(password) {
  if (!password || !password.trim())
    return;
  const trimmed = password.trim();
  if (trimmed.startsWith("Basic ") || trimmed.startsWith("Bearer ")) {
    return trimmed;
  }
  const credential = trimmed.includes(":") ? trimmed : `:${trimmed}`;
  const encoded = typeof btoa === "function" ? btoa(credential) : Buffer.from(credential).toString("base64");
  return `Basic ${encoded}`;
}
function buildPageContextPayload(pageContent) {
  const cleanTitle = pageContent.title.trim();
  const cleanUrl = pageContent.url.trim();
  const bodyPart = pageContent.text ? `

Page text excerpt:
${pageContent.text.slice(0, 4000)}` : "";
  return `Please analyze the current web page in Zen Browser:
- Title: ${cleanTitle}
- URL: ${cleanUrl}${bodyPart}`;
}
async function fetchWithTimeout(url, options, timeoutMs = 4000, customFetch = fetch) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await customFetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function checkServerStatus(serverUrl = DEFAULT_SERVER_URL, password, customFetch = fetch) {
  try {
    const headers = {};
    const auth = buildAuthHeader(password);
    if (auth)
      headers["Authorization"] = auth;
    const res = await fetchWithTimeout(`${serverUrl}/api/info`, { method: "GET", headers }, 2500, customFetch);
    if (res.status === 401) {
      return { online: true, requiresAuth: true, error: "Authentication required" };
    }
    if (!res.ok) {
      return { online: false, error: `HTTP ${res.status}: ${res.statusText}` };
    }
    const data = await res.json();
    return { online: true, version: data.version ?? "unknown", requiresAuth: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { online: false, error: message };
  }
}
async function detectActiveServer(ports = DEFAULT_SCAN_PORTS, password, customFetch = fetch) {
  for (const port of ports) {
    const candidateUrl = `http://127.0.0.1:${port}`;
    const status = await checkServerStatus(candidateUrl, password, customFetch);
    if (status.online) {
      return {
        found: true,
        url: candidateUrl,
        port,
        version: status.version,
        requiresAuth: status.requiresAuth
      };
    }
  }
  return { found: false, url: DEFAULT_SERVER_URL };
}
async function listSessions(serverUrl = DEFAULT_SERVER_URL, password, customFetch = fetch) {
  try {
    const headers = {};
    const auth = buildAuthHeader(password);
    if (auth)
      headers["Authorization"] = auth;
    const res = await fetchWithTimeout(`${serverUrl}/api/session`, { method: "GET", headers }, 4000, customFetch);
    if (res.status === 401) {
      return { success: false, sessions: [], error: "HTTP 401: Authentication required" };
    }
    if (!res.ok) {
      return { success: false, sessions: [], error: `HTTP ${res.status}: ${res.statusText}` };
    }
    const data = await res.json();
    const sessions = (Array.isArray(data) ? data : []).map((s) => ({
      id: s.id,
      title: s.title || `Session ${s.id.slice(0, 8)}`
    }));
    return { success: true, sessions };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, sessions: [], error: message };
  }
}
async function createSession(title, serverUrl = DEFAULT_SERVER_URL, password, customFetch = fetch) {
  try {
    const headers = { "Content-Type": "application/json" };
    const auth = buildAuthHeader(password);
    if (auth)
      headers["Authorization"] = auth;
    const res = await fetchWithTimeout(`${serverUrl}/api/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: title ?? "Zen Browser Session" })
    }, 5000, customFetch);
    if (res.status === 401) {
      return { success: false, error: "HTTP 401: Authentication required" };
    }
    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}: ${res.statusText}` };
    }
    const data = await res.json();
    if (!data.id) {
      return { success: false, error: "Server response missing session ID" };
    }
    return { success: true, sessionID: data.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
async function sendPrompt(sessionID, text, serverUrl = DEFAULT_SERVER_URL, password, customFetch = fetch) {
  if (!sessionID) {
    return { success: false, error: "Session ID is required" };
  }
  if (!text.trim()) {
    return { success: false, error: "Prompt text cannot be empty" };
  }
  try {
    const headers = { "Content-Type": "application/json" };
    const auth = buildAuthHeader(password);
    if (auth)
      headers["Authorization"] = auth;
    const res = await fetchWithTimeout(`${serverUrl}/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text })
    }, 8000, customFetch);
    if (res.status === 401) {
      return { success: false, error: "HTTP 401: Authentication required" };
    }
    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}: ${res.statusText}` };
    }
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
function getExtensionStorage() {
  const browserApi = typeof globalThis !== "undefined" ? globalThis.browser ?? globalThis.chrome : undefined;
  return {
    async get(keys) {
      if (!browserApi?.storage?.local)
        return {};
      const res = browserApi.storage.local.get(keys);
      if (res && typeof res.then === "function") {
        return await res;
      }
      return new Promise((resolve) => {
        browserApi.storage?.local?.get(keys, (items) => resolve(items ?? {}));
      });
    },
    async set(items) {
      if (!browserApi?.storage?.local)
        return;
      const res = browserApi.storage.local.set(items);
      if (res && typeof res.then === "function") {
        await res;
        return;
      }
      return new Promise((resolve) => {
        browserApi.storage?.local?.set(items, () => resolve());
      });
    }
  };
}
async function getStoredServerUrl() {
  const storage = getExtensionStorage();
  const data = await storage.get(["serverUrl"]);
  return typeof data.serverUrl === "string" && data.serverUrl ? data.serverUrl : DEFAULT_SERVER_URL;
}
async function setStoredServerUrl(url) {
  const storage = getExtensionStorage();
  await storage.set({ serverUrl: url });
}
async function getStoredServerPassword() {
  const storage = getExtensionStorage();
  const data = await storage.get(["serverPassword"]);
  return typeof data.serverPassword === "string" ? data.serverPassword : "";
}
async function setStoredServerPassword(password) {
  const storage = getExtensionStorage();
  await storage.set({ serverPassword: password });
}
async function getStoredSessionId() {
  const storage = getExtensionStorage();
  const data = await storage.get(["activeSessionId"]);
  return typeof data.activeSessionId === "string" ? data.activeSessionId : undefined;
}
async function setStoredSessionId(id) {
  const storage = getExtensionStorage();
  await storage.set({ activeSessionId: id });
}

// src/sidebar.ts
var statusBadge = document.getElementById("statusBadge");
var statusText = document.getElementById("statusText");
var rpcBadge = document.getElementById("rpcBadge");
var rpcStatusText = document.getElementById("rpcStatusText");
var toggleSettingsBtn = document.getElementById("toggleSettingsBtn");
var settingsPanel = document.getElementById("settingsPanel");
var serverUrlInput = document.getElementById("serverUrlInput");
var serverPasswordInput = document.getElementById("serverPasswordInput");
var autoDetectBtn = document.getElementById("autoDetectBtn");
var saveSettingsBtn = document.getElementById("saveSettingsBtn");
var authNotice = document.getElementById("authNotice");
var detectedPortNote = document.getElementById("detectedPortNote");
var loadingSkeleton = document.getElementById("loadingSkeleton");
var serverErrorState = document.getElementById("serverErrorState");
var retryServerBtn = document.getElementById("retryServerBtn");
var scanPortsFromErrorBtn = document.getElementById("scanPortsFromErrorBtn");
var activeContent = document.getElementById("activeContent");
var tabTitleEl = document.getElementById("tabTitle");
var tabUrlEl = document.getElementById("tabUrl");
var sendPageBtn = document.getElementById("sendPageBtn");
var sessionSelect = document.getElementById("sessionSelect");
var sessionCountEl = document.getElementById("sessionCount");
var newSessionBtn = document.getElementById("newSessionBtn");
var emptySessionsView = document.getElementById("emptySessionsView");
var sessionPickerRow = document.getElementById("sessionPickerRow");
var createFirstSessionBtn = document.getElementById("createFirstSessionBtn");
var promptInput = document.getElementById("promptInput");
var sendPromptBtn = document.getElementById("sendPromptBtn");
var feedbackBanner = document.getElementById("feedbackBanner");
var feedbackMessage = document.getElementById("feedbackMessage");
var aiActivityEmpty = document.getElementById("aiActivityEmpty");
var aiActivityList = document.getElementById("aiActivityList");
var clearActivityBtn = document.getElementById("clearActivityBtn");
var currentServerUrl = DEFAULT_SERVER_URL;
var currentPassword = "";
var activeTabContext = { title: "Current Page", url: "about:blank" };
function showFeedback(message, isError = false) {
  if (!feedbackBanner || !feedbackMessage)
    return;
  feedbackMessage.textContent = message;
  feedbackBanner.className = isError ? "alert-box alert-error" : "alert-box alert-success";
  feedbackBanner.classList.remove("hidden");
  setTimeout(() => {
    feedbackBanner.classList.add("hidden");
  }, 4000);
}
function updateStatusUI(state, text) {
  if (!statusBadge || !statusText)
    return;
  statusBadge.className = `status-badge ${state}`;
  statusText.textContent = text;
}
function updateRpcStatus(connected) {
  if (!rpcBadge || !rpcStatusText)
    return;
  if (connected) {
    rpcBadge.className = "status-badge online";
    rpcStatusText.textContent = "AI Bridge: Connected";
  } else {
    rpcBadge.className = "status-badge offline";
    rpcStatusText.textContent = "AI Bridge: Disconnected";
  }
}
function appendActivity(activity) {
  if (!aiActivityList || !activity)
    return;
  aiActivityEmpty?.classList.add("hidden");
  aiActivityList.classList.remove("hidden");
  const item = document.createElement("div");
  item.className = activity.success ? "activity-feed-item" : "activity-feed-item error";
  const textSpan = document.createElement("span");
  textSpan.className = "activity-feed-text";
  textSpan.textContent = `AI: ${activity.summary}`;
  const timeSpan = document.createElement("span");
  timeSpan.className = "activity-feed-time";
  const date = activity.timestamp ? new Date(activity.timestamp) : new Date;
  timeSpan.textContent = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  item.appendChild(textSpan);
  item.appendChild(timeSpan);
  aiActivityList.insertBefore(item, aiActivityList.firstChild);
  while (aiActivityList.children.length > 25 && aiActivityList.lastChild) {
    aiActivityList.removeChild(aiActivityList.lastChild);
  }
}
async function sendSidebarHeartbeat() {
  const candidateUrls = ["http://127.0.0.1:4097", "http://localhost:4097"];
  for (const base of candidateUrls) {
    try {
      const res = await fetch(`${base}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: "zen-extension-sidebar", version: "1.0.0" })
      });
      if (res.ok) {
        updateRpcStatus(true);
        return true;
      }
    } catch {}
  }
  for (const base of candidateUrls) {
    try {
      const res = await fetch(`${base}/status`);
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.connected === "boolean") {
          updateRpcStatus(data.connected);
          if (data.connected)
            return true;
        }
      }
    } catch {}
  }
  return false;
}
function initRpcListeners() {
  const browserApi = typeof globalThis !== "undefined" ? globalThis.browser ?? globalThis.chrome : undefined;
  const checkStatus = () => {
    if (browserApi?.runtime?.sendMessage) {
      try {
        browserApi.runtime.sendMessage({ type: "GET_RPC_STATUS" }, (res) => {
          if (res && typeof res.connected === "boolean") {
            updateRpcStatus(res.connected);
          }
        });
        browserApi.runtime.sendMessage({ type: "GET_AI_ACTIVITIES" }, (res) => {
          if (res && Array.isArray(res.activities)) {
            for (const act of [...res.activities].reverse()) {
              appendActivity(act);
            }
          }
        });
      } catch {}
    }
  };
  checkStatus();
  sendSidebarHeartbeat();
  setInterval(() => {
    sendSidebarHeartbeat();
    checkStatus();
  }, 2000);
  window.addEventListener("focus", () => void sendSidebarHeartbeat());
  document.addEventListener("click", () => void sendSidebarHeartbeat());
  if (browserApi?.runtime?.onMessage) {
    browserApi.runtime.onMessage.addListener((message) => {
      const msg = message;
      if (msg?.type === "RPC_STATUS") {
        updateRpcStatus(Boolean(msg.connected));
      }
      if (msg?.type === "AI_ACTIVITY" && msg.activity) {
        appendActivity(msg.activity);
      }
    });
  }
  if (browserApi?.runtime?.connect) {
    try {
      const port = browserApi.runtime.connect({ name: "sidebar-keepalive" });
      window.addEventListener("beforeunload", () => {
        try {
          port?.disconnect?.();
        } catch {}
      });
    } catch {}
  }
}
function showLoadingSkeleton() {
  loadingSkeleton?.classList.remove("hidden");
  serverErrorState?.classList.add("hidden");
  activeContent?.classList.add("hidden");
  updateStatusUI("loading", "Connecting...");
}
function showServerError(message) {
  loadingSkeleton?.classList.add("hidden");
  serverErrorState?.classList.remove("hidden");
  activeContent?.classList.add("hidden");
  updateStatusUI("offline", "Disconnected");
  const errEl = document.getElementById("serverErrorMessage");
  if (errEl)
    errEl.textContent = message;
}
function showActiveContent() {
  loadingSkeleton?.classList.add("hidden");
  serverErrorState?.classList.add("hidden");
  activeContent?.classList.remove("hidden");
  updateStatusUI("online", "Connected");
}
async function renderSessions(currentSessionId) {
  if (!sessionSelect)
    return;
  const result = await listSessions(currentServerUrl, currentPassword);
  const sessions = result.success ? result.sessions : [];
  sessionSelect.innerHTML = "";
  if (sessions.length === 0) {
    sessionPickerRow?.classList.add("hidden");
    emptySessionsView?.classList.remove("hidden");
    if (sessionCountEl)
      sessionCountEl.textContent = "0";
    return;
  }
  sessionPickerRow?.classList.remove("hidden");
  emptySessionsView?.classList.add("hidden");
  if (sessionCountEl)
    sessionCountEl.textContent = String(sessions.length);
  for (const s of sessions) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.title ? `${s.title} (${s.id.slice(0, 8)})` : `Session ${s.id.slice(0, 8)}`;
    sessionSelect.appendChild(opt);
  }
  if (currentSessionId && sessions.some((s) => s.id === currentSessionId)) {
    sessionSelect.value = currentSessionId;
  } else if (sessions[0]) {
    sessionSelect.value = sessions[0].id;
    await setStoredSessionId(sessions[0].id);
  }
}
async function connect(initial = false) {
  showLoadingSkeleton();
  if (initial) {
    currentServerUrl = await getStoredServerUrl();
    currentPassword = await getStoredServerPassword();
    if (serverUrlInput)
      serverUrlInput.value = currentServerUrl;
    if (serverPasswordInput)
      serverPasswordInput.value = currentPassword;
  }
  const status = await checkServerStatus(currentServerUrl, currentPassword);
  if (!status.online) {
    showServerError(`Cannot connect to server at ${currentServerUrl}. Please verify Orchestra is running.`);
    return;
  }
  if (status.requiresAuth) {
    authNotice?.classList.remove("hidden");
    showServerError(`Server at ${currentServerUrl} requires authentication. Enter password in Settings.`);
    return;
  }
  authNotice?.classList.add("hidden");
  showActiveContent();
  const savedSessionId = await getStoredSessionId();
  await renderSessions(savedSessionId);
  await updateActiveTabUI();
}
async function updateActiveTabUI() {
  const browserApi = typeof globalThis !== "undefined" ? globalThis.browser ?? globalThis.chrome : undefined;
  if (!browserApi?.tabs?.query)
    return;
  try {
    const tabs = await browserApi.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab && tab.url) {
      activeTabContext = {
        title: tab.title ?? "Current Page",
        url: tab.url
      };
      if (tabTitleEl)
        tabTitleEl.textContent = activeTabContext.title;
      if (tabUrlEl)
        tabUrlEl.textContent = activeTabContext.url;
    }
  } catch (err) {
    console.warn("Failed to get active tab:", err);
  }
}
async function handleCreateSession() {
  showFeedback("Creating session...");
  const res = await createSession("Zen Browser Session", currentServerUrl, currentPassword);
  if (res.success && res.sessionID) {
    showFeedback("Session created!");
    await renderSessions(res.sessionID);
  } else {
    showFeedback(`Failed to create session: ${res.error ?? "unknown error"}`, true);
  }
}
async function handleSendPage() {
  const sessionId = sessionSelect?.value;
  if (!sessionId) {
    showFeedback("Please select or create a session first", true);
    return;
  }
  const browserApi = typeof globalThis !== "undefined" ? globalThis.browser ?? globalThis.chrome : undefined;
  let pageText = "";
  if (browserApi?.tabs?.query && browserApi?.scripting?.executeScript) {
    try {
      const [activeTab] = await browserApi.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.id) {
        const results = await browserApi.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: () => document.body?.innerText?.slice(0, 4000) ?? ""
        });
        pageText = results?.[0]?.result ?? "";
      }
    } catch {}
  }
  const payload = buildPageContextPayload({
    title: activeTabContext.title,
    url: activeTabContext.url,
    text: pageText
  });
  showFeedback("Sending page context to session...");
  const res = await sendPrompt(sessionId, payload, currentServerUrl, currentPassword);
  if (res.success) {
    showFeedback("Page context sent to Orchestra session!");
  } else {
    showFeedback(`Failed: ${res.error ?? "unknown error"}`, true);
  }
}
async function handleSendPrompt() {
  const sessionId = sessionSelect?.value;
  if (!sessionId) {
    showFeedback("Please select or create a session first", true);
    return;
  }
  const text = promptInput?.value?.trim();
  if (!text) {
    showFeedback("Prompt cannot be empty", true);
    return;
  }
  if (sendPromptBtn) {
    sendPromptBtn.setAttribute("disabled", "true");
    sendPromptBtn.textContent = "Sending...";
  }
  showFeedback("Submitting prompt...");
  const res = await sendPrompt(sessionId, text, currentServerUrl, currentPassword);
  if (sendPromptBtn) {
    sendPromptBtn.removeAttribute("disabled");
    sendPromptBtn.textContent = "Send";
  }
  if (res.success) {
    showFeedback("Prompt accepted by Orchestra session!");
    if (promptInput)
      promptInput.value = "";
  } else {
    showFeedback(`Failed: ${res.error ?? "unknown error"}`, true);
  }
}
toggleSettingsBtn?.addEventListener("click", () => {
  settingsPanel?.classList.toggle("hidden");
});
saveSettingsBtn?.addEventListener("click", async () => {
  const newUrl = serverUrlInput?.value?.trim() ?? DEFAULT_SERVER_URL;
  const newPassword = serverPasswordInput?.value?.trim() ?? "";
  await setStoredServerUrl(newUrl);
  await setStoredServerPassword(newPassword);
  currentServerUrl = newUrl;
  currentPassword = newPassword;
  showFeedback("Settings saved");
  settingsPanel?.classList.add("hidden");
  connect();
});
autoDetectBtn?.addEventListener("click", async () => {
  if (autoDetectBtn) {
    autoDetectBtn.setAttribute("disabled", "true");
    autoDetectBtn.textContent = "Scanning...";
  }
  const result = await detectActiveServer(DEFAULT_SCAN_PORTS, currentPassword);
  if (autoDetectBtn) {
    autoDetectBtn.removeAttribute("disabled");
    autoDetectBtn.textContent = "Auto-detect";
  }
  if (result.found) {
    if (serverUrlInput)
      serverUrlInput.value = result.url;
    if (detectedPortNote) {
      detectedPortNote.textContent = `Found server at ${result.url}`;
      detectedPortNote.classList.remove("hidden");
    }
    showFeedback(`Found active server at ${result.url}`);
  } else {
    showFeedback("No server detected on standard ports (4096, 4444, 49375, 64022)", true);
  }
});
retryServerBtn?.addEventListener("click", () => void connect());
scanPortsFromErrorBtn?.addEventListener("click", () => {
  settingsPanel?.classList.remove("hidden");
  autoDetectBtn?.click();
});
newSessionBtn?.addEventListener("click", () => void handleCreateSession());
createFirstSessionBtn?.addEventListener("click", () => void handleCreateSession());
clearActivityBtn?.addEventListener("click", () => {
  if (aiActivityList)
    aiActivityList.innerHTML = "";
  aiActivityList?.classList.add("hidden");
  aiActivityEmpty?.classList.remove("hidden");
});
sessionSelect?.addEventListener("change", (e) => {
  const target = e.target;
  if (target && target.value) {
    setStoredSessionId(target.value);
  }
});
sendPageBtn?.addEventListener("click", () => void handleSendPage());
sendPromptBtn?.addEventListener("click", () => void handleSendPrompt());
promptInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    handleSendPrompt();
  }
});
initRpcListeners();
connect(true);
