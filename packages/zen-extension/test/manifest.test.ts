import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

describe("Zen Extension Manifest", () => {
  const extensionDir = join(import.meta.dir, "..")
  const manifestPath = join(extensionDir, "manifest.json")

  it("should exist and be valid JSON", () => {
    expect(existsSync(manifestPath)).toBe(true)
    const content = readFileSync(manifestPath, "utf-8")
    const manifest = JSON.parse(content)
    expect(manifest).toBeTypeOf("object")
  })

  it("should conform to Manifest V3 specification for Zen Browser", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"))

    expect(manifest.manifest_version).toBe(3)
    expect(manifest.name).toBe("Orchestra Companion for Zen")
    expect(manifest.version).toBe("1.0.0")
    expect(manifest.description).toBe("AI companion, sidebar panel and context capture for Zen Browser")

    // Gecko specific settings for Zen / Firefox
    expect(manifest.browser_specific_settings).toEqual({
      gecko: {
        id: "orchestra-zen@local",
        strict_min_version: "115.0",
      },
    })

    // Extension Icons
    expect(manifest.icons).toEqual({
      "48": "icon.svg",
      "128": "icon.svg",
    })

    // Permissions
    expect(manifest.permissions).toContain("activeTab")
    expect(manifest.permissions).toContain("contextMenus")
    expect(manifest.permissions).toContain("storage")

    // Host permissions for local daemon
    expect(manifest.host_permissions).toContain("http://127.0.0.1/*")
    expect(manifest.host_permissions).toContain("http://localhost/*")

    // Native Zen / Firefox sidebar_action with icon
    expect(manifest.sidebar_action).toEqual({
      default_panel: "sidebar.html",
      default_title: "Orchestra",
      default_icon: "icon.svg",
    })

    // Action popup with icon
    expect(manifest.action).toEqual({
      default_popup: "popup.html",
      default_title: "Orchestra Quick Action",
      default_icon: "icon.svg",
    })

    // Background scripts
    expect(manifest.background).toEqual({
      scripts: ["background.js"],
    })
  })

  it("should ensure all referenced entrypoint files exist on disk", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"))

    const sidebarPath = join(extensionDir, manifest.sidebar_action.default_panel)
    expect(existsSync(sidebarPath)).toBe(true)
    const sidebarHtml = readFileSync(sidebarPath, "utf-8")
    expect(sidebarHtml).toContain("sidebar.css")
    expect(sidebarHtml).toContain("sidebar.js")

    const popupPath = join(extensionDir, manifest.action.default_popup)
    expect(existsSync(popupPath)).toBe(true)
    const popupHtml = readFileSync(popupPath, "utf-8")
    expect(popupHtml).toContain("popup.js")
    expect(popupHtml).toContain("popup.css")

    for (const bgScript of manifest.background.scripts) {
      const bgPath = join(extensionDir, bgScript)
      expect(existsSync(bgPath)).toBe(true)
      const bgContent = readFileSync(bgPath, "utf-8")
      expect(bgContent.length).toBeGreaterThan(0)
    }

    // Icon validation
    const iconPath = join(extensionDir, "icon.svg")
    expect(existsSync(iconPath)).toBe(true)
    const iconContent = readFileSync(iconPath, "utf-8")
    expect(iconContent).toContain("<svg")
    expect(iconContent).toContain("#02080b")
    expect(iconContent).toContain("#00e5ff")

    // CSS styling tokens validation (Sculk theme)
    const cssPath = join(extensionDir, "sidebar.css")
    expect(existsSync(cssPath)).toBe(true)
    const cssContent = readFileSync(cssPath, "utf-8")
    expect(cssContent).toContain("--v2-bg-base")
    expect(cssContent).toContain("--v2-text-base")
    expect(cssContent).toContain("--sculk-void")
    expect(cssContent).toContain("--sculk-cyan")
    expect(cssContent).toContain("--sculk-glow")

    const popupCssPath = join(extensionDir, "popup.css")
    expect(existsSync(popupCssPath)).toBe(true)
  })
})
