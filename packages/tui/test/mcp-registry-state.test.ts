import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Entry } from "@orchestra/schema/config"
import { mcpRegistryState, mcpRegistryToggle } from "../src/util/mcp-registry"
const decode = Schema.decodeUnknownSync(Entry)
const doc = (servers: unknown) =>
  decode({ type: "document", path: "/test/orchestra.jsonc", info: { mcp: { servers } } })
test("installation comes from config after restart, not live connection status or global MCP switch", () => {
  const disk = JSON.stringify([
    {
      type: "document",
      path: "/test/orchestra.jsonc",
      info: {
        mcp: {
          servers: {
            context7: { type: "local", command: ["npx", "example"] },
            sentry: { type: "remote", url: "https://example.com/mcp", disabled: true },
          },
        },
      },
    },
  ])
  const restored = JSON.parse(disk).map(decode)
  expect(mcpRegistryState(restored)).toEqual({ installed: ["context7", "sentry"], disabled: ["sentry"] })
})
test("nearest config wins without forgetting global installations", () => {
  expect(
    mcpRegistryState([
      doc({
        context7: { type: "local", command: ["npx"], disabled: true },
        sentry: { type: "remote", url: "https://example.com" },
      }),
      doc({ context7: { type: "local", command: ["npx"], disabled: false } }),
    ]),
  ).toEqual({ installed: ["context7", "sentry"], disabled: [] })
})

test("operator OFF/ON preserves an installed custom command rather than reinstalling defaults", () => {
  const entries = [doc({ context7: { type: "local", command: ["custom-context7", "--mode", "private"], disabled: true } })]
  expect(mcpRegistryToggle(entries, "context7", { type: "local", command: ["npx", "catalog-default"] })).toEqual({ type: "local", command: ["custom-context7", "--mode", "private"], disabled: false })
  expect(mcpRegistryToggle(entries, "context7", { type: "local", command: ["npx"], disabled: true })?.disabled).toBe(true)
  expect(mcpRegistryToggle([], "context7", { type: "local", command: ["npx"] })).toEqual({ type: "local", command: ["npx"] })
  expect(mcpRegistryToggle(entries, "context7", null)).toBeNull()
})
