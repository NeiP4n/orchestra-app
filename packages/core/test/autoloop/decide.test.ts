import { describe, expect, test } from "bun:test"
import { decide } from "@orchestra/core/autoloop/kernel/decide"
import type { DecideEnv, DecideInput, Job } from "@orchestra/core/autoloop/kernel/decide"
import { emptyView, evolve } from "@orchestra/core/autoloop/kernel/evolve"
import type { View } from "@orchestra/core/autoloop/kernel/evolve"
import { emptyRules, eventRule, typeMatches } from "@orchestra/core/autoloop/kernel/rules"
import type { Rules } from "@orchestra/core/autoloop/kernel/rules"

const T0 = Date.parse("2026-11-05T21:00:00.000Z")
const MINUTE = 60_000

const rules: Rules = {
  ...emptyRules("UTC"),
  sources: { user: { name: "user" } },
  agents: {
    coder: { name: "coder", worker: "worker-1", use: "code", access: "edit" },
  },
  channels: {},
  rules: [
    {
      name: "build",
      when: { source: "user", types: ["task.created"] },
      to: "coder",
      cwd: "/tmp/work",
      group: "build",
      tell: "needed",
    },
  ],
}

const env = (seq = 1): DecideEnv => ({ rules, tokenSecret: "test-secret", seq, rulesVersion: 1 })

const step = (view: View, input: DecideInput, now: number, seq = 1) => {
  const result = decide(view, input, now, env(seq))
  return { view: result.facts.reduce(evolve, view), value: result.value, facts: result.facts }
}

const runRow = (view: View, id: number) => view["runs"]?.[String(id)] as Record<string, unknown> | undefined
const cardRows = (view: View) => Object.values(view["cards"] ?? {}) as Array<Record<string, unknown>>
const eventRows = (view: View) => Object.values(view["events"] ?? {}) as Array<Record<string, unknown>>

const ingestTask = (view: View, now: number, id = "evt-1") =>
  step(view, { type: "ingest", args: ["user", { id, type: "task.created", subject: "task-1", summary: "make it" }] }, now)

const claimTask = (view: View, now: number, claim = "claim-1", seq = 2) => {
  const claimed = step(view, { type: "claimNext", args: ["worker-1", claim] }, now, seq)
  return { ...claimed, job: claimed.value as Job }
}

describe("AutoloopDecide rules", () => {
  test("typeMatches supports exact, star and prefix patterns", () => {
    expect(typeMatches(["task.created"], "task.created")).toBe(true)
    expect(typeMatches(["task.*"], "task.created")).toBe(true)
    expect(typeMatches(["*"], "anything.at.all")).toBe(true)
    expect(typeMatches(["task.created"], "task.failed")).toBe(false)
    expect(eventRule(rules.rules[0]!)).toBe(true)
    expect(eventRule({ ...rules.rules[0]!, when: { cron: "* * * * *" } })).toBe(false)
  })
})

describe("AutoloopDecide ingest", () => {
  test("the same event from the same source is processed once", () => {
    const first = ingestTask(emptyView(), T0)
    const second = step(first.view, { type: "ingest", args: ["user", { id: "evt-1", type: "task.created" }] }, T0 + 1000)

    expect(first.value).toMatchObject({ event: 1, duplicate: false, routed: ["build"] })
    expect(second.value).toMatchObject({ event: 1, duplicate: true, routed: ["build"] })
    expect(second.facts).toEqual([])
    expect(second.view).toEqual(first.view)
  })

  test("ingest routes the event to the matching rule and queues a run", () => {
    const { view, value } = ingestTask(emptyView(), T0)

    expect(value).toMatchObject({ duplicate: false, routed: ["build"] })
    expect(runRow(view, 1)).toMatchObject({ rule: "build", agent: "coder", grp: "build", state: "queued" })
  })

  test("an event deeper than MAX_HOPS is recorded but not dispatched", () => {
    const { view, value } = step(emptyView(), { type: "ingest", args: ["user", { id: "evt-deep", type: "task.created", hops: 9 }] }, T0)

    expect(value).toMatchObject({ duplicate: false, routed: [] })
    expect(runRow(view, 1)).toBeUndefined()
    expect(eventRows(view)).toHaveLength(1)
    expect(cardRows(view).map((card) => card["key"])).toEqual(["hops:user:evt-deep"])
  })
})

