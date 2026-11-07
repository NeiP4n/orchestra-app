import { describe, expect, test } from "bun:test"
import { decide } from "@orchestra/core/autoloop/kernel/decide"
import type { DecideEnv, DecideInput, Job } from "@orchestra/core/autoloop/kernel/decide"
import type { ReplayResult, StopCheck } from "@orchestra/core/autoloop/kernel/attention"
import { emptyView, evolve } from "@orchestra/core/autoloop/kernel/evolve"
import type { View } from "@orchestra/core/autoloop/kernel/evolve"
import { emptyRules } from "@orchestra/core/autoloop/kernel/rules"
import type { Rules } from "@orchestra/core/autoloop/kernel/rules"

// Регрессионные тесты координации внимания (Agora MCP 0.8.4–0.8.6 —
// паттерны, не чужой код): запрет остановки, пока должен ответ,
// thread-aware ответы и replay пропущенного. Стиль — как в
// decide.test.ts: журнал строится шагами decide, без сети и без моделей.

const T0 = Date.parse("2026-11-05T21:00:00.000Z")
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const rules: Rules = {
  ...emptyRules("UTC"),
  sources: { user: { name: "user" } },
  agents: {
    coder: { name: "coder", worker: "worker-1", use: "code", access: "edit" },
  },
  channels: {},
  rules: [
    { name: "build", when: { source: "user", types: ["task.created"] }, to: "coder", cwd: "/tmp/work", group: "build", tell: "needed" },
    { name: "other", when: { source: "user", types: ["other.created"] }, to: "coder", cwd: "/tmp/work", group: "other", tell: "needed" },
  ],
}

const env = (seq = 1): DecideEnv => ({ rules, tokenSecret: "test-secret", seq, rulesVersion: 1 })

const step = (view: View, input: DecideInput, now: number, seq = 1) => {
  const result = decide(view, input, now, env(seq))
  return { view: result.facts.reduce(evolve, view), value: result.value, facts: result.facts }
}

const runRow = (view: View, id: number) => view["runs"]?.[String(id)] as Record<string, unknown> | undefined
const cardRow = (view: View, id: number) => view["cards"]?.[String(id)] as Record<string, unknown> | undefined

const ingest = (view: View, now: number, id: string, type: string, seq: number) =>
  step(view, { type: "ingest", args: ["user", { id, type, subject: id, summary: id }] }, now, seq)

const claim = (view: View, now: number, claimId: string, seq: number) => {
  const claimed = step(view, { type: "claimNext", args: ["worker-1", claimId] }, now, seq)
  return { ...claimed, job: claimed.value as Job }
}

/**
 * Тред с висящим вопросом: раунд 1 сдал результат и задал вопрос, раунд 2
 * в том же треде взят в работу. Возвращает вид, токен раунда 2 и номер
 * карточки с вопросом.
 */
const threadWithOpenQuestion = () => {
  const first = ingest(emptyView(), T0, "evt-1", "task.created", 1)
  const claimed1 = claim(first.view, T0, "claim-1", 2)
  const asked = step(
    claimed1.view,
    {
      type: "finish",
      args: [
        1,
        claimed1.job.token,
        { outcome: "done", summary: "built", ask: [{ key: "q1", title: "Уточнить задачу", text: "Какой вариант?", options: ["Да", "Нет"] }] },
      ],
    },
    T0 + MINUTE,
    3,
  )
  const second = ingest(asked.view, T0 + 2 * MINUTE, "evt-2", "task.created", 4)
  const claimed2 = claim(second.view, T0 + 2 * MINUTE, "claim-2", 5)
  return { view: claimed2.view, token2: claimed2.job.token, card: 1 }
}

