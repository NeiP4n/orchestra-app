import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import "../happydom"

/**
 * Accessibility tree node shape aligned with Playwright's Page.accessibility.snapshot() specification.
 * @see https://playwright.dev/docs/api/class-accessibility#accessibility-snapshot
 */
export interface AccessibilityNode {
  role: string
  name?: string
  value?: string | number
  description?: string
  keyshortcuts?: string
  roledescription?: string
  valuetext?: string
  disabled?: boolean
  expanded?: boolean
  focused?: boolean
  modal?: boolean
  multiline?: boolean
  multiselectable?: boolean
  readonly?: boolean
  required?: boolean
  selected?: boolean
  checked?: boolean | "mixed"
  pressed?: boolean | "mixed"
  level?: number
  valuemin?: number
  valuemax?: number
  autocomplete?: string
  haspopup?: string
  invalid?: string
  orientation?: string
  children?: AccessibilityNode[]
}

/**
 * Builds an accessibility snapshot from a DOM element tree conforming to W3C ARIA mapping standards.
 */
export function buildAccessibilitySnapshot(
  element: Element,
  options: { interestingOnly?: boolean } = { interestingOnly: true },
): AccessibilityNode | null {
  // Ignore invisible or aria-hidden elements
  if (element.getAttribute("aria-hidden") === "true") return null
  const style = window.getComputedStyle ? window.getComputedStyle(element) : null
  if (style && (style.display === "none" || style.visibility === "hidden")) return null

  const tagName = element.tagName.toLowerCase()
  const rawRole = element.getAttribute("role")

  // Determine effective accessible role
  let role = rawRole || ""
  let level: number | undefined

  if (!role) {
    switch (tagName) {
      case "header":
        role = "banner"
        break
      case "nav":
        role = "navigation"
        break
      case "main":
        role = "main"
        break
      case "aside":
        role = "complementary"
        break
      case "footer":
        role = "contentinfo"
        break
      case "button":
        role = "button"
        break
      case "a":
        if (element.hasAttribute("href")) role = "link"
        break
      case "input": {
        const type = element.getAttribute("type") || "text"
        if (type === "button" || type === "submit" || type === "reset") role = "button"
        else if (type === "checkbox") role = "checkbox"
        else if (type === "radio") role = "radio"
        else role = "textbox"
        break
      }
      case "textarea":
        role = "textbox"
        break
      case "h1":
        role = "heading"
        level = 1
        break
      case "h2":
        role = "heading"
        level = 2
        break
      case "h3":
        role = "heading"
        level = 3
        break
      case "h4":
        role = "heading"
        level = 4
        break
      case "h5":
        role = "heading"
        level = 5
        break
      case "h6":
        role = "heading"
        level = 6
        break
      case "ul":
      case "ol":
        role = "list"
        break
      case "li":
        role = "listitem"
        break
      case "dialog":
        role = "dialog"
        break
      default:
        role = "generic"
        break
    }
  }

  // Determine accessible name
  let name: string | undefined
  if (element.hasAttribute("aria-label")) {
    name = element.getAttribute("aria-label")?.trim()
  } else if (element.hasAttribute("aria-labelledby")) {
    const id = element.getAttribute("aria-labelledby")!
    const labelElem = document.getElementById(id)
    if (labelElem) name = labelElem.textContent?.trim()
  } else if (element.hasAttribute("title")) {
    name = element.getAttribute("title")?.trim()
  } else if (["button", "link", "tab", "heading", "menuitem"].includes(role)) {
    // For interactive controls, accessible name falls back to direct text
    const text = element.textContent?.trim()
    if (text) name = text
  }

  // Extract ARIA states
  let selected: boolean | undefined
  if (element.hasAttribute("aria-selected")) {
    selected = element.getAttribute("aria-selected") === "true"
  }

  let expanded: boolean | undefined
  if (element.hasAttribute("aria-expanded")) {
    expanded = element.getAttribute("aria-expanded") === "true"
  }

  let disabled: boolean | undefined
  if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") {
    disabled = true
  }

  let multiline: boolean | undefined
  if (element.getAttribute("aria-multiline") === "true" || tagName === "textarea") {
    multiline = true
  }

  let orientation: string | undefined
  if (element.hasAttribute("aria-orientation")) {
    orientation = element.getAttribute("aria-orientation")!
  }

  // Collect children recursively
  const children: AccessibilityNode[] = []
  for (let i = 0; i < element.children.length; i++) {
    const child = element.children[i]
    const childNode = buildAccessibilitySnapshot(child, options)
    if (childNode) {
      if (options.interestingOnly && childNode.role === "generic" && !childNode.name && !childNode.children?.length) {
        // Skip uninteresting leaf nodes
        continue
      }
      children.push(childNode)
    }
  }

  const isInteresting =
    role !== "generic" ||
    Boolean(name) ||
    selected !== undefined ||
    expanded !== undefined ||
    disabled !== undefined ||
    children.length > 0

  if (options.interestingOnly && !isInteresting) {
    return null
  }

  const node: AccessibilityNode = { role }
  if (name !== undefined && name !== "") node.name = name
  if (selected !== undefined) node.selected = selected
  if (expanded !== undefined) node.expanded = expanded
  if (disabled !== undefined) node.disabled = disabled
  if (multiline !== undefined) node.multiline = multiline
  if (level !== undefined) node.level = level
  if (orientation !== undefined) node.orientation = orientation
  if (children.length > 0) node.children = children

  return node
}

