import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { MemoryLevels } from "../src/memory/levels"

const DATE = "2026-11-07"

const withRoots = async (body: (project: string, society: string) => Promise<void>) => {
  const base = await mkdtemp(path.join(tmpdir(), "memory-levels-"))
  try {
    await body(path.join(base, "project"), path.join(base, "society"))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

const projectRoot = (project: string) => MemoryLevels.projectMemoryRoot(project)
const societyRoot = (society: string) => MemoryLevels.societyMemoryRoot(society)

const exists = async (file: string) => {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

const propose = (root: string, session: string, text: string, type: "decision" | "bugfix" | "feature" = "decision") =>
  MemoryLevels.appendDailyCandidate(root, { text, type, sessionId: session }, { date: DATE })

describe("L2 project memory", () => {
  test("promotion moves a daily candidate into MEMORY.md and index.json", async () => {
    await withRoots(async (project) => {
      const root = projectRoot(project)
      const candidate = await propose(root, "ses-1", "Решили хранить DoD в git, а не в БД")
      const result = await MemoryLevels.promoteSessionFacts(root, "ses-1")
      expect(result.promoted.map((fact) => fact.id)).toEqual([candidate.id])
      expect(result.skipped).toEqual([])
      const memory = await readFile(path.join(root, "MEMORY.md"), "utf8")
      expect(memory).toContain("Решили хранить DoD в git")
      expect(memory).toContain(candidate.id)
      const facts = await MemoryLevels.readProjectIndex(root)
      expect(facts.map((fact) => fact.id)).toEqual([candidate.id])
      const daily = await readFile(path.join(root, "daily", `${DATE}.md`), "utf8")
      expect(daily).toContain("- [x]")
    })
  })

  test("without promotion nothing from daily reaches MEMORY.md (levels do not leak)", async () => {
    await withRoots(async (project) => {
      const root = projectRoot(project)
      await propose(root, "ses-1", "Секретная находка сессии, которую никто не продвигал")
      expect(await exists(path.join(root, "MEMORY.md"))).toBe(false)
      expect(await MemoryLevels.readProjectIndex(root)).toEqual([])
      const candidates = await MemoryLevels.readDailyCandidates(root)
      expect(candidates.map((candidate) => candidate.text)).toEqual([
        "Секретная находка сессии, которую никто не продвигал",
      ])
    })
  })

  test("at most 5 facts per session are promoted", async () => {
    await withRoots(async (project) => {
      const root = projectRoot(project)
      for (let i = 1; i <= 6; i++) await propose(root, "ses-1", `Решение номер ${i}`)
      const result = await MemoryLevels.promoteSessionFacts(root, "ses-1")
      expect(result.promoted).toHaveLength(5)
      expect(result.skipped).toEqual([{ id: expect.any(String), reason: "over-limit" }])
      const facts = await MemoryLevels.readProjectIndex(root)
      expect(facts).toHaveLength(5)
      const second = await MemoryLevels.promoteSessionFacts(root, "ses-1")
      expect(second.promoted).toHaveLength(0)
      // The 6th fact is still a candidate and still over the per-session cap, so it is reported again.
      expect(second.skipped).toEqual([{ id: expect.any(String), reason: "over-limit" }])
    })
  })

  test("only painful-to-restore facts qualify (a routine feature stays a candidate)", async () => {
    await withRoots(async (project) => {
      const root = projectRoot(project)
      await propose(root, "ses-1", "Поправили опечатку в комментарии", "feature")
      await propose(root, "ses-1", "Нашли, почему падает сборка на Windows", "bugfix")
      const result = await MemoryLevels.promoteSessionFacts(root, "ses-1")
      expect(result.promoted.map((fact) => fact.text)).toEqual(["Нашли, почему падает сборка на Windows"])
      expect(result.skipped).toEqual([{ id: expect.any(String), reason: "not-painful" }])
      const candidates = await MemoryLevels.readDailyCandidates(root)
      expect(candidates.find((candidate) => candidate.text.includes("опечатку"))?.status).toBe("candidate")
    })
  })

  test("a painful flag promotes even a routine type", async () => {
    await withRoots(async (project) => {
      const root = projectRoot(project)
      await MemoryLevels.appendDailyCandidate(
        root,
        {
          text: "Фича, которую больно восстанавливать: ручной разбор формата",
          type: "feature",
          sessionId: "ses-1",
          painful: true,
        },
        { date: DATE },
      )
      const result = await MemoryLevels.promoteSessionFacts(root, "ses-1")
      expect(result.promoted).toHaveLength(1)
    })
  })

  test("MEMORY.md refuses to grow past 12 KiB, fail-closed", async () => {
    await withRoots(async (project) => {
      const root = projectRoot(project)
      // Five max-size facts (2 000 chars each) from one session fill the
      // file to just under the budget; a sixth fact from another session
      // must be refused, not silently truncated.
      for (let i = 1; i <= 5; i++) await propose(root, "ses-1", `${i} `.padEnd(2000, "x"), "decision")
      const first = await MemoryLevels.promoteSessionFacts(root, "ses-1")
      expect(first.promoted).toHaveLength(5)
      await propose(root, "ses-2", "z".repeat(2000), "decision")
      const second = await MemoryLevels.promoteSessionFacts(root, "ses-2")
      expect(second.promoted).toHaveLength(0)
      expect(second.skipped).toEqual([{ id: expect.any(String), reason: "budget" }])
      const memory = await readFile(path.join(root, "MEMORY.md"), "utf8")
      expect(Buffer.byteLength(memory, "utf8")).toBeLessThanOrEqual(MemoryLevels.PROJECT_MEMORY_LIMIT_BYTES)
      expect(memory).not.toContain("z".repeat(100))
    })
  })

  test("promotion is idempotent: a second run promotes nothing twice", async () => {
    await withRoots(async (project) => {
      const root = projectRoot(project)
      const candidate = await propose(root, "ses-1", "Одно решение")
      await MemoryLevels.promoteSessionFacts(root, "ses-1")
      const again = await MemoryLevels.promoteSessionFacts(root, "ses-1")
      expect(again.promoted).toHaveLength(0)
      expect((await MemoryLevels.readProjectIndex(root)).map((fact) => fact.id)).toEqual([candidate.id])
    })
  })

  test("promotion in one project never touches the society root", async () => {
    await withRoots(async (project, society) => {
      const root = projectRoot(project)
      await propose(root, "ses-1", "Проектное решение")
      await MemoryLevels.promoteSessionFacts(root, "ses-1")
      expect(await exists(societyRoot(society))).toBe(false)
    })
  })

  test("actor notes land in actors/<name>.md", async () => {
    await withRoots(async (project) => {
      const root = projectRoot(project)
      await MemoryLevels.recordActor(root, "worker-1", "Разобрался в сборке", { date: DATE })
      const content = await readFile(path.join(root, "actors", "worker-1.md"), "utf8")
      expect(content).toContain("Разобрался в сборке")
      await expect(MemoryLevels.recordActor(root, "../escape", "x")).rejects.toThrow("lowercase slug")
    })
  })
})

describe("L2 search with progressive disclosure", () => {
  const seed = async (root: string) => {
    const a = await propose(root, "ses-1", "Решили хранить DoD в git, а не в базе данных")
    const b = await propose(root, "ses-2", "Нашли, почему падает сборка на Windows: обратные слеши в путях")
    await MemoryLevels.promoteSessionFacts(root, "ses-1")
    await MemoryLevels.promoteSessionFacts(root, "ses-2")
    await MemoryLevels.recordActor(root, "worker-1", "Разбирался в сборке на Windows", { date: DATE })
    return { a, b }
  }

  test("search returns compact hits with a token estimate, not full text", async () => {
    await withRoots(async (project) => {
      const root = projectRoot(project)
      const { a } = await seed(root)
      const hits = await MemoryLevels.searchProjectMemory(root, "DoD git")
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0].id).toBe(a.id)
      expect(hits[0].kind).toBe("fact")
      expect(hits[0].approxTokens).toBeLessThanOrEqual(100)
      expect(Object.keys(hits[0]).sort()).toEqual(["approxTokens", "id", "kind", "score", "title"])
    })
  })

  test("timeline returns chronological context around a hit", async () => {
    await withRoots(async (project) => {
      const root = projectRoot(project)
      const { b } = await seed(root)
      const entries = await MemoryLevels.timelineProjectMemory(root, { ids: [b.id] })
      expect(entries.map((entry) => entry.id)).toContain(b.id)
      expect(entries.length).toBeGreaterThan(1)
      const dates = entries.map((entry) => entry.date)
      expect([...dates].sort()).toEqual(dates)
      expect(entries.every((entry) => entry.snippet.length <= 200)).toBe(true)
    })
  })

  test("get returns full details only for the requested ids", async () => {
    await withRoots(async (project) => {
      const root = projectRoot(project)
      const { a, b } = await seed(root)
      const details = await MemoryLevels.getProjectMemoryFacts(root, [b.id, "f_missing", a.id])
      expect(details.map((fact) => fact.id)).toEqual([b.id, a.id])
      expect(details[0].text).toContain("падает сборка на Windows")
      expect(details[0].promotedAt).toBeDefined()
    })
  })

  test("search is safe against injection strings", async () => {
    await withRoots(async (project) => {
      const root = projectRoot(project)
      await seed(root)
      const total = (await MemoryLevels.readProjectIndex(root)).length
      expect(total).toBe(2)
      const attacks = [
        `" OR 1=1 --`,
        `'; DROP TABLE docs; --`,
        `*`,
        `"(a"`,
        `foo\nbar`,
        `x`.repeat(10_000),
        `MATCH (content) AGAINST ('*')`,
      ]
      for (const query of attacks) {
        const hits = await MemoryLevels.searchProjectMemory(root, query)
        expect(hits.length).toBeLessThanOrEqual(2)
        expect(hits.length).toBeGreaterThanOrEqual(0)
      }
      expect(await MemoryLevels.searchProjectMemory(root, "")).toEqual([])
      expect(await MemoryLevels.searchProjectMemory(root, "   ")).toEqual([])
    })
  })
})

describe("L1 society memory", () => {
  test("human writes everything, council writes decisions/lessons/rules, agent writes nothing directly", async () => {
    await withRoots(async (_project, society) => {
      const root = societyRoot(society)
      await MemoryLevels.initSocietyMemory(root)
      expect(MemoryLevels.canWriteSociety("human", "charter.md")).toBe(true)
      expect(MemoryLevels.canWriteSociety("council", "decisions/d-1.md")).toBe(true)
      expect(MemoryLevels.canWriteSociety("council", "charter.md")).toBe(false)
      expect(MemoryLevels.canWriteSociety("agent", "MEMORY.md")).toBe(false)
      expect(MemoryLevels.canWriteSociety("orchestrator", "rules.md")).toBe(false)
      await MemoryLevels.writeSocietyFile(root, "human", "charter.md", "# Устав\n")
      await expect(MemoryLevels.writeSocietyFile(root, "agent", "charter.md", "# Взлом\n")).rejects.toThrow(
        "may not write",
      )
      expect(await readFile(path.join(root, "charter.md"), "utf8")).toBe("# Устав\n")
      await expect(MemoryLevels.writeSocietyFile(root, "council", "../escape.md", "x")).rejects.toThrow(
        "Not a society memory file",
      )
    })
  })

  test("orchestrator and agent proposals land in the society daily, never in decisions", async () => {
    await withRoots(async (_project, society) => {
      const root = societyRoot(society)
      await MemoryLevels.initSocietyMemory(root)
      const proposal = await MemoryLevels.proposeToSociety(
        root,
        { author: "worker-1", role: "agent", kind: "lesson", text: "Сборка падает из-за слешей" },
        { date: DATE },
      )
      const daily = await readFile(path.join(root, "daily", `${DATE}.md`), "utf8")
      expect(daily).toContain(proposal.id)
      expect(daily).toContain("Сборка падает из-за слешей")
      expect(await readdir(path.join(root, "decisions"))).toEqual([])
    })
  })

  test("promotion L2→L1 moves only decisions/lessons/rules and only by human or council", async () => {
    await withRoots(async (project, society) => {
      const proot = projectRoot(project)
      const sroot = societyRoot(society)
      await MemoryLevels.initSocietyMemory(sroot)
      const candidate = await propose(proot, "ses-1", "Решили хранить DoD в git")
      await MemoryLevels.promoteSessionFacts(proot, "ses-1")
      await expect(
        MemoryLevels.promoteProjectToSociety(proot, sroot, { by: "agent", kind: "decision", factIds: [candidate.id] }),
      ).rejects.toThrow("Only a human or the council")
      const result = await MemoryLevels.promoteProjectToSociety(proot, sroot, {
        by: "council",
        kind: "decision",
        factIds: [candidate.id, "f_missing"],
        projectName: "orchestra-app",
      })
      expect(result.promoted.map((fact) => fact.id)).toEqual([candidate.id])
      expect(result.skipped).toEqual([{ id: "f_missing", reason: "not-found" }])
      const decision = await readFile(path.join(sroot, "decisions", `${candidate.id}.md`), "utf8")
      expect(decision).toContain("Решили хранить DoD в git")
      expect(decision).toContain("orchestra-app")
      const again = await MemoryLevels.promoteProjectToSociety(proot, sroot, {
        by: "human",
        kind: "decision",
        factIds: [candidate.id],
      })
      expect(again.promoted).toHaveLength(0)
      expect(again.skipped).toEqual([{ id: candidate.id, reason: "duplicate" }])
    })
  })

  test("hard society rules outrank everything; soft rules resolve most-specific-first", async () => {
    const society = MemoryLevels.parseSocietyRules(
      "# Правила\n\n## hard\n- [*] Никогда не трогать реальный экран пользователя\n\n## soft\n- [project:*] Писать тесты на каждую правку\n- [project:orchestra:core] Тесты гонять из директории пакета\n",
    )
    const project = {
      hard: [{ text: "Проектное жёсткое", hard: true, applies: "*", specificity: 0 }],
      soft: [{ text: "Проектное мягкое", hard: false, applies: "project:orchestra", specificity: 2 }],
    }
    const resolved = MemoryLevels.resolveRules(society, project)
    expect(resolved.map((rule) => rule.text)).toEqual([
      "Никогда не трогать реальный экран пользователя",
      "Проектное жёсткое",
      "Тесты гонять из директории пакета",
      "Проектное мягкое",
      "Писать тесты на каждую правку",
    ])
  })

  test("acl.yaml mirrors the in-code ACL table", async () => {
    await withRoots(async (_project, society) => {
      const root = societyRoot(society)
      await MemoryLevels.initSocietyMemory(root)
      const acl = await readFile(path.join(root, "acl.yaml"), "utf8")
      expect(acl).toContain("human: MEMORY.md, charter.md, rules.md")
      expect(acl).toContain("agent: (только предложения в daily)")
      expect(acl).toContain("council: decisions/, lessons/, rules.md")
    })
  })

  test("init is idempotent and never overwrites a human file", async () => {
    await withRoots(async (_project, society) => {
      const root = societyRoot(society)
      const first = await MemoryLevels.initSocietyMemory(root)
      expect(first).toContain("charter.md")
      await writeFile(path.join(root, "charter.md"), "# Наш устав\n")
      const second = await MemoryLevels.initSocietyMemory(root)
      expect(second).not.toContain("charter.md")
      expect(await readFile(path.join(root, "charter.md"), "utf8")).toBe("# Наш устав\n")
    })
  })
})

describe("secret scrub hook-point", () => {
  test("a supplied scrub function is applied before any write", async () => {
    await withRoots(async (project) => {
      const root = projectRoot(project)
      const scrub: MemoryLevels.ScrubFn = (text) => text.replaceAll("sk-SECRET", "[redacted]")
      await MemoryLevels.appendDailyCandidate(
        root,
        { text: "Ключ sk-SECRET нашли в логах", type: "decision", sessionId: "ses-1" },
        { date: DATE, scrub },
      )
      const daily = await readFile(path.join(root, "daily", `${DATE}.md`), "utf8")
      expect(daily).toContain("[redacted]")
      expect(daily).not.toContain("sk-SECRET")
      const result = await MemoryLevels.promoteSessionFacts(root, "ses-1", { scrub })
      expect(result.promoted).toHaveLength(1)
      const memory = await readFile(path.join(root, "MEMORY.md"), "utf8")
      expect(memory).not.toContain("sk-SECRET")
    })
  })

  test("without an explicit scrub the foundation scrubber applies by default (merge wiring)", async () => {
    await withRoots(async (project) => {
      const root = projectRoot(project)
      const key = "sk-abcdefgh12345678"
      await MemoryLevels.appendDailyCandidate(
        root,
        { text: `Нашли ключ ${key} в логах`, type: "decision", sessionId: "ses-1" },
        { date: DATE },
      )
      const daily = await readFile(path.join(root, "daily", `${DATE}.md`), "utf8")
      expect(daily).not.toContain(key)
      expect(daily).toContain("[REDACTED]")
      const result = await MemoryLevels.promoteSessionFacts(root, "ses-1")
      expect(result.promoted).toHaveLength(1)
      const memory = await readFile(path.join(root, "MEMORY.md"), "utf8")
      expect(memory).not.toContain(key)
    })
  })
})
