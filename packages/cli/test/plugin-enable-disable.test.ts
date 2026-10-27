import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { enablePluginConfig, matches } from "../src/commands/handlers/plugin/enable"
import { disablePluginConfig } from "../src/commands/handlers/plugin/disable"
import { removePluginConfig } from "../src/commands/handlers/plugin/remove"

describe("plugin enable/disable/remove config handlers", () => {
  it("matches target correctly across formats", () => {
    expect(matches("opencode-antigravity-auth", "opencode-antigravity-auth")).toBe(true)
    expect(matches("-opencode-antigravity-auth", "opencode-antigravity-auth")).toBe(true)
    expect(matches("C:/some/path/node_modules/opencode-antigravity-auth", "opencode-antigravity-auth")).toBe(true)
    expect(matches("-C:/some/path/node_modules/opencode-antigravity-auth", "opencode-antigravity-auth")).toBe(true)
    expect(matches({ package: "opencode-antigravity-auth" }, "opencode-antigravity-auth")).toBe(true)
    expect(matches({ package: "-opencode-antigravity-auth" }, "opencode-antigravity-auth")).toBe(true)
    expect(matches("other-plugin", "opencode-antigravity-auth")).toBe(false)
  })

  it("disables an active configured plugin", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plugin-test-"))
    const configPath = path.join(dir, "orchestra.jsonc")
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: [
            "opencode-claude-auth",
            "C:/modules/opencode-antigravity-auth",
          ],
        }, null, 2),
      )

      const changed = await disablePluginConfig(configPath, "opencode-antigravity-auth")
      expect(changed).toBe(true)

      const content = JSON.parse(await readFile(configPath, "utf8"))
      expect(content.plugins).toEqual([
        "opencode-claude-auth",
        "-C:/modules/opencode-antigravity-auth",
      ])

      // Disabling again should be a no-op
      const changedAgain = await disablePluginConfig(configPath, "opencode-antigravity-auth")
      expect(changedAgain).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("enables a disabled plugin", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plugin-test-"))
    const configPath = path.join(dir, "orchestra.jsonc")
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: [
            "opencode-claude-auth",
            "-C:/modules/opencode-antigravity-auth",
          ],
        }, null, 2),
      )

      const changed = await enablePluginConfig(configPath, "opencode-antigravity-auth")
      expect(changed).toBe(true)

      const content = JSON.parse(await readFile(configPath, "utf8"))
      expect(content.plugins).toEqual([
        "opencode-claude-auth",
        "C:/modules/opencode-antigravity-auth",
      ])

      // Enabling again should be a no-op
      const changedAgain = await enablePluginConfig(configPath, "opencode-antigravity-auth")
      expect(changedAgain).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("removes a configured plugin whether enabled or disabled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plugin-test-"))
    const configPath = path.join(dir, "orchestra.jsonc")
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: [
            "opencode-claude-auth",
            "-C:/modules/opencode-antigravity-auth",
          ],
        }, null, 2),
      )

      const changed = await removePluginConfig(configPath, "opencode-antigravity-auth")
      expect(changed).toBe(true)

      const content = JSON.parse(await readFile(configPath, "utf8"))
      expect(content.plugins).toEqual([
        "opencode-claude-auth",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("adds -target when disabling an unconfigured plugin", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plugin-test-"))
    const configPath = path.join(dir, "orchestra.jsonc")
    try {
      await writeFile(configPath, JSON.stringify({ plugins: ["builtin-a"] }, null, 2))

      const changed = await disablePluginConfig(configPath, "discovered-plugin")
      expect(changed).toBe(true)

      const content = JSON.parse(await readFile(configPath, "utf8"))
      expect(content.plugins).toEqual(["builtin-a", "-discovered-plugin"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
