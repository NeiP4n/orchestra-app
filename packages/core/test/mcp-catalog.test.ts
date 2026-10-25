import { describe, expect, test } from "bun:test"
import type { ServerConfig } from "@orchestra/schema/mcp"
import { all, forPlatform, missing } from "../src/mcp/catalog"

describe("MCP registry catalog", () => {
  test("includes the REA Anything launcher", () => {
    const rea = all.find((entry) => entry.id === "rea-anything")

    expect(rea).toMatchObject({
      id: "rea-anything",
      name: "REA — Reverse Engineer Anything",
      runtime: "npx",
      config: {
        type: "local",
        command: ["npx", "-y", "rea-agents@latest", "mcp"],
      },
    })
    expect(rea?.description).toContain("reverse engineering")
  })

  test("REA is available on Linux, macOS, and Windows", () => {
    expect(forPlatform("win32").some((entry) => entry.id === "rea-anything")).toBe(true)
    expect(forPlatform("linux").some((entry) => entry.id === "rea-anything")).toBe(true)
    expect(forPlatform("darwin").some((entry) => entry.id === "rea-anything")).toBe(true)
  })

  test("names the keys a catalog server cannot start without", () => {
    const brave = all.find((entry) => entry.id === "brave-search")!.config
    const previous = process.env.BRAVE_API_KEY
    delete process.env.BRAVE_API_KEY
    try {
      expect(missing("brave-search", brave)).toEqual(["BRAVE_API_KEY"])
      expect(missing("brave-search", { ...brave, environment: { BRAVE_API_KEY: "k" } } as ServerConfig)).toEqual([])
      if (brave.type === "local")
        expect(missing("brave-search", { ...brave, command: [...brave.command, "--brave-api-key=k"] })).toEqual([])
      expect(missing("my-own-server", brave)).toEqual([])
    } finally {
      if (previous !== undefined) process.env.BRAVE_API_KEY = previous
    }
  })
})