describe("AutoloopDecide claim and finish", () => {
  test("a repeated claim with the same token returns the same run and token", () => {
    const ingested = ingestTask(emptyView(), T0)
    const first = claimTask(ingested.view, T0)
    const second = claimTask(first.view, T0 + 1000)

    expect(first.job).toMatchObject({ run: 1, rule: "build", agent: "coder", cwd: "/tmp/work" })
    expect(first.job.token).toMatch(/^[0-9a-f]{32}$/)
    expect(second.job.run).toBe(first.job.run)
    expect(second.job.token).toBe(first.job.token)
  })

  test("finish is idempotent: the same receipt twice gives the same answer and changes nothing", () => {
    const ingested = ingestTask(emptyView(), T0)
    const claimed = claimTask(ingested.view, T0)
    const receipt = { outcome: "done", summary: "built" }
    const first = step(claimed.view, { type: "finish", args: [1, claimed.job.token, receipt] }, T0 + 1000, 3)
    const second = step(first.view, { type: "finish", args: [1, claimed.job.token, receipt] }, T0 + 2000, 4)

    expect(first.value).toEqual({ rejected: [] })
    expect(second.value).toMatchObject({ rejected: [], duplicate: true })
    expect(second.facts).toEqual([])
    expect(runRow(second.view, 1)).toMatchObject({ state: "done", summary: "built" })
  })

  test("a different receipt under the same token is a conflict", () => {
    const ingested = ingestTask(emptyView(), T0)
    const claimed = claimTask(ingested.view, T0)
    const finished = step(claimed.view, { type: "finish", args: [1, claimed.job.token, { outcome: "done", summary: "built" }] }, T0 + 1000, 3)

    expect(() =>
      decide(finished.view, { type: "finish", args: [1, claimed.job.token, { outcome: "done", summary: "other" }] }, T0 + 2000, env(4)),
    ).toThrow("этот раунд уже сдал другой результат")
  })

  test("a wrong token cannot finish a run", () => {
    const ingested = ingestTask(emptyView(), T0)
    const claimed = claimTask(ingested.view, T0)

    expect(() =>
      decide(claimed.view, { type: "finish", args: [1, "not-the-token", { outcome: "done" }] }, T0 + 1000, env(3)),
    ).toThrow("не принадлежит этому токену")
  })
})

describe("AutoloopDecide retryLater", () => {
  test("a failed run retries once after 5 minutes, then stops after the second failure", () => {
    const ingested = ingestTask(emptyView(), T0)
    const firstClaim = claimTask(ingested.view, T0)
    const failedOnce = step(
      firstClaim.view,
      { type: "finish", args: [1, firstClaim.job.token, { outcome: "failed", error: "boom" }] },
      T0 + 1000,
      3,
    )

    expect(runRow(failedOnce.view, 1)).toMatchObject({ state: "queued", attempts: 1 })
    expect(runRow(failedOnce.view, 1)?.["not_before"]).toBe(new Date(T0 + 1000 + 5 * MINUTE).toISOString())

    const secondClaim = claimTask(failedOnce.view, T0 + 6 * MINUTE, "claim-2", 4)
    expect(secondClaim.job.run).toBe(1)
    const failedTwice = step(
      secondClaim.view,
      { type: "finish", args: [1, secondClaim.job.token, { outcome: "failed", error: "boom again" }] },
      T0 + 7 * MINUTE,
      5,
    )

    expect(runRow(failedTwice.view, 1)).toMatchObject({ state: "cancelled", attempts: 2 })
    expect(cardRows(failedTwice.view).map((card) => card["key"])).toContain("run:1:stopped")
  })
})

