import { describe, expect, test } from "bun:test"
import { isContinuation, isTrivial, keywordStems, keywords, sentences, stem } from "@orchestra/core/prompt-intake/normalize"

describe("prompt-intake normalize", () => {
  test("stem unifies Russian verb forms", () => {
    expect(stem("исправь")).toBe(stem("исправить"))
    expect(stem("добавь")).toBe(stem("добавить"))
    expect(stem("собери")).toBe(stem("собрать"))
    expect(stem("найди")).toBe(stem("найти"))
    expect(stem("напиши")).toBe(stem("написать"))
    // "создать" keeps its root vowel ("созд"), "создай" keeps "созда":
    // the stems agree by prefix, which is what matching uses.
    expect(stem("создай").startsWith(stem("создать"))).toBe(true)
  })

  test("stem unifies noun cases and plurals", () => {
    expect(stem("тесты")).toBe(stem("тест"))
    expect(stem("ошибку")).toBe(stem("ошибки"))
    expect(stem("документацию")).toBe(stem("документация"))
  })

  test("stem leaves short and English words intact", () => {
    expect(stem("тест")).toBe("тест")
    expect(stem("bug")).toBe("bug")
    expect(stem("testing")).toBe("test")
  })

  test("keywordStems deduplicates and stems", () => {
    expect(keywordStems("Исправь ошибку и исправь тест")).toEqual(["исправ", "ошибк", "тест"])
  })

  test("keywords drops stopwords", () => {
    expect(keywords("исправь ошибку в сервере")).toEqual(["исправь", "ошибку", "сервере"])
  })

  test("sentences do not split on dots inside file paths", () => {
    expect(sentences("Исправь ошибку в packages/core/src/session/prompt.ts. Сервер падает.")).toEqual([
      "Исправь ошибку в packages/core/src/session/prompt.ts.",
      "Сервер падает.",
    ])
  })

  test("continuations are recognised", () => {
    expect(isContinuation("продолжай")).toBe(true)
    expect(isContinuation("да")).toBe(true)
    expect(isContinuation("исправь ошибку")).toBe(false)
  })

  test("trivial prompts are greetings, thanks, and short acknowledgements", () => {
    for (const text of ["отлично", "привет", "спасибо", "ок", "да", "так, давай", "понял, спасибо", "good job"]) {
      expect(isTrivial(text)).toBe(true)
    }
  })

  test("trivial detection never matches a real task", () => {
    for (const text of ["исправь тесты", "тесты падают", "что это?", "отлично, теперь исправь тесты", "привет, сделай кнопку"]) {
      expect(isTrivial(text)).toBe(false)
    }
    expect(isTrivial("")).toBe(false)
    expect(isTrivial("   ")).toBe(false)
  })
})
