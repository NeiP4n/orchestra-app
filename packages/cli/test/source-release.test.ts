import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { SourceRelease } from "../src/services/source-release"

describe("SourceRelease capability guard", () => {
  test("the Bun test graph loads the real bun module, not the node shim", async () => {
    // vite.node.config.ts aliases "bun" to a throwing shim for the node build only.
    // If that alias ever leaks into the Bun graph, this call throws.
    expect(await $`printf source-release-ok`.text()).toBe("source-release-ok")
  })

  test("supported() requires both a non-node artifact and the Bun runtime", () => {
    expect(SourceRelease.supported("cli", true)).toBe(true)
    expect(SourceRelease.supported("cli-node", true)).toBe(false)
    expect(SourceRelease.supported("cli", false)).toBe(false)
    expect(SourceRelease.supported("cli-node", false)).toBe(false)
  })

  test("the unsupported message names the Bun source installation without git or network advice", () => {
    expect(SourceRelease.UNSUPPORTED_MESSAGE).toContain("Bun source installation")
    expect(SourceRelease.UNSUPPORTED_MESSAGE).not.toContain("git ")
    expect(SourceRelease.UNSUPPORTED_MESSAGE.toLowerCase()).not.toContain("internet")
    expect(SourceRelease.UNSUPPORTED_MESSAGE.toLowerCase()).not.toContain("network")
  })
})