describe("AutoloopDecide cards", () => {
  test("createCard with the same key does not create a duplicate", () => {
    const spec = { key: "ask-1", kind: "ask", title: "Which?", text: "Pick one", options: ["a", "b"] }
    const first = step(emptyView(), { type: "createCard", args: [spec] }, T0)
    const second = step(first.view, { type: "createCard", args: [spec] }, T0 + 1000)

    expect(first.value).toMatchObject({ duplicate: false })
    expect(second.value).toMatchObject({ duplicate: true, card: (first.value as { card: number }).card })
    expect(cardRows(second.view)).toHaveLength(1)
  })

  test("answering an ask card records card.answered and starts a new round", () => {
    const ingested = ingestTask(emptyView(), T0)
    const claimed = claimTask(ingested.view, T0)
    const finished = step(
      claimed.view,
      {
        type: "finish",
        args: [1, claimed.job.token, { outcome: "done", summary: "built", ask: [{ key: "q1", title: "Ship it?", text: "Ready?", options: ["yes", "no"] }] }],
      },
      T0 + 1000,
      3,
    )
    const card = cardRows(finished.view).find((row) => row["key"] === "thread:build::q1")
    expect(card).toMatchObject({ kind: "ask", state: "open", rule: "build" })

    const answered = step(finished.view, { type: "answer", args: [card!["id"], { choice: 0, by: "satria" }] }, T0 + 2000, 4)

    expect(answered.value).toMatchObject({ changed: true, state: "decided" })
    expect(eventRows(answered.view).map((event) => event["type"])).toContain("card.answered")
    expect(runRow(answered.view, 2)).toMatchObject({ rule: "build", state: "queued" })
  })

  test("nextCard hands a card out once, delivered stops resends, failed reschedules", () => {
    const created = step(
      emptyView(),
      { type: "createCard", args: [{ key: "ask-1", kind: "ask", title: "Which?", text: "Pick", options: ["a", "b"] }] },
      T0,
    )
    const cardId = (created.value as { card: number }).card

    const first = step(created.view, { type: "nextCard", args: ["web"] }, T0, 2)
    expect(first.value).toMatchObject({ id: cardId, kind: "ask", channel: "web" })

    const resting = step(first.view, { type: "nextCard", args: ["web"] }, T0, 3)
    expect(resting.value).toBeNull()

    const delivered = step(resting.view, { type: "delivered", args: ["web", cardId, 1, "msg-1"] }, T0 + 1000, 4)
    const afterDelivery = step(delivered.view, { type: "nextCard", args: ["web"] }, T0 + 1000, 5)
    expect(afterDelivery.value).toBeNull()

    const created2 = step(
      afterDelivery.view,
      { type: "createCard", args: [{ key: "ask-2", kind: "ask", title: "Again?", text: "Pick", options: ["a", "b"] }] },
      T0 + 1000,
      6,
    )
    const card2 = (created2.value as { card: number }).card
    const handed = step(created2.view, { type: "nextCard", args: ["web"] }, T0 + 1000, 7)
    expect(handed.value).toMatchObject({ id: card2 })
    const failed = step(handed.view, { type: "failed", args: ["web", card2, 1, "boom"] }, T0 + 1000, 8)
    const resent = step(failed.view, { type: "nextCard", args: ["web"] }, T0 + 1000 + 2 * MINUTE, 9)
    expect(resent.value).toMatchObject({ id: card2 })
  })
})

describe("AutoloopDecide cancel", () => {
  test("a queued run cancels at once; a claimed run is marked for cancellation", () => {
    const ingested = ingestTask(emptyView(), T0)
    const cancelled = step(ingested.view, { type: "cancel", args: [1] }, T0 + 1000)
    expect(runRow(cancelled.view, 1)).toMatchObject({ state: "cancelled" })

    const ingested2 = ingestTask(emptyView(), T0)
    const claimed = claimTask(ingested2.view, T0)
    const marked = step(claimed.view, { type: "cancel", args: [1] }, T0 + 1000, 3)
    expect(runRow(marked.view, 1)).toMatchObject({ state: "claimed" })
    expect(runRow(marked.view, 1)?.["cancel_at"]).toBe(new Date(T0 + 1000).toISOString())
  })
})

describe("AutoloopDecide verify iterations", () => {
  test("a failed code check requeues the run; after 5 rounds the run stops and asks a human", () => {
    let view = emptyView()
    view = ingestTask(view, T0).view
    for (let round = 1; round <= 5; round += 1) {
      const now = T0 + round * MINUTE
      const claimed = claimTask(view, now, `claim-${round}`, round + 1)
      expect(claimed.job.run).toBe(1)
      const finished = step(
        claimed.view,
        { type: "finish", args: [1, claimed.job.token, { outcome: "done", summary: "still broken", verifyFailed: true }] },
        now + 1000,
        round + 2,
      )
      view = finished.view
      if (round < 5) {
        expect(runRow(view, 1)).toMatchObject({ state: "queued", verifyIterations: round })
      }
    }
    expect(runRow(view, 1)).toMatchObject({ state: "cancelled", verifyIterations: 5 })
    const ask = cardRows(view).find((card) => card["key"] === "run:1:verify")
    expect(ask).toMatchObject({ kind: "ask", state: "open" })
    expect(ask?.["options"]).toHaveLength(3)
  })
})

