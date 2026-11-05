export * as Autoloop from "./service.js"

import { makeGlobalNode } from "@orchestra/util/effect/app-node"
import { Cause, Context, Deferred, Duration, Effect, Layer, Option, PubSub, Ref, Schema, Scope, Semaphore, Stream } from "effect"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Database } from "../database/database.js"
import type { Entry } from "@orchestra/schema/config"
import { AutoloopCards } from "./cards.js"
import type { CardChange, CardsEnv } from "./cards.js"
import { limitsFromConfig, mergeDispatchRule, orchestraRules } from "./orchestrator.js"
import {
  decide,
  resolveLimits,
  type AutoloopLimits,
  type CardRow,
  type DecideInput,
  type DeliveryRow,
} from "./kernel/decide.js"
import { deadlines, MINUTE, type DueLimits } from "./kernel/due.js"
import type { View } from "./kernel/evolve.js"
import { emptyRules, type Rules } from "./kernel/rules.js"
import { FORMAT } from "./kernel/schema.js"
import { AutoloopStore } from "./kernel/store.js"

// Tick and delivery service (block Б3, подшаг 3): the Effect service around
// the journal (`store`) and the pure decision (`decide`), mirroring
// agent-autoloop's `host/runtime.ts`. `execute` is the only way the clock,
// the orchestrator and the API move the cycle: open the view, decide, commit
// the facts in one transaction, tell the listeners, deliver the cards.
//
// The clock is ONE timer on the nearest due — cron schedules, `later`
// timers, retry pauses, card resends, a worker gone quiet (sweep) — never a
// polling loop. Every `execute` wakes the loop, so a new due is never slept
// past; with nothing due the loop waits on a signal and runs no ticks at
// all. State lives in the journal, not in this process: a restart reopens
// the view from the journal (rebuilding the projections when the kernel
// format changed) and the runs pick up where they left off.
//
// Card delivery hands the next card to the `web` channel and publishes it on
// the Bus, so the existing SSE feed carries it; a failed publish is marked
// and comes back on the `RESEND_AT` schedule, and after 57 minutes the
// channel gives up (`given_up`). Card state changes that are not a first
// delivery (an answer, a close) are published here too; the first
// publication of a card is its delivery, so nobody hears about it twice.

export class ServiceFailure extends Schema.TaggedError<ServiceFailure>()("Autoloop.ServiceFailure", {
  code: Schema.Literals(["not-found", "invalid", "conflict", "forbidden", "unavailable"]),
  message: Schema.String,
}) {}

export interface Stats {
  /** Ticks the clock has run since this service started. */
  readonly ticks: number
  /** When the last tick ran, milliseconds since epoch, or null before the first. */
  readonly lastTickAt: number | null
}

