import { describe, expect, test } from "bun:test"
import { recommendSkills, type SkillRef } from "@orchestra/core/prompt-intake/skills"
import { understand } from "@orchestra/core/prompt-intake/understand"
import type { IntakeContext } from "@orchestra/core/prompt-intake/types"

const emptyContext = (): IntakeContext => ({
  dodItems: [],
  recentPrompts: [],
  journalTitles: [],
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