describe("AutoloopAttention stop guard (Agora 0.8.6)", () => {
  test("a worker cannot stop cancelled while a question waits in its thread", () => {
    const { view, token2 } = threadWithOpenQuestion()

    expect(() =>
      decide(view, { type: "finish", args: [2, token2, { outcome: "cancelled", summary: "ухожу" }] }, T0 + 3 * MINUTE, env(6)),
    ).toThrow("ждут ответа")
    // Ничего не записано: раунд остался claimed, его можно завершить после ответа.
    expect(runRow(view, 2)).toMatchObject({ state: "claimed" })
  })

  test("stopCheck reports the pending question, then allows the stop once answered", () => {
    const { view, token2 } = threadWithOpenQuestion()

    const blocked = step(view, { type: "stopCheck", args: ["worker-1"] }, T0 + 3 * MINUTE, 6)
    expect(blocked.facts).toEqual([])
    expect(blocked.value).toMatchObject({ mayStop: false, threadsChecked: 1, threadsTotal: 1, truncated: false })
    expect((blocked.value as StopCheck).pending).toMatchObject([{ card: 1, title: "Уточнить задачу" }])

    const answered = step(view, { type: "answer", args: [1, { choice: 0, by: "op" }] }, T0 + 4 * MINUTE, 7)
    expect(cardRow(answered.view, 1)).toMatchObject({ state: "decided" })
    const allowed = step(answered.view, { type: "stopCheck", args: ["worker-1"] }, T0 + 5 * MINUTE, 8)
    expect(allowed.value).toMatchObject({ mayStop: true, pending: [] })

    const finished = step(
      answered.view,
      { type: "finish", args: [2, token2, { outcome: "cancelled", summary: "ухожу" }] },
      T0 + 6 * MINUTE,
      9,
    )
    expect(runRow(finished.view, 2)).toMatchObject({ state: "cancelled" })
  })

  test("a nothing receipt is blocked the same way: stopping without a result", () => {
    const { view, token2 } = threadWithOpenQuestion()

    expect(() =>
      decide(view, { type: "finish", args: [2, token2, { outcome: "nothing", summary: "нечего делать" }] }, T0 + 3 * MINUTE, env(6)),
    ).toThrow("ждут ответа")
    expect(runRow(view, 2)).toMatchObject({ state: "claimed" })
  })

  test("a done result passes with a pending question, and an operator cancel bypasses the guard", () => {
    const { view, token2 } = threadWithOpenQuestion()

    const done = step(view, { type: "finish", args: [2, token2, { outcome: "done", summary: "сделал" }] }, T0 + 3 * MINUTE, 6)
    expect(runRow(done.view, 2)).toMatchObject({ state: "done" })

    const fresh = threadWithOpenQuestion()
    const cancelled = step(fresh.view, { type: "cancel", args: [2] }, T0 + 3 * MINUTE, 6)
    expect(runRow(cancelled.view, 2)).toMatchObject({ cancel_at: expect.any(String) })
    const finished = step(
      cancelled.view,
      { type: "finish", args: [2, fresh.token2, { outcome: "cancelled", summary: "отменено оператором" }] },
      T0 + 4 * MINUTE,
      7,
    )
    expect(runRow(finished.view, 2)).toMatchObject({ state: "cancelled" })
  })

  test("stopCheck checks at most 5 threads and says so when there are more", () => {
    const manyRules: Rules = {
      ...emptyRules("UTC"),
      sources: { user: { name: "user" } },
      agents: { coder: { name: "coder", worker: "worker-1", use: "code", access: "edit" } },
      channels: {},
      rules: Array.from({ length: 7 }, (_, i) => ({
        name: `r${i + 1}`,
        when: { source: "user", types: ["task.created"] },
        to: "coder",
        cwd: "/tmp/work",
        group: `g${i + 1}`,
        tell: "needed" as const,
      })),
    }
    const runs: Record<string, unknown> = {}
    const cards: Record<string, unknown> = {}
    for (let i = 1; i <= 7; i++) {
      runs[String(i)] = {
        id: i,
        rule: `r${i}`,
        agent: "coder",
        grp: `g${i}`,
        lane: "",
        state: "claimed",
        claim: "c",
        issued: 1,
        seen_at: new Date(T0).toISOString(),
        not_before: new Date(T0).toISOString(),
        created_at: new Date(T0).toISOString(),
      }
      cards[String(i)] = {
        id: i,
        key: `q${i}`,
        kind: "ask",
        title: `Вопрос ${i}`,
        text: "?",
        options: ["Да", "Нет"],
        state: "open",
        rule: `r${i}`,
        lane: "",
        run_id: 999,
      }
    }
    const fabricated: View = { runs, cards }
    const checked = decide(
      fabricated,
      { type: "stopCheck", args: ["worker-1"] },
      T0 + MINUTE,
      { rules: manyRules, tokenSecret: "test-secret", seq: 1, rulesVersion: 1 },
    )
    expect(checked.facts).toEqual([])
    expect(checked.value).toMatchObject({ mayStop: false, threadsChecked: 5, threadsTotal: 7, truncated: true })
    expect((checked.value as StopCheck).pending).toHaveLength(5)
  })
})

