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

// src/rpc-client.ts
var DEFAULT_RPC_URL = "ws://127.0.0.1:4097";
var DEFAULT_HTTP_FALLBACK_URL = "http://127.0.0.1:4097";
var RECONNECT_INTERVAL_MS = 2000;
var HTTP_POLL_INTERVAL_MS = 1500;
var HEARTBEAT_INTERVAL_MS = 2000;
function getBrowserApi() {
  if (typeof globalThis === "undefined")
    return;
  const g = globalThis;
  return g.browser ?? g.chrome;
}
async function resolveTargetTabId(browserApi, tabId) {
  if (typeof tabId === "number" && !Number.isNaN(tabId)) {
    return tabId;
  }
  if (!browserApi.tabs?.query) {
    throw new Error("Tabs API unavailable");
  }
  const activeTabs = await browserApi.tabs.query({ active: true, currentWindow: true });
  const fallback = activeTabs[0] ?? (await browserApi.tabs.query({ active: true }))[0];
  if (!fallback?.id) {
    throw new Error("No active tab found");
  }
  return fallback.id;
}
async function handleRpcAction(action, params = {}, browserApi = getBrowserApi() ?? {}) {
  switch (action) {
    case "tabs": {
      if (!browserApi.tabs?.query)
        throw new Error("Tabs API unavailable");
      const list = await browserApi.tabs.query({});
      return list.map((t) => ({
        id: t.id,
        title: t.title ?? "",
        url: t.url ?? "",
        active: Boolean(t.active),
        audible: Boolean(t.audible),
        muted: Boolean(t.mutedInfo?.muted ?? t.muted)
      }));
    }
    case "read": {
      if (!browserApi.scripting?.executeScript)
        throw new Error("Scripting API unavailable");
      const tabId = await resolveTargetTabId(browserApi, params.tabId);
      const results = await browserApi.scripting.executeScript({
        target: { tabId },
        func: () => {
          const bodyText = document.body ? document.body.innerText.slice(0, 50000) : "";
          return {
            title: document.title,
            url: window.location.href,
            text: bodyText,
            innerText: bodyText,
            selection: window.getSelection() ? String(window.getSelection()) : ""
          };
        }
      });
      return results?.[0]?.result;
    }
    case "eval": {
      if (!browserApi.scripting?.executeScript)
        throw new Error("Scripting API unavailable");
      const code = typeof params.code === "string" ? params.code : "";
      if (!code)
        throw new Error("Code parameter required for eval");
      const tabId = await resolveTargetTabId(browserApi, params.tabId);
      const results = await browserApi.scripting.executeScript({
        target: { tabId },
        args: [code],
        func: (scriptCode) => {
          const src = String(scriptCode).trim();
          let evalResult;
          let evalDone = false;
          let lastError;
          try {
            try {
              evalResult = new Function("return (" + src + ")")();
              evalDone = true;
            } catch {
              evalResult = new Function(src)();
              evalDone = true;
            }
          } catch (err) {
            lastError = err;
          }
          if (!evalDone) {
            try {
              const channelId = "__zen_eval_" + Math.random().toString(36).slice(2);
              const container = document.createElement("div");
              container.id = channelId;
              container.style.display = "none";
              (document.head || document.documentElement).appendChild(container);
              const nonceEl = document.querySelector("script[nonce]");
              const nonce = nonceEl ? nonceEl.getAttribute("nonce") || nonceEl.nonce : null;
              const scriptEl = document.createElement("script");
              if (nonce) {
                scriptEl.setAttribute("nonce", nonce);
              }
              const wrappedCode = `
              (() => {
                const __container = document.getElementById("${channelId}");
                if (!__container) return;
                try {
                  const __evalFn = function() {
                    ${src.includes("return") ? src : `return (${src});`}
                  };
                  const __res = __evalFn();
                  let __serialized;
                  if (__res === undefined) {
                    __serialized = "__zen_undefined__";
                  } else if (__res === null) {
                    __serialized = "null";
                  } else if (typeof __res === "object") {
                    try {
                      __serialized = JSON.stringify(__res);
                    } catch {
                      __serialized = String(__res);
                    }
                  } else {
                    __serialized = String(__res);
                  }
                  __container.setAttribute("data-result", __serialized);
                } catch (__err) {
                  __container.setAttribute("data-error", __err instanceof Error ? __err.message : String(__err));
                }
              })();
              `;
              scriptEl.textContent = wrappedCode;
              (document.head || document.documentElement).appendChild(scriptEl);
              scriptEl.remove();
              const dataResult = container.getAttribute("data-result");
              const dataError = container.getAttribute("data-error");
              container.remove();
              if (dataError) {
                throw new Error(dataError);
              }
              if (dataResult !== null) {
                if (dataResult === "__zen_undefined__") {
                  evalResult = undefined;
                } else {
                  try {
                    evalResult = JSON.parse(dataResult);
                  } catch {
                    evalResult = dataResult;
                  }
                }
                evalDone = true;
              }
            } catch (domErr) {
              lastError = domErr || lastError;
            }
          }
          if (!evalDone) {
            try {
              if (src === "document.title") {
                evalResult = document.title;
                evalDone = true;
              } else if (src === "location.href" || src === "window.location.href") {
                evalResult = window.location.href;
                evalDone = true;
              } else if (src === "document.body.innerText") {
                evalResult = document.body ? document.body.innerText.slice(0, 50000) : "";
                evalDone = true;
              }
            } catch {}
          }
          if (!evalDone) {
            const msg = lastError instanceof Error ? lastError.message : String(lastError);
            throw new Error(`Eval failed: ${msg}`);
          }
          if (evalResult === undefined)
            return;
          if (evalResult === null)
            return null;
          if (typeof evalResult === "object") {
            if ("nodeType" in evalResult) {
              const el = evalResult;
              return el.outerHTML ? el.outerHTML.slice(0, 5000) : `<${el.tagName}>`;
            }
            try {
              return JSON.parse(JSON.stringify(evalResult));
            } catch {
              return String(evalResult);
            }
          }
          return evalResult;
        }
      });
      return results?.[0]?.result;
    }
    case "click": {
      if (!browserApi.scripting?.executeScript)
        throw new Error("Scripting API unavailable");
      const selector = typeof params.selector === "string" ? params.selector : "";
      if (!selector)
        throw new Error("Selector parameter required for click");
      const tabId = await resolveTargetTabId(browserApi, params.tabId);
      const results = await browserApi.scripting.executeScript({
        target: { tabId },
        args: [selector],
        func: (sel) => {
          const el = document.querySelector(String(sel));
          if (!el)
            throw new Error(`Element not found: ${String(sel)}`);
          el.focus();
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
          el.click();
          return { clicked: true, tagName: el.tagName, text: el.textContent?.trim().slice(0, 100) };
        }
      });
      return results?.[0]?.result;
    }
    case "type": {
      if (!browserApi.scripting?.executeScript)
        throw new Error("Scripting API unavailable");
      const selector = typeof params.selector === "string" ? params.selector : "";
      const text = typeof params.text === "string" ? params.text : typeof params.value === "string" ? params.value : "";
      if (!selector)
        throw new Error("Selector parameter required for type");
      const tabId = await resolveTargetTabId(browserApi, params.tabId);
      const results = await browserApi.scripting.executeScript({
        target: { tabId },
        args: [selector, text],
        func: (sel, val) => {
          const targetSelector = String(sel);
          const targetValue = String(val);
          const el = document.querySelector(targetSelector);
          if (!el)
            throw new Error(`Input element not found: ${targetSelector}`);
          el.focus();
          let execSuccess = false;
          try {
            document.execCommand("selectAll", false, undefined);
            execSuccess = document.execCommand("insertText", false, targetValue);
          } catch {}
          const isTextInput = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || "value" in el;
          if (isTextInput) {
            try {
              const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
              const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
              descriptor?.set?.call(el, targetValue);
            } catch {
              el.value = targetValue;
            }
          } else if (!execSuccess) {
            el.innerText = targetValue;
          }
          try {
            el.dispatchEvent(new InputEvent("input", {
              bubbles: true,
              cancelable: true,
              inputType: "insertText",
              data: targetValue
            }));
          } catch {
            el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
          }
          el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
          return { typed: true, length: targetValue.length, selector: targetSelector };
        }
      });
      return results?.[0]?.result;
    }
    case "navigate": {
      if (!browserApi.tabs)
        throw new Error("Tabs API unavailable");
      const url = typeof params.url === "string" ? params.url : "";
      if (!url)
        throw new Error("URL parameter required for navigate");
      if (typeof params.tabId === "number") {
        return await browserApi.tabs.update(params.tabId, { url });
      }
      return await browserApi.tabs.create({ url });
    }
    case "activate": {
      if (!browserApi.tabs)
        throw new Error("Tabs API unavailable");
      const tabId = await resolveTargetTabId(browserApi, params.tabId);
      return await browserApi.tabs.update(tabId, { active: true });
    }
    case "close": {
      if (!browserApi.tabs)
        throw new Error("Tabs API unavailable");
      const tabId = await resolveTargetTabId(browserApi, params.tabId);
      await browserApi.tabs.remove(tabId);
      return { closed: true, tabId };
    }
    case "media": {
      if (!browserApi.scripting?.executeScript || !browserApi.tabs?.query) {
        throw new Error("Scripting/Tabs API unavailable");
      }
      const cmd = typeof params.action === "string" ? params.action : typeof params.command === "string" ? params.command : "toggle";
      let tabId;
      if (typeof params.tabId === "number") {
        tabId = params.tabId;
      } else {
        const audible = await browserApi.tabs.query({ audible: true });
        if (audible[0]?.id) {
          tabId = audible[0].id;
        } else {
          tabId = await resolveTargetTabId(browserApi);
        }
      }
      const results = await browserApi.scripting.executeScript({
        target: { tabId },
        args: [cmd],
        func: (actionCmd) => {
          const command = String(actionCmd).toLowerCase();
          if (command === "next") {
            const nextBtn = document.querySelector(".ytp-next-button, button[aria-label='Next'], [data-testid='control-button-skip-forward']");
            if (nextBtn) {
              nextBtn.click();
              return { command: "next", handledByButton: true };
            }
          }
          if (command === "prev") {
            const prevBtn = document.querySelector(".ytp-prev-button, button[aria-label='Previous'], [data-testid='control-button-skip-back']");
            if (prevBtn) {
              prevBtn.click();
              return { command: "prev", handledByButton: true };
            }
          }
          const media = document.querySelector("video, audio");
          if (!media)
            throw new Error("No video or audio element found on page");
          if (command === "play") {
            media.play();
            return { command: "play", paused: false };
          }
          if (command === "pause") {
            media.pause();
            return { command: "pause", paused: true };
          }
          if (command === "mute") {
            media.muted = true;
            return { command: "mute", muted: true };
          }
          if (command === "unmute") {
            media.muted = false;
            return { command: "unmute", muted: false };
          }
          if (media.paused) {
            media.play();
            return { command: "play", paused: false };
          }
          media.pause();
          return { command: "pause", paused: true };
        }
      });
      return results?.[0]?.result;
    }
    default:
      throw new Error(`Unsupported RPC action: ${action}`);
  }
}
function formatActionSummary(action, params = {}) {
  switch (action) {
    case "tabs":
      return "Inspected open tabs";
    case "read":
      return `Read page content (tab ${String(params.tabId ?? "active")})`;
    case "eval":
      return "Evaluated custom script";
    case "click":
      return `Clicked element: ${String(params.selector ?? "")}`;
    case "type":
      return `Typed into: ${String(params.selector ?? "")}`;
    case "navigate":
      return `Navigated to ${String(params.url ?? "")}`;
    case "activate":
      return `Switched to tab ${String(params.tabId ?? "")}`;
    case "close":
      return `Closed tab ${String(params.tabId ?? "")}`;
    case "media":
      return `Media control: ${String(params.action ?? params.command ?? "toggle")}`;
    default:
      return `Executed action: ${action}`;
  }
}
var defaultWsFactory = (u) => {
  const Ctor = typeof WebSocket !== "undefined" ? WebSocket : typeof globalThis !== "undefined" && ("WebSocket" in globalThis) ? globalThis.WebSocket : undefined;
  if (!Ctor) {
    throw new Error("WebSocket constructor is not available in current environment");
  }
  return new Ctor(u);
};

