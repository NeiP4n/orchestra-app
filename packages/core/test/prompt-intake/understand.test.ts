import { describe, expect, test } from "bun:test"
import { understand } from "@orchestra/core/prompt-intake/understand"
import type { IntakeContext } from "@orchestra/core/prompt-intake/types"

const emptyContext = (): IntakeContext => ({
  dodItems: [],
  recentPrompts: [],
  journalTitles: [],
  sources: { dod: true, history: true, journal: true },
})

describe("prompt-intake understand", () => {
  test("splits a prompt into goal, context, and a plan", () => {
    const task = understand(
      "Исправь ошибку в packages/core/src/session/prompt.ts. Сервер падает при пустом промпте.",
      emptyContext(),
    )
    expect(task.goal).toContain("Исправь ошибку")
    expect(task.context.join(" ")).toContain("Сервер падает")
    expect(task.plan[0]).toBe("Воспроизвести проблему")
    expect(task.keywords).toContain("ошибку")
  })

  test("mentions files as context and flags a missing target", () => {
    const task = understand("Исправь ошибку сервера", emptyContext())
    expect(task.context).toEqual([])
    expect(task.ambiguities.some((ambiguity) => ambiguity.question.includes("файле"))).toBe(true)
  })

  test("a mentioned file lands in context instead of an ambiguity", () => {
    const task = understand("Исправь ошибку в packages/core/src/session/prompt.ts", emptyContext())
    expect(task.context.some((line) => line.includes("packages/core/src/session/prompt.ts"))).toBe(true)
  })

  test("constraints are picked out of the text", () => {
    const task = understand("Исправь ошибку, только не трогай реальный экран пользователя.", emptyContext())
    expect(task.constraints.length).toBeGreaterThan(0)
    expect(task.constraints.join(" ")).toContain("не трогай")
  })

  test("vague words become questions with default assumptions, at most 3", () => {
    const task = understand("сделай лучше и нормально", emptyContext())
    expect(task.ambiguities.length).toBeGreaterThan(0)
    expect(task.ambiguities.length).toBeLessThanOrEqual(3)
    for (const ambiguity of task.ambiguities) {
      expect(ambiguity.question.length).toBeGreaterThan(0)
      expect(ambiguity.assumption.length).toBeGreaterThan(0)
    }
  })

  test("DoD criteria always include the goal and a verification step", () => {
    const task = understand("Добавь kanban в DoD", emptyContext())
    expect(task.dod[0]).toContain("Добавь kanban")
    expect(task.dod.join(" ")).toContain("проверен")
  })

  test("a vague prompt needs a model, a clear one does not", () => {
    expect(understand("сделай лучше", emptyContext()).needsModel).toBe(true)
    expect(understand("Исправь ошибку в packages/core/src/session/prompt.ts", emptyContext()).needsModel).toBe(false)
  })

  test("a continuation is a minimal task with no model step", () => {
    const task = understand("продолжай", emptyContext())
    expect(task.ambiguities).toEqual([])
    expect(task.needsModel).toBe(false)
    expect(task.plan).toEqual(["Продолжить текущую работу"])
  })
})
