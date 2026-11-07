import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Event } from "@orchestra/schema/event"
import { Database } from "@orchestra/core/database/database"
import { AutoloopCards } from "@orchestra/core/autoloop/cards"
import type { CardChange, CardsEnv } from "@orchestra/core/autoloop/cards"
import { decide, RESEND_AT } from "@orchestra/core/autoloop/kernel/decide"
import type { DecideEnv, DecideInput, Job } from "@orchestra/core/autoloop/kernel/decide"
import { emptyRules } from "@orchestra/core/autoloop/kernel/rules"
import type { Rules } from "@orchestra/core/autoloop/kernel/rules"
import { AutoloopStore } from "@orchestra/core/autoloop/kernel/store"
import { Global } from "@orchestra/util/global"

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

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Database.layer({ path: ":memory:" })),
      Effect.provideService(Global.Service, Global.make({ data: path.join(process.cwd(), ".test-data") })),
      Effect.scoped,
    ),
  )

const envAt = (now: number): CardsEnv => ({ rules, now })

/** Apply one decide input straight to the journal, like the service will. */
const applyDecide = (input: DecideInput, now: number, seq: number) =>
  Effect.gen(function* () {
    const opened = yield* AutoloopStore.openView()
    const decideEnv: DecideEnv = { rules, tokenSecret: "test-secret", seq, rulesVersion: 1 }
    const result = decide(opened.view, input, now, decideEnv)
    yield* AutoloopStore.commitLatest(result.facts)
    return result.value
  })

/** A run that asked a question: ingest → claim → finish with an ask card. */
const askCardSetup = Effect.gen(function* () {
  yield* applyDecide(
    { type: "ingest", args: ["user", { id: "evt-1", type: "task.created", subject: "task-1", summary: "make it" }] },
    T0,
    1,
  )
  const job = (yield* applyDecide({ type: "claimNext", args: ["worker-1", "claim-1"] }, T0, 2)) as Job
  yield* applyDecide(
    {
      type: "finish",
      args: [
        1,
        job.token,
        { outcome: "done", summary: "built", ask: [{ key: "q1", title: "Ship it?", text: "Ready?", options: ["yes", "no"] }] },
      ],
    },
    T0 + 1000,
    3,
  )
  const cards = yield* AutoloopCards.listOpenCards()
  return cards[0]!
})

const seenEvents: Array<{ type: string; card: unknown }> = []
const fakePublisher = {
  publish: <D extends Event.Definition>(definition: D, data: Event.Data<D>) =>
    Effect.sync(() => {
      seenEvents.push({ type: definition.type, card: (data as { card: unknown }).card })
      return {
        id: Event.ID.create(),
        created: Date.now(),
        type: definition.type,
        data,
      } as Event.Payload<D>
    }),
}

describe("AutoloopCards list and create", () => {
  test("a card created through the API is visible in the open list", async () => {
    await run(
      Effect.gen(function* () {
        const created = yield* AutoloopCards.createCard(
          { key: "ask-1", kind: "ask", title: "Which?", text: "Pick one", options: ["a", "b"] },
          { now: T0 },
        )

        expect(created.duplicate).toBe(false)
        expect(created.card).toMatchObject({ key: "ask-1", kind: "ask", state: "open", title: "Which?" })
        expect(created.events).toHaveLength(1)
        expect(created.events[0]?.type).toBe("created")

        const open = yield* AutoloopCards.listOpenCards()
        expect(open).toHaveLength(1)
        expect(open[0]?.id).toBe(created.card.id)
      }),
    )
  })

  test("a second card with the same key is a duplicate, not a second card", async () => {
    await run(
      Effect.gen(function* () {
        const spec = { key: "ask-1", kind: "ask" as const, title: "Which?", text: "Pick", options: ["a", "b"] }
        const first = yield* AutoloopCards.createCard(spec, { now: T0 })
        const before = yield* AutoloopStore.readLog()
        const second = yield* AutoloopCards.createCard(spec, { now: T0 + 1000 })
        const after = yield* AutoloopStore.readLog()

        expect(second).toMatchObject({ duplicate: true, card: { id: first.card.id } })
        expect(second.events).toEqual([])
        expect(after).toHaveLength(before.length)
        expect(yield* AutoloopCards.listOpenCards()).toHaveLength(1)
      }),
    )
  })

  test("create publishes a created event, answer publishes an answered event", async () => {
    await run(
      Effect.gen(function* () {
        seenEvents.length = 0
        const created = yield* AutoloopCards.createCard(
          { key: "ask-1", kind: "ask", title: "Which?", text: "Pick", options: ["a", "b"] },
          { now: T0 },
        )
        yield* AutoloopCards.publish(fakePublisher, created.events)
        const answered = yield* AutoloopCards.answerCard(created.card.id, { choice: 1, by: "satria" }, { now: T0 + 1000 })
        yield* AutoloopCards.publish(fakePublisher, answered.events)

        expect(seenEvents.map((event) => event.type)).toEqual(["autoloop.card.created", "autoloop.card.answered"])
        expect((seenEvents[1]?.card as { state: string }).state).toBe("decided")
      }),
    )
  })
})

