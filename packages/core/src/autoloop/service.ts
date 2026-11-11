import { runtimeLimits } from "./runtime-limits.js"
export * as Autoloop from "./service.js"

import { randomBytes } from "node:crypto"
import { makeGlobalNode } from "@orchestra/util/effect/app-node"
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import { Bus } from "../bus.js"
import { SessionContinuation } from "../session/continuation.js"
import { Config } from "../config.js"
import { Database } from "../database/database.js"
import type { Entry } from "@orchestra/schema/config"
import { AutoloopCards } from "./cards.js"
import type { CardChange, CardsEnv } from "./cards.js"
import {
  autonomyFromConfig,
  batchLimitsFromConfig,
  limitsFromConfig,
  mergeDispatchRule,
  orchestraRules,
} from "./orchestrator.js"
import {
  decide,
  resolveLimits,
  type AutoloopLimits,
  type CardRow,
  type DecideInput,
  type DeliveryRow,
  type EventInput,
} from "./kernel/decide.js"
import { resolveBatchLimits, shouldFlushBatch, type AutonomyMode, type BatchLimits } from "./kernel/autonomy.js"
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
  /**
   * Ingest a whole burst of events from one source in a single decide
   * pass (one commit, one deadlines recompute) instead of one pass per
   * event. The value is what `decide` returned for `ingestBatch`.
   */
  readonly ingestBatch: (source: string, events: ReadonlyArray<EventInput>) => Effect.Effect<unknown, ServiceFailure>
  /**
   * Ingest one event through the batching window: it accumulates with
   * other events from the same source and flushes in one `ingestBatch`
   * pass when the window runs out or `maxBatchEvents` arrive. The event
   * is not in the journal until the flush — `flushBatch` forces it out.
   */
  readonly ingestEvent: (source: string, event: EventInput) => Effect.Effect<void, ServiceFailure>
  /** Flush every accumulated batch now, in one `ingestBatch` pass each. */
  readonly flushBatch: () => Effect.Effect<void, ServiceFailure>
  /** Current view, read fresh from the journal — it includes writes from the API handlers. */
  readonly getView: () => Effect.Effect<View, ServiceFailure>
  /** The view after each execute that committed facts, for live subscribers. */
  readonly subscribe: () => Stream.Stream<View>
  /** A worker says it is alive, and lists the runs it still holds. */
  readonly heartbeat: (worker: string, running: ReadonlyArray<number>) => Effect.Effect<void, ServiceFailure>
  /**
   * Start the clock: one timer on the nearest due. Idempotent — a second
   * start is a no-op. The loop lives in the caller's scope and stops when
   * that scope closes (server shutdown).
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>
  /** How many ticks the clock has run, and when the last one ran. */
  readonly stats: () => Effect.Effect<Stats>
  /**
   * Apply operator options at runtime — rules, limits, autonomy mode and
   * batch limits from the Orchestra config, set once at server boot
   * before the clock starts. Only the fields given change; the rest keep
   * what the layer was built with. The claim/finish secret stays
   * construction-only: tokens already issued must keep verifying.
   */
  readonly configure: (options: {
    rules?: Rules
    limits?: Partial<AutoloopLimits>
    autonomy?: AutonomyMode
    batch?: Partial<BatchLimits>
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@orchestra/Autoloop") {}

/** What the caller passes in: rules, limits and secrets, like `CardsEnv`. */
export interface Options {
  /** Cycle rules; when absent, the rules stored in the journal are used, else none. */
  rules?: Rules
  /** Cycle limits; anything missing falls back to `decide`'s defaults. */
  limits?: Partial<AutoloopLimits>
  /**
   * Autonomy mode (`off` / `observe` / `auto`). When absent the service
   * runs as before (`auto`); the operator-facing default (`observe`) is
   * applied by `ensureConfigured` from `orchestra.society.autonomy` when
   * a config is present in the context.
   */
  autonomy?: AutonomyMode
  /** Router batch limits; anything missing falls back to the kernel defaults. */
  batch?: Partial<BatchLimits>
  /** Secret the claim/finish tokens are derived from (credential store).
   * When absent, a random 32-byte secret is generated per process: tokens
   * are `sha256(secret:run:id:issued)`, so an empty secret makes every token
   * predictable from the journal alone (M-01). The price is that tokens
   * issued before a restart stop verifying — a run claimed across a restart
   * is re-claimed by lease expiry instead of finished, never lost. */
  tokenSecret?: string
}

interface State {
  readonly isEnabled: () => boolean
  /** Set at build, replaced by `configure` at server boot. */
  readonly rules: Ref.Ref<Rules | undefined>
  /** Set at build, replaced by `configure` at server boot. */
  readonly limits: Ref.Ref<Partial<AutoloopLimits> | undefined>
  /** Autonomy mode; `auto` until a config (or `configure`) says otherwise. */
  readonly autonomy: Ref.Ref<AutonomyMode>
  /** Router batch limits; replaced by `configure` at server boot. */
  readonly batch: Ref.Ref<BatchLimits>
  /** Single events waiting for the batch window, one batch per source. */
  readonly pending: Ref.Ref<Map<string, { events: Array<EventInput>; firstAt: number }>>
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

const cardsEnv = (
  rules: Rules | undefined,
  limits: Partial<AutoloopLimits> | undefined,
  tokenSecret: string | undefined,
  autonomy?: AutonomyMode,
): CardsEnv => ({
  rules,
  limits,
  autonomy,
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
    const env = cardsEnv(
      yield* Ref.get(state.rules),
      yield* Ref.get(state.limits),
      state.tokenSecret,
      yield* Ref.get(state.autonomy),
    )
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
        opened._tag === "Success" ? (opened.value.view["cards"]?.[String(card.id)] as CardRow | undefined) : undefined
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
        yield* AutoloopCards.markFailed("web", card.id, version, Cause.pretty(published.cause), env).pipe(Effect.ignore)
        return
      }
      yield* AutoloopCards.markDelivered("web", card.id, version, null, env).pipe(
        Effect.catchCause((cause) => Effect.logError("autoloop: не удалось отметить доставку", { cause })),
      )
    }
  }).pipe(Effect.provideService(Database.Service, state.database))

/** One decide input, serialised so two executes never decide on the same view. */
const executeInner = (state: State, input: DecideInput, now = Date.now()) =>
  state.semaphore
    .withPermit(
      Effect.gen(function* () {
        const opened = yield* AutoloopStore.openView().pipe(Effect.mapError(storeFailure))
        const stored = AutoloopCards.storedRules(opened.view)
        const rules = (yield* Ref.get(state.rules)) ?? stored?.rules ?? emptyRules()
        const configuredLimits = yield* Ref.get(state.limits)
        const limits = runtimeLimits(configuredLimits)
        const autonomy = yield* Ref.get(state.autonomy)
        const decided = yield* Effect.try({
          try: () =>
            decide(opened.view, input, now, {
              rules,
              limits,
              autonomy,
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
    )
    .pipe(Effect.provideService(Database.Service, state.database))

/** One tick from the clock: run `decide(tick)` and count it. */
const tickOnce = (state: State) =>
  Effect.gen(function* () {
    if (!state.isEnabled()) return
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
    if (!state.isEnabled()) {
      yield* Deferred.await(wakeup)
      return "wakeup" as const
    }
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
          Effect.logError("autoloop: не удалось узнать ближайшее due", { cause }).pipe(Effect.as("failed" as const)),
        ),
      )
      if (step === "failed") {
        yield* Effect.sleep("5 seconds")
        continue
      }
      if (step === "tick") {
        yield* tickOnce(state).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("autoloop: tick не удался", { cause }).pipe(Effect.andThen(Effect.sleep("5 seconds"))),
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
    const continuation = yield* Effect.serviceOption(SessionContinuation.Service)
    // State is restored from the journal at start, never from memory: the
    // runs are in the journal, so a restart loses none of them. A format
    // change rebuilds the projections from the journal instead of trusting
    // rows folded by older kernel code.
    const opened = yield* AutoloopStore.openView()
    if (opened.format !== null && opened.format !== FORMAT) {
      yield* AutoloopStore.rebuildProjections()
    }
    const state: State = {
      isEnabled: () => Option.isNone(continuation) || continuation.value.isEnabled(),
      rules: yield* Ref.make(options.rules),
      limits: yield* Ref.make(options.limits),
      autonomy: yield* Ref.make<AutonomyMode>(options.autonomy ?? "auto"),
      batch: yield* Ref.make(resolveBatchLimits(options.batch)),
      pending: yield* Ref.make(new Map()),
      configured: yield* Ref.make(false),
      tokenSecret: options.tokenSecret ?? randomBytes(32).toString("hex"),
      bus,
      database,
      changes: yield* PubSub.unbounded<View>(),
      wakeup: yield* Ref.make(yield* Deferred.make<void>()),
      started: yield* Ref.make(false),
      semaphore: Semaphore.makeUnsafe(1),
      stats: yield* Ref.make<Stats>({ ticks: 0, lastTickAt: null }),
    }
    if (Option.isSome(continuation)) {
      const remove = continuation.value.listen(() => signal(state))
      yield* Effect.addFinalizer(() => Effect.sync(remove))
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
        const entries = yield* config.value.entries().pipe(Effect.orElseSucceed(() => [] as Entry[]))
        const info = Config.latest(entries, "orchestra")
        const autoloop = info?.autoloop
        const opened = yield* AutoloopStore.openView().pipe(
          Effect.provideService(Database.Service, state.database),
          Effect.orElseSucceed(() => null),
        )
        const stored = opened === null ? undefined : AutoloopCards.storedRules(opened.view)
        const rules = stored === undefined ? orchestraRules() : mergeDispatchRule(stored.rules)
        yield* Ref.set(state.rules, rules)
        yield* Ref.set(state.limits, limitsFromConfig(autoloop))
        yield* Ref.set(state.autonomy, autonomyFromConfig(info))
        yield* Ref.set(state.batch, resolveBatchLimits(batchLimitsFromConfig(autoloop)))
        yield* Ref.set(state.configured, true)
      })

    /** One decide input with the operator config applied first, as `execute` does. */
    const run = (state: State, input: DecideInput, now?: number) =>
      Effect.gen(function* () {
        yield* ensureConfigured(state)
        return yield* executeInner(state, input, now)
      })

    /**
     * Flush every accumulated batch in one `ingestBatch` pass each. Never
     * fails the caller: a stuck flush is logged and the batch stays
     * pending for the next window instead of being dropped silently.
     */
    const flushPending = (state: State) =>
      Effect.gen(function* () {
        const pending = yield* Ref.get(state.pending)
        if (pending.size === 0) return
        yield* Ref.set(state.pending, new Map())
        for (const [source, batch] of pending) {
          yield* run(state, { type: "ingestBatch", args: [source, batch.events] }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logError("autoloop: не удалось сбросить пачку событий", { cause, source })
                const rest = new Map(yield* Ref.get(state.pending))
                const kept = rest.get(source) ?? { events: [], firstAt: batch.firstAt }
                rest.set(source, { events: [...batch.events, ...kept.events], firstAt: batch.firstAt })
                yield* Ref.set(state.pending, rest)
              }),
            ),
          )
        }
      })

    /**
     * The batch window: every `windowMs` the accumulated events flush in
     * one pass per source. A failed flush never kills the loop — it is
     * logged and retried on the next window, so a broken journal cannot
     * spin and a fixed one is picked up on its own.
     */
    const batchLoop = (state: State): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        while (true) {
          const limits = yield* Ref.get(state.batch)
          yield* Effect.sleep(Duration.millis(limits.windowMs))
          yield* flushPending(state).pipe(
            Effect.catchCause((cause) => Effect.logError("autoloop: сброс пачки событий не удался", { cause })),
          )
        }
      })

    const service: Interface = {
      execute: (input, now) =>
        Effect.gen(function* () {
          yield* ensureConfigured(state)
          return yield* executeInner(state, input, now)
        }),
      ingestBatch: (source, events) => run(state, { type: "ingestBatch", args: [source, [...events]] }),
      ingestEvent: (source, event) =>
        Effect.gen(function* () {
          yield* ensureConfigured(state)
          const now = Date.now()
          const limits = yield* Ref.get(state.batch)
          const pending = new Map(yield* Ref.get(state.pending))
          const batch = pending.get(source) ?? { events: [], firstAt: now }
          batch.events.push(event)
          pending.set(source, batch)
          yield* Ref.set(state.pending, pending)
          if (!shouldFlushBatch(batch.events.length, batch.firstAt, now, limits)) return
          const rest = new Map([...pending].filter(([key]) => key !== source))
          yield* Ref.set(state.pending, rest)
          yield* executeInner(state, { type: "ingestBatch", args: [source, batch.events] })
        }),
      flushBatch: () => flushPending(state),
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
          yield* Effect.forkScoped(batchLoop(state))
        }),
      stats: () => Ref.get(state.stats),
      configure: (given) =>
        state.semaphore.withPermit(
          Effect.gen(function* () {
            if (given.rules !== undefined) yield* Ref.set(state.rules, given.rules)
            if (given.limits !== undefined) yield* Ref.set(state.limits, given.limits)
            if (given.autonomy !== undefined) yield* Ref.set(state.autonomy, given.autonomy)
            if (given.batch !== undefined) {
              const current = yield* Ref.get(state.batch)
              yield* Ref.set(state.batch, resolveBatchLimits({ ...current, ...given.batch }))
            }
          }),
        ),
    }
    return service
  })

export const node = makeGlobalNode({
  service: Service,
  layer: layer(),
  deps: [Database.node, Bus.node, SessionContinuation.node],
})