class ZenRpcClient {
  ws = null;
  reconnectTimer = null;
  pollTimer = null;
  heartbeatTimer = null;
  isDestroyed = false;
  isConnected = false;
  isWsConnected = false;
  url;
  browserApi;
  httpFallbackUrl;
  wsFactory;
  customFetch;
  constructor(urlOrOptions = DEFAULT_RPC_URL, browserApiOrHttpFallback, fallbackUrlOrBrowserApi, wsFactory = defaultWsFactory, customFetch = (url, init) => fetch(url, init)) {
    if (typeof urlOrOptions === "object" && urlOrOptions !== null) {
      const port = urlOrOptions.port ?? 4097;
      this.url = urlOrOptions.url ?? (urlOrOptions.port ? `ws://127.0.0.1:${port}` : DEFAULT_RPC_URL);
      this.httpFallbackUrl = urlOrOptions.httpFallbackUrl ?? (urlOrOptions.port ? `http://127.0.0.1:${port}` : DEFAULT_HTTP_FALLBACK_URL);
      this.browserApi = urlOrOptions.browserApi ?? getBrowserApi() ?? {};
      this.wsFactory = urlOrOptions.wsFactory ?? wsFactory;
      this.customFetch = urlOrOptions.customFetch ?? customFetch;
    } else {
      this.url = typeof urlOrOptions === "string" ? urlOrOptions : DEFAULT_RPC_URL;
      this.wsFactory = wsFactory;
      this.customFetch = customFetch;
      if (typeof browserApiOrHttpFallback === "string") {
        this.httpFallbackUrl = browserApiOrHttpFallback;
        this.browserApi = typeof fallbackUrlOrBrowserApi === "object" && fallbackUrlOrBrowserApi !== null ? fallbackUrlOrBrowserApi : getBrowserApi() ?? {};
      } else {
        this.browserApi = browserApiOrHttpFallback ?? getBrowserApi() ?? {};
        this.httpFallbackUrl = typeof fallbackUrlOrBrowserApi === "string" ? fallbackUrlOrBrowserApi : DEFAULT_HTTP_FALLBACK_URL;
      }
    }
  }
  start() {
    this.isDestroyed = false;
    console.log(`[ZenRpcClient] Starting RPC client (url=${this.url}, fallback=${this.httpFallbackUrl})`);
    this.sendHeartbeat();
    try {
      this.connectWs();
    } catch (err) {
      console.error("[ZenRpcClient] Error starting WebSocket connection:", err);
      this.sendHeartbeat();
    }
    try {
      this.startHttpFallback();
    } catch (err) {
      console.error("[ZenRpcClient] Error starting HTTP fallback:", err);
    }
  }
  ensureConnected() {
    if (this.isDestroyed)
      return;
    if (!this.isWsConnected && !this.ws) {
      console.log("[ZenRpcClient] ensureConnected triggered: reconnecting WebSocket...");
      this.connectWs();
    }
    this.sendHeartbeat();
  }
  stop() {
    this.isDestroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isWsConnected = false;
    this.setConnectionState(false);
  }
  setConnectionState(connected) {
    if (this.isConnected !== connected) {
      this.isConnected = connected;
      console.log(`[ZenRpcClient] Connection state changed: ${connected ? "CONNECTED" : "DISCONNECTED"}`);
      this.broadcastStatus(connected);
    }
  }
  connectWs() {
    if (this.isDestroyed)
      return;
    try {
      console.log(`[ZenRpcClient] Creating WebSocket instance to ${this.url}`);
      this.ws = this.wsFactory(this.url);
      this.ws.onopen = () => {
        console.log(`[ZenRpcClient] WebSocket connection established to ${this.url}`);
        this.isWsConnected = true;
        this.setConnectionState(true);
        this.send({
          type: "hello",
          client: "zen-extension",
          version: "1.0.0"
        });
      };
      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
      this.ws.onclose = () => {
        console.warn(`[ZenRpcClient] WebSocket closed for ${this.url}`);
        this.handleWsDisconnect();
      };
      this.ws.onerror = (err) => {
        console.error(`[ZenRpcClient] WebSocket error for ${this.url}:`, err);
        this.handleWsDisconnect();
        this.sendHeartbeat();
      };
    } catch (err) {
      console.error(`[ZenRpcClient] Failed to instantiate WebSocket for ${this.url}:`, err);
      this.handleWsDisconnect();
      this.sendHeartbeat();
    }
  }
  handleWsDisconnect() {
    this.isWsConnected = false;
    if (!this.isConnected) {
      this.setConnectionState(false);
    }
    if (this.isDestroyed)
      return;
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connectWs();
      }, RECONNECT_INTERVAL_MS);
    }
  }
  startHttpFallback() {
    if (this.isDestroyed)
      return;
    this.heartbeatTimer = setInterval(() => {
      if (this.isDestroyed)
        return;
      this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    this.sendHeartbeat();
    this.scheduleNextPoll(100);
  }
  scheduleNextPoll(delayMs = HTTP_POLL_INTERVAL_MS) {
    if (this.isDestroyed)
      return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.executeHttpPoll();
    }, delayMs);
  }
  async sendHeartbeat() {
    const candidateUrls = [this.httpFallbackUrl];
    if (this.httpFallbackUrl.includes("127.0.0.1")) {
      candidateUrls.push(this.httpFallbackUrl.replace("127.0.0.1", "localhost"));
    }
    for (const baseUrl of candidateUrls) {
      try {
        const res = await this.customFetch(`${baseUrl}/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client: "zen-extension", version: "1.0.0" })
        });
        if (res.ok) {
          this.setConnectionState(true);
          return;
        }
      } catch {}
    }
    if (!this.isWsConnected) {
      this.setConnectionState(false);
    }
  }
  async executeHttpPoll() {
    if (this.isDestroyed)
      return;
    if (this.isWsConnected) {
      this.scheduleNextPoll(HTTP_POLL_INTERVAL_MS);
      return;
    }
    try {
      const controller = new AbortController;
      const timer = setTimeout(() => controller.abort(), 30000);
      const res = await this.customFetch(`${this.httpFallbackUrl}/poll`, {
        method: "GET",
        signal: controller.signal
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        this.setConnectionState(true);
        if (res.status === 200) {
          const data = await res.json();
          if (data && typeof data === "object" && "id" in data && "action" in data) {
            this.executeHttpRpcRequest(data);
          }
        }
      } else {
        if (!this.isWsConnected) {
          this.setConnectionState(false);
        }
      }
    } catch (error) {
      const isAbort = error instanceof Error && error.name === "AbortError";
      if (!isAbort && !this.isWsConnected) {
        this.setConnectionState(false);
      }
    } finally {
      this.scheduleNextPoll(HTTP_POLL_INTERVAL_MS);
    }
  }
  async executeHttpRpcRequest(req) {
    const { id, action, params = {} } = req;
    try {
      const result = await handleRpcAction(action, params, this.browserApi);
      await this.customFetch(`${this.httpFallbackUrl}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, success: true, result })
      });
      this.broadcastActivity({
        action,
        summary: formatActionSummary(action, params),
        success: true,
        timestamp: Date.now()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.customFetch(`${this.httpFallbackUrl}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, success: false, error: message })
      });
      this.broadcastActivity({
        action,
        summary: `Failed ${action}: ${message}`,
        success: false,
        timestamp: Date.now()
      });
    }
  }
  broadcastStatus(connected) {
    try {
      this.browserApi.runtime?.sendMessage?.({
        type: "RPC_STATUS",
        connected
      });
    } catch {}
  }
  broadcastActivity(event) {
    try {
      this.browserApi.runtime?.sendMessage?.({
        type: "AI_ACTIVITY",
        activity: event
      });
    } catch {}
  }
  send(data) {
    if (this.ws && (this.ws.readyState === 1 || typeof WebSocket !== "undefined" && this.ws.readyState === WebSocket.OPEN)) {
      this.ws.send(JSON.stringify(data));
    }
  }
  async handleMessage(raw) {
    let req;
    try {
      req = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (!req || typeof req !== "object" || !("id" in req) || !("action" in req)) {
      return;
    }
    const { id, action, params = {} } = req;
    try {
      const result = await handleRpcAction(action, params, this.browserApi);
      this.send({ id, success: true, result });
      this.broadcastActivity({
        action,
        summary: formatActionSummary(action, params),
        success: true,
        timestamp: Date.now()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send({ id, success: false, error: message });
      this.broadcastActivity({
        action,
        summary: `Failed ${action}: ${message}`,
        success: false,
        timestamp: Date.now()
      });
    }
  }
}

// src/background.ts
var api = typeof globalThis !== "undefined" ? globalThis.browser ?? globalThis.chrome : undefined;
var MENU_SEND_SELECTION = "orchestra-send-selection";
var MENU_ANALYZE_PAGE = "orchestra-analyze-page";
var recentAiActivities = [];
var MAX_ACTIVITIES = 30;
function recordActivity(activity) {
  recentAiActivities.unshift(activity);
  if (recentAiActivities.length > MAX_ACTIVITIES) {
    recentAiActivities.pop();
  }
}
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
  try {
    api.contextMenus.removeAll?.(() => {
      try {
        api.contextMenus?.create?.({
          id: MENU_SEND_SELECTION,
          title: "Send selection to Orchestra",
          contexts: ["selection"]
        });
        api.contextMenus?.create?.({
          id: MENU_ANALYZE_PAGE,
          title: "Analyze page with Orchestra",
          contexts: ["page", "selection"]
        });
      } catch (err) {
        console.warn("[Orchestra Zen] setupContextMenus create error:", err);
      }
    });
  } catch (err) {
    console.warn("[Orchestra Zen] setupContextMenus removeAll error:", err);
  }
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
var KEEPALIVE_ALARM_NAME = "orchestra-keepalive";
function setupKeepAliveAlarm() {
  if (!api?.alarms) {
    console.warn("[Orchestra Zen] alarms API is not available");
    return;
  }
  try {
    api.alarms.create(KEEPALIVE_ALARM_NAME, {
      periodInMinutes: 0.25
    });
    console.log("[Orchestra Zen] Registered keepalive alarm (every 15s)");
  } catch (err) {
    console.error("[Orchestra Zen] Failed to register keepalive alarm:", err);
  }
}
if (api?.alarms?.onAlarm) {
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM_NAME) {
      console.log("[Orchestra Zen] Keepalive alarm tick: ensuring connection...");
      try {
        rpcClient?.ensureConnected?.();
      } catch (err) {
        console.error("[Orchestra Zen] Keepalive ensureConnected error:", err);
      }
      (async () => {
        try {
          await fetch("http://127.0.0.1:4097/heartbeat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client: "zen-extension-alarm", version: "1.0.0" })
          });
        } catch {}
      })();
    }
  });
}
if (api?.runtime?.onConnect) {
  api.runtime.onConnect.addListener((port) => {
    console.log(`[Orchestra Zen] Port connected: ${port?.name ?? "unknown"}`);
    port?.onDisconnect?.addListener(() => {
      console.log(`[Orchestra Zen] Port disconnected: ${port?.name ?? "unknown"}`);
    });
  });
}
var rpcClient;
try {
  console.log("[Orchestra Zen] Starting ZenRpcClient on port 4097...");
  rpcClient = new ZenRpcClient({ port: 4097 });
  rpcClient.start();
  console.log("[Orchestra Zen] ZenRpcClient started successfully");
} catch (err) {
  console.error("[Orchestra Zen] Failed to initialize ZenRpcClient:", err);
}
try {
  setupKeepAliveAlarm();
} catch (err) {
  console.error("[Orchestra Zen] setupKeepAliveAlarm error:", err);
}
if (api?.runtime?.onInstalled) {
  api.runtime.onInstalled.addListener(() => {
    try {
      setupContextMenus();
    } catch (err) {
      console.warn("[Orchestra Zen] onInstalled setupContextMenus error:", err);
    }
  });
} else {
  try {
    setupContextMenus();
  } catch (err) {
    console.warn("[Orchestra Zen] setupContextMenus error:", err);
  }
}
if (api?.contextMenus?.onClicked) {
  api.contextMenus.onClicked.addListener((info, tab) => {
    try {
      handleContextMenuClick(info, tab);
    } catch (err) {
      console.error("[Orchestra Zen] handleContextMenuClick error:", err);
    }
  });
}
if (api?.runtime?.onMessage) {
  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message;
    if (msg.type === "CHECK_STATUS") {
      (async () => {
        try {
          const password = await getStoredServerPassword();
          const resolved = await resolveServer(password);
          sendResponse(resolved);
        } catch (err) {
          console.error("[Orchestra Zen] CHECK_STATUS error:", err);
          sendResponse({ url: DEFAULT_SERVER_URL, online: false });
        }
      })();
      return true;
    }
    if (msg.type === "GET_ACTIVE_TAB") {
      if (api.tabs?.query) {
        api.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
          sendResponse(tabs[0] ?? null);
        }).catch((err) => {
          console.error("[Orchestra Zen] GET_ACTIVE_TAB error:", err);
          sendResponse(null);
        });
        return true;
      }
      sendResponse(null);
      return false;
    }
    if (msg.type === "GET_RPC_STATUS") {
      sendResponse({ connected: rpcClient?.isConnected ?? false });
      return false;
    }
    if (msg.type === "GET_AI_ACTIVITIES") {
      sendResponse({ activities: recentAiActivities });
      return false;
    }
    if (msg.type === "AI_ACTIVITY" && msg.activity) {
      recordActivity(msg.activity);
      return false;
    }
    return false;
  });
}