export interface Interface {
  /**
   * Run one decide input against the journal: open the view, decide, commit
   * the facts, notify the listeners, deliver the cards. The value is what
   * `decide` returned for the input.
   */
  readonly execute: (input: DecideInput, now?: number) => Effect.Effect<unknown, ServiceFailure>
  /** Current view, read fresh from the journal — it includes writes from the API handlers. */
  readonly getView: () => Effect.Effect<View, ServiceFailure>
  /** The view after each execute that committed facts, for live subscribers. */
  readonly subscribe: () => Stream.Stream<View>
  /** A worker says it is alive, and lists the runs it still holds. */
  readonly heartbeat: (
    worker: string,
    running: ReadonlyArray<number>,
  ) => Effect.Effect<void, ServiceFailure>
  /**
   * Start the clock: one timer on the nearest due. Idempotent — a second
   * start is a no-op. The loop lives in the caller's scope and stops when
   * that scope closes (server shutdown).
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>
  /** How many ticks the clock has run, and when the last one ran. */
  readonly stats: () => Effect.Effect<Stats>
  /**
   * Apply operator options at runtime — rules and limits from the Orchestra
   * config, set once at server boot before the clock starts. Only the
   * fields given change; the rest keep what the layer was built with. The
   * claim/finish secret stays construction-only: tokens already issued
   * must keep verifying.
   */
  readonly configure: (options: {
    rules?: Rules
    limits?: Partial<AutoloopLimits>
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@orchestra/Autoloop") {}

/** What the caller passes in: rules, limits and secrets, like `CardsEnv`. */
export interface Options {
  /** Cycle rules; when absent, the rules stored in the journal are used, else none. */
  rules?: Rules
  /** Cycle limits; anything missing falls back to `decide`'s defaults. */
  limits?: Partial<AutoloopLimits>
  /** Secret the claim/finish tokens are derived from (credential store). */
  tokenSecret?: string
}

interface State {
  /** Set at build, replaced by `configure` at server boot. */
  readonly rules: Ref.Ref<Rules | undefined>
  /** Set at build, replaced by `configure` at server boot. */
  readonly limits: Ref.Ref<Partial<AutoloopLimits> | undefined>
  /** Whether the operator config has been applied once (see `ensureConfigured`). */
  readonly configured: Ref.Ref<boolean>
  readonly tokenSecret: string | undefined
  readonly bus: Bus.Interface
  /** Captured at make time, so the interface methods need no environment: the journal is provided, not requested. */
  readonly database: Database.Interface
  readonly changes: PubSub.PubSub<View>
  readonly wakeup: Ref.Ref<Deferred.Deferred<void>>
  readonly started: Ref.Ref<boolean>
  readonly semaphore: Semaphore.Semaphore
  readonly stats: Ref.Ref<Stats>
}

const decideFailure = (cause: unknown): ServiceFailure => {
  const code = (cause as { code?: unknown } | null)?.code
  const message = cause instanceof Error ? cause.message : String(cause)
  if (code === "Autoloop.DecideNotFound") return new ServiceFailure({ code: "not-found", message })
  if (code === "Autoloop.DecideAuth") return new ServiceFailure({ code: "forbidden", message })
  if (code === "Autoloop.DecideConflict") return new ServiceFailure({ code: "conflict", message })
  return new ServiceFailure({ code: "invalid", message })
}

/** A store failure is not a bad input: the journal is unavailable, so the service is too. */
const storeFailure = (cause: unknown): ServiceFailure =>
  cause instanceof ServiceFailure
    ? cause
    : new ServiceFailure({
        code: "unavailable",
        message: cause instanceof Error ? cause.message : "журнал недоступен",
      })

/** `DueLimits` for the clock, from the cycle limits (mirrors `decide`'s own conversion). */
const dueLimitsOf = (limits: AutoloopLimits): DueLimits => ({
  runLeaseMs: limits.runLeaseMinutes * MINUTE,
  workerFreshMs: limits.workerFreshMinutes * MINUTE,
  offlineAfterMs: limits.offlineAfterMinutes * MINUTE,
})

/** Wake the clock loop so it recomputes the nearest due from the fresh view. */
const signal = (state: State) =>
  Effect.gen(function* () {
    const wakeup = yield* Ref.get(state.wakeup)
    yield* Deferred.succeed(wakeup, undefined)
    yield* Ref.set(state.wakeup, yield* Deferred.make<void>())
  })

const cardsEnv = (rules: Rules | undefined, limits: Partial<AutoloopLimits> | undefined, tokenSecret: string | undefined): CardsEnv => ({
  rules,
  limits,
  tokenSecret,
})

/**
 * Hand due cards to the `web` channel until there is nothing to hand out:
 * `nextCard` picks the next one honouring the resend schedule, the publish
 * is the delivery, and the mark tells the journal whether it went out or
 * has to come back on the next `RESEND_AT` step. A failed publish stops
 * the drain — the card rests until its resend is due instead of spinning.
 * Never fails: a stuck delivery must not fail the execute that created the card.
 */
const drainDelivery = (state: State): Effect.Effect<void> =>
  Effect.gen(function* () {
    const env = cardsEnv(yield* Ref.get(state.rules), yield* Ref.get(state.limits), state.tokenSecret)
    while (true) {
      const handed = yield* AutoloopCards.nextCard("web", env).pipe(Effect.exit)
      if (handed._tag === "Failure") {
        yield* Effect.logError("autoloop: не удалось взять карточку для доставки", { cause: handed.cause })
        return
      }
      const card = handed.value.card
      if (card === null) return
      const opened = yield* AutoloopStore.openView().pipe(Effect.exit)
      // The public card shape carries no version; the journal row does.
      const cardRow =
        opened._tag === "Success"
          ? (opened.value.view["cards"]?.[String(card.id)] as CardRow | undefined)
          : undefined
      const delivery =
        opened._tag === "Success"
          ? (opened.value.view["deliveries"]?.[`${card.id}:web`] as DeliveryRow | undefined)
          : undefined
      const version = typeof cardRow?.["version"] === "number" ? cardRow["version"] : 1
      // The first hand-out announces the card; a later one is an update.
      const change: CardChange = {
        type: delivery !== undefined && delivery.tries > 1 ? "updated" : "created",
        card,
      }
      const published = yield* AutoloopCards.publish(state.bus, [change]).pipe(Effect.exit)
      if (published._tag === "Failure") {
        yield* Effect.logError("autoloop: не удалось доставить карточку", { cause: published.cause })
        yield* AutoloopCards.markFailed("web", card.id, version, Cause.pretty(published.cause), env).pipe(
          Effect.ignore,
        )
        return
      }
      yield* AutoloopCards.markDelivered("web", card.id, version, null, env).pipe(
        Effect.catchCause((cause) => Effect.logError("autoloop: не удалось отметить доставку", { cause })),
      )
    }
  }).pipe(Effect.provideService(Database.Service, state.database))

/** One decide input, serialised so two executes never decide on the same view. */
const executeInner = (state: State, input: DecideInput, now = Date.now()) =>
  state.semaphore.withPermit(
    Effect.gen(function* () {
      const opened = yield* AutoloopStore.openView().pipe(Effect.mapError(storeFailure))
      const stored = AutoloopCards.storedRules(opened.view)
      const rules = (yield* Ref.get(state.rules)) ?? stored?.rules ?? emptyRules()
      const limits = yield* Ref.get(state.limits)
      const decided = yield* Effect.try({
        try: () =>
          decide(opened.view, input, now, {
            rules,
            limits,
            tokenSecret: state.tokenSecret,
            seq: opened.lastSeq + 1,
            rulesVersion: stored?.version ?? 1,
          }),
        catch: (cause) => decideFailure(cause),
      })
      const beforeSeq = opened.lastSeq
      if (decided.facts.length > 0) {
        yield* AutoloopStore.commitLatest(decided.facts).pipe(Effect.mapError(storeFailure))
      }
      // State changes that are not a first delivery go out here; a card's
      // first publication is its delivery, in the drain below.
      const committed = yield* AutoloopStore.openView().pipe(Effect.mapError(storeFailure))
      const changes = AutoloopCards.cardChanges(opened.view, committed.view).filter(
        (change) => change.type !== "created",
      )
      if (changes.length > 0) yield* AutoloopCards.publish(state.bus, changes)
      yield* drainDelivery(state)
      const final = yield* AutoloopStore.openView().pipe(Effect.mapError(storeFailure))
      if (final.lastSeq !== beforeSeq) yield* PubSub.publish(state.changes, final.view)
      yield* signal(state)
      return decided.value
    }),
  ).pipe(Effect.provideService(Database.Service, state.database))

/** One tick from the clock: run `decide(tick)` and count it. */
const tickOnce = (state: State) =>
  Effect.gen(function* () {
    yield* executeInner(state, { type: "tick", args: [] })
    yield* Ref.update(state.stats, (stats) => ({ ticks: stats.ticks + 1, lastTickAt: Date.now() }))
  })

/**
 * One step of the clock: wait for the nearest due, or for a wake-up from an
 * `execute`. The wake-up is read before the view, and `execute` commits
 * before it signals, so a signal that lands anywhere in the step is never
 * missed: either the awaited deferred completes, or the fresh view already
 * holds the change. Returns what woke the loop, or "failed" when the view
 * could not be read at all.
 */
const loopStep = (state: State): Effect.Effect<"tick" | "wakeup", unknown, never> =>
  Effect.gen(function* () {
    const wakeup = yield* Ref.get(state.wakeup)
    const opened = yield* AutoloopStore.openView()
    const stored = AutoloopCards.storedRules(opened.view)
    const rules = (yield* Ref.get(state.rules)) ?? stored?.rules ?? emptyRules()
    const limits = resolveLimits(yield* Ref.get(state.limits))
    const now = Date.now()
    const due = deadlines(opened.view, now, rules, dueLimitsOf(limits))
    const ats = Object.values(due)
      .map((row) => Date.parse(row.at))
      .filter((at) => Number.isFinite(at))
    if (ats.length === 0) {
      yield* Deferred.await(wakeup)
      return "wakeup" as const
    }
    const delay = Math.max(0, Math.min(...ats) - now)
    return yield* Effect.raceFirst(
      Effect.sleep(Duration.millis(delay)).pipe(Effect.as("tick" as const)),
      Deferred.await(wakeup).pipe(Effect.as("wakeup" as const)),
    )
  }).pipe(Effect.provideService(Database.Service, state.database))

/**
 * The clock: one timer on the nearest due, forever. A failed step never
 * kills the loop — it is logged and retried after a short pause, so a
 * broken tick cannot spin and a fixed journal is picked up on its own.
 */
const loop = (state: State): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    while (true) {
      const step = yield* loopStep(state).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("autoloop: не удалось узнать ближайшее due", { cause }).pipe(
            Effect.as("failed" as const),
          ),
        ),
      )
      if (step === "failed") {
        yield* Effect.sleep("5 seconds")
        continue
      }
      if (step === "tick") {
        yield* tickOnce(state).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("autoloop: tick не удался", { cause }).pipe(
              Effect.andThen(Effect.sleep("5 seconds")),
            ),
          ),
        )
      }
    }
  })

