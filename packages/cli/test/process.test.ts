import { expect, test } from "bun:test"
import { selfRootFrom } from "../src/util/process"

test("selfRootFrom finds the checkout root for a source CLI entrypoint", () => {
  expect(selfRootFrom("/home/user/orchestra-app/packages/cli/src/index.ts")).toBe("/home/user/orchestra-app")
  expect(selfRootFrom("/home/user/orchestra-app/packages/cli/src/index.js")).toBe("/home/user/orchestra-app")
})

test("selfRootFrom ignores installed binaries and other packages", () => {
  expect(selfRootFrom("/usr/local/bin/orchestra")).toBe(undefined)
  expect(selfRootFrom("/home/user/orchestra-app/packages/tui/src/index.ts")).toBe(undefined)
  expect(selfRootFrom("/home/user/orchestra-app/packages/cli/src")).toBe(undefined)
  expect(selfRootFrom(undefined)).toBe(undefined)
})
