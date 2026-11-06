export * as AutoloopDue from "./due.js"

import type { View } from "./evolve.js"
import { iso } from "./evolve.js"
import type { Rules } from "./rules.js"

// Deadlines (block B3). Port of agent-autoloop's kernel/due.ts: the next
// moment each thing needs the clock — schedules, reviews, retries, card
// resends, a worker gone quiet, a lease run out. The service keeps one
// timer, for the earliest of them, so nothing has to poll.
//
// Times are ISO strings in the projections (as everywhere in this kernel);
// the `at` of a due row is an ISO string too. Limits arrive as `DueLimits`
// (milliseconds); callers that pass none get the Orchestra defaults below,
// which match the constants — `RUN_LEASE` (5 min) replaces the old
// `STALE_CLAIM_MS` (10 min) for cycle runs.

export const MINUTE = 60_000

/** A worker seen this recently is really there, so a run it has stopped mentioning has really gone quiet. */
export const WORKER_FRESH = 2 * MINUTE

/** How long a claimed run can go unmentioned by its worker before it's in doubt. */
export const RUN_LEASE = 5 * MINUTE

/** How long work can wait on a worker that doesn't come before the owner hears. */
export const OFFLINE_AFTER = 10 * MINUTE

/**
 * How often being seen goes in the log. A worker asks every second with work
 * in hand and a fact is a disk sync, so a stamp can be behind the last
 * contact by this much. It has to stay under what reads it: under
 * WORKER_FRESH; and under RUN_LEASE - WORKER_FRESH, or a run could look
 * quiet while its worker still looks there.
 */
export const SEEN_EVERY = MINUTE

/** Millisecond limits `deadlines` reads; defaults are the constants above. */
export interface DueLimits {
  runLeaseMs: number
  workerFreshMs: number
  offlineAfterMs: number
}

export const DEFAULT_DUE_LIMITS: DueLimits = {
  runLeaseMs: RUN_LEASE,
  workerFreshMs: WORKER_FRESH,
  offlineAfterMs: OFFLINE_AFTER,
}

type Row = Record<string, unknown>

const rowsOf = (view: View, collection: string): Row[] =>
  Object.values(view[collection] ?? {}).map((value) => value as Row)

const text = (row: Row, field: string): string | undefined =>
  typeof row[field] === "string" ? (row[field] as string) : undefined

const timeOf = (row: Row, field: string): number => Date.parse(text(row, field) ?? "")

/** The worker an agent runs on, from the rule set. */
export const workerOfRun = (rules: Rules, agent: string | undefined): string | undefined =>
  agent === undefined ? undefined : rules.agents[agent]?.worker

/** Every worker known: seen before, or named by an agent in the rule set. */
export function workers(view: View, rules: Rules): string[] {
  const seen = rowsOf(view, "seen")
    .filter((row) => row["kind"] === "worker")
    .map((row) => text(row, "name"))
    .filter((name): name is string => name !== undefined)
  const named = Object.values(rules.agents).map((agent) => agent.worker)
  return [...new Set([...seen, ...named])]
}

/**
 * Runs waiting on one worker: queued, claimed or unknown runs whose agent
 * runs on that worker. An unknown run is still waiting: its worker may come
 * back and finish it, or the sweep re-queues it while the worker stays gone.
 * `now` is unused here but kept so the signature matches the original and
 * callers can filter by freshness at the call site.
 */
export function waitingOn(view: View, worker: string, rules: Rules): Row[] {
  return rowsOf(view, "runs").filter(
    (run) =>
      (run["state"] === "queued" || run["state"] === "claimed" || run["state"] === "unknown") &&
      workerOfRun(rules, text(run, "agent")) === worker,
  )
}

/**
 * The card about a worker gone away, and whether it has said all there is to
 * say: it's still open, or the owner closed it after everything now waiting
 * had come in. Anything newer is news, or one closed card would hide it
 * until the worker's back.
 */