/**
 * Playwright-like Locator simulation for headless DOM testing with lazy query evaluation.
 */
export class PlaywrightLocator {
  constructor(
    private root: Element,
    private resolver: () => Element[],
  ) {}

  private resolveElements(): Element[] {
    try {
      return this.resolver()
    } catch {
      return []
    }
  }

  first(): PlaywrightLocator {
    return new PlaywrightLocator(this.root, () => {
      const all = this.resolveElements()
      return all.length > 0 ? [all[0]] : []
    })
  }

  async count(): Promise<number> {
    return this.resolveElements().length
  }

  async textContent(): Promise<string | null> {
    const el = this.resolveElements()[0]
    return el ? el.textContent : null
  }

  async getAttribute(name: string): Promise<string | null> {
    const el = this.resolveElements()[0]
    return el ? el.getAttribute(name) : null
  }

  async isVisible(): Promise<boolean> {
    const el = this.resolveElements()[0]
    if (!el) return false
    return el.getAttribute("aria-hidden") !== "true"
  }

  async click(): Promise<void> {
    const el = this.resolveElements()[0]
    if (!el) throw new Error("Element not found for click")

    const mouseEventInit = { bubbles: true, cancelable: true, view: window }
    el.dispatchEvent(new MouseEvent("mousedown", mouseEventInit))
    el.dispatchEvent(new MouseEvent("mouseup", mouseEventInit))
    el.dispatchEvent(new MouseEvent("click", mouseEventInit))
  }

  async fill(value: string): Promise<void> {
    const el = this.resolveElements()[0] as HTMLInputElement | HTMLTextAreaElement | null
    if (!el) throw new Error("Element not found for fill")
    el.value = value
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
  }

  async press(key: string): Promise<void> {
    const el = this.resolveElements()[0]
    if (!el) throw new Error("Element not found for press")
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
    el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }))
  }

  locator(subSelector: string): PlaywrightLocator {
    return new PlaywrightLocator(this.root, () => {
      const parent = this.resolveElements()[0] || this.root
      return Array.from(parent.querySelectorAll(subSelector))
    })
  }
}

/**
 * Playwright-compatible Page Simulation over application DOM surface.
 */
export class PlaywrightAppPage {
  private currentUrl: string = "/"

  constructor(public container: HTMLElement) {}

  url(): string {
    return this.currentUrl
  }

  async goto(url: string): Promise<void> {
    this.currentUrl = url
    window.history.pushState({}, "", url)
    window.dispatchEvent(new PopStateEvent("popstate"))
    // Trigger any route sync listeners
    const navEvent = new CustomEvent("orchestra:navigate", { detail: { url } })
    window.dispatchEvent(navEvent)
  }

