import { test, expect } from "bun:test"
import { BrowserWatcherLifetime } from "@orchestra/core/browser/watcher-lifetime"

test("last paused/deleted observer is released, enabled sibling retains it, other pages do not", async () => {
  const stopped: string[] = []
  const input = {
    sessionID: "browser1",
    projectID: "project1",
    directory: "C:\\Work\\Project",
    sessions: [{ id: "browser1", name: "Test", projectID: "project1", project: "c:\\work\\project" }],
    stop: async (id: string) => {
      stopped.push(id)
    },
  }
  const sibling = { enabled: true, kind: "browser", spec: "browser1" }
  expect(await BrowserWatcherLifetime.release({ ...input, triggers: [sibling] })).toBe(false)
  expect(stopped).toEqual([])
  expect(
    await BrowserWatcherLifetime.release({
      ...input,
      triggers: [
        { ...sibling, enabled: false },
        { ...sibling, spec: "browser2" },
      ],
    }),
  ).toBe(true)
  expect(stopped).toEqual(["browser1"])
  expect(await BrowserWatcherLifetime.release({ ...input, triggers: [] })).toBe(true)
})
test("missing/foreign/legacy registry bindings cannot stop another project's watcher", async () => {
  let count = 0
  const input = {
    sessionID: "browser1",
    projectID: "project1",
    directory: "/workspace/a",
    triggers: [],
    stop: async () => {
      count++
    },
  }
  for (const sessions of [
    [],
    [{ id: "browser1", name: "Foreign", projectID: "project2", project: "/workspace/a" }],
    [{ id: "browser1", name: "Legacy", project: "/workspace/a" }],
    [{ id: "browser1", name: "Wrongpath", projectID: "project1", project: "/workspace/b" }],
  ]) {
    expect(await BrowserWatcherLifetime.release({ ...input, sessions })).toBe(false)
  }
  expect(count).toBe(0)
})
