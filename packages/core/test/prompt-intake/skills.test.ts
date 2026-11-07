import { describe, expect, test } from "bun:test"
import { recommendSkills, valueVerdictForMarketplace, type SkillRef } from "@orchestra/core/prompt-intake/skills"
import { understand } from "@orchestra/core/prompt-intake/understand"
import { checkValue } from "@orchestra/core/prompt-intake/value"
import type { IntakeContext } from "@orchestra/core/prompt-intake/types"

const emptyContext = () => ({
  dodItems: [] as IntakeContext["dodItems"][number][],
  recentPrompts: [] as IntakeContext["recentPrompts"][number][],
  journalTitles: [] as IntakeContext["journalTitles"][number][],
  sources: { dod: true, history: true, journal: true },
})

const CATALOG: ReadonlyArray<SkillRef> = [
  { id: "skill-test", name: "testing", description: "Run the test suite", content: "Run bun test in the package directory." },
  { id: "skill-docs", name: "docs", description: "Write documentation", content: "Write clear docs with examples." },
  { id: "skill-git", name: "git", description: "Version control", content: "Commit, branch, and merge with git." },
  { id: "skill-review", name: "code-review", description: "Review code", content: "Review code for bugs and style." },
]

describe("prompt-intake skill recommendations", () => {
  test("recommends the skill whose words match the task", () => {
    const task = understand("Протестируй исправление и прогони тесты", emptyContext())
    const recommended = recommendSkills(task, CATALOG)
    expect(recommended[0]?.id).toBe("skill-test")
    expect(recommended[0]?.reason).toContain("тест")
  })

  test("Russian task words match English skill names through aliases", () => {
    const task = understand("Напиши документацию к модулю", emptyContext())
    const recommended = recommendSkills(task, CATALOG)
    expect(recommended.some((skill) => skill.id === "skill-docs")).toBe(true)
  })

  test("returns at most 3, each with a reason and a score", () => {
    const task = understand("Протестируй код, напиши документацию и сделай ревью", emptyContext())
    const recommended = recommendSkills(task, CATALOG)
    expect(recommended.length).toBeLessThanOrEqual(3)
    for (const skill of recommended) {
      expect(skill.reason.length).toBeGreaterThan(0)
      expect(skill.score).toBeGreaterThanOrEqual(0.2)
    }
  })

  test("an empty catalog recommends nothing", () => {
    const task = understand("Протестируй исправление", emptyContext())
    expect(recommendSkills(task, [])).toEqual([])
  })
})

describe("prompt-intake value verdict for the skill marketplace", () => {
  test("an executable prompt proceeds, with the checker's reasons", () => {
    const assessment = checkValue("Исправь ошибку в packages/core/src/session/prompt.ts: сервер падает при пустом промпте", emptyContext())
    expect(assessment.verdict).toBe("execute")
    const verdict = valueVerdictForMarketplace(assessment)
    expect(verdict.proceed).toBe(true)
    expect(verdict.reason).toBe(assessment.reasons.join(" "))
  })

  test("a duplicate prompt does not proceed (marketplace must not search)", () => {
    const context = emptyContext()
    context.dodItems.push({
      id: "S1",
      title: "Исправить ошибку сервера при пустом промпте",
      state: "IN_PROGRESS",
    })
    const assessment = checkValue("Исправь ошибку сервера при пустом промпте", context)
    expect(assessment.verdict).toBe("merge")
    expect(valueVerdictForMarketplace(assessment).proceed).toBe(false)
  })

  test("an already-done prompt does not proceed", () => {
    const context = emptyContext()
    context.dodItems.push({
      id: "S1",
      title: "Добавь kanban в DoD",
      state: "DONE",
    })
    const assessment = checkValue("Добавь kanban в DoD", context)
    expect(assessment.verdict).toBe("skip")
    expect(valueVerdictForMarketplace(assessment).proceed).toBe(false)
  })
})