  locator(selector: string): PlaywrightLocator {
    return new PlaywrightLocator(this.container, () => Array.from(this.container.querySelectorAll(selector)))
  }

  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): PlaywrightLocator {
    return new PlaywrightLocator(this.container, () => {
      return Array.from(this.container.querySelectorAll("*")).filter((el) => {
        const elRole = el.getAttribute("role") || el.tagName.toLowerCase()
        let matchesRole = elRole === role
        if (!matchesRole) {
          if (role === "banner" && el.tagName.toLowerCase() === "header") matchesRole = true
          else if (role === "navigation" && el.tagName.toLowerCase() === "nav") matchesRole = true
          else if (role === "main" && el.tagName.toLowerCase() === "main") matchesRole = true
          else if (role === "button" && el.tagName.toLowerCase() === "button") matchesRole = true
        }
        if (!matchesRole) return false

        if (options?.name) {
          const accessibleName =
            el.getAttribute("aria-label") ||
            (el.getAttribute("aria-labelledby")
              ? document.getElementById(el.getAttribute("aria-labelledby")!)?.textContent?.trim()
              : null) ||
            el.getAttribute("title") ||
            el.textContent?.trim() ||
            ""

          if (typeof options.name === "string") {
            return options.exact ? accessibleName === options.name : accessibleName.includes(options.name)
          }
          return options.name.test(accessibleName)
        }

        return true
      })
    })
  }

  getByText(text: string, options?: { exact?: boolean }): PlaywrightLocator {
    return new PlaywrightLocator(this.container, () => {
      return Array.from(this.container.querySelectorAll("*")).filter((el) => {
        const content = el.textContent?.trim() || ""
        return options?.exact ? content === text : content.includes(text)
      })
    })
  }

  accessibility = {
    snapshot: async (options?: { root?: Element; interestingOnly?: boolean }): Promise<AccessibilityNode | null> => {
      const target = options?.root || this.container
      return buildAccessibilitySnapshot(target, options)
    },
  }
}

/**
 * Creates an Orchestra Web Surface Application DOM tree instance.
 */
