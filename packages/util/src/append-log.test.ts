import { expect, test } from "bun:test"
import { closeSync, writeSync, mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, statSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { appendLog, openRotatingLog } from "./append-log"

test("bounded log appends and rotates actual data through an open descriptor", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "append-log-")),
    file = path.join(root, "events.log")
  try {
    appendLog(file, "first\n", 8)
    appendLog(file, "second\n", 8)
    expect(readFileSync(file, "utf8")).toBe("first\nsecond\n")
    appendLog(file, "third\n", 8)
    expect(readFileSync(file + ".1", "utf8")).toBe("first\nsecond\n")
    expect(readFileSync(file, "utf8")).toBe("third\n")
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test("a substituted symlink is refused rather than modifying its target", () => {
  if (process.platform === "win32") return
  const root = mkdtempSync(path.join(os.tmpdir(), "append-log-link-")),
    target = path.join(root, "target"),
    file = path.join(root, "events.log")
  try {
    writeFileSync(target, "untouched")
    symlinkSync(target, file)
    expect(() => appendLog(file, "changed", 3)).toThrow()
    expect(readFileSync(target, "utf8")).toBe("untouched")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a returned stderr descriptor keeps its rotation suffix and accepts child output", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stderr-log-")),
    file = path.join(root, "stderr.log")
  try {
    writeFileSync(file, "previous crash evidence")
    const fd = openRotatingLog(file, 4, ".old")
    try {
      writeSync(fd, "next launch")
    } finally {
      closeSync(fd)
    }
    expect(readFileSync(file + ".old", "utf8")).toBe("previous crash evidence")
    expect(readFileSync(file, "utf8")).toBe("next launch")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
