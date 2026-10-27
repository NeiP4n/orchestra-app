import { describe, expect, it } from "bun:test"
import type { PluginInfo } from "@orchestra/client"
import { format } from "../src/commands/handlers/plugin/list"

describe("plugin list format", () => {
  it("formats plugins grouped by category with headers", () => {
    const plugins: PluginInfo[] = [
      {
        id: "opencode-antigravity-auth",
        source: { type: "local", path: "packages/plugin-antigravity-auth" },
        features: { server: true },
        state: { status: "active" },
      },
      {
        id: "opencode.provider.openai",
        source: { type: "builtin" },
        features: { server: true },
        state: { status: "active" },
      },
      {
        id: "browser",
        source: { type: "local", path: "packages/plugin-browser" },
        features: { server: true },
        state: { status: "active" },
      },
      {
        id: "orchestra.tool.skill",
        source: { type: "builtin" },
        features: { server: true },
        state: { status: "active" },
      },
    ]

    const output = format(plugins, [], true, [])
    expect(output).toContain("[Auth & Identity]")
    expect(output).toContain("[Providers & Models]")
    expect(output).toContain("[Tools & Automation]")
    expect(output).toContain("[Skills & Knowledge]")
    expect(output).toContain("opencode-antigravity-auth")
    expect(output).toContain("opencode.provider.openai")
    expect(output).toContain("browser")
    expect(output).toContain("orchestra.tool.skill")
  })

  it("handles empty lists gracefully", () => {
    const output = format([], [], false, [])
    expect(output).toBe("")
  })

  it("includes disabled status correctly within its category", () => {
    const plugins: PluginInfo[] = [
      {
        id: "opencode-antigravity-auth",
        source: { type: "local", path: "packages/plugin-antigravity-auth" },
        features: { server: true },
        state: { status: "active" },
      },
    ]

    const output = format(plugins, [], false, ["opencode-antigravity-auth"])
    expect(output).toContain("[Auth & Identity]")
    expect(output).toContain("disabled")
  })
})
