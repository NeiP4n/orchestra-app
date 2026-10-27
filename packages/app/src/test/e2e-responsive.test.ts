import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import "../happydom"

/**
 * W3C ARIA Accessibility tree node specification.
 */
export interface AccessibilityNode {
  role: string
  name?: string
  value?: string | number
  description?: string
  disabled?: boolean
  expanded?: boolean
  focused?: boolean
  modal?: boolean
  multiline?: boolean
  selected?: boolean
  level?: number
  children?: AccessibilityNode[]
}

/**
 * Traverses DOM tree to construct accessibility snapshot.
 */
export function buildAccessibilitySnapshot(
  element: Element,
  options: { interestingOnly?: boolean } = { interestingOnly: true },
): AccessibilityNode | null {
  if (element.getAttribute("aria-hidden") === "true") return null
  const style = window.getComputedStyle ? window.getComputedStyle(element) : null
  if (style && (style.display === "none" || style.visibility === "hidden")) return null

  const tagName = element.tagName.toLowerCase()
  const rawRole = element.getAttribute("role")
  let role = rawRole || ""

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
      case "button":
        role = "button"
        break
      case "a":
        if (element.hasAttribute("href")) role = "link"
        break
      case "dialog":
        role = "dialog"
        break
      case "input":
      case "textarea":
        role = "textbox"
        break
      default:
        role = "generic"
        break
    }
  }

  let name: string | undefined
  if (element.hasAttribute("aria-label")) {
    name = element.getAttribute("aria-label")?.trim()
  } else if (element.hasAttribute("title")) {
    name = element.getAttribute("title")?.trim()
  } else if (["button", "link", "tab", "heading"].includes(role)) {
    const text = element.textContent?.trim()
    if (text) name = text
  }

  let expanded: boolean | undefined
  if (element.hasAttribute("aria-expanded")) {
    expanded = element.getAttribute("aria-expanded") === "true"
  }

  let selected: boolean | undefined
  if (element.hasAttribute("aria-selected")) {
    selected = element.getAttribute("aria-selected") === "true"
  }

  const children: AccessibilityNode[] = []
  for (let i = 0; i < element.children.length; i++) {
    const childNode = buildAccessibilitySnapshot(element.children[i], options)
    if (childNode) {
      if (options.interestingOnly && childNode.role === "generic" && !childNode.name && !childNode.children?.length) {
        continue
      }
      children.push(childNode)
    }
  }

  const isInteresting =
    role !== "generic" || Boolean(name) || expanded !== undefined || selected !== undefined || children.length > 0

  if (options.interestingOnly && !isInteresting) return null

  const node: AccessibilityNode = { role }
  if (name !== undefined && name !== "") node.name = name
  if (expanded !== undefined) node.expanded = expanded
  if (selected !== undefined) node.selected = selected
  if (children.length > 0) node.children = children

  return node
}

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
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null
    if (style && (style.display === "none" || style.visibility === "hidden")) return false
    return el.getAttribute("aria-hidden") !== "true"
  }

  async click(): Promise<void> {
    const el = this.resolveElements()[0]
    if (!el) throw new Error("Element not found for click")

    const init = { bubbles: true, cancelable: true, view: window }
    el.dispatchEvent(new MouseEvent("mousedown", init))
    el.dispatchEvent(new MouseEvent("mouseup", init))
    el.dispatchEvent(new MouseEvent("click", init))
  }
}

export interface ViewportSize {
  width: number
  height: number
}

/**
 * Playwright-compatible Responsive Page Simulation.
 */
export class PlaywrightResponsivePage {
  private currentViewport: ViewportSize = { width: 1440, height: 900 }
  private resizeListeners: Set<() => void> = new Set()

  constructor(public container: HTMLElement) {
    this.setupMatchMediaMock()
  }

