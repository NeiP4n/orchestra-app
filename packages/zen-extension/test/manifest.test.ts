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

    // Permissions
    expect(manifest.permissions).toContain("activeTab")
    expect(manifest.permissions).toContain("contextMenus")
    expect(manifest.permissions).toContain("storage")

    // Host permissions for local daemon
    expect(manifest.host_permissions).toContain("http://127.0.0.1:*/*")
    expect(manifest.host_permissions).toContain("http://localhost:*/*")

    // Native Zen / Firefox sidebar_action
    expect(manifest.sidebar_action).toEqual({
      default_panel: "sidebar.html",
      default_title: "Orchestra",
    })

    // Action popup
    expect(manifest.action).toEqual({
      default_popup: "popup.html",
      default_title: "Orchestra Quick Action",
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

    for (const bgScript of manifest.background.scripts) {
      const bgPath = join(extensionDir, bgScript)
      expect(existsSync(bgPath)).toBe(true)
      const bgContent = readFileSync(bgPath, "utf-8")
      expect(bgContent.length).toBeGreaterThan(0)
    }

    const cssPath = join(extensionDir, "sidebar.css")
    expect(existsSync(cssPath)).toBe(true)
    const cssContent = readFileSync(cssPath, "utf-8")
    expect(cssContent).toContain("--v2-bg-base")
    expect(cssContent).toContain("--v2-text-base")
  })
})