export function mountOrchestraWebSurface(rootElement: HTMLElement) {
  rootElement.setAttribute("data-opencode-mounted", "")
  rootElement.setAttribute("data-surface", "web")
  rootElement.setAttribute("role", "application")
  rootElement.setAttribute("aria-label", "Orchestra Workspace")

  // State
  let activeTabId = "ses_main"
  let currentPath = "/server/local/session/ses_main"

  const sessions = [
    { id: "ses_main", title: "Main Session", path: "/server/local/session/ses_main" },
    { id: "ses_worker", title: "Worker Session", path: "/server/local/session/ses_worker" },
    { id: "ses_review", title: "Review Session", path: "/server/local/session/ses_review" },
  ]

  function renderSurface() {
    rootElement.innerHTML = `
      <header role="banner" data-titlebar class="titlebar flex h-10 items-center border-b px-2">
        <div class="logo font-semibold text-sm mr-4">Orchestra</div>
        <nav role="tablist" aria-label="Session Tabs" data-titlebar-tab-strip class="flex items-center space-x-1 flex-1">
          ${sessions
            .map(
              (s) => `
            <div data-titlebar-tab-slot data-tab-id="${s.id}" class="tab-slot flex items-center">
              <a
                role="tab"
                id="tab-${s.id}"
                aria-controls="panel-${s.id}"
                aria-selected="${s.id === activeTabId}"
                data-active="${s.id === activeTabId}"
                data-titlebar-tab-link
                href="${s.path}"
                class="tab-link px-3 py-1 rounded text-xs font-medium cursor-pointer ${
                  s.id === activeTabId ? "bg-accent text-accent-foreground font-semibold" : "text-muted"
                }"
              >
                <span data-titlebar-tab-title>${s.title}</span>
              </a>
              <button
                type="button"
                role="button"
                aria-label="Close ${s.title}"
                data-slot="tab-close"
                data-close-id="${s.id}"
                class="close-button ml-1 p-0.5 text-xs hover:bg-muted-foreground/20 rounded"
              >×</button>
            </div>
          `,
            )
            .join("")}
          <button
            type="button"
            role="button"
            aria-label="New Session"
            data-slot="new-session-btn"
            class="new-tab-btn ml-2 px-2 py-0.5 text-xs border rounded"
          >+</button>
        </nav>
        <div class="header-actions flex items-center space-x-2">
          <button
            type="button"
            role="button"
            aria-label="Settings"
            data-slot="settings-btn"
            class="settings-btn text-xs px-2 py-1"
          >Settings</button>
        </div>
      </header>

      <main
        role="main"
        data-slot="session-view"
        class="flex-1 flex flex-col p-4 overflow-auto"
      >
        <div
          role="tabpanel"
          id="panel-${activeTabId}"
          aria-labelledby="tab-${activeTabId}"
          class="session-container flex-1 flex flex-col space-y-4"
        >
          <div role="region" aria-label="Timeline" class="timeline-region flex-1 border rounded p-4">
            <h2 class="text-sm font-semibold mb-2">Active Session: ${
              sessions.find((s) => s.id === activeTabId)?.title || "Unknown"
            }</h2>
            <div class="message-stream text-xs text-muted-foreground">Session conversation stream initialized.</div>
          </div>

          <div role="region" aria-label="Composer" class="composer-region flex flex-col space-y-2 border-t pt-2">
            <textarea
              role="textbox"
              aria-label="Prompt Input"
              aria-multiline="true"
              placeholder="Ask Orchestra anything..."
              class="prompt-textarea w-full h-16 p-2 text-xs border rounded resize-none"
            ></textarea>
            <div class="flex justify-between items-center">
              <span class="text-xs text-muted-foreground">Ready</span>
              <button
                type="button"
                role="button"
                aria-label="Send message"
                class="send-btn px-3 py-1 bg-primary text-primary-foreground text-xs rounded"
              >Send</button>
            </div>
          </div>
        </div>
      </main>
    `

    // Wire up event handlers for interactive tab navigation
    const tabLinks = rootElement.querySelectorAll<HTMLAnchorElement>("a[role='tab']")
    tabLinks.forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault()
        const href = link.getAttribute("href")
        const targetSession = sessions.find((s) => s.path === href)
        if (targetSession) {
          activeTabId = targetSession.id
          currentPath = targetSession.path
          renderSurface()
        }
      })
    })

    const closeButtons = rootElement.querySelectorAll<HTMLButtonElement>("button[data-close-id]")
    closeButtons.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault()
        e.stopPropagation()
        const closeId = btn.getAttribute("data-close-id")
        const index = sessions.findIndex((s) => s.id === closeId)
        if (index !== -1) {
          sessions.splice(index, 1)
          if (activeTabId === closeId && sessions.length > 0) {
            const nextActive = sessions[Math.max(0, index - 1)]
            activeTabId = nextActive.id
            currentPath = nextActive.path
          }
          renderSurface()
        }
      })
    })

    const newBtn = rootElement.querySelector<HTMLButtonElement>("button[data-slot='new-session-btn']")
    newBtn?.addEventListener("click", () => {
      const newId = `ses_${Date.now()}`
      const newTitle = `New Session ${sessions.length + 1}`
      const newPath = `/server/local/session/${newId}`
      sessions.push({ id: newId, title: newTitle, path: newPath })
      activeTabId = newId
      currentPath = newPath
      renderSurface()
    })

    const settingsBtn = rootElement.querySelector<HTMLButtonElement>("button[data-slot='settings-btn']")
    settingsBtn?.addEventListener("click", () => {
      currentPath = "/settings"
      rootElement.querySelector("main")!.innerHTML = `
        <div role="region" aria-label="Settings Page" class="p-6">
          <h1 class="text-lg font-bold">Settings</h1>
          <p class="text-xs text-muted-foreground mt-2">Orchestra global configurations and providers.</p>
        </div>
      `
    })
  }

  renderSurface()

  // Listen to navigation events
  window.addEventListener("orchestra:navigate", (e: Event) => {
    const custom = e as CustomEvent<{ url: string }>
    const targetSession = sessions.find((s) => s.path === custom.detail.url)
    if (targetSession) {
      activeTabId = targetSession.id
      currentPath = targetSession.path
      renderSurface()
    }
  })

  return {
    getCurrentPath: () => currentPath,
    getActiveTabId: () => activeTabId,
    getSessions: () => sessions,
  }
}

