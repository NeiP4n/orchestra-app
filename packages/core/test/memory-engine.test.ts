import { describe, expect, test } from "bun:test"
import { MemoryEngine } from "../src/memory/engine.js"
import { hashEmbed, cosineSimilarity } from "../src/memory/embed.js"
import { stemRU, stemEN, extractTerms, trigrams } from "../src/memory/text.js"

describe("Native Memory Engine (bun:sqlite associative-vector memory)", () => {
  test("text processing: stemming RU/EN, tokenization and trigrams", () => {
    expect(stemRU("пользователю")).toBe("пользовател")
    expect(stemRU("архитектурный")).toBe("архитектур")
    expect(stemEN("optimizations")).toBe("optimiz")
    expect(stemEN("developer")).toBe("develop")

    const termsRU = extractTerms("Пользователь предпочитает темную тему интерфейса")
    expect(termsRU.has("пользовател")).toBe(true)
    expect(termsRU.has("предпочит")).toBe(true)
    expect(termsRU.has("тем")).toBe(true)
    expect(termsRU.has("интерфейс")).toBe(true)

    const tris = trigrams("Effect")
    expect(tris.length).toBeGreaterThan(0)
    expect(tris).toContain("eff")
  })

  test("hash embedding: deterministic 64-dim L2-normalized vector", () => {
    const vec1 = hashEmbed("Пользователь предпочитает темную тему")
    const vec2 = hashEmbed("Пользователь любит темный интерфейс")
    const vec3 = hashEmbed("Database SQL indexing performance benchmark")

    expect(vec1).toBeInstanceOf(Int8Array)
    expect(vec1.length).toBe(64)

    // Проверяем ненулевую норму
    let sumSq = 0
    for (let i = 0; i < vec1.length; i++) sumSq += vec1[i] * vec1[i]
    expect(sumSq).toBeGreaterThan(0)

    // Семантическая близость: близкие фразы имеют более высокий cosSim
    const simSimilar = cosineSimilarity(vec1, vec2)
    const simDifferent = cosineSimilarity(vec1, vec3)

    expect(simSimilar).toBeGreaterThan(simDifferent)
  })

  test("full integration: remember, link graph, hybrid search RU/EN, recall, stats and speed <3ms", () => {
    // Реальный bun:sqlite in-memory движок
    const engine = MemoryEngine.open(":memory:")

    // 1. Сохранение фактов (remember)
    const fact1 = engine.remember({
      text: "Пользователь предпочитает темную тему, минималистичные кнопки и быстрый TUI интерфейс.",
      entity: {
        name: "user",
        kind: "preference",
        summary: "UI/UX предпочтения человека",
      },
      scope: "user",
    })
    expect(fact1.observationID).toBeDefined()
    expect(fact1.entityID).toBeDefined()

    const fact2 = engine.remember({
      text: "Архитектура Orchestra построена на базе Effect v4 со строгой типизацией и structured concurrency.",
      entity: {
        name: "orchestra-core",
        kind: "architecture",
        summary: "Архитектура ядра платформы",
      },
      scope: "project",
    })
    expect(fact2.observationID).toBeDefined()

    const fact3 = engine.remember({
      text: "The project uses bun:sqlite with WAL mode and memory mapping for ultra-fast queries.",
      entity: {
        name: "storage-engine",
        kind: "component",
        summary: "Нативное хранилище базы данных",
      },
      scope: "project",
    })
    expect(fact3.observationID).toBeDefined()

    const fact4 = engine.remember({
      text: "Antigravity model uses high reasoning effort to solve complex agentic coding tasks.",
      entity: {
        name: "ai-model",
        kind: "config",
      },
      scope: "project",
    })
    expect(fact4.observationID).toBeDefined()

    // 2. Связывание сущностей в граф (link)
    const link1 = engine.link({
      source: "user",
      target: "orchestra-core",
      type: "uses",
      weight: 1.0,
    })
    expect(link1.id).toBeDefined()

    const link2 = engine.link({
      source: "orchestra-core",
      target: "storage-engine",
      type: "depends_on",
      weight: 0.9,
    })
    expect(link2.id).toBeDefined()

    // 3. Статистика графа и БД (stats)
    const stats = engine.stats()
    expect(stats.observations).toBe(4)
    expect(stats.entities).toBeGreaterThanOrEqual(4)
    expect(stats.relations).toBe(2)
    expect(stats.docs).toBe(4)
    expect(stats.terms).toBeGreaterThan(10)

    // 4. Поиск по русскому языку (RU search)
    const ruResults = engine.search("темная тема интерфейс")
    expect(ruResults.length).toBeGreaterThan(0)
    expect(ruResults[0].content).toContain("темную тему")
    expect(ruResults[0].entityName).toBe("user")
    expect(ruResults[0].score).toBeGreaterThan(0.2)

    const ruArchResults = engine.search("Effect concurrency типизация")
    expect(ruArchResults.length).toBeGreaterThan(0)
    expect(ruArchResults[0].content).toContain("Effect v4")

    // 5. Поиск по английскому языку (EN search)
    const enResults = engine.search("sqlite WAL memory mapping")
    expect(enResults.length).toBeGreaterThan(0)
    expect(enResults[0].content).toContain("bun:sqlite")
    expect(enResults[0].entityName).toBe("storage-engine")

    const enModelResults = engine.search("reasoning effort agentic coding")
    expect(enModelResults.length).toBeGreaterThan(0)
    expect(enModelResults[0].content).toContain("Antigravity")

    // 6. Семантическое извлечение контекста для промпта (recall)
    const recallContext = engine.recall("темная тема")
    expect(recallContext).toContain("### Relevant Memory:")
    expect(recallContext).toContain("темную тему")

    // 7. Проверка скорости поиска: замер времени < 3мс
    const start = performance.now()
    for (let i = 0; i < 10; i++) {
      engine.search("темная тема интерфейс")
      engine.search("sqlite WAL memory")
    }
    const elapsedTotal = performance.now() - start
    const avgDuration = elapsedTotal / 20 // среднее время на один запрос

    expect(avgDuration).toBeLessThan(3.0)

    // 8. Удаление факта (forget)
    const forgetRes = engine.forget({ observationID: fact1.observationID })
    expect(forgetRes.deleted).toBeGreaterThan(0)

    const searchAfterForget = engine.search("темная тема интерфейс")
    const foundDeleted = searchAfterForget.some((r) => r.id === fact1.observationID)
    expect(foundDeleted).toBe(false)

    engine.close()
  })
})
