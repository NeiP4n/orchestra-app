import { describe, expect, test } from "bun:test"
import { checkValue } from "@orchestra/core/prompt-intake/value"
import { dispositionFor } from "@orchestra/core/prompt-intake/policy"
import type { IntakeContext } from "@orchestra/core/prompt-intake/types"

const emptyContext = () => ({
  dodItems: [] as IntakeContext["dodItems"][number][],
  recentPrompts: [] as IntakeContext["recentPrompts"][number][],
  journalTitles: [] as IntakeContext["journalTitles"][number][],
  sources: { dod: true, history: true, journal: true },
})

describe("prompt-intake value policy (verdict is advisory, never a refusal)", () => {
  test("a clear prompt admits", () => {
    const value = checkValue(
      "Исправь ошибку в packages/core/src/session/prompt.ts: сервер падает при пустом промпте",
      emptyContext(),
    )
    expect(value.verdict).toBe("execute")
    expect(dispositionFor(value)).toEqual({
      action: "admit",
    })
  })

  test("work already done admits, naming the finished item in the advisory reason", () => {
    const context = emptyContext()
    context.dodItems.push({ id: "S3", title: "Добавить kanban в DoD", state: "DONE" })
    const value = checkValue("Добавь kanban в DoD", context)
    expect(value.verdict).toBe("skip")
    const disposition = dispositionFor(value)
    expect(disposition.action).toBe("admit")
    expect(disposition.reason).toContain("Добавить kanban в DoD")
  })

  test("a duplicate of an open item admits, naming the existing item in the advisory reason", () => {
    const context = emptyContext()
    context.dodItems.push({
      id: "S1",
      title: "Исправить ошибку сервера при пустом промпте",
      state: "IN_PROGRESS",
    })
    const value = checkValue("Исправь ошибку сервера при пустом промпте", context)
    expect(value.verdict).toBe("merge")
    const disposition = dispositionFor(value)
    expect(disposition.action).toBe("admit")
    expect(disposition.reason).toContain("Исправить ошибку сервера при пустом промпте")
  })

  test("a repeated prompt in this session admits", () => {
    const context = emptyContext()
    context.recentPrompts.push({ text: "Добавь kanban в DoD" })
    const value = checkValue("Добавь kanban в DoD", context)
    expect(value.verdict).toBe("merge")
    expect(dispositionFor(value).action).toBe("admit")
  })

  test("a short prompt admits too: the verdict stays advisory", () => {
    const context = emptyContext()
    context.dodItems.push({ id: "S9", title: "Добавить kanban", state: "DONE" })
    const value = checkValue("Добавь kanban", context)
    // The verdict still says skip — the evidence matches — but the policy
    // never enforces it: the prompt reaches the model, which verifies the
    // claim and tells the user instead of the prompt being dropped.
    expect(value.verdict).toBe("skip")
    const disposition = dispositionFor(value)
    expect(disposition.action).toBe("admit")
    expect(disposition.reason).toContain("Добавить kanban")
  })

  test("a vague prompt admits, carrying the questions in the advisory reason", () => {
    const value = checkValue("сделай лучше", emptyContext())
    expect(value.verdict).toBe("clarify")
    const disposition = dispositionFor(value)
    expect(disposition.action).toBe("admit")
    expect(disposition.reason).toContain("Уточни")
    expect(disposition.reason).toContain(value.questions[0] ?? "")
  })

  test("the reported vague prompts admit: they reach the model instead of a rejection box", () => {
    for (const text of ["сделай что-нибудь", "исправь", "помоги"]) {
      const value = checkValue(text, emptyContext())
      expect(value.verdict).toBe("clarify")
      expect(value.questions.length).toBeGreaterThan(0)
      expect(dispositionFor(value).action).toBe("admit")
    }
  })

  test("an empty prompt admits: the model asks what to do instead of the sender getting a rejection", () => {
    const value = checkValue("   ", emptyContext())
    expect(value.verdict).toBe("clarify")
    const disposition = dispositionFor(value)
    expect(disposition.action).toBe("admit")
    expect(disposition.reason).toContain("Что нужно сделать?")
  })

  test("a retry of failed work admits: a failure is not a duplicate", () => {
    const context = emptyContext()
    context.journalTitles.push({ title: "Собрать приложение для Android", outcome: "failed" })
    const value = checkValue("Собери приложение для Android", context)
    expect(value.verdict).toBe("execute")
    expect(value.reasons.join(" ")).toContain("падала")
    expect(dispositionFor(value)).toEqual({ action: "admit" })
  })

  test("a continuation admits", () => {
    const value = checkValue("продолжай", emptyContext())
    expect(value.verdict).toBe("execute")
    expect(dispositionFor(value)).toEqual({ action: "admit" })
  })
})
