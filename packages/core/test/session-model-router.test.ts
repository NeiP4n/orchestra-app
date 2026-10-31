import { describe, expect, test } from "bun:test"
import { ModelRouter } from "@orchestra/core/session/model-router"

// The golden table is the specification: one row per shape of work the router must recognise.
// Changing a weight is supposed to change these rows, which is exactly why they are written out.
const scenarios: ReadonlyArray<{
  readonly name: string
  readonly input: ModelRouter.ClassifyInput
  readonly tier: ModelRouter.Tier
  readonly score: number
  readonly strong: boolean
}> = [
  {
    name: "a typo in one small file is trivial",
    input: { task: "Исправь опечатку в README", role: "developer", files: [{ path: "README.md", lines: 20 }] },
    tier: "trivial",
    score: -5,
    strong: false,
  },
  {
    name: "a status question is trivial even while coding",
    input: { task: "Покажи статус сборки", role: "developer", mode: "coding" },
    tier: "trivial",
    score: -7,
    strong: false,
  },
  {
    name: "lint and formatting work is trivial",
    input: { task: "Поправь lint и форматирование в packages/core", role: "engineer" },
    tier: "trivial",
    score: -9,
    strong: false,
  },
  {
    name: "a test for one component stays standard",
    input: {
      task: "Добавь тест на компонент кнопки",
      role: "frontend-developer",
      mode: "coding",
      files: [
        { path: "button.tsx", lines: 100 },
        { path: "button.test.tsx", lines: 100 },
      ],
    },
    tier: "standard",
    score: 2,
    strong: false,
  },
  {
    name: "a fix across three files is standard",
    input: {
      task: "Реализуй фикс ретрая в очереди",
      role: "backend-developer",
      mode: "coding",
      files: [{ path: "queue.ts", lines: 400 }, { path: "retry.ts", lines: 200 }, { path: "test.ts", lines: 100 }],
    },
    tier: "standard",
    score: 3,
    strong: false,
  },
  {
    name: "reviewing four files is standard, not deep, without a hard signal",
    input: {
      task: "Проверь изменения в отчёте",
      role: "reviewer",
      mode: "review",
      files: [
        { path: "a.ts", lines: 10 },
        { path: "b.ts", lines: 10 },
        { path: "c.ts", lines: 10 },
        { path: "d.ts", lines: 10 },
      ],
    },
    tier: "standard",
    score: 5,
    strong: false,
  },
  {
    name: "a second attempt on a failing debug task escalates to deep",
    input: {
      task: "Почему падает тест после ретрая?",
      role: "developer",
      mode: "debug",
      attempts: 2,
      files: [{ path: "retry.test.ts", lines: 50 }],
    },
    tier: "deep",
    score: 5,
    strong: true,
  },
  {
    name: "architecture mode and an architect role are deep",
    input: { task: "Спроектируй контракты сервиса оплаты", role: "architect", mode: "architecture" },
    tier: "deep",
    score: 10,
    strong: true,
  },
  {
    name: "an audit keyword with many files is deep",
    input: {
      task: "Проведи аудит безопасности плагина",
      role: "reviewer",
      files: Array.from({ length: 9 }, (_, index) => ({ path: `file-${index}.ts`, lines: 10 })),
    },
    tier: "deep",
    score: 7,
    strong: true,
  },
  {
    name: "a very long coding task still needs a strong signal to go deep",
    input: { task: `Реализуй сценарий ${"a".repeat(3100)}`, role: "developer", mode: "coding" },
    tier: "standard",
    score: 4,
    strong: false,
  },
  {
    name: "fast mode caps an architecture request at trivial",
    input: { task: "Набросай архитектуру кэша", role: "architect", mode: "fast" },
    tier: "trivial",
    score: 4,
    strong: true,
  },
  {
    name: "review mode lifts a trivial score to standard but no further",
    input: {
      task: "Покажи опечатку в отчёте",
      role: "developer",
      mode: "review",
      files: Array.from({ length: 9 }, (_, index) => ({ path: `file-${index}.ts`, lines: 10 })),
    },
    tier: "standard",
    score: -4,
    strong: false,
  },
]

describe("ModelRouter.classify", () => {
  for (const scenario of scenarios) {
    test(scenario.name, () => {
      const decision = ModelRouter.classify(scenario.input)

      expect({ tier: decision.tier, score: decision.score, strong: decision.strong }).toEqual({
        tier: scenario.tier,
        score: scenario.score,
        strong: scenario.strong,
      })
      expect(decision.reasons.length).toBeGreaterThan(0)
    })
  }

  test("is deterministic and never mutates its input", () => {
    const input: ModelRouter.ClassifyInput = { task: "Спроектируй контракты", role: "architect", mode: "planning" }
    const frozen = JSON.stringify(input)

    expect(ModelRouter.classify(input)).toEqual(ModelRouter.classify(input))
    expect(JSON.stringify(input)).toBe(frozen)
  })

  test("explains every signal it counted", () => {
    const decision = ModelRouter.classify({
      task: "Проведи аудит гонок в очереди",
      role: "reviewer",
      mode: "debug",
      attempts: 3,
      files: [{ path: "queue.ts", lines: 900 }, { path: "a.ts", lines: 1 }, { path: "b.ts", lines: 1 }],
    })

    expect(decision.reasons.some((reason) => reason.startsWith("role reviewer"))).toBe(true)
    expect(decision.reasons.some((reason) => reason.includes("debug mode"))).toBe(true)
    expect(decision.reasons.some((reason) => reason.startsWith("hard work"))).toBe(true)
    expect(decision.reasons.some((reason) => reason.startsWith("retry 3"))).toBe(true)
    expect(decision.reasons.some((reason) => reason.startsWith("files 3"))).toBe(true)
  })
})

