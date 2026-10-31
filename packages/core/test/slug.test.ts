import { describe, expect, test } from "bun:test"
import { Slug } from "@orchestra/core/slug"

describe("Slug.folder", () => {
  test("transliterates Cyrillic into readable ASCII", () => {
    expect(Slug.folder("Планировщик")).toBe("planirovshchik")
    expect(Slug.folder("Архитекторы")).toBe("arkhitektory")
    expect(Slug.folder("Тестировщики")).toBe("testirovshchiki")
    expect(Slug.folder("Кодеры")).toBe("kodery")
  })

  test("keeps the letters that only look alike apart", () => {
    expect(Slug.folder("ёлка")).toBe("elka")
    expect(Slug.folder("подъезд")).toBe("podezd")
    expect(Slug.folder("жизнь")).toBe("zhizn")
    expect(Slug.folder("юла")).toBe("yula")
    expect(Slug.folder("яблоко")).toBe("yabloko")
    expect(Slug.folder("эхо")).toBe("ekho")
    expect(Slug.folder("май")).toBe("mai")
    expect(Slug.folder("выйти")).toBe("vyiti")
  })

  test("folds accents and non-ASCII punctuation into one dash", () => {
    expect(Slug.folder("Café Münster")).toBe("cafe-munster")
    expect(Slug.folder("Backend API")).toBe("backend-api")
    expect(Slug.folder("  Hello,   World!  ")).toBe("hello-world")
    expect(Slug.folder("a--b")).toBe("a-b")
  })

  test("never leaves a trailing dot, a leading dot or a Windows device name", () => {
    expect(Slug.folder("Project.")).toBe("project")
    expect(Slug.folder(".config")).toBe("config")
    expect(Slug.folder("con")).toBe("_con")
    expect(Slug.folder("COM1")).toBe("_com1")
    expect(Slug.folder("lpt9")).toBe("_lpt9")
    expect(Slug.folder("con.txt")).toBe("_con.txt")
    expect(Slug.folder("console")).toBe("console")
  })

  test("limits the length without leaving a trailing dash", () => {
    expect(Slug.folder("a".repeat(80))).toBe("a".repeat(48))
    expect(Slug.folder("x".repeat(80), { max: 10 })).toBe("x".repeat(10))

    const cut = Slug.folder(`${"a".repeat(47)} б`)
    expect(cut.length).toBe(47)
    expect(cut.endsWith("-")).toBe(false)
  })

  test("falls back to the given name, then to a stable hash of the value", () => {
    expect(Slug.folder("***", { fallback: "Проект" })).toBe("proekt")
    expect(Slug.folder("***")).toMatch(/^item-[a-z0-9]+$/)
    expect(Slug.folder("***")).toBe(Slug.folder("***"))
    expect(Slug.folder("***")).not.toBe(Slug.folder("!!!"))
  })

  test("keeps every result safe on Windows, macOS and Linux", () => {
    const names = ["Планировщик", "Моё Общество 1", "***", "con", "Project. ", "Кодеры (v2)", "🎉🎉", "a".repeat(200)]
    for (const name of names) {
      const folder = Slug.folder(name)
      expect(folder).toMatch(/^[a-z0-9._-]+$/)
      expect(folder.startsWith(".")).toBe(false)
      expect(folder.endsWith(".")).toBe(false)
      expect(folder.length).toBeLessThanOrEqual(48)
    }
  })
})
