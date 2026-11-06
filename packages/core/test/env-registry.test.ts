import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { EnvRegistry } from "@orchestra/core/env-registry"

const REPO_ROOT = path.join(import.meta.dir, "..", "..", "..")
const REGISTRY_FILE = path.join(REPO_ROOT, "packages/core/src/env-registry.ts")

const readNames = (text: string): Set<string> => {
  // Build-time defines (import.meta.env) are not runtime environment reads.
  const cleaned = text.replace(/import\.meta\.env\.[A-Za-z0-9_]+/g, "")
  const names = new Set<string>()
  for (const pattern of [
    /process\.env\.(ORCHESTRA_[A-Z0-9_]+)/g,
    /process\.env\[["'](ORCHESTRA_[A-Z0-9_]+)["']\]/g,
    /\.env\.(ORCHESTRA_[A-Z0-9_]+)/g,
    /(?<![A-Za-z0-9_$.])env\.(ORCHESTRA_[A-Z0-9_]+)/g,
  ]) {
    for (const match of cleaned.matchAll(pattern)) {
      if (match[1]) names.add(match[1])
    }
  }
  return names
}

const collectSources = async (): Promise<ReadonlyArray<{ readonly file: string; readonly text: string }>> => {
  const packages = await readdir(path.join(REPO_ROOT, "packages"), { withFileTypes: true })
  const sources: Array<{ file: string; text: string }> = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (/\.(ts|tsx)$/.test(entry.name) && full !== REGISTRY_FILE)
        sources.push({ file: full, text: await readFile(full, "utf8") })
    }
  }
  for (const pkg of packages) {
    if (!pkg.isDirectory()) continue
    const src = path.join(REPO_ROOT, "packages", pkg.name, "src")
    await walk(src).catch(() => undefined)
  }
  return sources
}

const sources = await collectSources()

describe("environment registry (arch3 №10)", () => {
  test("every ORCHESTRA_* variable read in source is registered", () => {
    const read = new Set<string>()
    for (const source of sources) for (const name of readNames(source.text)) read.add(name)
    const missing = [...read].filter((name) => !(name in EnvRegistry.ENV_REGISTRY)).sort()
    expect(missing).toEqual([])
  })

  test("every registered variable is read or set somewhere in source", () => {
    const joined = sources.map((source) => source.text).join("\n")
    const stale = Object.entries(EnvRegistry.ENV_REGISTRY)
      .filter(([, entry]) => entry.legacy !== true)
      .map(([name]) => name)
      .filter((name) => !joined.includes(name))
      .sort()
    expect(stale).toEqual([])
  })

  test("registry keys are sorted and every entry has a purpose", () => {
    const keys = Object.keys(EnvRegistry.ENV_REGISTRY)
    expect(keys).toEqual([...keys].sort())
    for (const [name, entry] of Object.entries(EnvRegistry.ENV_REGISTRY)) {
      expect(entry.purpose.trim().length, name).toBeGreaterThan(0)
    }
  })
})
