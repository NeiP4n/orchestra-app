import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, symlinkSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import { ReviewedIndex as R } from "../src/memory/reviewed-index"
const card = (id = "lesson_1", text = "Restart browser watcher after service recovery"): R.Card => ({
  id,
  kind: "lesson",
  source: "lessons.md",
  title: "Browser recovery",
  text,
  reviewed: true,
})
const project = () => mkdtempSync(path.join(os.tmpdir(), "reviewed-index-"))
test("offline index survives reopen, binds one project and deletes stale rows on rebuild", () => {
  const dir = project()
  try {
    const first = R.open(dir, "prj_a")
    expect(first.replace([card()])).toBe(1)
    first.close()
    expect(() => R.open(dir, "prj_b")).toThrow("different project")
    const reopened = R.open(dir, "prj_a")
    expect(reopened.search("browser recovery")[0]?.id).toBe("lesson_1")
    reopened.replace([])
    expect(reopened.search("browser recovery")).toEqual([])
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test("secret and forbidden-source cards reject the whole batch without replacing known-safe rows", () => {
  const dir = project(),
    index = R.open(dir, "prj_a")
  try {
    index.replace([card()])
    for (const bad of [
      { ...card("bad"), reviewed: false },
      { ...card("bad"), text: "sk-proj-SECRET-CANARY-123456789" },
      { ...card("bad"), source: "../lessons.md" },
      { ...card("bad"), source: "browserQueue.json" },
      { ...card("bad"), kind: "page", source: "pages/account.html" },
      { ...card("bad"), kind: "plan", source: ".env" },
      { ...card("bad"), text: "https://api.invalid?token=SECRET-CANARY" },
    ])
      expect(() => index.replace([card("good"), bad as R.Card])).toThrow("nothing was indexed")
    expect(index.search("browser recovery")[0]?.id).toBe("lesson_1")
    index.close()
    expect(readFileSync(path.join(dir, ".orchestra", "reviewed-index.db")).includes(Buffer.from("SECRET-CANARY"))).toBe(
      false,
    )
  } finally {
    try {
      index.close()
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})
test("queries scan past100 cards, RU/EN lexical matches and version mismatch stays closed until rebuilt", () => {
  const dir = project(),
    index = R.open(dir, "prj_a")
  try {
    const cards = Array.from({ length: 150 }, (_, i) => card(`n${i}`, `Generic filler number ${i}`))
    cards.push({
      ...card("target"),
      title: "Перезапуск браузера",
      text: "Перезапуск браузера после сбоя сервиса; browser service recovery",
    })
    index.replace(cards)
    for (const q of ["Перезапуск браузера", "browser service recovery"]) expect(index.search(q)[0]?.id).toBe("target")
    index.close()
    const db = new Database(path.join(dir, ".orchestra", "reviewed-index.db"))
    db.run("UPDATE meta SET value='old-embedding' WHERE key='version'")
    db.close()
    const next = R.open(dir, "prj_a")
    expect(() => next.search("browser")).toThrow("rebuild")
    next.replace([card()])
    expect(next.search("browser")[0]?.id).toBe("lesson_1")
    next.close()
  } finally {
    try {
      index.close()
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})
test("different projects never see each other's cards and directory symlinks are refused", () => {
  const a = project(),
    b = project()
  try {
    const one = R.open(a, "prj_a"),
      two = R.open(b, "prj_b")
    one.replace([card()])
    two.replace([])
    expect(two.search("browser")).toEqual([])
    one.close()
    two.close()
    rmSync(path.join(b, ".orchestra"), { recursive: true, force: true })
    symlinkSync(
      path.join(a, ".orchestra"),
      path.join(b, ".orchestra"),
      process.platform === "win32" ? "junction" : "dir",
    )
    expect(() => R.open(b, "prj_b")).toThrow("real project")
  } finally {
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

test("bounded prototype rejects oversized batches, duplicate IDs, invalid query and limits", () => {
  const dir = project(),
    index = R.open(dir, "prj_a")
  try {
    expect(() => index.replace(Array.from({ length: R.MAX_CARDS + 1 }, (_, i) => card(`c${i}`)))).toThrow("limit")
    expect(() => index.replace([card(), card()])).toThrow("nothing was indexed")
    expect(() => index.replace([card("large", "x".repeat(R.MAX_CARD_BYTES + 1))])).toThrow("nothing was indexed")
    const start = performance.now()
    index.replace(Array.from({ length: R.MAX_CARDS }, (_, i) => ({ ...card(`c${i}`), title: `Safe lesson ${i}` })))
    const hits = index.search("browser recovery", 20)
    expect(hits.length).toBe(20)
    expect(performance.now() - start).toBeLessThan(5000)
    for (const q of ["sk-proj-SECRET-CANARY-123456789", "x".repeat(501), ""])
      expect(() => index.search(q)).toThrow("Invalid")
    for (const limit of [0, 21, NaN]) expect(() => index.search("browser", limit)).toThrow("Invalid")
  } finally {
    index.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
