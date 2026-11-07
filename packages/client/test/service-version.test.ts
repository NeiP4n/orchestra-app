import { expect, test } from "bun:test"
import { matchesVersion } from "../src/service-version"

test("a server from another commit of the same release matches", () => {
  expect(matchesVersion("1.0.0+a3727276a", { version: "1.0.0+deadbeef0" })).toBe(true)
  expect(matchesVersion("1.0.0", { version: "1.0.0+a3727276a" })).toBe(true)
  expect(matchesVersion("1.0.0+a3727276a", { version: "1.0.0" })).toBe(true)
})

test("a different release does not match", () => {
  expect(matchesVersion("1.0.0+a3727276a", { version: "1.0.1+deadbeef0" })).toBe(false)
  expect(matchesVersion("1.0.0", { version: "2.0.0" })).toBe(false)
  expect(matchesVersion("0.0.0-dev-1", { version: "0.0.0-dev-2" })).toBe(false)
})

test("versions without build metadata still compare exactly", () => {
  expect(matchesVersion("test", { version: "test" })).toBe(true)
  expect(matchesVersion("test", { version: "old" })).toBe(false)
  expect(matchesVersion("2.1.0-next.1", { version: "2.1.0-next.1" })).toBe(true)
})

test("an absent requirement matches everything and an absent version matches nothing", () => {
  expect(matchesVersion("1.0.0+a3727276a", {})).toBe(true)
  expect(matchesVersion(undefined, { version: "1.0.0" })).toBe(false)
  expect(matchesVersion(undefined, {})).toBe(true)
})

test("a predicate requirement is called with the full version", () => {
  expect(matchesVersion("1.0.0+a3727276a", { version: (version) => version.endsWith("+a3727276a") })).toBe(true)
  expect(matchesVersion("1.0.0+a3727276a", { version: (version) => version.startsWith("2.") })).toBe(false)
})
