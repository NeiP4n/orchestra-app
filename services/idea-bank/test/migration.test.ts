import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

const migrations = [
  "0001_init.sql",
  "0002_seed_content_hashes.sql",
  "0003_global_signal_counts.sql",
  "0004_unicode_search_text.sql",
] as const

const readMigration = (name: string) => readFile(new URL("../migrations/" + name, import.meta.url), "utf8")

describe("Global Idea Bank D1 migration chain", () => {
  it("applies every production migration in filename order to a fresh database", async () => {
    const db = new Database(":memory:")
    try {
      for (const name of migrations) db.exec(await readMigration(name))

      const columns = (db.query("PRAGMA table_info(ideas)").all() as { name: string }[]).map((x) => x.name)
      expect(columns).toContain("content_hash")
      expect(columns).toContain("signal_count")
      expect(columns).toContain("search_text")
      expect(columns).toContain("reviewed_at")

      const seeds = db.query(
        "SELECT id, content_hash, signal_count, search_text FROM ideas WHERE id LIKE 'seed-%' ORDER BY id",
      ).all() as Array<{ id: string; content_hash: string; signal_count: number; search_text: string }>
      expect(seeds).toHaveLength(8)
      expect(new Set(seeds.map((idea) => idea.content_hash)).size).toBe(8)
      expect(seeds.every((idea) => idea.signal_count === 1)).toBe(true)
      expect(seeds.find((idea) => idea.id === "seed-game-localization")?.search_text).toContain("translation")

      const rateLimit = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'submission_rate_limits'")
        .get() as { name: string } | null
      expect(rateLimit?.name).toBe("submission_rate_limits")
    } finally {
      db.close()
    }
  })

  it("upgrades an existing installation without losing community ideas", async () => {
    const db = new Database(":memory:")
    try {
      db.exec(await readMigration("0001_init.sql"))
      db.query(
        `INSERT INTO ideas
          (id, title, summary, category, tags, language, status, submitter_hash, content_hash, created_at, updated_at, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "legacy-community-idea",
        "Legacy community search helper",
        "A tool to search project notes and keep them available after an upgrade.",
        "Productivity",
        '["notes","search"]',
        "en",
        "published",
        "legacy-hash",
        "legacy-content-hash",
        100,
        200,
        200,
      )

      for (const name of migrations.slice(1)) db.exec(await readMigration(name))

      const legacy = db
        .query("SELECT title, signal_count, search_text FROM ideas WHERE id = ?")
        .get("legacy-community-idea") as { title: string; signal_count: number; search_text: string } | null
      expect(legacy?.title).toBe("Legacy community search helper")
      expect(legacy?.signal_count).toBe(1)
      expect(legacy?.search_text).toContain("legacy community search helper")
    } finally {
      db.close()
    }
  })
})