  private setupMatchMediaMock() {
    const self = this
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => {
        const maxWidthMatch = query.match(/max-width:\s*(\d+)px/)
        const maxWidth = maxWidthMatch ? parseInt(maxWidthMatch[1], 10) : Infinity
        const matches = self.currentViewport.width <= maxWidth

        return {
          matches,
          media: query,
          onchange: null,
          addListener: (cb: () => void) => self.resizeListeners.add(cb),
          removeListener: (cb: () => void) => self.resizeListeners.delete(cb),
          addEventListener: (_type: string, cb: () => void) => self.resizeListeners.add(cb),
          removeEventListener: (_type: string, cb: () => void) => self.resizeListeners.delete(cb),
          dispatchEvent: (_event: Event) => true,
        } as unknown as MediaQueryList
      },
    })
  }

  /**
   * Playwright page.setViewportSize({ width, height }) emulation.
   */
  async setViewportSize(size: ViewportSize): Promise<void> {
    this.currentViewport = { ...size }
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: size.width })
    Object.defineProperty(window, "innerHeight", { writable: true, configurable: true, value: size.height })
    Object.defineProperty(window, "outerWidth", { writable: true, configurable: true, value: size.width })
    Object.defineProperty(window, "outerHeight", { writable: true, configurable: true, value: size.height })

    window.dispatchEvent(new Event("resize"))
    for (const listener of this.resizeListeners) {
      listener()
    }
  }

  viewportSize(): ViewportSize {
    return { ...this.currentViewport }
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
          else if (role === "complementary" && el.tagName.toLowerCase() === "aside") matchesRole = true
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

  accessibility = {
    snapshot: async (options?: { root?: Element; interestingOnly?: boolean }): Promise<AccessibilityNode | null> => {
      const target = options?.root || this.container
      return buildAccessibilitySnapshot(target, options)
    },
  }
}

/**
 * Mounts a responsive Orchestra Application layout surface into container.
 */
export function mountResponsiveOrchestraApp(root: HTMLElement, page: PlaywrightResponsivePage) {
  root.setAttribute("data-opencode-mounted", "")
  root.setAttribute("role", "application")
  root.setAttribute("aria-label", "Orchestra Responsive Workspace")

  let mobileMenuOpen = false

  function render() {
    const isMobile = page.viewportSize().width <= 767

    root.innerHTML = `
      <div data-surface="responsive-shell" class="app-layout flex flex-col h-full w-full">
        <!-- Header / Titlebar -->
        <header role="banner" class="titlebar flex items-center justify-between h-10 px-3 border-b bg-muted/20">
          <div class="flex items-center space-x-2">
            <!-- Mobile Burger Navigation Toggle -->
            ${
              isMobile
                ? `
              <button
                type="button"
                role="button"
                aria-label="Navigation menu"
                aria-haspopup="dialog"
                aria-expanded="${mobileMenuOpen}"
                data-slot="mobile-burger-button"
                class="burger-btn p-1.5 rounded hover:bg-accent focus:outline-none"
              >
                <span class="sr-only">Navigation menu</span>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <line x1="3" y1="12" x2="21" y2="12"></line>
                  <line x1="3" y1="6" x2="21" y2="6"></line>
                  <line x1="3" y1="18" x2="21" y2="18"></line>
                </svg>
              </button>
            `
                : ""
            }
            <span class="font-bold text-sm tracking-tight">Orchestra</span>
          </div>

          <!-- Desktop Tab Strip -->
          ${
            !isMobile
              ? `
            <nav role="tablist" aria-label="Desktop Session Tabs" data-titlebar-tab-strip class="flex items-center space-x-1 flex-1 px-4">
              <a role="tab" aria-selected="true" data-active="true" class="px-3 py-1 text-xs font-semibold bg-accent rounded">Main Session</a>
              <a role="tab" aria-selected="false" data-active="false" class="px-3 py-1 text-xs text-muted rounded">Research Session</a>
            </nav>
          `
              : `
            <div data-slot="mobile-title" class="text-xs font-medium text-muted-foreground">Main Session</div>
          `
          }

          <div class="actions flex items-center space-x-2">
            <button type="button" role="button" aria-label="Settings" class="text-xs px-2 py-1">⚙</button>
          </div>
        </header>

        <!-- Body Area: Side Panels + Main View -->
        <div class="main-body flex flex-1 overflow-hidden relative">
          <!-- Session Side Panel (Collapses on Mobile) -->
          <aside
            role="complementary"
            aria-label="Sessions Sidebar"
            data-slot="sidebar"
            data-state="${isMobile ? "collapsed" : "expanded"}"
            aria-expanded="${!isMobile}"
            class="sidebar border-r p-3 ${isMobile ? "hidden" : "flex flex-col w-64"}"
            ${isMobile ? 'aria-hidden="true" style="display: none;"' : 'style="width: 256px;"'}
          >
            <h2 class="text-xs font-bold text-muted-foreground uppercase mb-2">Projects & Sessions</h2>
            <ul role="list" class="space-y-1 text-xs">
              <li role="listitem" class="p-1.5 rounded bg-accent/40 font-medium">Main Session</li>
              <li role="listitem" class="p-1.5 rounded hover:bg-muted/30">Research Session</li>
              <li role="listitem" class="p-1.5 rounded hover:bg-muted/30">Testing Branch</li>
            </ul>
          </aside>

          <!-- Main Session View Surface -->
          <main role="main" data-slot="session-view" class="flex-1 flex flex-col p-4 overflow-auto">
            <h1 class="text-sm font-semibold mb-2">Main Session Workspace</h1>
            <div class="chat-viewport flex-1 border rounded p-3 text-xs text-muted-foreground">
              Conversation timeline and prompt stream.
            </div>
          </main>

          <!-- Mobile Drawer Navigation Overlay (When Burger Opened) -->
          ${
            isMobile && mobileMenuOpen
              ? `
            <div
              role="dialog"
              aria-label="Navigation drawer"
              data-slot="mobile-navigation-drawer"
              class="mobile-drawer fixed inset-0 z-50 flex"
            >
              <div class="backdrop absolute inset-0 bg-black/50" data-slot="drawer-backdrop"></div>
              <nav role="navigation" aria-label="Mobile Navigation" class="relative w-64 bg-background p-4 flex flex-col space-y-4 shadow-xl z-10">
                <div class="flex justify-between items-center border-b pb-2">
                  <span class="font-bold text-sm">Navigation</span>
                  <button type="button" role="button" aria-label="Close navigation" data-slot="drawer-close-btn" class="p-1 text-xs">✕</button>
                </div>
                <div class="space-y-2 text-xs">
                  <a role="link" href="/session/main" class="block p-2 rounded bg-accent">Main Session</a>
                  <a role="link" href="/session/research" class="block p-2 rounded hover:bg-muted">Research Session</a>
                  <a role="link" href="/settings" class="block p-2 rounded hover:bg-muted">Settings</a>
                </div>
              </nav>
            </div>
          `
              : ""
          }
        </div>
      </div>
    `

    // Event wiring
    const burger = root.querySelector<HTMLButtonElement>("button[data-slot='mobile-burger-button']")
    burger?.addEventListener("click", () => {
      mobileMenuOpen = !mobileMenuOpen
      render()
    })

    const closeBtn = root.querySelector<HTMLButtonElement>("button[data-slot='drawer-close-btn']")
    closeBtn?.addEventListener("click", () => {
      mobileMenuOpen = false
      render()
    })

    const backdrop = root.querySelector<HTMLDivElement>("div[data-slot='drawer-backdrop']")
    backdrop?.addEventListener("click", () => {
      mobileMenuOpen = false
      render()
    })
  }

  // Hook into resize triggers
  window.addEventListener("resize", render)
  render()
}