export const layer = (options: Options = {}) => Layer.effect(Service, make(options))

/**
 * Build the service implementation from options, shared by `layer` and
 * tests: restore the state from the journal (rebuilding the projections
 * when the kernel format changed), then hand out the interface over the
 * captured database and bus.
 */
const make = (options: Options = {}) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const database = yield* Database.Service
    // State is restored from the journal at start, never from memory: the
    // runs are in the journal, so a restart loses none of them. A format
    // change rebuilds the projections from the journal instead of trusting
    // rows folded by older kernel code.
    const opened = yield* AutoloopStore.openView()
    if (opened.format !== null && opened.format !== FORMAT) {
      yield* AutoloopStore.rebuildProjections()
    }
    const state: State = {
      rules: yield* Ref.make(options.rules),
      limits: yield* Ref.make(options.limits),
      configured: yield* Ref.make(false),
      tokenSecret: options.tokenSecret,
      bus,
      database,
      changes: yield* PubSub.unbounded<View>(),
      wakeup: yield* Ref.make(yield* Deferred.make<void>()),
      started: yield* Ref.make(false),
      semaphore: Semaphore.makeUnsafe(1),
      stats: yield* Ref.make<Stats>({ ticks: 0, lastTickAt: null }),
    }
    /**
     * Apply the operator config once, on first use in a context that carries it.
     * Config is location-scoped, so server boot cannot see it (the built routes
     * context holds no `Config.Service`); the cycle instead self-configures when
     * a dispatch (or any other `execute` call) runs in a config-bearing context,
     * exactly like the orchestrator's worker policy does. The tick loop has no
     * config, so it leaves the flag unset until a dispatch arrives.
     * Operator rules stored in the journal are kept: the dispatch rule is merged
     * into them instead of shadowing them. Without a config in the context this
     * is a no-op, and the kernel defaults apply.
     */
    const ensureConfigured = (state: State) =>
      Effect.gen(function* () {
        if (yield* Ref.get(state.configured)) return
        const config = yield* Effect.serviceOption(Config.Service)
        if (Option.isNone(config)) return
        const entries = yield* config.value.entries().pipe(
          Effect.catch(() => Effect.succeed([] as Entry[])),
        )
        const autoloop = Config.latest(entries, "orchestra")?.autoloop
        const opened = yield* AutoloopStore.openView().pipe(
          Effect.provideService(Database.Service, state.database),
          Effect.catch(() => Effect.succeed(null)),
        )
        const stored = opened === null ? undefined : AutoloopCards.storedRules(opened.view)
        const rules = stored === undefined ? orchestraRules() : mergeDispatchRule(stored.rules)
        yield* Ref.set(state.rules, rules)
        yield* Ref.set(state.limits, limitsFromConfig(autoloop))
        yield* Ref.set(state.configured, true)
      })

    const service: Interface = {
      execute: (input, now) =>
        Effect.gen(function* () {
          yield* ensureConfigured(state)
          return yield* executeInner(state, input, now)
        }),
      getView: () =>
        AutoloopStore.openView().pipe(
          Effect.provideService(Database.Service, database),
          Effect.map(({ view }) => view),
          Effect.mapError(storeFailure),
        ),
      subscribe: () => Stream.fromPubSub(state.changes),
      heartbeat: (worker, running) =>
        executeInner(state, { type: "heartbeat", args: [worker, [...running]] }).pipe(Effect.asVoid),
      start: () =>
        Effect.gen(function* () {
          const already = yield* Ref.getAndSet(state.started, true)
          if (already) return
          yield* Effect.forkScoped(loop(state))
        }),
      stats: () => Ref.get(state.stats),
      configure: (given) =>
        state.semaphore.withPermit(
          Effect.gen(function* () {
            if (given.rules !== undefined) yield* Ref.set(state.rules, given.rules)
            if (given.limits !== undefined) yield* Ref.set(state.limits, given.limits)
          }),
        ),
    }
    return service
  })

export const node = makeGlobalNode({
  service: Service,
  layer: layer(),
  deps: [Database.node, Bus.node],
})
