import { expect, test } from "bun:test"
import { mcpMayStart } from "../src/mcp/disabled"

test("the central gate is fail-closed and explicit OFF wins over global ON", () => {
  for (const value of [undefined, "", "0", "false", "true"]) {
    expect(mcpMayStart({}, { ORCHESTRA_MCP: value })).toBe(false)
    expect(mcpMayStart({ disabled: true }, { ORCHESTRA_MCP: value })).toBe(false)
  }
  expect(mcpMayStart({}, { ORCHESTRA_MCP: "1" })).toBe(true)
  expect(mcpMayStart({ disabled: false }, { ORCHESTRA_MCP: "1" })).toBe(true)
  expect(mcpMayStart({ disabled: true }, { ORCHESTRA_MCP: "1" })).toBe(false)
})