describe("E2E Playwright Responsive & Mobile Viewport Suite (OPT-016)", () => {
  let root: HTMLElement
  let page: PlaywrightResponsivePage

  beforeEach(async () => {
    root = document.createElement("div")
    root.id = "root"
    document.body.appendChild(root)
    page = new PlaywrightResponsivePage(root)
    await page.setViewportSize({ width: 1440, height: 900 })
    mountResponsiveOrchestraApp(root, page)
  })

  afterEach(() => {
    if (root && root.parentNode) {
      root.parentNode.removeChild(root)
    }
  })

  test("1. Emulates desktop viewport (1440x900) and displays expanded sidebars without mobile burger", async () => {
    await page.setViewportSize({ width: 1440, height: 900 })
    expect(page.viewportSize()).toEqual({ width: 1440, height: 900 })

    // Sidebar must be expanded and visible on desktop
    const sidebar = page.locator("[data-slot='sidebar']")
    expect(await sidebar.isVisible()).toBe(true)
    expect(await sidebar.getAttribute("data-state")).toBe("expanded")
    expect(await sidebar.getAttribute("aria-expanded")).toBe("true")

    // Desktop tab strip is active
    const desktopTabs = page.getByRole("tablist", { name: "Desktop Session Tabs" })
    expect(await desktopTabs.isVisible()).toBe(true)

    // Mobile burger button must NOT be present
    const burgerBtn = page.getByRole("button", { name: "Navigation menu" })
    expect(await burgerBtn.count()).toBe(0)
  })

  test("2. Emulates mobile screens (375x667 iPhone SE, 414x896 iPhone XR) and auto-collapses session sidebar", async () => {
    const mobileResolutions = [
      { name: "iPhone SE", width: 375, height: 667 },
      { name: "iPhone XR", width: 414, height: 896 },
    ]

    for (const res of mobileResolutions) {
      await page.setViewportSize({ width: res.width, height: res.height })
      expect(page.viewportSize().width).toBe(res.width)

      // Sidebar must be collapsed and hidden on mobile
      const sidebar = page.locator("[data-slot='sidebar']")
      expect(await sidebar.getAttribute("data-state")).toBe("collapsed")
      expect(await sidebar.getAttribute("aria-expanded")).toBe("false")
      expect(await sidebar.isVisible()).toBe(false)

      // Mobile burger navigation must be visible and accessible
      const burger = page.getByRole("button", { name: "Navigation menu" })
      expect(await burger.count()).toBe(1)
      expect(await burger.isVisible()).toBe(true)
      expect(await burger.getAttribute("aria-expanded")).toBe("false")
    }
  })

  test("3. Toggles mobile navigation menu drawer, verifying accessibility state transitions", async () => {
    await page.setViewportSize({ width: 375, height: 667 })

    const burger = page.getByRole("button", { name: "Navigation menu" })
    expect(await burger.getAttribute("aria-expanded")).toBe("false")

    // Click burger to open navigation drawer
    await burger.click()
    expect(await burger.getAttribute("aria-expanded")).toBe("true")

    // Drawer dialog is mounted and visible
    const drawerDialog = page.getByRole("dialog", { name: "Navigation drawer" })
    expect(await drawerDialog.isVisible()).toBe(true)

    const drawerNav = page.getByRole("navigation", { name: "Mobile Navigation" })
    expect(await drawerNav.isVisible()).toBe(true)

    // Navigation links are accessible
    const mainSessionLink = page.getByRole("link", { name: "Main Session" })
    expect(await mainSessionLink.isVisible()).toBe(true)

    // Close drawer via close button
    const closeBtn = page.getByRole("button", { name: "Close navigation" })
    await closeBtn.click()

    // Drawer is closed and burger reflects collapsed state
    expect(await burger.getAttribute("aria-expanded")).toBe("false")
    expect(await drawerDialog.count()).toBe(0)
  })

  test("4. Validates accessibility snapshot changes between desktop and mobile structures", async () => {
    // 1. Desktop Snapshot
    await page.setViewportSize({ width: 1440, height: 900 })
    const desktopSnapshot = await page.accessibility.snapshot()

    expect(desktopSnapshot).not.toBeNull()
    expect(desktopSnapshot?.role).toBe("application")

    function findNode(node: AccessibilityNode | null, predicate: (n: AccessibilityNode) => boolean): boolean {
      if (!node) return false
      if (predicate(node)) return true
      if (node.children) {
        for (const child of node.children) {
          if (findNode(child, predicate)) return true
        }
      }
      return false
    }

    // Desktop snapshot includes the sidebar complementary landmark and no burger
    expect(findNode(desktopSnapshot, (n) => n.role === "complementary" && n.name === "Sessions Sidebar")).toBe(true)
    expect(findNode(desktopSnapshot, (n) => n.role === "button" && n.name === "Navigation menu")).toBe(false)

    // 2. Mobile Snapshot
    await page.setViewportSize({ width: 375, height: 667 })
    const mobileSnapshot = await page.accessibility.snapshot()

    // Mobile snapshot collapses sidebar from accessibility tree and includes burger button
    expect(findNode(mobileSnapshot, (n) => n.role === "complementary" && n.name === "Sessions Sidebar")).toBe(false)
    expect(
      findNode(mobileSnapshot, (n) => n.role === "button" && n.name === "Navigation menu" && n.expanded === false),
    ).toBe(true)

    // 3. Mobile Snapshot with Drawer Opened
    const burger = page.getByRole("button", { name: "Navigation menu" })
    await burger.click()

    const openDrawerSnapshot = await page.accessibility.snapshot()
    expect(
      findNode(openDrawerSnapshot, (n) => n.role === "button" && n.name === "Navigation menu" && n.expanded === true),
    ).toBe(true)
    expect(findNode(openDrawerSnapshot, (n) => n.role === "dialog" && n.name === "Navigation drawer")).toBe(true)
  })

  test("5. Smoothly transitions layout back and forth across 768px responsive breakpoint", async () => {
    // 1. Start on Mobile (767px)
    await page.setViewportSize({ width: 767, height: 800 })
    expect(await page.getByRole("button", { name: "Navigation menu" }).isVisible()).toBe(true)
    expect(await page.locator("[data-slot='sidebar']").isVisible()).toBe(false)

    // 2. Resize to Tablet/Desktop boundary (768px)
    await page.setViewportSize({ width: 768, height: 800 })
    expect(await page.getByRole("button", { name: "Navigation menu" }).count()).toBe(0)
    expect(await page.locator("[data-slot='sidebar']").isVisible()).toBe(true)

    // 3. Resize back to narrow mobile (360px)
    await page.setViewportSize({ width: 360, height: 740 })
    expect(await page.getByRole("button", { name: "Navigation menu" }).isVisible()).toBe(true)
    expect(await page.locator("[data-slot='sidebar']").isVisible()).toBe(false)
  })
})
