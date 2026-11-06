import { describe, expect, test } from "bun:test"
import { containment, jaccard, similarity } from "@orchestra/core/prompt-intake/similarity"

describe("prompt-intake similarity", () => {
  test("identical texts score 1", () => {
    expect(similarity("исправь ошибку в сервере", "исправь ошибку в сервере")).toBe(1)
  })

  test("unrelated texts score near 0", () => {
    expect(similarity("исправь ошибку в сервере", "нарисуй логотип для кота")).toBeLessThan(0.3)
  })

  test("a prompt that is a subset of a bigger task scores high", () => {
    expect(similarity("исправь ошибку", "исправь ошибку в сервере при пустом промпте и добавь тест")).toBeGreaterThanOrEqual(0.6)
  })

  test("jaccard is 0 for disjoint keywords and 1 for identical", () => {
    expect(jaccard("исправь ошибку", "нарисуй кота")).toBe(0)
    expect(jaccard("исправь ошибку", "ошибку исправь")).toBe(1)
  })

  test("containment is 1 when one text is a subset of the other", () => {
    expect(containment("исправь ошибку", "исправь ошибку в сервере")).toBe(1)
    expect(containment("исправь ошибку в сервере", "исправь ошибку")).toBeLessThan(1)
  })
})
