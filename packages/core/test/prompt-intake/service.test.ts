import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PromptIntake } from "@orchestra/core/prompt-intake/index"
import type { SessionSchema } from "@orchestra/schema/session"
import type { IntakeContext } from "@orchestra/core/prompt-intake/types"

const run = <A>(effect: Effect.Effect<A, never>) => Effect.runPromise(effect)

const emptyContext = (): IntakeContext => ({
  dodItems: [],
  recentPrompts: [],
  journalTitles: [],
  sources: { dod: true, history: true, journal: true },
})

// The mock disambiguator ignores the session; the cast only satisfies the
// type of the process input.
const fakeSession = {} as SessionSchema.Info

const mockDisambiguate: PromptIntake.Disambiguator = () =>
  Effect.succeed({
    assumptions: ["Быстрее — цель: ответ за 100 мс"],
    clarifiedGoal: "Ускорить ответ сервера до 100 мс",
    modelUsed: true,
  })

describe("prompt-intake service", () => {
  test("processPure structures a clear prompt into goal, DoD, and skills", () => {
    const result = PromptIntake.processPure({
      text: "Исправь ошибку в packages/core/src/session/prompt.ts. Сервер падает при пустом промпте.",
      context: emptyContext(),
      skills: [
        { id: "skill-test", name: "testing", description: "Run tests", content: "Run bun test." },
      ],
    })
    expect(result.value.verdict).toBe("execute")
    expect(result.task.goal).toContain("Исправь ошибку")
    expect(result.task.dod.length).toBeGreaterThan(0)
    expect(result.trivial).toBe(false)
    expect(result.modelUsed).toBe(false)
    // The structured block is gone: the result carries no enriched text.
    expect("enrichedPrompt" in result).toBe(false)
  })

  test("process with a mock model refines an ambiguous prompt and marks model use", async () => {
    const result = await run(
      PromptIntake.process({
        session: fakeSession,
        text: "сделай лучше",
        context: emptyContext(),
        disambiguate: mockDisambiguate,
      }),
    )
    expect(result.modelUsed).toBe(true)
    expect(result.task.goal).toBe("Ускорить ответ сервера до 100 мс")
    expect(result.task.ambiguities[0]?.assumption).toBe("Быстрее — цель: ответ за 100 мс")
  })

  test("process without a disambiguator never uses a model", async () => {
    const result = await run(
      PromptIntake.process({ session: fakeSession, text: "сделай лучше", context: emptyContext() }),
    )
    expect(result.modelUsed).toBe(false)
    expect(result.task.ambiguities.length).toBeGreaterThan(0)
  })

  test("a continuation is trivial and passes through untouched", async () => {
    const result = await run(
      PromptIntake.process({ session: fakeSession, text: "продолжай", context: emptyContext() }),
    )
    expect(result.trivial).toBe(true)
    expect(result.original).toBe("продолжай")
    expect(result.value.verdict).toBe("execute")
    expect(result.modelUsed).toBe(false)
    expect(result.skills).toHaveLength(0)
  })

  test("a trivial prompt skips analysis entirely: no model, no skills, no structure", async () => {
    for (const text of ["отлично", "привет", "спасибо", "ок", "так, давай"]) {
      const result = await run(PromptIntake.process({ session: fakeSession, text, context: emptyContext() }))
      expect(result.trivial).toBe(true)
      expect(result.original).toBe(text)
      expect(result.value.verdict).toBe("execute")
      expect(result.modelUsed).toBe(false)
      expect(result.skills).toHaveLength(0)
      expect(result.task.dod).toHaveLength(0)
      expect(result.task.plan).toHaveLength(0)
    }
    // The pure pipeline agrees: no model is involved for a trivial prompt.
    const pure = PromptIntake.processPure({ text: "отлично", context: emptyContext() })
    expect(pure.trivial).toBe(true)
    expect(pure.modelUsed).toBe(false)
  })

  test("process never fails, even on an empty prompt", async () => {
    const result = await run(
      PromptIntake.process({ session: fakeSession, text: "   ", context: emptyContext() }),
    )
    expect(result.value.verdict).toBe("clarify")
    expect(result.original).toBe("   ")
  })

  test("a duplicate verdict survives the full pipeline with its evidence", async () => {
    const context = emptyContext()
    context.dodItems.push({ id: "S1", title: "Добавить kanban в DoD", state: "DONE" })
    const result = await run(
      PromptIntake.process({ session: fakeSession, text: "Добавь kanban в DoD", context }),
    )
    expect(result.value.verdict).toBe("skip")
    expect(result.task.goal).toContain("Добавь kanban в DoD")
    expect(result.value.reasons.join(" ")).toContain("kanban")
    expect(result.trivial).toBe(false)
  })

  test("the pipeline refuses a duplicate: the disposition is refuse, not just text", async () => {
    const context = emptyContext()
    context.dodItems.push({ id: "S1", title: "Добавить kanban в DoD", state: "DONE" })
    const result = await run(
      PromptIntake.process({ session: fakeSession, text: "Добавь kanban в DoD", context }),
    )
    expect(result.disposition.action).toBe("refuse")
    if (result.disposition.action === "refuse")
      expect(result.disposition.reason).toContain("Добавить kanban в DoD")
  })

  test("the pipeline refuses a vague prompt and admits a clear one", async () => {
    const vague = await run(
      PromptIntake.process({ session: fakeSession, text: "сделай лучше", context: emptyContext() }),
    )
    expect(vague.value.verdict).toBe("clarify")
    expect(vague.disposition.action).toBe("refuse")
    const clear = await run(
      PromptIntake.process({
        session: fakeSession,
        text: "Исправь ошибку в packages/core/src/session/prompt.ts. Сервер падает при пустом промпте.",
        context: emptyContext(),
      }),
    )
    expect(clear.value.verdict).toBe("execute")
    expect(clear.disposition).toEqual({ action: "admit" })
  })

  test("an overlong clarified goal from the model never replaces the user's goal", async () => {
    const longGoal: PromptIntake.Disambiguator = () =>
      Effect.succeed({
        assumptions: ["y".repeat(600)],
        clarifiedGoal: "x".repeat(600),
        modelUsed: true,
      })
    const result = await run(
      PromptIntake.process({
        session: fakeSession,
        text: "сделай лучше",
        context: emptyContext(),
        disambiguate: longGoal,
      }),
    )
    expect(result.modelUsed).toBe(true)
    expect(result.task.goal).not.toContain("x".repeat(100))
    expect(result.task.goal.length).toBeLessThanOrEqual(500)
    expect(result.task.ambiguities[0]?.assumption.length).toBeLessThanOrEqual(500)
  })
})