export function offlineCard(view: View, worker: string, waiting: Row[]) {
  const seen = view["seen"]?.[`worker:${worker}`] as Row | undefined
  const key = `worker:${worker}:offline:${seen ? text(seen, "seen_at") : "never"}`
  const card = rowsOf(view, "cards").find((row) => text(row, "key") === key)
  const told =
    card !== undefined &&
    (card["state"] === "open" ||
      waiting.every((run) => (text(run, "created_at") ?? "") <= (text(card, "closed_at") ?? "")))
  return { key, told }
}

export interface DueRow {
  kind: string
  key: string
  at: string
}

/**
 * The next moment each thing needs the clock, keyed `${kind}:${key}`.
 * Schedules whose rule still has a cron, open timers, queued runs waiting
 * out a retry pause, card deliveries waiting to resend, and workers with
 * waiting work (offline notices, and lease checks on their claimed runs).
 */
export function deadlines(view: View, now: number, rules: Rules, limits: DueLimits = DEFAULT_DUE_LIMITS) {
  const due: Record<string, DueRow> = {}
  const add = (kind: string, key: string, atMs: number) => {
    due[`${kind}:${key}`] = { kind, key, at: iso(new Date(atMs)) }
  }

  const scheduled = (rule: string) =>
    rules.rules.some((known) => known.name === rule && "cron" in known.when)

  for (const schedule of rowsOf(view, "schedules")) {
    const rule = text(schedule, "rule")
    if (rule !== undefined && scheduled(rule)) add("cron", rule, timeOf(schedule, "next_at"))
  }
  for (const timer of rowsOf(view, "timers").filter((row) => row["event_id"] === null)) {
    add("later", String(timer["id"]), timeOf(timer, "at"))
  }
  for (const run of rowsOf(view, "runs").filter((row) => row["state"] === "queued")) {
    const notBefore = timeOf(run, "not_before")
    if (notBefore > now) add("retry", String(run["id"]), notBefore)
  }
  for (const delivery of rowsOf(view, "deliveries").filter((row) => row["given_up"] === 0 && row["not_before"] !== null)) {
    const notBefore = timeOf(delivery, "not_before")
    if (notBefore > now) add("delivery", `${String(delivery["card_id"])}:${text(delivery, "channel")}`, notBefore)
  }
  for (const worker of workers(view, rules)) {
    const seen = view["seen"]?.[`worker:${worker}`] as Row | undefined
    const waiting = waitingOn(view, worker, rules)
    if (waiting.length === 0) continue

    // The sweep acts strictly after each limit, hence the extra millisecond.
    if (!offlineCard(view, worker, waiting).told) {
      const base = seen === undefined ? timeOf(waiting[0]!, "created_at") : timeOf(seen, "seen_at")
      add("offline", worker, Math.max(now, base + limits.offlineAfterMs + 1))
    }

    if (seen === undefined || now - timeOf(seen, "seen_at") > limits.workerFreshMs) {
      // The worker is gone: the sweep still has to wake up for its runs.
      // A stale claimed run goes unknown and an unknown one goes back to the
      // queue (see `sweep`), so both need a deadline of their own — before
      // this fix a dead worker with its offline card already told had no due
      // at all, and the clock slept while its runs rotted.
      for (const run of waiting.filter((row) => row["state"] === "claimed")) {
        add("lease", String(run["id"]), Math.max(now, timeOf(run, "seen_at") + limits.runLeaseMs + 1))
      }
      for (const run of waiting.filter((row) => row["state"] === "unknown")) {
        add("requeue", String(run["id"]), Math.max(now, timeOf(run, "seen_at") + limits.runLeaseMs + 1))
      }
      continue
    }
    for (const run of waiting.filter((row) => row["state"] === "claimed")) {
      const at = Math.max(now, timeOf(run, "seen_at") + limits.runLeaseMs + 1)
      if (at <= timeOf(seen, "seen_at") + limits.workerFreshMs) add("lease", String(run["id"]), at)
    }
  }

  return due
}
