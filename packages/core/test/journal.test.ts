import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Logger } from "effect"
import { Database } from "@orchestra/core/database/database"
import { AutoloopStore } from "@orchestra/core/autoloop/kernel/store"
import type { AutoloopFact } from "@orchestra/core/autoloop/kernel/schema"
import { Journal } from "@orchestra/core/journal"
import { Global } from "@orchestra/util/global"

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Database.layer({ path: ":memory:" })),
      Effect.provideService(Global.Service, Global.make({ data: path.join(process.cwd(), ".test-data") })),
      Effect.scoped,
    ),
  )

const runFact = (id: string, key: string, state: string, session: string): AutoloopFact => ({
  id,
  type: `run.${state}`,
  collection: "runs",
  key,
  data: { state, session },
})

describe("Journal", () => {
  test("records errors as journal-only facts and reads them back", async () => {
    await run(
      Effect.gen(function* () {
        yield* AutoloopStore.commitLatest([runFact("f1", "run_1", "queued", "ses_other")])
        yield* Journal.recordError({
          source: "session-runner",
          kind: "stream-interrupted",
          message: "The provider response ended unexpectedly.",
          sessionID: "ses_test",
          detail: { attempt: 1 },
        })
        const errors = yield* Journal.readErrors()
        expect(errors).toHaveLength(1)
        expect(errors[0]).toMatchObject({
          source: "session-runner",
          kind: "stream-interrupted",
          message: "The provider response ended unexpectedly.",
          sessionID: "ses_test",
          detail: { attempt: 1 },
        })
        expect(errors[0]?.id.startsWith("err:session-runner:")).toBe(true)
        // The error fact changed no projection: the run row is untouched.
        const { view } = yield* AutoloopStore.openView()
        expect(view["runs"]).toEqual({ run_1: { state: "queued", session: "ses_other" } })
      }),
    )
  })

  test("recording without a database in scope logs the dropped error instead of vanishing", async () => {
    const logged: Array<unknown> = []
    await Effect.runPromise(
      Journal.recordError({ source: "test", kind: "x", message: "no db here" }).pipe(
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([Logger.make((entry) => logged.push(entry.message))]),
        ),
      ),
    )
    // Effect logs a warning as [message, ...args], not a plain string.
    expect(logged.some((message) => JSON.stringify(message).includes("dropping a recorded error"))).toBe(true)
    expect(logged.some((message) => JSON.stringify(message).includes("no db here"))).toBe(true)
  })

  test("hasUnfinishedRun follows the runs projection", async () => {
    await run(
      Effect.gen(function* () {
        expect(yield* Journal.hasUnfinishedRun("ses_a")).toBe(false)
        yield* AutoloopStore.commitLatest([runFact("f1", "run_1", "queued", "ses_a")])
        expect(yield* Journal.hasUnfinishedRun("ses_a")).toBe(true)
        expect(yield* Journal.hasUnfinishedRun("ses_b")).toBe(false)
        yield* AutoloopStore.commitLatest([runFact("f2", "run_1", "done", "ses_a")])
        expect(yield* Journal.hasUnfinishedRun("ses_a")).toBe(false)
        yield* AutoloopStore.commitLatest([runFact("f3", "run_2", "claimed", "ses_a")])
        expect(yield* Journal.hasUnfinishedRun("ses_a")).toBe(true)
        yield* AutoloopStore.commitLatest([runFact("f4", "run_2", "cancelled", "ses_a")])
        expect(yield* Journal.hasUnfinishedRun("ses_a")).toBe(false)
      }),
    )
  })
})
