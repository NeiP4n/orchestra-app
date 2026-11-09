import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { BrowserProvenance } from "@orchestra/core/browser/provenance"

test("browser task provenance fails closed and survives a fresh disk read", () => {
  const previous = process.env.ORCHESTRA_DATA_DIR
  const root = mkdtempSync(path.join(os.tmpdir(), "browser-provenance-"))
  process.env.ORCHESTRA_DATA_DIR = root
  try {
    expect(BrowserProvenance.read("worker")).toEqual({ mode: "unknown" })
    for (const action of ["click", "type", "eval", "open", "start", "assign", "sessions"])
      expect(BrowserProvenance.refusal(BrowserProvenance.read("worker"), action)).toContain("read-only")
    const record = { mode: "read-only" as const, triggerID: "t", browserSessionID: "b" }
    expect(BrowserProvenance.write("worker", record)).toBe(true)
    // No memory cache is consulted: each call independently parses the persisted file.
    expect(BrowserProvenance.read("worker")).toEqual(record)
    expect(BrowserProvenance.refusal(BrowserProvenance.read("worker"), "text", "other")).toContain("bound")
    expect(BrowserProvenance.refusal(BrowserProvenance.read("worker"), "text", "b")).toBeUndefined()
    const file = path.join(root, "browser-provenance", "worker.json")
    writeFileSync(file, "broken")
    expect(BrowserProvenance.read("worker")).toEqual({ mode: "unknown" })
    rmSync(file)
    expect(BrowserProvenance.read("worker")).toEqual({ mode: "unknown" })
    mkdirSync(file)
    expect(BrowserProvenance.read("worker")).toEqual({ mode: "unknown" })
    expect(BrowserProvenance.write("worker", { mode: "ordinary" })).toBe(false)
    expect(BrowserProvenance.refusal(BrowserProvenance.read("worker"), "click")).toBeDefined()
    rmSync(file, { recursive: true })
    expect(BrowserProvenance.write("worker", { mode: "ordinary" })).toBe(true)
    expect(BrowserProvenance.refusal(BrowserProvenance.read("worker"), "click")).toBeUndefined()
  } finally {
    if (previous === undefined) delete process.env.ORCHESTRA_DATA_DIR
    else process.env.ORCHESTRA_DATA_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})
