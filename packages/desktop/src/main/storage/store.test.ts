import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createSettingsStore } from "./store"

const dir = () => mkdtempSync(path.join(tmpdir(), "opencode-settings-"))

describe("settings store", () => {
  test("reads the tab-indented file electron-store wrote and rewrites it in the same shape", () => {
    const file = path.join(dir(), "opencode.settings")
    writeFileSync(file, JSON.stringify({ windowIds: ["a"], backgroundColor: "#121212" }, null, "\t"))
    const store = createSettingsStore(file)
    expect(store.get("windowIds")).toEqual(["a"])
    store.set("backgroundColor", "#ffffff")
    expect(readFileSync(file, "utf8")).toBe(
      JSON.stringify({ windowIds: ["a"], backgroundColor: "#ffffff" }, null, "\t"),
    )
    expect(createSettingsStore(file).get("backgroundColor")).toBe("#ffffff")
  })

  test("starts empty without a file, creates it on the first write, and refuses undefined", () => {
    const file = path.join(dir(), "nested", "opencode.updater")
    const store = createSettingsStore(file)
    expect(store.get("ready")).toBeUndefined()
    expect(existsSync(file)).toBe(false)
    store.set("ready", { version: "1.0.0" })
    // Like electron-store, undefined is refused instead of treated as a delete.
    expect(() => store.set("ready", undefined)).toThrow(TypeError)
    expect(store.get("ready")).toEqual({ version: "1.0.0" })
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ready: { version: "1.0.0" } })
    store.delete("ready")
    expect(store.get("ready")).toBeUndefined()
    expect(readFileSync(file, "utf8")).toBe("{}")
  })

  test("sets an unreadable file aside instead of failing", () => {
    const file = path.join(dir(), "opencode.settings")
    writeFileSync(file, "{ not json")
    const store = createSettingsStore(file)
    expect(store.get("anything")).toBeUndefined()
    expect(existsSync(`${file}.corrupt`)).toBe(true)
    store.set("firstLaunchOnboardingComplete", true)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ firstLaunchOnboardingComplete: true })
  })

  test("falls back to legacy settings store when modern store does not exist", () => {
    const d = dir()
    const legacyFile = path.join(d, "opencode.settings")
    const modernFile = path.join(d, "orchestra.settings")
    writeFileSync(legacyFile, JSON.stringify({ windowIds: ["win-legacy"], backgroundColor: "#000000" }, null, "\t"))

    const store = createSettingsStore(modernFile, legacyFile)
    expect(store.get("windowIds")).toEqual(["win-legacy"])
    expect(store.get("backgroundColor")).toBe("#000000")

    // Writing persists to modernFile, leaving legacy intact
    store.set("backgroundColor", "#111111")
    expect(existsSync(modernFile)).toBe(true)
    expect(JSON.parse(readFileSync(modernFile, "utf8"))).toEqual({
      windowIds: ["win-legacy"],
      backgroundColor: "#111111",
    })
    expect(JSON.parse(readFileSync(legacyFile, "utf8")).backgroundColor).toBe("#000000")
  })
})
