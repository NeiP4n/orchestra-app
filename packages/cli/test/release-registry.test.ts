import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  cliUpdateManifest,
  compareVersions,
  entryForVersion,
  latestEntry,
  parseRegistry,
  readRegistryFile,
  type ReleaseEntry,
} from "../src/services/release-registry"

const entry = (overrides: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  version: "1.0.0",
  commit: "6cb819619d708dae3577af8d7dfb0762e47c3c2a",
  date: "2026-11-06",
  channel: "latest",
  notes: "First release.",
  ...overrides,
})

test("a well-formed registry parses", () => {
  expect(parseRegistry({ releases: [entry()] })).toEqual([entry()])
  expect(parseRegistry({ releases: [] })).toEqual([])
})

test("malformed registries are rejected, not partially read", () => {
  expect(parseRegistry(undefined)).toBeUndefined()
  expect(parseRegistry([])).toBeUndefined()
  expect(parseRegistry({})).toBeUndefined()
  expect(parseRegistry({ releases: "1.0.0" })).toBeUndefined()
  expect(parseRegistry({ releases: [entry({ version: "1.0" })] })).toBeUndefined()
  expect(parseRegistry({ releases: [entry({ version: "v1.0.0" })] })).toBeUndefined()
  expect(parseRegistry({ releases: [entry({ commit: "6cb8196" })] })).toBeUndefined()
  expect(parseRegistry({ releases: [entry({ commit: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" })] })).toBeUndefined()
  expect(parseRegistry({ releases: [entry({ date: "06-11-2026" })] })).toBeUndefined()
  expect(parseRegistry({ releases: [entry({ channel: "dev" as "latest" })] })).toBeUndefined()
  expect(parseRegistry({ releases: [entry({ notes: "  " })] })).toBeUndefined()
  expect(parseRegistry({ releases: [entry({ yanked: "yes" as unknown as boolean })] })).toBeUndefined()
  expect(parseRegistry({ releases: [entry(), entry()] })).toBeUndefined()
})

test("the newest non-yanked entry wins per channel", () => {
  const entries = [
    entry({ version: "1.9.0" }),
    entry({ version: "1.10.0" }),
    entry({ version: "1.11.0", yanked: true }),
    entry({ version: "1.5.0-beta.1", channel: "beta" }),
  ]
  expect(latestEntry(entries)?.version).toBe("1.10.0")
  expect(latestEntry(entries, "beta")?.version).toBe("1.5.0-beta.1")
  expect(latestEntry([])).toBeUndefined()
  expect(latestEntry([entry({ yanked: true })])).toBeUndefined()
})

test("versions compare numerically, not lexicographically", () => {
  expect(compareVersions("1.9.0", "1.10.0")).toBe(-1)
  expect(compareVersions("1.10.0", "1.9.0")).toBe(1)
  expect(compareVersions("1.10.0", "1.10.0")).toBe(0)
})

test("an entry is found by exact version", () => {
  const entries = [entry(), entry({ version: "1.1.0" })]
  expect(entryForVersion(entries, "1.1.0")?.version).toBe("1.1.0")
  expect(entryForVersion(entries, "1.2.0")).toBeUndefined()
})

test("the registry file on disk reads and rejects bad JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orchestra-registry-"))
  try {
    const file = path.join(root, "releases.json")
    await writeFile(file, JSON.stringify({ releases: [entry()] }))
    expect(readRegistryFile(file)).toEqual([entry()])
    await writeFile(file, "{not json")
    expect(readRegistryFile(file)).toBeUndefined()
    expect(readRegistryFile(path.join(root, "missing.json"))).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the CLI update manifest names the npm package", () => {
  expect(cliUpdateManifest(entry({ version: "1.1.0" }))).toEqual({
    version: "1.1.0",
    metadata: { package: "@orchestra/cli" },
  })
})
