// src/bridge.ts
var DEFAULT_SERVER_URL = "http://127.0.0.1:4096";
function buildSelectionPayload(selectionText, pageUrl, pageTitle) {
  const cleanSelection = selectionText.trim();
  const titlePart = pageTitle ? ` from "${pageTitle}"` : "";
  return `Here is a selection${titlePart} (${pageUrl}):

> ${cleanSelection.split(`
`).join(`
> `)}

Please analyze this excerpt and help me with it.`;
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
async function checkServerStatus(serverUrl = DEFAULT_SERVER_URL, customFetch = fetch) {
  try {
    const res = await fetchWithTimeout(`${serverUrl}/api/info`, { method: "GET" }, 3000, customFetch);
    if (!res.ok) {
      return { online: false, error: `HTTP ${res.status}: ${res.statusText}` };
    }
    const data = await res.json();
    return { online: true, version: data.version ?? "unknown" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { online: false, error: message };
  }
}
async function listSessions(serverUrl = DEFAULT_SERVER_URL, customFetch = fetch) {
  try {
    const res = await fetchWithTimeout(`${serverUrl}/api/session`, { method: "GET" }, 4000, customFetch);
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
async function createSession(title, serverUrl = DEFAULT_SERVER_URL, customFetch = fetch) {
  try {
    const res = await fetchWithTimeout(`${serverUrl}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title ?? "Zen Browser Session" })
    }, 5000, customFetch);
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
async function sendPrompt(sessionID, text, serverUrl = DEFAULT_SERVER_URL, customFetch = fetch) {
  if (!sessionID) {
    return { success: false, error: "Session ID is required" };
  }
  if (!text.trim()) {
    return { success: false, error: "Prompt text cannot be empty" };
  }
  try {
    const res = await fetchWithTimeout(`${serverUrl}/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    }, 8000, customFetch);
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
async function getStoredSessionId() {
  const storage = getExtensionStorage();
  const data = await storage.get(["activeSessionId"]);
  return typeof data.activeSessionId === "string" ? data.activeSessionId : undefined;
}
async function setStoredSessionId(id) {
  const storage = getExtensionStorage();
  await storage.set({ activeSessionId: id });
}

// src/background.ts
var api = typeof globalThis !== "undefined" ? globalThis.browser ?? globalThis.chrome : undefined;
var MENU_SEND_SELECTION = "orchestra-send-selection";
var MENU_ANALYZE_PAGE = "orchestra-analyze-page";
function setBadge(text, color = "#5b89f7") {
  try {
    api?.action?.setBadgeText?.({ text });
    api?.action?.setBadgeBackgroundColor?.({ color });
    if (text) {
      setTimeout(() => {
        api?.action?.setBadgeText?.({ text: "" });
      }, 3000);
    }
  } catch {}
}
function setupContextMenus() {
  if (!api?.contextMenus)
    return;
  api.contextMenus.removeAll?.(() => {
    api.contextMenus?.create({
      id: MENU_SEND_SELECTION,
      title: "Send selection to Orchestra",
      contexts: ["selection"]
    });
    api.contextMenus?.create({
      id: MENU_ANALYZE_PAGE,
      title: "Analyze page with Orchestra",
      contexts: ["page", "selection"]
    });
  });
}
async function ensureTargetSession(serverUrl) {
  const storedId = await getStoredSessionId();
  if (storedId) {
    const listRes = await listSessions(serverUrl);
    if (listRes.success && listRes.sessions.some((s) => s.id === storedId)) {
      return storedId;
    }
  }
  const listRes = await listSessions(serverUrl);
  if (listRes.success && listRes.sessions.length > 0) {
    const firstId = listRes.sessions[0]?.id;
    if (firstId) {
      await setStoredSessionId(firstId);
      return firstId;
    }
  }
  const createRes = await createSession("Zen Browser Session", serverUrl);
  if (createRes.success && createRes.sessionID) {
    await setStoredSessionId(createRes.sessionID);
    return createRes.sessionID;
  }
  return;
}
async function handleContextMenuClick(info, tab) {
  const serverUrl = await getStoredServerUrl();
  const status = await checkServerStatus(serverUrl);
  if (!status.online) {
    setBadge("ERR", "#ef4444");
    console.error("[Orchestra Zen] Cannot dispatch: local server is offline at", serverUrl);
    return;
  }
  const sessionID = await ensureTargetSession(serverUrl);
  if (!sessionID) {
    setBadge("ERR", "#ef4444");
    console.error("[Orchestra Zen] Failed to obtain an active Orchestra session");
    return;
  }
  const pageUrl = tab?.url || info.pageUrl || "about:blank";
  const pageTitle = tab?.title || "Web Page";
  let prompt = "";
  if (info.menuItemId === MENU_SEND_SELECTION && info.selectionText) {
    prompt = buildSelectionPayload(info.selectionText, pageUrl, pageTitle);
  } else if (info.menuItemId === MENU_ANALYZE_PAGE) {
    prompt = buildPageContextPayload({
      title: pageTitle,
      url: pageUrl
    });
  }
  if (!prompt)
    return;
  setBadge("...", "#3b82f6");
  const result = await sendPrompt(sessionID, prompt, serverUrl);
  if (result.success) {
    setBadge("OK", "#10b981");
  } else {
    setBadge("FAIL", "#ef4444");
    console.error("[Orchestra Zen] sendPrompt error:", result.error);
  }
}
if (api?.runtime?.onInstalled) {
  api.runtime.onInstalled.addListener(() => {
    setupContextMenus();
  });
} else {
  setupContextMenus();
}
if (api?.contextMenus?.onClicked) {
  api.contextMenus.onClicked.addListener((info, tab) => {
    handleContextMenuClick(info, tab);
  });
}
if (api?.runtime?.onMessage) {
  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message;
    if (msg.type === "CHECK_STATUS") {
      getStoredServerUrl().then((url) => checkServerStatus(url)).then(sendResponse);
      return true;
    }
    if (msg.type === "GET_ACTIVE_TAB") {
      if (api.tabs?.query) {
        api.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
          sendResponse(tabs[0] ?? null);
        });
        return true;
      }
      sendResponse(null);
      return false;
    }
    return false;
  });
}
