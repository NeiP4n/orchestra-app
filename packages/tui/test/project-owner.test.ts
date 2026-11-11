import { expect, test } from "bun:test"
import { owningProject } from "../src/util/project-owner"

const work = { id: "work", directory: "/home/u/Work" }
const plugin = { id: "plugin", directory: "/home/u/Work/VsPlugin" }
const other = { id: "other", directory: "/home/u/Orchestra" }

test("nested projects: the most specific directory owns it", () => {
  expect(owningProject([work, plugin, other], "/home/u/Work/VsPlugin")?.id).toBe("plugin")
  expect(owningProject([plugin, work, other], "/home/u/Work/VsPlugin/src")?.id).toBe("plugin")
})

test("a directory in the parent only belongs to the parent", () => {
  expect(owningProject([work, plugin], "/home/u/Work/notes")?.id).toBe("work")
})

test("no project contains it", () => {
  expect(owningProject([work, plugin], "/home/u/Elsewhere")).toBeUndefined()
})