describe("AutoloopAttention thread-aware replies (Agora 0.8.5)", () => {
  test("a receipt cannot resolve a card from another thread; its own thread resolves", () => {
    const first = ingest(emptyView(), T0, "evt-a", "task.created", 1)
    const second = ingest(first.view, T0, "evt-b", "other.created", 2)
    const claimed1 = claim(second.view, T0, "claim-1", 3)
    const claimed2 = claim(claimed1.view, T0, "claim-2", 4)
    const asked = step(
      claimed2.view,
      {
        type: "finish",
        args: [
          2,
          claimed2.job.token,
          { outcome: "done", summary: "built", ask: [{ key: "qx", title: "Вопрос из other", text: "?", options: ["Да", "Нет"] }] },
        ],
      },
      T0 + MINUTE,
      5,
    )
    expect(cardRow(asked.view, 1)).toMatchObject({ rule: "other", state: "open" })

    // Раунд из треда build пытается закрыть чужую карточку — отказ, карточка открыта.
    const foreign = step(
      asked.view,
      { type: "finish", args: [1, claimed1.job.token, { outcome: "done", summary: "built", resolve: [{ card: 1, reason: "разобрался" }] }] },
      T0 + 2 * MINUTE,
      6,
    )
    expect(foreign.value).toMatchObject({ rejected: [{ card: 1, reason: "карточка не в треде этого раунда" }] })
    expect(cardRow(foreign.view, 1)).toMatchObject({ state: "open" })

    // Свой тред — закрывается: раунд 3 в build задаёт вопрос, раунд 4 в build его закрывает.
    const third = ingest(foreign.view, T0 + 3 * MINUTE, "evt-c", "task.created", 7)
    const claimed3 = claim(third.view, T0 + 3 * MINUTE, "claim-3", 8)
    const askedOwn = step(
      claimed3.view,
      {
        type: "finish",
        args: [
          3,
          claimed3.job.token,
          { outcome: "done", summary: "built", ask: [{ key: "qy", title: "Свой вопрос", text: "?", options: ["Да", "Нет"] }] },
        ],
      },
      T0 + 4 * MINUTE,
      9,
    )
    const fourth = ingest(askedOwn.view, T0 + 5 * MINUTE, "evt-d", "task.created", 10)
    const claimed4 = claim(fourth.view, T0 + 5 * MINUTE, "claim-4", 11)
    const resolved = step(
      claimed4.view,
      { type: "finish", args: [4, claimed4.job.token, { outcome: "done", summary: "built", resolve: [{ card: 2, reason: "готово" }] }] },
      T0 + 6 * MINUTE,
      12,
    )
    expect(resolved.value).toEqual({ rejected: [] })
    expect(cardRow(resolved.view, 2)).toMatchObject({ state: "closed" })
  })

  test("an answer naming the wrong thread is rejected; the right thread and no thread answer fine", () => {
    const { view } = threadWithOpenQuestion()

    expect(() =>
      decide(view, { type: "answer", args: [1, { choice: 0, by: "op", thread: { rule: "other", lane: "" } }] }, T0 + 3 * MINUTE, env(6)),
    ).toThrow("ответ не в тот тред")
    expect(cardRow(view, 1)).toMatchObject({ state: "open" })

    const answered = step(
      view,
      { type: "answer", args: [1, { choice: 0, by: "op", thread: { rule: "build", lane: "" } }] },
      T0 + 3 * MINUTE,
      6,
    )
    expect(cardRow(answered.view, 1)).toMatchObject({ state: "decided" })
  })
})

describe("AutoloopAttention missed-attention replay (Agora 0.8.4)", () => {
  test("a returning worker gets the queued event and the open question since it was last seen", () => {
    const seen = step(emptyView(), { type: "heartbeat", args: ["worker-1", []] }, T0, 1)
    const first = ingest(seen.view, T0 + 10 * MINUTE, "evt-1", "task.created", 2)
    const claimed1 = claim(first.view, T0 + 10 * MINUTE, "claim-1", 3)
    const asked = step(
      claimed1.view,
      {
        type: "finish",
        args: [
          1,
          claimed1.job.token,
          { outcome: "done", summary: "built", ask: [{ key: "q1", title: "Уточнить задачу", text: "Какой вариант?", options: ["Да", "Нет"] }] },
        ],
      },
      T0 + 10 * MINUTE,
      4,
    )
    const second = ingest(asked.view, T0 + 20 * MINUTE, "evt-2", "task.created", 5)

    const replayed = step(second.view, { type: "replay", args: ["worker-1"] }, T0 + 30 * MINUTE, 6)
    expect(replayed.facts).toEqual([])
    const replay = replayed.value as ReplayResult
    expect(replay.worker).toBe("worker-1")
    expect(replay.since).toBe(new Date(T0).toISOString())
    expect(replay.droppedOlderThan24h).toBe(0)
    expect(replay.truncated).toBe(false)
    // Событие первого раунда не пропущено — его раунд завершён; пропущены
    // вопрос (10-я минута) и событие второго раунда (20-я минута), по порядку.
    expect(replay.missed.map((item) => [item.kind, item.id])).toEqual([
      ["card", 1],
      ["event", 2],
    ])
  })

  test("replay drops items older than 24 hours and counts them", () => {
    const seen = step(emptyView(), { type: "heartbeat", args: ["worker-1", []] }, T0, 1)
    const first = ingest(seen.view, T0 + MINUTE, "evt-1", "task.created", 2)

    const replayed = step(first.view, { type: "replay", args: ["worker-1"] }, T0 + 25 * HOUR, 3)
    const replay = replayed.value as ReplayResult
    expect(replay.since).toBe(new Date(T0 + HOUR).toISOString())
    expect(replay.missed).toEqual([])
    expect(replay.droppedOlderThan24h).toBe(1)
  })
})
