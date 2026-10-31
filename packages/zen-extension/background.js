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
async function resolveServer(password) {
  let serverUrl = await getStoredServerUrl();
  let status = await checkServerStatus(serverUrl, password);
  if (!status.online) {
    const detection = await detectActiveServer(undefined, password);
    if (detection.found) {
      serverUrl = detection.url;
      await setStoredServerUrl(serverUrl);
      status = { online: true, version: detection.version, requiresAuth: detection.requiresAuth };
    }
  }
  return { url: serverUrl, online: status.online, requiresAuth: status.requiresAuth };
}
async function ensureTargetSession(serverUrl, password) {
  const storedId = await getStoredSessionId();
  if (storedId) {
    const listRes = await listSessions(serverUrl, password);
    if (listRes.success && listRes.sessions.some((s) => s.id === storedId)) {
      return storedId;
    }
  }
  const listRes = await listSessions(serverUrl, password);
  if (listRes.success && listRes.sessions.length > 0) {
    const firstId = listRes.sessions[0]?.id;
    if (firstId) {
      await setStoredSessionId(firstId);
      return firstId;
    }
  }
  const createRes = await createSession("Zen Browser Session", serverUrl, password);
  if (createRes.success && createRes.sessionID) {
    await setStoredSessionId(createRes.sessionID);
    return createRes.sessionID;
  }
  return;
}
async function handleContextMenuClick(info, tab) {
  const password = await getStoredServerPassword();
  const server = await resolveServer(password);
  if (!server.online) {
    setBadge("ERR", "#ef4444");
    console.error("[Orchestra Zen] Cannot dispatch: local server is offline at", server.url);
    return;
  }
  if (server.requiresAuth && !password) {
    setBadge("AUTH", "#f59e0b");
    console.error("[Orchestra Zen] Server requires authentication. Please configure password in settings.");
    return;
  }
  const sessionID = await ensureTargetSession(server.url, password);
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
  const result = await sendPrompt(sessionID, prompt, server.url, password);
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
      (async () => {
        const password = await getStoredServerPassword();
        const resolved = await resolveServer(password);
        sendResponse(resolved);
      })();
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
