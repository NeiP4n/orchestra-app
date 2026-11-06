import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ZenBridgeServer } from "@orchestra/core/zen/bridge-server"
import { ZenBrowserTool } from "@orchestra/core/tool/plugin/zen-browser"

const SESSION = "ses_zen_browser_test"

/** A fake bridge: no browser, no extension — only the calls the tool makes. */
class FakeBridge {
  calls: Array<{ readonly action: string; readonly params?: unknown }> = []
  tabs: Array<{ readonly id: number; readonly url: string; readonly active?: boolean; readonly title?: string }> = []
  navigateResult: unknown = { id: 7, url: "https://8.8.8.8/" }
  connected = true
  port = 4097

  getStatus() {
    return { connected: this.connected }
  }

  async sendRpc<T>(action: string, params?: unknown): Promise<T> {
    this.calls.push({ action, params })
    if (action === "tabs") return { tabs: this.tabs } as T
    if (action === "navigate") return this.navigateResult as T
    if (action === "eval") return { result: "ok" } as T
    return {} as T
  }
}

const originalBridge = ZenBrowserTool.getZenBridgeServer()

afterEach(() => {
  ZenBrowserTool.setZenBridgeServer(originalBridge)
  ZenBrowserTool.clearAgentTabs()
  delete process.env.ORCHESTRA_ZEN_BROWSER_ALLOW_LOCAL_URLS
})

const attempt = async (input: Parameters<typeof ZenBrowserTool.run>[0], sessionID = SESSION) => {
  try {
    const out = await Effect.runPromise(ZenBrowserTool.run(input, sessionID))
    return { ok: true as const, output: out.output }
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
  }
}

describe("zen_browser gates (arch3 №5)", () => {
  test("navigate to a loopback URL is refused before any bridge call", async () => {
    const bridge = new FakeBridge()
    ZenBrowserTool.setZenBridgeServer(bridge as unknown as ZenBridgeServer)
    for (const url of ["http://127.0.0.1:17890/", "http://localhost:3000/", "http://169.254.169.254/"]) {
      const result = await attempt({ action: "navigate", url })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toContain("refused")
    }
    expect(bridge.calls).toEqual([])
  })

  test("navigate to a public URL passes the gate and records the tab", async () => {
    const bridge = new FakeBridge()
    ZenBrowserTool.setZenBridgeServer(bridge as unknown as ZenBridgeServer)
    const result = await attempt({ action: "navigate", url: "https://8.8.8.8/" })
    expect(result.ok).toBe(true)
    expect(bridge.calls.some((call) => call.action === "navigate")).toBe(true)
    expect(ZenBrowserTool.isAgentTab(SESSION, 7)).toBe(true)
  })

  test("the local-URL opt-in lifts the gate for testing", async () => {
    const bridge = new FakeBridge()
    ZenBrowserTool.setZenBridgeServer(bridge as unknown as ZenBridgeServer)
    process.env.ORCHESTRA_ZEN_BROWSER_ALLOW_LOCAL_URLS = "1"
    const result = await attempt({ action: "navigate", url: "http://127.0.0.1:17890/" })
    expect(result.ok).toBe(true)
    expect(bridge.calls.some((call) => call.action === "navigate")).toBe(true)
  })

  test("eval in a tab the session did not open is refused", async () => {
    const bridge = new FakeBridge()
    ZenBrowserTool.setZenBridgeServer(bridge as unknown as ZenBridgeServer)
    const foreign = await attempt({ action: "eval", tabId: 99, code: "document.title" })
    expect(foreign.ok).toBe(false)
    if (!foreign.ok) expect(foreign.message).toContain("was not opened by this session")
    expect(bridge.calls.some((call) => call.action === "eval")).toBe(false)

    bridge.tabs = [{ id: 99, url: "https://example.com/", active: true }]
    const active = await attempt({ action: "eval", code: "document.title" })
    expect(active.ok).toBe(false)
    if (!active.ok) expect(active.message).toContain("was not opened by this session")
    expect(bridge.calls.some((call) => call.action === "eval")).toBe(false)
  })

  test("eval in a tab the session opened with navigate is allowed", async () => {
    const bridge = new FakeBridge()
    ZenBrowserTool.setZenBridgeServer(bridge as unknown as ZenBridgeServer)
    await attempt({ action: "navigate", url: "https://8.8.8.8/" })
    const byId = await attempt({ action: "eval", tabId: 7, code: "document.title" })
    expect(byId.ok).toBe(true)
    expect(bridge.calls.some((call) => call.action === "eval")).toBe(true)

    bridge.tabs = [{ id: 7, url: "https://8.8.8.8/", active: true }]
    const callsBefore = bridge.calls.length
    const byActive = await attempt({ action: "eval", code: "document.title" })
    expect(byActive.ok).toBe(true)
    const evalCall = bridge.calls.slice(callsBefore).find((call) => call.action === "eval")
    expect((evalCall?.params as { tabId?: number } | undefined)?.tabId).toBe(7)
  })

  test("agent tabs are scoped per session", async () => {
    const bridge = new FakeBridge()
    ZenBrowserTool.setZenBridgeServer(bridge as unknown as ZenBridgeServer)
    await attempt({ action: "navigate", url: "https://8.8.8.8/" })
    const other = await attempt({ action: "eval", tabId: 7, code: "1" }, "ses_other_session")
    expect(other.ok).toBe(false)
  })
})