describe("AutoloopDecide tick and sweep", () => {
  test("a run its worker stopped mentioning becomes unknown on tick", () => {
    const ingested = ingestTask(emptyView(), T0)
    const claimed = claimTask(ingested.view, T0)
    // The worker is alive (heartbeat at T0+4m) but no longer mentions the run.
    const heartbeated = step(claimed.view, { type: "heartbeat", args: ["worker-1", []] }, T0 + 4 * MINUTE, 3)
    const ticked = step(heartbeated.view, { type: "tick", args: [] }, T0 + 5 * MINUTE + 1000, 4)

    expect(runRow(ticked.view, 1)).toMatchObject({ state: "unknown" })
    expect(cardRows(ticked.view).map((card) => card["key"])).toContain("run:1:unknown")
  })

  test("a heartbeat stamps the worker and the runs it mentions", () => {
    const ingested = ingestTask(emptyView(), T0)
    const claimed = claimTask(ingested.view, T0)
    const heartbeated = step(claimed.view, { type: "heartbeat", args: ["worker-1", [1]] }, T0 + MINUTE, 3)

    expect(heartbeated.view["seen"]?.["worker:worker-1"]).toMatchObject({ kind: "worker", name: "worker-1" })
    expect(runRow(heartbeated.view, 1)?.["seen_at"]).toBe(new Date(T0 + MINUTE).toISOString())
  })

  test("a run of a worker that never comes back returns to the queue on tick", () => {
    const ingested = ingestTask(emptyView(), T0)
    const claimed = claimTask(ingested.view, T0)
    // No heartbeat at all: the worker is gone, the run went quiet 6 minutes ago.
    const ticked = step(claimed.view, { type: "tick", args: [] }, T0 + 6 * MINUTE + 1000, 3)

    expect(runRow(ticked.view, 1)).toMatchObject({ state: "queued", claim: null })
    expect(runRow(ticked.view, 1)?.["not_before"]).toBe(new Date(T0 + 6 * MINUTE + 1000).toISOString())
    const unknown = cardRows(ticked.view).find((card) => card["key"] === "run:1:unknown")
    expect(unknown).toMatchObject({ state: "closed", result: "возвращена в очередь: исполнитель не на связи" })
    // The lane is free again: another worker can claim the same run.
    const reclaimed = claimTask(ticked.view, T0 + 6 * MINUTE + 2000, "claim-2", 4)
    expect(reclaimed.job.run).toBe(1)
  })

  test("an unknown run returns to the queue once its worker goes quiet", () => {
    const ingested = ingestTask(emptyView(), T0)
    const claimed = claimTask(ingested.view, T0)
    // The worker is alive at T0+4m but no longer mentions the run: it goes unknown.
    const heartbeated = step(claimed.view, { type: "heartbeat", args: ["worker-1", []] }, T0 + 4 * MINUTE, 3)
    const ticked = step(heartbeated.view, { type: "tick", args: [] }, T0 + 5 * MINUTE + 1000, 4)
    expect(runRow(ticked.view, 1)).toMatchObject({ state: "unknown" })

    // The worker never comes back: on the next tick the unknown run is re-queued.
    const reticked = step(ticked.view, { type: "tick", args: [] }, T0 + 11 * MINUTE, 5)
    expect(runRow(reticked.view, 1)).toMatchObject({ state: "queued", claim: null })
  })

  test("an unknown run stays unknown while its worker is still alive", () => {
    const ingested = ingestTask(emptyView(), T0)
    const claimed = claimTask(ingested.view, T0)
    const heartbeated = step(claimed.view, { type: "heartbeat", args: ["worker-1", []] }, T0 + 4 * MINUTE, 3)
    const ticked = step(heartbeated.view, { type: "tick", args: [] }, T0 + 5 * MINUTE + 1000, 4)
    expect(runRow(ticked.view, 1)).toMatchObject({ state: "unknown" })

    // The worker comes back: it may still finish the run, so no re-queue.
    const back = step(ticked.view, { type: "heartbeat", args: ["worker-1", []] }, T0 + 6 * MINUTE, 5)
    const reticked = step(back.view, { type: "tick", args: [] }, T0 + 6 * MINUTE + 1000, 6)
    expect(runRow(reticked.view, 1)).toMatchObject({ state: "unknown" })
  })

  test("a cron rule fires on tick and queues a run", () => {
    const cronRules: Rules = {
      ...emptyRules("UTC"),
      agents: { coder: { name: "coder", worker: "worker-1", use: "code", access: "edit" } },
      channels: {},
      rules: [
        { name: "nightly", when: { cron: "0 22 * * *" }, to: "coder", cwd: "/tmp/work", group: "nightly", tell: "needed" },
      ],
    }
    const cronEnv: DecideEnv = { rules: cronRules, tokenSecret: "test-secret", seq: 1, rulesVersion: 1 }
    const at = Date.parse("2026-11-05T21:59:00.000Z")
    const first = decide(emptyView(), { type: "tick", args: [] }, at, cronEnv)
    const view = first.facts.reduce(evolve, emptyView())
    // First tick only learns the schedule (next run 22:00); the tick at 22:00 fires it.
    const second = decide(view, { type: "tick", args: [] }, at + MINUTE, { ...cronEnv, seq: 2 })
    const fired = second.facts.reduce(evolve, view)

    expect(runRow(fired, 1)).toMatchObject({ rule: "nightly", state: "queued" })
    expect(eventRows(fired).map((event) => event["type"])).toContain("schedule.tick")
  })
})

