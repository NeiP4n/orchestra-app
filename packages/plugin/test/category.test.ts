import { describe, expect, it } from "bun:test"
import { categorizePlugin, comparePluginCategories, PLUGIN_CATEGORIES } from "../src/category.js"

describe("categorizePlugin", () => {
  it("categorizes auth & identity plugins", () => {
    expect(categorizePlugin("opencode-antigravity-auth")).toBe("Auth & Identity")
    expect(categorizePlugin("@orchestra/plugin-antigravity-auth")).toBe("Auth & Identity")
    expect(categorizePlugin("orchestra.identity")).toBe("Auth & Identity")
    expect(categorizePlugin(undefined, "opencode-claude-auth")).toBe("Auth & Identity")
    expect(categorizePlugin("auth-manager")).toBe("Auth & Identity")
    expect(categorizePlugin("credential-store")).toBe("Auth & Identity")
  })

  it("categorizes provider & model plugins", () => {
    expect(categorizePlugin("opencode.provider.openai")).toBe("Providers & Models")
    expect(categorizePlugin("opencode.provider.freebuff")).toBe("Providers & Models")
    expect(categorizePlugin("opencode.provider.azure")).toBe("Providers & Models")
    expect(categorizePlugin("models-dev")).toBe("Providers & Models")
    expect(categorizePlugin("zen-models")).toBe("Providers & Models")
    expect(categorizePlugin("chatgpt-plugin")).toBe("Providers & Models")
    expect(categorizePlugin(undefined, "modal-provider")).toBe("Providers & Models")
  })

  it("categorizes skills & knowledge plugins", () => {
    expect(categorizePlugin("orchestra.tool.skill")).toBe("Skills & Knowledge")
    expect(categorizePlugin("skill-catalog")).toBe("Skills & Knowledge")
    expect(categorizePlugin("skill-marketplace")).toBe("Skills & Knowledge")
    expect(categorizePlugin("research-tool")).toBe("Skills & Knowledge")
    expect(categorizePlugin("idea-bank")).toBe("Skills & Knowledge")
    expect(categorizePlugin("memory-store")).toBe("Skills & Knowledge")
    expect(categorizePlugin("note-tool")).toBe("Skills & Knowledge")
  })

  it("categorizes UI & rendering plugins", () => {
    expect(categorizePlugin("tui-sidebar")).toBe("UI & Rendering")
    expect(categorizePlugin("merman")).toBe("UI & Rendering")
    expect(categorizePlugin("latex")).toBe("UI & Rendering")
    expect(categorizePlugin("theme-dracula")).toBe("UI & Rendering")
    expect(categorizePlugin("formatter-prettier")).toBe("UI & Rendering")
  })

  it("categorizes tools & automation plugins", () => {
    expect(categorizePlugin("browser", "@orchestra/plugin-browser")).toBe("Tools & Automation")
    expect(categorizePlugin("desktop-control")).toBe("Tools & Automation")
    expect(categorizePlugin("playtest")).toBe("Tools & Automation")
    expect(categorizePlugin("mcp-forge")).toBe("Tools & Automation")
    expect(categorizePlugin("workspace-forge")).toBe("Tools & Automation")
    expect(categorizePlugin("plugin-forge")).toBe("Tools & Automation")
    expect(categorizePlugin("tool-patch")).toBe("Tools & Automation")
    expect(categorizePlugin("websearch")).toBe("Tools & Automation")
  })

  it("categorizes system & workspace plugins", () => {
    expect(categorizePlugin("opencode.vcs.git")).toBe("System & Workspace")
    expect(categorizePlugin("vcs.hg")).toBe("System & Workspace")
    expect(categorizePlugin("sandbox")).toBe("System & Workspace")
    expect(categorizePlugin("location-watcher")).toBe("System & Workspace")
    expect(categorizePlugin("policy-enforcer")).toBe("System & Workspace")
    expect(categorizePlugin("compaction")).toBe("System & Workspace")
    expect(categorizePlugin("warming")).toBe("System & Workspace")
  })

  it("falls back to Other for unknown plugins", () => {
    expect(categorizePlugin("custom-analytics-beacon")).toBe("Other")
    expect(categorizePlugin(undefined, "/opt/custom/plugin.js")).toBe("Other")
  })

  it("orders categories canonically", () => {
    const list = ["Other", "System & Workspace", "Auth & Identity", "Providers & Models"] as const
    const sorted = [...list].sort(comparePluginCategories)
    expect(sorted).toEqual(["Auth & Identity", "Providers & Models", "System & Workspace", "Other"])
  })
})
