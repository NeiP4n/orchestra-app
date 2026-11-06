import { describe, expect, test } from "bun:test"
import { isFilesystemServerCommand, localSpawnArgs } from "../src/mcp/client"

// Upstream servers v2.3.0: the filesystem server takes --read-only and serves
// only the tools that cannot change anything. The client passes the flag
// through only for that server, and only when the operator opted in.
describe("isFilesystemServerCommand", () => {
  test("recognizes the official filesystem server in its launch spellings", () => {
    expect(isFilesystemServerCommand(["npx", "-y", "@modelcontextprotocol/server-filesystem", "/data"])).toBe(true)
    expect(isFilesystemServerCommand(["bunx", "@modelcontextprotocol/server-filesystem", "/data"])).toBe(true)
    expect(isFilesystemServerCommand(["node", "/usr/lib/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js"])).toBe(
      true,
    )
    expect(isFilesystemServerCommand(["mcp-server-filesystem", "--read-only", "/data"])).toBe(true)
    expect(isFilesystemServerCommand(["/opt/bin/mcp-server-filesystem", "/data"])).toBe(true)
  })

  test("does not mistake other servers for the filesystem server", () => {
    expect(isFilesystemServerCommand(["npx", "-y", "@modelcontextprotocol/server-fetch"])).toBe(false)
    expect(isFilesystemServerCommand(["npx", "-y", "@modelcontextprotocol/server-git", "/repo"])).toBe(false)
    expect(isFilesystemServerCommand(["node", "server.js"])).toBe(false)
    expect(isFilesystemServerCommand([])).toBe(false)
  })
})

describe("localSpawnArgs", () => {
  const filesystem = (readOnly?: boolean) => ({
    type: "local" as const,
    command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/data"],
    ...(readOnly === undefined ? {} : { readOnly }),
  })
  const other = (readOnly?: boolean) => ({
    type: "local" as const,
    command: ["npx", "-y", "@modelcontextprotocol/server-fetch"],
    ...(readOnly === undefined ? {} : { readOnly }),
  })

  test("appends --read-only for a filesystem server only when opted in", () => {
    expect(localSpawnArgs(filesystem(true))).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/data",
      "--read-only",
    ])
    // Off by default: no flag without the opt-in, and never for other servers.
    expect(localSpawnArgs(filesystem())).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/data"])
    expect(localSpawnArgs(filesystem(false))).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/data"])
    expect(localSpawnArgs(other(true))).toEqual(["-y", "@modelcontextprotocol/server-fetch"])
  })

  test("never duplicates a flag the operator already passed", () => {
    expect(
      localSpawnArgs({
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "--read-only", "/data"],
        readOnly: true,
      }),
    ).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "--read-only", "/data"])
  })
})
