import { expect, test } from "bun:test"
import { App } from "@orchestra/core/app"

test("preserves the explicit latest channel in the user agent", () => {
  expect(App.useragent(App.make({ name: "cli", version: "1.0.0", channel: "latest" }))).toBe(
    "orchestra/latest/1.0.0/cli",
  )
})

test("uses a version-only user agent for local and branch builds", () => {
  expect(App.useragent(App.make({ name: "cli", version: "1.0.0+abc123", channel: "lan-rooms" }))).toBe(
    "orchestra/1.0.0+abc123",
  )
  expect(App.useragent(App.make({ name: "cli", version: "1.0.0+abc123", channel: "local" }))).toBe(
    "orchestra/1.0.0+abc123",
  )
})
