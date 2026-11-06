import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  collectDecisions,
  countUnansweredCards,
  digestFilename,
  digestPath,
  promptFilename,
  renderDigest,
  renderDigestFromDisagreements,
  renderSessionPrompt,
  summarizeDecisions,
  writeDigest,
  writeSessionPrompt,
} from "@orchestra/core/autoloop/shadow"
import type { View } from "@orchestra/core/autoloop/kernel/evolve"

// Журнал за сутки: два законченных запуска, одна отвеченная карточка,
// одно событие, одна открытая карточка и один запуск, законченный раньше окна.
const view = (): View => ({
  runs: {
    1: {
      id: 1,
      rule: "orchestra-task",
      agent: "orchestrator",
      lane: "worker-1",
      state: "done",
      attempts: 1,
      finished_at: "2026-11-06T10:00:00.000Z",
      summary: "задача сделана",
      error: null,
    },
    2: {
      id: 2,
      rule: "orchestra-task",
      agent: "orchestrator",
      lane: "worker-2",
      state: "failed",
      attempts: 2,
      finished_at: "2026-11-06T11:00:00.000Z",
      summary: "упал дважды",
      error: "timeout",
    },
    3: {
      id: 3,
      rule: "orchestra-task",
      agent: "orchestrator",
      lane: "worker-1",
      state: "done",
      attempts: 1,
      finished_at: "2026-11-04T10:00:00.000Z",
      summary: "старый запуск",
      error: null,
    },
    4: {
      id: 4,
      rule: "orchestra-task",
      agent: "orchestrator",
      lane: "worker-3",
      state: "claimed",
      attempts: 1,
      finished_at: null,
      summary: null,
      error: null,
    },
  },
  cards: {
    1: { id: 1, title: "продолжить?", state: "decided", decided_at: "2026-11-06T12:00:00.000Z", agent: "orchestrator", rule: "orchestra-task", lane: "" },
    2: { id: 2, title: "без ответа", state: "open", decided_at: null, agent: null, rule: null, lane: "" },
  },
  events: {
    1: { id: 1, type: "task.created", subject: "новая задача", summary: "", received_at: "2026-11-06T09:00:00.000Z", hops: 0 },
  },
})

const since = Date.parse("2026-11-06T00:00:00.000Z")
const until = Date.parse("2026-11-07T00:00:00.000Z")

describe("ShadowDecisions", () => {
  test("collects only decisions finished inside the window", () => {
    const decisions = collectDecisions(view(), since, until)

    expect(decisions.map((decision) => decision.id)).toEqual(["event:1", "run:1", "run:2", "card:1"])
    expect(decisions.find((decision) => decision.id === "run:2")).toMatchObject({
      kind: "run",
      state: "failed",
      error: "timeout",
      attempts: 2,
    })
  })

  test("counts outcomes, agents, failures and retries", () => {
    const summary = summarizeDecisions(collectDecisions(view(), since, until))

    expect(summary.total).toBe(4)
    expect(summary.byState).toEqual({ "task.created": 1, done: 1, failed: 1, decided: 1 })
    expect(summary.byAgent).toEqual({ orchestrator: 3 })
    expect(summary.failed.map((decision) => decision.id)).toEqual(["run:2"])
    expect(summary.retried.map((decision) => decision.id)).toEqual(["run:2"])
  })

  test("counts open cards separately from the window", () => {
    expect(countUnansweredCards(view())).toBe(1)
  })

  test("session prompt lists every decision with its journal id", () => {
    const decisions = collectDecisions(view(), since, until)
    const summary = { ...summarizeDecisions(decisions), unansweredCards: countUnansweredCards(view()) }
    const prompt = renderSessionPrompt(new Date("2026-11-06T00:00:00.000Z"), decisions, summary)

    expect(prompt).toContain("run:2")
    expect(prompt).toContain("timeout")
    expect(prompt).toContain("Не выдумывай решения")
    expect(prompt).not.toContain("run:3")
    expect(prompt).not.toContain("run:4")
  })

  test("digest keeps the session text and names the counts", () => {
    const decisions = collectDecisions(view(), since, until)
    const summary = { ...summarizeDecisions(decisions), unansweredCards: 1 }
    const digest = renderDigest(new Date("2026-11-06T00:00:00.000Z"), summary, "Не согласен: run:2 стоило отменить раньше.")

    expect(digest).toContain("Проверено решений главного оркестратора: 4")
    expect(digest).toContain("Не согласен: run:2 стоило отменить раньше.")
  })

  test("structured disagreements render one section each, silence renders agreement", () => {
    const decisions = collectDecisions(view(), since, until)
    const summary = { ...summarizeDecisions(decisions), unansweredCards: 1 }
    const withDisagreement = renderDigestFromDisagreements(new Date("2026-11-06T00:00:00.000Z"), summary, [
      { decisionId: "run:2", claim: "два повтора зря", reason: "та же ошибка timeout дважды" },
    ])
    const silent = renderDigestFromDisagreements(new Date("2026-11-06T00:00:00.000Z"), summary, [])

    expect(withDisagreement).toContain("## run:2")
    expect(withDisagreement).toContain("два повтора зря")
    expect(silent).toContain("Несогласий нет")
  })

  test("digest and prompt file names are dated and live under shadow/", () => {
    const date = new Date("2026-11-06T00:00:00.000Z")

    expect(digestFilename(date)).toBe("shadow-digest-2026-11-06.md")
    expect(promptFilename(date)).toBe("shadow-prompt-2026-11-06.md")
    expect(digestPath("/data/society", date)).toBe(path.join("/data/society", "shadow", "shadow-digest-2026-11-06.md"))
  })

  test("writer stores prompt and digest in the society directory", async () => {
    const societyDir = await mkdtemp(path.join(tmpdir(), "shadow-society-"))
    const date = new Date("2026-11-06T00:00:00.000Z")
    const decisions = collectDecisions(view(), since, until)
    const summary = { ...summarizeDecisions(decisions), unansweredCards: 1 }

    const promptFile = await writeSessionPrompt(societyDir, date, decisions, summary)
    const digestFile = await writeDigest(societyDir, date, summary, "Несогласий нет.")
    const promptText = await readFile(promptFile, "utf8")
    const digestText = await readFile(digestFile, "utf8")

    expect(promptText).toContain("Теневой оркестратор")
    expect(digestText).toContain("Несогласий нет.")
    expect(promptFile).toBe(path.join(societyDir, "shadow", "shadow-prompt-2026-11-06.md"))
  })
})