describe("AutoloopDecide cancelling a task (G2-12)", () => {
  /** Five failed code checks in a row: the run stops and asks a human. */
  const driveToVerifyAsk = (view: View) => {
    let current = ingestTask(view, T0).view
    for (let round = 1; round <= 5; round += 1) {
      const now = T0 + round * MINUTE
      const claimed = claimTask(current, now, `claim-${round}`, round + 1)
      const finished = step(
        claimed.view,
        { type: "finish", args: [1, claimed.job.token, { outcome: "done", summary: "still broken", verifyFailed: true }] },
        now + 1000,
        round + 2,
      )
      current = finished.view
    }
    return current
  }

  test("answering 'Отменить задачу' cancels the task and starts no new run", () => {
    const view = driveToVerifyAsk(emptyView())
    const ask = cardRows(view).find((card) => card["key"] === "run:1:verify")
    expect(ask?.["options"]).toEqual(["Исправить и проверить снова", "Принять без проверки", "Отменить задачу"])

    const answered = step(view, { type: "answer", args: [ask!["id"], { choice: 2, by: "satria" }] }, T0 + 6 * MINUTE, 8)

    expect(answered.value).toMatchObject({ changed: true, state: "decided", cancelled: true })
    expect(runRow(answered.view, 1)).toMatchObject({ state: "cancelled" })
    expect(runRow(answered.view, 2)).toBeUndefined()
    const event = eventRows(answered.view).find((row) => row["type"] === "card.answered")
    expect(event?.["detail"]).toContain("Отменить задачу")
  })

  test("answering 'Исправить и проверить снова' starts a new round with a fresh check count", () => {
    const view = driveToVerifyAsk(emptyView())
    const ask = cardRows(view).find((card) => card["key"] === "run:1:verify")

    const answered = step(view, { type: "answer", args: [ask!["id"], { choice: 0, by: "satria" }] }, T0 + 6 * MINUTE, 8)

    expect(answered.value).toMatchObject({ changed: true, state: "decided" })
    expect(answered.value).not.toMatchObject({ cancelled: true })
    expect(runRow(answered.view, 2)).toMatchObject({ rule: "build", state: "queued", verifyIterations: 0 })
    const event = eventRows(answered.view).find((row) => row["type"] === "card.answered")
    expect(event?.["detail"]).toContain("Исправить и проверить снова")
  })

  test("answering an ask card records the chosen option in the card.answered event", () => {
    const ingested = ingestTask(emptyView(), T0)
    const claimed = claimTask(ingested.view, T0)
    const finished = step(
      claimed.view,
      {
        type: "finish",
        args: [1, claimed.job.token, { outcome: "done", summary: "built", ask: [{ key: "q1", title: "Ship it?", text: "Ready?", options: ["yes", "no"] }] }],
      },
      T0 + 1000,
      3,
    )
    const card = cardRows(finished.view).find((row) => row["key"] === "thread:build::q1")

    const answered = step(finished.view, { type: "answer", args: [card!["id"], { choice: 1, text: "not yet", by: "satria" }] }, T0 + 2000, 4)

    const event = eventRows(answered.view).find((row) => row["type"] === "card.answered")
    expect(event?.["detail"]).toBe("no — not yet")
    expect(runRow(answered.view, 2)).toMatchObject({ rule: "build", state: "queued" })
  })
})

