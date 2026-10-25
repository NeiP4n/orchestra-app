import { expect, test } from "bun:test"
import { hasGithubDirectory } from "../src/util/github"

test("finds .github however the server terminates directory paths", () => {
  expect(hasGithubDirectory([{ path: ".github\\", type: "directory" }])).toBe(true)
  expect(hasGithubDirectory([{ path: ".github/", type: "directory" }])).toBe(true)
  expect(hasGithubDirectory([{ path: ".github", type: "directory" }])).toBe(true)
})

test("ignores a .github file and other directories", () => {
  expect(hasGithubDirectory([{ path: ".github", type: "file" }])).toBe(false)
  expect(hasGithubDirectory([{ path: ".git\\", type: "directory" }, { path: "src/", type: "directory" }])).toBe(false)
})