describe("AutoloopCards answer", () => {
  test("answering an ask card records card.answered and starts a new round", async () => {
    await run(
      Effect.gen(function* () {
        const card = yield* askCardSetup
        expect(card).toMatchObject({ kind: "ask", state: "open", title: "Ship it?" })

        const answered = yield* AutoloopCards.answerCard(card.id, { choice: 0, by: "satria" }, envAt(T0 + 2000))

        expect(answered.changed).toBe(true)
        expect(answered.card).toMatchObject({ state: "decided", choice: 0, answer: null, by: "satria" })
        expect(answered.newRunId).toBe(2)
        expect(answered.events.map((event: CardChange) => event.type)).toEqual(["answered"])

        const { view } = yield* AutoloopStore.openView()
        const events = Object.values(view["events"] ?? {}) as Array<Record<string, unknown>>
        expect(events.map((event) => event["type"])).toContain("card.answered")
        const runs = Object.values(view["runs"] ?? {}) as Array<Record<string, unknown>>
        expect(runs.find((run) => run["id"] === 2)).toMatchObject({ rule: "build", state: "queued" })
        expect(yield* AutoloopCards.listOpenCards()).toHaveLength(0)
        expect(yield* AutoloopCards.listCards()).toHaveLength(1)
      }),
    )
  })

  test("answering 'Отменить задачу' starts no new run (newRunId null)", async () => {
    await run(
      Effect.gen(function* () {
        yield* applyDecide(
          { type: "ingest", args: ["user", { id: "evt-1", type: "task.created", subject: "task-1", summary: "make it" }] },
          T0,
          1,
        )
        for (let round = 1; round <= 5; round += 1) {
          const now = T0 + round * MINUTE
          const job = (yield* applyDecide({ type: "claimNext", args: ["worker-1", `claim-${round}`] }, now, round + 1)) as Job
          yield* applyDecide(
            { type: "finish", args: [1, job.token, { outcome: "done", summary: ["login test fails", "checkout test fails", "lint fails", "build fails", "typecheck fails"][round - 1], verifyFailed: true }] },
            now + 1000,
            round + 2,
          )
        }
        const cards = yield* AutoloopCards.listOpenCards()
        const ask = cards.find((card) => card.key === "run:1:verify")!
        const answered = yield* AutoloopCards.answerCard(ask.id, { choice: 2, by: "satria" }, envAt(T0 + 6 * MINUTE))

        expect(answered.changed).toBe(true)
        expect(answered.card).toMatchObject({ state: "decided", choice: 2 })
        expect(answered.newRunId).toBeNull()
        const { view } = yield* AutoloopStore.openView()
        const runs = Object.values(view["runs"] ?? {}) as Array<Record<string, unknown>>
        expect(runs).toHaveLength(1)
        expect(runs[0]).toMatchObject({ id: 1, state: "cancelled" })
      }),
    )
  })

  test("answering the same card twice changes nothing the second time", async () => {
    await run(
      Effect.gen(function* () {
        const card = yield* askCardSetup
        const first = yield* AutoloopCards.answerCard(card.id, { choice: 0, by: "satria" }, envAt(T0 + 2000))
        const before = yield* AutoloopStore.readLog()
        const second = yield* AutoloopCards.answerCard(card.id, { choice: 1, by: "satria" }, envAt(T0 + 3000))
        const after = yield* AutoloopStore.readLog()

        expect(first.changed).toBe(true)
        expect(second.changed).toBe(false)
        expect(second.card).toMatchObject({ state: "decided", choice: 0 })
        expect(second.events).toEqual([])
        expect(after).toHaveLength(before.length)
      }),
    )
  })

  test("answering a card that does not exist fails as not-found", async () => {
    await run(
      Effect.gen(function* () {
        const error = yield* AutoloopCards.answerCard(99, { choice: 0 }, { now: T0 }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(AutoloopCards.CardsFailure)
        expect(error as AutoloopCards.CardsFailure).toMatchObject({ code: "not-found" })
      }),
    )
  })

  test("answering with an option that does not exist fails as invalid", async () => {
    await run(
      Effect.gen(function* () {
        const card = yield* askCardSetup
        const error = yield* AutoloopCards.answerCard(card.id, { choice: 5 }, envAt(T0 + 2000)).pipe(Effect.flip)
        expect(error).toBeInstanceOf(AutoloopCards.CardsFailure)
        expect(error as AutoloopCards.CardsFailure).toMatchObject({ code: "invalid" })
      }),
    )
  })
})

describe("AutoloopCards delivery", () => {
  test("nextCard hands a card out once, delivered stops resends, failed reschedules", async () => {
    await run(
      Effect.gen(function* () {
        const created = yield* AutoloopCards.createCard(
          { key: "ask-1", kind: "ask", title: "Which?", text: "Pick", options: ["a", "b"] },
          { now: T0 },
        )
        const first = yield* AutoloopCards.nextCard("web", { now: T0 })
        expect(first.card?.id).toBe(created.card.id)

        // Resting a minute after the hand-out.
        expect((yield* AutoloopCards.nextCard("web", { now: T0 })).card).toBeNull()

        yield* AutoloopCards.markDelivered("web", created.card.id, 1, "msg-1", { now: T0 + 1000 })
        expect((yield* AutoloopCards.nextCard("web", { now: T0 + 1000 })).card).toBeNull()

        const second = yield* AutoloopCards.createCard(
          { key: "ask-2", kind: "ask", title: "Again?", text: "Pick", options: ["a", "b"] },
          { now: T0 + 1000 },
        )
        const handed = yield* AutoloopCards.nextCard("web", { now: T0 + 1000 })
        expect(handed.card?.id).toBe(second.card.id)
        yield* AutoloopCards.markFailed("web", second.card.id, 1, "boom", { now: T0 + 1000 })
        // First resend is one minute after the first try.
        expect((yield* AutoloopCards.nextCard("web", { now: T0 + 1000 })).card).toBeNull()
        const resent = yield* AutoloopCards.nextCard("web", { now: T0 + 1000 + 2 * MINUTE })
        expect(resent.card?.id).toBe(second.card.id)
      }),
    )
  })

  test("after 57 minutes of failed sends the channel gives up", async () => {
    await run(
      Effect.gen(function* () {
        const created = yield* AutoloopCards.createCard(
          { key: "ask-1", kind: "ask", title: "Which?", text: "Pick", options: ["a", "b"] },
          { now: T0 },
        )
        let now = T0
        for (let attempt = 0; attempt < RESEND_AT.length; attempt++) {
          const handed = yield* AutoloopCards.nextCard("web", { now })
          expect(handed.card?.id).toBe(created.card.id)
          yield* AutoloopCards.markFailed("web", created.card.id, 1, "boom", { now })
          // Next hand-out is due at the next RESEND_AT step after the first try.
          now = T0 + (RESEND_AT[attempt + 1] ?? 57) * MINUTE + 1000
        }
        expect((yield* AutoloopCards.nextCard("web", { now })).card).toBeNull()
        const { view } = yield* AutoloopStore.openView()
        const delivery = view["deliveries"]?.[`${created.card.id}:web`] as Record<string, unknown> | undefined
        expect(delivery).toMatchObject({ given_up: 1 })
      }),
    )
  })
})

describe("AutoloopCards disputes", () => {
  test("raising a dispute returns its id, level and deadline; resolving stops it", async () => {
    await run(
      Effect.gen(function* () {
        const raised = yield* AutoloopCards.raiseDispute(
          { subject: "format", positionA: "JSON", positionB: "YAML" },
          { now: T0 },
        )
        expect(raised).toMatchObject({ dispute: 1, level: "agent", deadline: new Date(T0 + 15 * MINUTE).toISOString() })

        const resolved = yield* AutoloopCards.resolveDispute(raised.dispute, "JSON it is", { now: T0 + 1000 })
        expect(resolved).toEqual({ resolved: true })
        const again = yield* AutoloopCards.resolveDispute(raised.dispute, "JSON it is", { now: T0 + 2000 })
        expect(again).toEqual({ resolved: false })
      }),
    )
  })

  test("escalating moves the dispute up one rung", async () => {
    await run(
      Effect.gen(function* () {
        const raised = yield* AutoloopCards.raiseDispute(
          { subject: "format", positionA: "JSON", positionB: "YAML" },
          { now: T0 },
        )
        const moved = yield* AutoloopCards.escalateDispute(raised.dispute, { now: T0 + 1000 })
        expect(moved).toMatchObject({ escalated: true, level: "group-leader" })
        expect(moved.reason).toContain("group-leader")
      }),
    )
  })

  test("two answers racing on one card: exactly one changes it", async () => {
    await run(
      Effect.gen(function* () {
        const card = yield* askCardSetup
        const results = yield* Effect.all(
          [
            AutoloopCards.answerCard(card.id, { choice: 0, by: "a" }, envAt(T0 + 2000)),
            AutoloopCards.answerCard(card.id, { choice: 1, by: "b" }, envAt(T0 + 2000)),
          ],
          { concurrency: "unbounded" },
        )
        expect(results.map((result) => result.changed).sort()).toEqual([false, true])
        const final = yield* AutoloopCards.listCards()
        expect(final.find((found) => found.id === card.id)).toMatchObject({ state: "decided" })
      }),
    )
  })
})