describe("AutoloopDecide repeat-error stop-word (idea #2)", () => {
  const stepWithLimits = (view: View, input: DecideInput, now: number, seq: number, limits: { maxAttempts: number; retryBaseMinutes: number }) => {
    const result = decide(view, input, now, { rules, tokenSecret: "test-secret", seq, rulesVersion: 1, limits })
    return { view: result.facts.reduce(evolve, view), value: result.value, facts: result.facts }
  }
  const claimWithLimits = (view: View, now: number, claim: string, seq: number, limits: { maxAttempts: number; retryBaseMinutes: number }) => {
    const claimed = stepWithLimits(view, { type: "claimNext", args: ["worker-1", claim] }, now, seq, limits)
    return { ...claimed, job: claimed.value as Job }
  }
  /** Fail the run once with `error`, starting from a claim at `now`. */
  const failOnce = (
    view: View,
    now: number,
    seq: number,
    error: string | undefined,
    limits: { maxAttempts: number; retryBaseMinutes: number },
  ) => {
    const claimed = claimWithLimits(view, now, `claim-${seq}`, seq, limits)
    expect(claimed.job.run).toBe(1)
    return stepWithLimits(
      claimed.view,
      { type: "finish", args: [1, claimed.job.token, { outcome: "failed", summary: "failed", error }] },
      now + 1000,
      seq + 1,
      limits,
    )
  }

  test("the same error three times in a row stops the run even when retries remain", () => {
    const limits = { maxAttempts: 5, retryBaseMinutes: 1 }
    let view = ingestTask(emptyView(), T0).view
    // Same failure, different ports: the fingerprint still says "same error".
    view = failOnce(view, T0, 2, "connect ECONNREFUSED 127.0.0.1:5432", limits).view
    expect(runRow(view, 1)).toMatchObject({ state: "queued", attempts: 1, error_repeat: 1 })
    view = failOnce(view, T0 + 3 * MINUTE, 4, "connect ECONNREFUSED 127.0.0.1:17890", limits).view
    expect(runRow(view, 1)).toMatchObject({ state: "queued", attempts: 2, error_repeat: 2 })
    view = failOnce(view, T0 + 8 * MINUTE, 6, "connect ECONNREFUSED 127.0.0.1:5433", limits).view

    expect(runRow(view, 1)).toMatchObject({ state: "cancelled", attempts: 3, error_repeat: 3 })
    expect(runRow(view, 1)?.["summary"]).toContain("Та же ошибка")
    expect(typeof runRow(view, 1)?.["error_fingerprint"]).toBe("string")
    const stopped = cardRows(view).find((card) => card["key"] === "run:1:stopped")
    expect(stopped?.["text"]).toContain("ECONNREFUSED")
  })

  test("different errors do not trip the stop-word", () => {
    const limits = { maxAttempts: 5, retryBaseMinutes: 1 }
    let view = ingestTask(emptyView(), T0).view
    view = failOnce(view, T0, 2, "database is locked", limits).view
    view = failOnce(view, T0 + 3 * MINUTE, 4, "port already in use", limits).view
    view = failOnce(view, T0 + 8 * MINUTE, 6, "database is locked", limits).view

    expect(runRow(view, 1)).toMatchObject({ state: "queued", attempts: 3, error_repeat: 1 })
    expect(runRow(view, 1)?.["summary"]).toBeNull()
  })

  test("three of the same within an hour stop the run even when not consecutive", () => {
    const limits = { maxAttempts: 10, retryBaseMinutes: 1 }
    let view = ingestTask(emptyView(), T0).view
    view = failOnce(view, T0, 2, "database is locked", limits).view
    view = failOnce(view, T0 + 3 * MINUTE, 4, "port already in use", limits).view
    view = failOnce(view, T0 + 8 * MINUTE, 6, "database is locked", limits).view
    view = failOnce(view, T0 + 17 * MINUTE, 8, "port already in use", limits).view
    view = failOnce(view, T0 + 30 * MINUTE, 10, "database is locked", limits).view

    expect(runRow(view, 1)).toMatchObject({ state: "cancelled", attempts: 5 })
    expect(runRow(view, 1)?.["summary"]).toContain("Та же ошибка")
  })

  test("a failure with no error text never trips the stop-word", () => {
    const limits = { maxAttempts: 5, retryBaseMinutes: 1 }
    let view = ingestTask(emptyView(), T0).view
    view = failOnce(view, T0, 2, undefined, limits).view
    view = failOnce(view, T0 + 3 * MINUTE, 4, undefined, limits).view
    view = failOnce(view, T0 + 8 * MINUTE, 6, undefined, limits).view

    expect(runRow(view, 1)).toMatchObject({ state: "queued", attempts: 3, error_repeat: 0 })
    expect(runRow(view, 1)?.["error_fingerprint"]).toBeNull()
  })
})
