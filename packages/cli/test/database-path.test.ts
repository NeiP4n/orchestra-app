import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { databasePath } from "../src/database-path"

describe("databasePath", () => {
  const tmpDir = path.resolve(import.meta.dir, "../../..", "node_modules/.tmp/database-path-test")

  test("honors ORCHESTRA_DB environment variable", () => {
    const original = process.env.ORCHESTRA_DB
    try {
      process.env.ORCHESTRA_DB = ":memory:"
      expect(databasePath("/some/dir")).toBe(":memory:")

      process.env.ORCHESTRA_DB = "custom.db"
      expect(databasePath("/some/dir")).toBe(path.resolve("/some/dir", "custom.db"))
    } finally {
      if (original === undefined) {
        delete process.env.ORCHESTRA_DB
      }
      if (original !== undefined) {
        process.env.ORCHESTRA_DB = original
      }
    }
  })

  test("defaults to orchestra.db when channel db is disabled", () => {
    const originalDb = process.env.ORCHESTRA_DB
    const originalDisable = process.env.ORCHESTRA_DISABLE_CHANNEL_DB
    delete process.env.ORCHESTRA_DB
    process.env.ORCHESTRA_DISABLE_CHANNEL_DB = "1"
    try {
      const dataDir = path.join(tmpDir, "fresh-default")
      rmSync(dataDir, { recursive: true, force: true })
      mkdirSync(dataDir, { recursive: true })
      expect(databasePath(dataDir)).toBe(path.resolve(dataDir, "orchestra.db"))
    } finally {
      if (originalDb !== undefined) {
        process.env.ORCHESTRA_DB = originalDb
      }
      if (originalDisable === undefined) {
        delete process.env.ORCHESTRA_DISABLE_CHANNEL_DB
      }
      if (originalDisable !== undefined) {
        process.env.ORCHESTRA_DISABLE_CHANNEL_DB = originalDisable
      }
    }
  })

  test("migrates opencode.db to orchestra.db with wal and shm files", () => {
    const originalDb = process.env.ORCHESTRA_DB
    const originalDisable = process.env.ORCHESTRA_DISABLE_CHANNEL_DB
    delete process.env.ORCHESTRA_DB
    process.env.ORCHESTRA_DISABLE_CHANNEL_DB = "1"
    try {
      const dataDir = path.join(tmpDir, "migrate-default")
      rmSync(dataDir, { recursive: true, force: true })
      mkdirSync(dataDir, { recursive: true })

      writeFileSync(path.join(dataDir, "opencode.db"), "legacy-db-content")
      writeFileSync(path.join(dataDir, "opencode.db-wal"), "wal-content")
      writeFileSync(path.join(dataDir, "opencode.db-shm"), "shm-content")

      const result = databasePath(dataDir)
      expect(result).toBe(path.resolve(dataDir, "orchestra.db"))
      expect(existsSync(result)).toBe(true)
      expect(readFileSync(result, "utf8")).toBe("legacy-db-content")
      expect(existsSync(`${result}-wal`)).toBe(true)
      expect(readFileSync(`${result}-wal`, "utf8")).toBe("wal-content")
      expect(existsSync(`${result}-shm`)).toBe(true)
      expect(readFileSync(`${result}-shm`, "utf8")).toBe("shm-content")

      // Original opencode.db is preserved for safety
      expect(existsSync(path.join(dataDir, "opencode.db"))).toBe(true)
    } finally {
      if (originalDb !== undefined) {
        process.env.ORCHESTRA_DB = originalDb
      }
      if (originalDisable === undefined) {
        delete process.env.ORCHESTRA_DISABLE_CHANNEL_DB
      }
      if (originalDisable !== undefined) {
        process.env.ORCHESTRA_DISABLE_CHANNEL_DB = originalDisable
      }
    }
  })

  test("migrates base opencode.db to channel db when channel db does not exist", () => {
    const originalDb = process.env.ORCHESTRA_DB
    const originalDisable = process.env.ORCHESTRA_DISABLE_CHANNEL_DB
    delete process.env.ORCHESTRA_DB
    delete process.env.ORCHESTRA_DISABLE_CHANNEL_DB
    try {
      const dataDir = path.join(tmpDir, "migrate-channel")
      rmSync(dataDir, { recursive: true, force: true })
      mkdirSync(dataDir, { recursive: true })

      writeFileSync(path.join(dataDir, "opencode.db"), "legacy-base-content")

      const result = databasePath(dataDir)
      expect(result).toBe(path.resolve(dataDir, "orchestra-local.db"))
      expect(existsSync(result)).toBe(true)
      expect(readFileSync(result, "utf8")).toBe("legacy-base-content")
    } finally {
      if (originalDb !== undefined) {
        process.env.ORCHESTRA_DB = originalDb
      }
      if (originalDisable !== undefined) {
        process.env.ORCHESTRA_DISABLE_CHANNEL_DB = originalDisable
      }
    }
  })

  test("does not overwrite existing orchestra.db", () => {
    const originalDb = process.env.ORCHESTRA_DB
    const originalDisable = process.env.ORCHESTRA_DISABLE_CHANNEL_DB
    delete process.env.ORCHESTRA_DB
    process.env.ORCHESTRA_DISABLE_CHANNEL_DB = "1"
    try {
      const dataDir = path.join(tmpDir, "existing-default")
      rmSync(dataDir, { recursive: true, force: true })
      mkdirSync(dataDir, { recursive: true })

      writeFileSync(path.join(dataDir, "orchestra.db"), "new-content")
      writeFileSync(path.join(dataDir, "opencode.db"), "old-content")

      const result = databasePath(dataDir)
      expect(result).toBe(path.resolve(dataDir, "orchestra.db"))
      expect(readFileSync(result, "utf8")).toBe("new-content")
    } finally {
      if (originalDb !== undefined) {
        process.env.ORCHESTRA_DB = originalDb
      }
      if (originalDisable === undefined) {
        delete process.env.ORCHESTRA_DISABLE_CHANNEL_DB
      }
      if (originalDisable !== undefined) {
        process.env.ORCHESTRA_DISABLE_CHANNEL_DB = originalDisable
      }
    }
  })
})
