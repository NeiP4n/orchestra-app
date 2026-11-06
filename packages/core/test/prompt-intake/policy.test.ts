import { describe, expect, test } from "bun:test"
import { checkValue } from "@orchestra/core/prompt-intake/value"
import { dispositionFor } from "@orchestra/core/prompt-intake/policy"
import type { IntakeContext } from "@orchestra/core/prompt-intake/types"

const emptyContext = (): IntakeContext => ({
  dodItems: [],
  recentPrompts: [],
  journalTitles: [],
  sources: { dod: true, history: true, journal: true },
})

describe("prompt-intake value policy (verdict as code)", () => {
  test("a clear prompt admits", () => {
    const value = checkValue(
      "Исправь ошибку в packages/core/src/session/prompt.ts: сервер падает при пустом промпте",
      emptyContext(),
    )
    expect(value.verdict).toBe("execute")
    expect(dispositionFor(value, "Исправь ошибку в packages/core/src/session/prompt.ts")).toEqual({
      action: "admit",
    })
  })

  test("work already done refuses, naming the finished item", () => {
    const context = emptyContext()
    context.dodItems.push({ id: "S3", title: "Добавить kanban в DoD", state: "DONE" })
    const value = checkValue("Добавь kanban в DoD", context)
    expect(value.verdict).toBe("skip")
    const disposition = dispositionFor(value, "Добавь kanban в DoD")
    expect(disposition.action).toBe("refuse")
    if (disposition.action === "refuse") expect(disposition.reason).toContain("Добавить kanban в DoD")
  })

  test("a duplicate of an open item refuses, naming the existing item", () => {
    const context = emptyContext()
    context.dodItems.push({
      id: "S1",
      title: "Исправить ошибку сервера при пустом промпте",
      state: "IN_PROGRESS",
    })
    const value = checkValue("Исправь ошибку сервера при пустом промпте", context)
    expect(value.verdict).toBe("merge")
    const disposition = dispositionFor(value, "Исправь ошибку сервера при пустом промпте")
    expect(disposition.action).toBe("refuse")
    if (disposition.action === "refuse")
      expect(disposition.reason).toContain("Исправить ошибку сервера при пустом промпте")
  })

  test("a repeated prompt in this session refuses", () => {
    const context = emptyContext()
    context.recentPrompts.push({ text: "Добавь kanban в DoD" })
    const value = checkValue("Добавь kanban в DoD", context)
    expect(value.verdict).toBe("merge")
    expect(dispositionFor(value, "Добавь kanban в DoD").action).toBe("refuse")
  })

  test("a short prompt is never refused: too few words to prove it is the same work", () => {
    const context = emptyContext()
    context.dodItems.push({ id: "S9", title: "Добавить kanban", state: "DONE" })
    const value = checkValue("Добавь kanban", context)
    // The verdict still says skip — the evidence matches — but the policy
    // does not enforce it: two shared words are not proof of the same work.
    expect(value.verdict).toBe("skip")
    expect(dispositionFor(value, "Добавь kanban")).toEqual({ action: "admit" })
  })

  test("a vague prompt refuses, carrying the questions in the reason", () => {
    const value = checkValue("сделай лучше", emptyContext())
    expect(value.verdict).toBe("clarify")
    const disposition = dispositionFor(value, "сделай лучше")
    expect(disposition.action).toBe("refuse")
    if (disposition.action === "refuse") {
      expect(disposition.reason).toContain("Уточни")
      expect(disposition.reason).toContain(value.questions[0] ?? "")
    }
  })

  test("an empty prompt refuses instead of starting a drain on nothing", () => {
    const value = checkValue("   ", emptyContext())
    expect(value.verdict).toBe("clarify")
    expect(dispositionFor(value, "   ").action).toBe("refuse")
  })

  test("a retry of failed work admits: a failure is not a duplicate", () => {
    const context = emptyContext()
    context.journalTitles.push({ title: "Собрать приложение для Android", outcome: "failed" })
    const value = checkValue("Собери приложение для Android", context)
    expect(value.verdict).toBe("execute")
    expect(value.reasons.join(" ")).toContain("падала")
    expect(dispositionFor(value, "Собери приложение для Android")).toEqual({ action: "admit" })
  })

  test("a continuation admits", () => {
    const value = checkValue("продолжай", emptyContext())
    expect(value.verdict).toBe("execute")
    expect(dispositionFor(value, "продолжай")).toEqual({ action: "admit" })
  })
})
