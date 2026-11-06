import { describe, expect, test } from "bun:test"
import { checkValue } from "@orchestra/core/prompt-intake/value"
import type { IntakeContext } from "@orchestra/core/prompt-intake/types"

const emptyContext = (): IntakeContext => ({
  dodItems: [],
  recentPrompts: [],
  journalTitles: [],
  sources: { dod: true, history: true, journal: true },
})

describe("prompt-intake value check", () => {
  test("a duplicate of an open DoD item merges, with evidence pointing at it", () => {
    const context = emptyContext()
    context.dodItems.push({
      id: "S1",
      title: "Исправить ошибку сервера при пустом промпте",
      state: "IN_PROGRESS",
    })
    const result = checkValue("Исправь ошибку сервера при пустом промпте", context)
    expect(result.verdict).toBe("merge")
    expect(result.evidence[0]?.kind).toBe("dod-open")
    expect(result.evidence[0]?.ref).toBe("S1")
    expect(result.reasons.join(" ")).toContain("Исправить ошибку сервера при пустом промпте")
  })

  test("a prompt that is a subset of a bigger DoD task merges", () => {
    const context = emptyContext()
    context.dodItems.push({
      id: "S2",
      title: "Исправить ошибку сервера при пустом промпте и добавить тест",
      state: "NOT_STARTED",
    })
    expect(checkValue("Исправь ошибку сервера", context).verdict).toBe("merge")
  })

  test("work already done is skipped, not redone", () => {
    const context = emptyContext()
    context.dodItems.push({ id: "S3", title: "Добавить kanban в DoD", state: "DONE" })
    const result = checkValue("Добавь kanban в DoD", context)
    expect(result.verdict).toBe("skip")
    expect(result.evidence[0]?.kind).toBe("dod-done")
    expect(result.evidence[0]?.ref).toBe("S3")
  })

  test("a prompt already succeeded in this session is skipped", () => {
    const context = emptyContext()
    context.recentPrompts.push({ text: "Добавь kanban в DoD", outcome: "succeeded" })
    expect(checkValue("Добавь kanban в DoD", context).verdict).toBe("skip")
  })

  test("a repeated prompt without an outcome merges into the earlier one", () => {
    const context = emptyContext()
    context.recentPrompts.push({ text: "Добавь kanban в DoD" })
    expect(checkValue("Добавь kanban в DoD", context).verdict).toBe("merge")
  })

  test("a failed autoloop journal entry merges with a reason to check the failure first", () => {
    const context = emptyContext()
    context.journalTitles.push({ title: "Собрать приложение для Android", outcome: "failed" })
    const result = checkValue("Собери приложение для Android", context)
    expect(result.verdict).toBe("merge")
    expect(result.evidence[0]?.kind).toBe("autoloop-journal")
    expect(result.reasons.join(" ")).toContain("падала")
  })

  test("a vague prompt asks 1-3 questions instead of guessing", () => {
    const result = checkValue("сделай лучше", emptyContext())
    expect(result.verdict).toBe("clarify")
    expect(result.questions.length).toBeGreaterThan(0)
    expect(result.questions.length).toBeLessThanOrEqual(3)
  })

  test("a clear actionable prompt executes", () => {
    const result = checkValue("Исправь ошибку в packages/core/src/session/prompt.ts: сервер падает при пустом промпте", emptyContext())
    expect(result.verdict).toBe("execute")
    expect(result.confidence).toBeGreaterThanOrEqual(0.7)
  })

  test("a continuation is not a new task", () => {
    const result = checkValue("продолжай", emptyContext())
    expect(result.verdict).toBe("execute")
    expect(result.reasons.join(" ")).toContain("Продолжение")
  })

  test("an empty prompt asks what to do", () => {
    const result = checkValue("   ", emptyContext())
    expect(result.verdict).toBe("clarify")
    expect(result.questions.length).toBe(1)
  })

  test("a question is a task to answer, not a vague prompt", () => {
    expect(checkValue("Как работает autoloop?", emptyContext()).verdict).toBe("execute")
  })
})
