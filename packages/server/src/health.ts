export * as ServerHealth from "./health"

import { Autoloop } from "@orchestra/core/autoloop/service"
import { Bus } from "@orchestra/core/bus"
import { Database } from "@orchestra/core/database/database"
import { Cause, Clock, Duration, Effect, Exit, Fiber, Option, Schema, Stream } from "effect"
import { randomUUID } from "node:crypto"

export interface HealthCheckResult {
  readonly status: "ok" | "unavailable"
  readonly detail?: string
  readonly latencyMs?: number
}

export interface HealthReport {
  readonly status: "ok" | "degraded"
  readonly checks: {
    readonly database: HealthCheckResult
    readonly bus: HealthCheckResult
    readonly autoloop: HealthCheckResult
  }
}

// The bus probe's ping: an ephemeral event, never durable, never in the log.
// A nonce per probe keeps a stale ping from another probe from passing this one.
const HealthPing = Bus.ephemeral({
  type: "health.ping",
  schema: { nonce: Schema.String },
})

const unavailable = (detail: string): HealthCheckResult => ({ status: "unavailable", detail })

function shortCause(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause)
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 200 ? `${message.slice(0, 200)}…` : message
}

// One probe: the check runs under a timeout and never throws — every outcome,
// including a dead service, is a value. `detail` is the check's own ok-detail.
function probe(
  check: Effect.Effect<string | undefined, unknown>,
  timeout: Duration.Input,
): Effect.Effect<HealthCheckResult> {
  return Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const outcome = yield* check.pipe(Effect.timeout(timeout), Effect.exit)
    const latencyMs = (yield* Clock.currentTimeMillis) - started
    if (Exit.isFailure(outcome))
      return { status: "unavailable", detail: shortCause(outcome.cause), latencyMs } satisfies HealthCheckResult
    const detail = outcome.value
    return {
      status: "ok",
      ...(detail !== undefined ? { detail } : {}),
      latencyMs,
    } satisfies HealthCheckResult
  })
}

const checkDatabase = (database: Option.Option<Database.Interface>): Effect.Effect<HealthCheckResult> =>
  Option.isNone(database)
    ? Effect.succeed(unavailable("Database service is not in this layer"))
    : probe(
        Effect.gen(function* () {
          // Migrations already ran at layer build; SELECT 1 proves the
          // connection still answers.
          yield* database.value.db.run("SELECT 1")
          return undefined
        }),
        Duration.seconds(3),
      )

const checkBus = (bus: Option.Option<Bus.Interface>): Effect.Effect<HealthCheckResult> =>
  Option.isNone(bus)
    ? Effect.succeed(unavailable("Bus service is not in this layer"))
    : probe(
        Effect.gen(function* () {
          const nonce = randomUUID()
          // Same shape as the bus's own tests: subscribe first (take the one
          // ping carrying our nonce), publish second, join the subscriber.
          // The fork lives in a scope we open ourselves, so the probe does
          // not depend on the handler running scoped.
          const delivered = yield* Effect.scoped(
            Effect.gen(function* () {
              const fiber = yield* bus.value.subscribe(HealthPing).pipe(
                Stream.filter((event) => event.data.nonce === nonce),
                Stream.take(1),
                Stream.runCollect,
                Effect.forkScoped,
              )
              // Let the subscription register before publishing: the live
              // channel only delivers to subscribers that are already listening.
              yield* Effect.sleep(Duration.millis(100))
              yield* bus.value.publish(HealthPing, { nonce })
              return yield* Fiber.join(fiber).pipe(Effect.timeout(Duration.seconds(5)), Effect.option)
            }),
          )
          if (Option.isNone(delivered))
            return yield* Effect.fail(new Error("the health ping was not delivered within 5 seconds"))
          // The durable read path: an empty log for a fresh aggregate still
          // exercises the bus's storage read.
          yield* bus.value.log({ aggregateID: "health-check", follow: false }).pipe(Stream.runDrain)
          return undefined
        }),
        Duration.seconds(10),
      )

const checkAutoloop = (autoloop: Option.Option<Autoloop.Interface>): Effect.Effect<HealthCheckResult> =>
  Option.isNone(autoloop)
    ? Effect.succeed(unavailable("Autoloop service is not in this layer"))
    : probe(
        Effect.gen(function* () {
          const stats = yield* autoloop.value.stats()
          // The view is the scheduler's journal read: a journal the scheduler
          // cannot open is a scheduler that cannot work. A never-ticked clock
          // is NOT a failure here — the clock only ticks once runs exist, and
          // the fetch/workerd runtime never starts it, so ticks stay 0 on an
          // idle server by design.
          yield* autoloop.value.getView()
          return `ticks=${stats.ticks}, lastTickAt=${stats.lastTickAt === null ? "never" : new Date(stats.lastTickAt).toISOString()}`
        }),
        Duration.seconds(3),
      )

// G2-6: the real health check — database, bus, scheduler. Every service is
// read optionally: a layer that cannot verify a component reports it
// unavailable instead of failing the probe or, worse, answering 200 about a
// server it never checked. The three probes run concurrently so a slow one
// does not delay the others.
export const check = Effect.fn("ServerHealth.check")(function* () {
  const database = yield* Effect.serviceOption(Database.Service)
  const bus = yield* Effect.serviceOption(Bus.Service)
  const autoloop = yield* Effect.serviceOption(Autoloop.Service)
  const checks = yield* Effect.all(
    {
      database: checkDatabase(database),
      bus: checkBus(bus),
      autoloop: checkAutoloop(autoloop),
    },
    { concurrency: "unbounded" },
  )
  const status = Object.values(checks).every((result) => result.status === "ok") ? "ok" : "degraded"
  return { status, checks } satisfies HealthReport
})