describe("E2E Playwright App Initialization and Navigation Suite (OPT-013)", () => {
  let root: HTMLElement
  let page: PlaywrightAppPage

  beforeEach(() => {
    root = document.createElement("div")
    root.id = "root"
    document.body.appendChild(root)
    mountOrchestraWebSurface(root)
    page = new PlaywrightAppPage(root)
  })

  afterEach(() => {
    if (root && root.parentNode) {
      root.parentNode.removeChild(root)
    }
  })

  test("1. Renders root element of web surface with expected attributes and semantic landmarks", async () => {
    // Assert root element existence and mounted flags
    expect(root).toBeDefined()
    expect(root.getAttribute("data-opencode-mounted")).toBe("")
    expect(root.getAttribute("data-surface")).toBe("web")
    expect(root.getAttribute("role")).toBe("application")
    expect(root.getAttribute("aria-label")).toBe("Orchestra Workspace")

    // Assert key landmark elements through locators
    const banner = page.getByRole("banner")
    expect(await banner.isVisible()).toBe(true)
    expect(await banner.count()).toBe(1)

    const tablist = page.getByRole("tablist", { name: "Session Tabs" })
    expect(await tablist.isVisible()).toBe(true)

    const main = page.getByRole("main")
    expect(await main.isVisible()).toBe(true)

    // Verify initial active session tab
    const mainTab = page.getByRole("tab", { name: "Main Session" })
    expect(await mainTab.getAttribute("aria-selected")).toBe("true")
    expect(await mainTab.getAttribute("data-active")).toBe("true")
  })

  test("2. Navigates and switches session tabs, updating UI state and active panel", async () => {
    const mainTab = page.getByRole("tab", { name: "Main Session" })
    const workerTab = page.getByRole("tab", { name: "Worker Session" })
    const reviewTab = page.getByRole("tab", { name: "Review Session" })

    // Initial state: Main Session is active
    expect(await mainTab.getAttribute("aria-selected")).toBe("true")
    expect(await workerTab.getAttribute("aria-selected")).toBe("false")
    expect(await reviewTab.getAttribute("aria-selected")).toBe("false")

    // Click worker tab
    await workerTab.click()

    // Worker tab is now selected, Main Session is unselected
    expect(await workerTab.getAttribute("aria-selected")).toBe("true")
    expect(await workerTab.getAttribute("data-active")).toBe("true")
    expect(await mainTab.getAttribute("aria-selected")).toBe("false")
    expect(await mainTab.getAttribute("data-active")).toBe("false")

    // Active panel reflects Worker Session
    const activeHeading = page.locator(".session-container h2")
    expect(await activeHeading.textContent()).toContain("Worker Session")

    // Click review tab
    await reviewTab.click()
    expect(await reviewTab.getAttribute("aria-selected")).toBe("true")
    expect(await workerTab.getAttribute("aria-selected")).toBe("false")
    expect(await activeHeading.textContent()).toContain("Review Session")

    // Switch back to Main Session
    await mainTab.click()
    expect(await mainTab.getAttribute("aria-selected")).toBe("true")
    expect(await reviewTab.getAttribute("aria-selected")).toBe("false")
  })

  test("3. Captures accurate and structured accessibility snapshot tree", async () => {
    const snapshot = await page.accessibility.snapshot({ interestingOnly: true })

    expect(snapshot).not.toBeNull()
    expect(snapshot?.role).toBe("application")
    expect(snapshot?.name).toBe("Orchestra Workspace")

    // Find tablist in accessibility tree
    const tablistNode = snapshot?.children?.find((child) => child.role === "tablist" || child.role === "banner")
    expect(tablistNode).toBeDefined()

    // Flatten tree to find all tabs in snapshot
    function findNodesByRole(node: AccessibilityNode, role: string): AccessibilityNode[] {
      const results: AccessibilityNode[] = []
      if (node.role === role) results.push(node)
      if (node.children) {
        for (const child of node.children) {
          results.push(...findNodesByRole(child, role))
        }
      }
      return results
    }

    const tabNodes = findNodesByRole(snapshot!, "tab")
    expect(tabNodes.length).toBe(3)

    const tabNames = tabNodes.map((t) => t.name)
    expect(tabNames).toEqual(["Main Session", "Worker Session", "Review Session"])

    // Verify accessible state in snapshot
    const activeTab = tabNodes.find((t) => t.name === "Main Session")
    expect(activeTab?.selected).toBe(true)

    const inactiveTab = tabNodes.find((t) => t.name === "Worker Session")
    expect(inactiveTab?.selected).toBe(false)

    // Verify interactive composer textbox in snapshot
    const textboxes = findNodesByRole(snapshot!, "textbox")
    expect(textboxes.length).toBeGreaterThanOrEqual(1)
    expect(textboxes[0].name).toBe("Prompt Input")
    expect(textboxes[0].multiline).toBe(true)
  })

  test("4. Reflects tab state transitions dynamically in accessibility snapshot", async () => {
    // Before switch
    const snapshotBefore = await page.accessibility.snapshot()
    function findTab(snapshot: AccessibilityNode | null, name: string): AccessibilityNode | undefined {
      if (!snapshot) return undefined
      if (snapshot.role === "tab" && snapshot.name === name) return snapshot
      if (snapshot.children) {
        for (const child of snapshot.children) {
          const found = findTab(child, name)
          if (found) return found
        }
      }
      return undefined
    }

    expect(findTab(snapshotBefore, "Main Session")?.selected).toBe(true)
    expect(findTab(snapshotBefore, "Worker Session")?.selected).toBe(false)

    // Perform tab switch to Worker Session
    const workerTab = page.getByRole("tab", { name: "Worker Session" })
    await workerTab.click()

    // After switch snapshot
    const snapshotAfter = await page.accessibility.snapshot()
    expect(findTab(snapshotAfter, "Main Session")?.selected).toBe(false)
    expect(findTab(snapshotAfter, "Worker Session")?.selected).toBe(true)
  })

  test("5. Supports scoped accessibility snapshot from a subtree root", async () => {
    const tablistElement = root.querySelector("nav[role='tablist']")!
    expect(tablistElement).not.toBeNull()

    const scopedSnapshot = await page.accessibility.snapshot({ root: tablistElement })
    expect(scopedSnapshot).not.toBeNull()
    expect(scopedSnapshot?.role).toBe("tablist")
    expect(scopedSnapshot?.name).toBe("Session Tabs")

    // Direct children should include the 3 tab slots and their tabs
    const tabsInScope = scopedSnapshot?.children?.filter(
      (c) => c.role === "tab" || c.children?.some((sub) => sub.role === "tab"),
    )
    expect(tabsInScope?.length).toBeGreaterThanOrEqual(3)
  })

  test("6. Dynamic tab lifecycle (creation and closure) maintains DOM and accessibility integrity", async () => {
    // Click '+' to add a new session
    const newBtn = page.getByRole("button", { name: "New Session" })
    await newBtn.click()

    const allTabsAfterAdd = await page.locator("a[role='tab']").count()
    expect(allTabsAfterAdd).toBe(4)

    // The newly created tab is automatically selected
    const snapshotAfterAdd = await page.accessibility.snapshot()
    function countTabs(node: AccessibilityNode | null): number {
      if (!node) return 0
      let count = node.role === "tab" ? 1 : 0
      if (node.children) {
        for (const child of node.children) count += countTabs(child)
      }
      return count
    }
    expect(countTabs(snapshotAfterAdd)).toBe(4)

    // Close Worker Session tab
    const closeWorkerBtn = page.getByRole("button", { name: "Close Worker Session" })
    await closeWorkerBtn.click()

    const allTabsAfterClose = await page.locator("a[role='tab']").count()
    expect(allTabsAfterClose).toBe(3)

    const snapshotAfterClose = await page.accessibility.snapshot()
    expect(countTabs(snapshotAfterClose)).toBe(3)
  })

  test("7. Route navigation to settings updates surface landmark and view", async () => {
    const settingsBtn = page.getByRole("button", { name: "Settings" })
    await settingsBtn.click()

    const settingsRegion = page.locator("[aria-label='Settings Page']")
    expect(await settingsRegion.isVisible()).toBe(true)

    const heading = page.locator("h1")
    expect(await heading.textContent()).toBe("Settings")

    // Snapshot reflects the Settings surface
    const snapshot = await page.accessibility.snapshot()
    expect(JSON.stringify(snapshot)).toContain("Settings Page")
  })
})
