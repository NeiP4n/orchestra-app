import { describe, expect, test } from "bun:test"
import { requireAntigravityClientSecret as coreSecret } from "../packages/core/src/plugin/provider/google-antigravity-env"
import { requireAntigravityClientSecret as pluginSecret } from "../packages/plugin-antigravity-auth/src/constants"
import { requireAntigravityClientSecret as legacySecret } from "../packages/plugin-antigravity-auth/dist/constants.js"
import { requireAntigravityClientSecret as builtSecret } from "../packages/plugin-antigravity-auth/dist/src/constants.js"

const root = new URL("..", import.meta.url).pathname
const fake = "test-only-placeholder"
for (const [name, read] of Object.entries({ coreSecret, pluginSecret, legacySecret, builtSecret })) {
  describe(name, () => {
    test("requires configuration, without a built-in fallback", () => {
      expect(() => read({})).toThrow("ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET")
      expect(() => read({ ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET: "  " })).toThrow("ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET")
    })
    test("uses the provided value unchanged", () => {
      expect(read({ ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET: fake })).toBe(fake)
    })
  })
}

describe("startup guards", () => {
  test("daemon stops before starting work without server password", () => {
    const env = { ...process.env }
    delete env.ORCHESTRA_PASSWORD
    const child = Bun.spawnSync([process.execPath, "script/autonomous-council-daemon.ts"], { cwd: root, env })
    expect(child.exitCode).not.toBe(0)
    expect(child.stderr.toString()).toContain("Не задана ORCHESTRA_PASSWORD")
  })
  test("quota script stops before reading accounts or sending requests without OAuth secret", () => {
    const env = { ...process.env }
    delete env.ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET
    const child = Bun.spawnSync([process.execPath, "packages/plugin-antigravity-auth/scripts/check-quota.mjs"], { cwd: root, env })
    expect(child.exitCode).not.toBe(0)
    expect(child.stderr.toString()).toContain("Не задана ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET")
  })
  test("imports do not require OAuth configuration", () => {
    const env = { ...process.env }
    delete env.ORCHESTRA_ANTIGRAVITY_CLIENT_SECRET
    const child = Bun.spawnSync([process.execPath, "-e", 'await import("./packages/plugin-antigravity-auth/src/constants.ts")'], { cwd: root, env })
    expect(child.exitCode).toBe(0)
  })
})
