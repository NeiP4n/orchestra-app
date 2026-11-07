export type EnsureTiming = {
  readonly pollInterval: number
  readonly requestTimeout: number
  readonly spawnDelay: number
  readonly maxSpawnDelay: number
  readonly promiseTimeout: number
  readonly stopPollInterval: number
  readonly stopPollAttempts: number
  /** First budget for a server stuck in its startup state; see waitingTimeoutFor. */
  readonly waitingTimeoutBase: number
}

const timings = new WeakMap<object, EnsureTiming>()

// A freshly spawned service registers in ~250 ms, so the poll cadence is a large share of the
// time a client waits for it. Probes are sequential, so the wait between them only matters while
// the connection is refused; both variants give up after promiseTimeout of wall-clock time.
export const defaultEnsureTiming: EnsureTiming = {
  pollInterval: 25,
  requestTimeout: 2_000,
  spawnDelay: 5_000,
  maxSpawnDelay: 30_000,
  promiseTimeout: 120_000,
  stopPollInterval: 50,
  stopPollAttempts: 100,
  waitingTimeoutBase: 30_000,
}

// How long a server may sit in its startup state before ensure() replaces it.
// The budget doubles with every replacement, so a slow machine eventually gets
// a window long enough for a cold boot instead of losing the same race at the
// same 30 s every time. It stays capped at half the overall deadline so a
// replacement still has time to start.
export function waitingTimeoutFor(timing: EnsureTiming, replacements: number) {
  return Math.min(timing.promiseTimeout / 2, timing.waitingTimeoutBase * 2 ** replacements)
}

export function ensureTiming(options: object) {
  return timings.get(options) ?? defaultEnsureTiming
}

// Keep test timing out of the public lifecycle option types.
export function withEnsureTiming<A extends object>(options: A, overrides: Partial<EnsureTiming>): A {
  timings.set(options, { ...defaultEnsureTiming, ...overrides })
  return options
}
