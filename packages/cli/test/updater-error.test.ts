import { expect, test } from "bun:test"
import { AppProcess } from "@orchestra/util/process"
import { errorDetail } from "../src/services/updater-error"

test("uses stderr from Bun shell errors instead of the generic exit message", () => {
  const error = Object.assign(new Error("Failed with exit code 1"), {
    stderr: Buffer.from("fatal: local changes would be overwritten\n"),
    stdout: Buffer.alloc(0),
  })
  expect(errorDetail(error)).toBe("fatal: local changes would be overwritten")
})

test("uses stdout when a failed command has no stderr", () => {
  const error = Object.assign(new Error("Failed with exit code 1"), {
    stderr: Buffer.alloc(0),
    stdout: Buffer.from("dependency resolution failed\n"),
  })
  expect(errorDetail(error)).toBe("dependency resolution failed")
})

test("keeps the existing AppProcess error formatting", () => {
  const error = new AppProcess.AppProcessError({
    command: "bun install",
    exitCode: 1,
    stderr: "registry denied access",
  })
  expect(errorDetail(error)).toBe("registry denied access")
})

test("falls back to the error message when a process supplied no output", () => {
  expect(errorDetail(new Error("Failed with exit code 1"))).toBe("Failed with exit code 1")
})