const catalog: ReadonlyArray<ModelRouter.CatalogModel> = [
  {
    id: "flash",
    providerID: "gemini",
    variants: [{ id: "fast" }, { id: "minimal" }, { id: "low" }, { id: "medium" }],
    cost: [{ input: 0.1, output: 0.4 }],
  },
  {
    id: "deepseek",
    providerID: "polza",
    variants: [{ id: "minimal" }, { id: "fast" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
    cost: [{ input: 0.3, output: 1.2 }],
  },
  {
    id: "opus",
    providerID: "polza",
    variants: [{ id: "low" }, { id: "high" }, { id: "max" }],
    cost: [{ input: 3, output: 15 }],
  },
]

describe("ModelRouter.route", () => {
  test("a pinned model with its variant wins over everything", () => {
    const decision = ModelRouter.route({
      tier: "deep",
      candidates: ["gemini/flash", "polza/deepseek"],
      catalog,
      pinned: "polza/opus#max",
    })

    expect(decision).toEqual({ model: "polza/opus", variant: "max", reason: "pinned by the caller", skipped: [] })
  })

  test("takes the cheapest priced candidate that has the tier's variant", () => {
    const decision = ModelRouter.route({ tier: "deep", candidates: ["polza/opus", "polza/deepseek"], catalog })

    expect(decision).toEqual({
      model: "polza/deepseek",
      variant: "high",
      reason: "cheapest of 2 priced candidate(s): 1.5 USD per million tokens",
      skipped: [{ model: "polza/opus", why: "priced higher (18 > 1.5)" }],
    })
  })

  test("asks for the variant the tier needs", () => {
    expect(ModelRouter.route({ tier: "trivial", candidates: ["gemini/flash", "polza/deepseek"], catalog }).variant).toBe("minimal")
    expect(ModelRouter.route({ tier: "standard", candidates: ["gemini/flash", "polza/deepseek"], catalog }).variant).toBe("low")
    expect(ModelRouter.route({ tier: "deep", candidates: ["polza/deepseek"], catalog }).variant).toBe("high")
  })

  test("keeps a variant the candidate names itself", () => {
    expect(ModelRouter.route({ tier: "standard", candidates: ["polza/deepseek#max"], catalog }).variant).toBe("max")
  })

  test("prices a request by the context tier its tokens fall into", () => {
    const tiered: ReadonlyArray<ModelRouter.CatalogModel> = [
      {
        id: "tiered",
        providerID: "polza",
        cost: [
          { input: 1, output: 1 },
          { input: 10, output: 10, tier: { type: "context", size: 100_000 } },
        ],
      },
      { id: "flat", providerID: "polza", cost: [{ input: 5, output: 5 }] },
    ]

    // 50k tokens: tiered costs 1 + 1 = 2, flat costs 10.
    expect(ModelRouter.route({ tier: "standard", candidates: ["polza/tiered", "polza/flat"], catalog: tiered, tokens: 50_000 }).model).toBe(
      "polza/tiered",
    )
    // 200k tokens: tiered costs 10 + 10 = 20, flat still costs 10.
    expect(ModelRouter.route({ tier: "standard", candidates: ["polza/tiered", "polza/flat"], catalog: tiered, tokens: 200_000 })).toMatchObject({
      model: "polza/flat",
      skipped: [{ model: "polza/tiered", why: "priced higher (20 > 10)" }],
    })
  })

  test("reports why a candidate was skipped", () => {
    const decision = ModelRouter.route({
      tier: "standard",
      candidates: ["polza/unknown", "polza/deepseek"],
      catalog,
    })

    expect(decision.skipped).toEqual([{ model: "polza/unknown", why: "not in the catalog" }])
  })

  test("without a catalog takes the first candidate and says it could not compare", () => {
    const decision = ModelRouter.route({ tier: "trivial", candidates: ["gemini/flash#minimal", "polza/deepseek"] })

    expect(decision).toEqual({
      model: "gemini/flash",
      variant: "minimal",
      reason: "no catalog: took the first candidate",
      skipped: [{ model: "polza/deepseek", why: "no catalog: cannot compare prices" }],
    })
  })

  test("with a catalog but no prices still answers", () => {
    const decision = ModelRouter.route({ tier: "deep", candidates: ["polza/deepseek"], catalog: [{ id: "deepseek", providerID: "polza" }] })

    expect(decision).toMatchObject({ model: "polza/deepseek", reason: "no candidate could be priced: took a candidate anyway" })
    expect(decision.skipped).toEqual([{ model: "polza/deepseek", why: "no price" }])
  })
})
