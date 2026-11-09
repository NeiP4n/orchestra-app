export * as TriggerMissed from "./trigger-missed.js"
import { Trigger } from "./trigger.js"
export const TICK_GRACE_MS = 90_000
export const ONCE_GRACE_MS = 24 * 60 * 60_000
export function plan(trigger: Trigger.Info, now: number, timezone = Trigger.localZone()): Trigger.Info {
  if (!trigger.enabled || trigger.nextAt === null || trigger.pendingFire || trigger.catchUpRemaining || now - trigger.nextAt <= TICK_GRACE_MS) return trigger
  const policy = trigger.missedPolicy ?? (trigger.kind === "once" ? "run-once" : "skip")
  if (trigger.kind === "once") {
    if (policy !== "skip" && now-trigger.nextAt <= ONCE_GRACE_MS) return trigger
    return { ...trigger, enabled: false, nextAt: null, missedCount: (trigger.missedCount ?? 0)+1, lastMissedAt: now, pausedReason: "missed: one-shot expired or skip policy selected" }
  }
  if (trigger.kind !== "cron" && trigger.kind !== "interval") return trigger
  let count = 0, at: number | null = trigger.nextAt, recent: number[] = []
  if (trigger.kind === "interval") {
    const interval = Number(trigger.spec)*60_000
    count = Math.floor((now-at)/interval)+1
    recent = Array.from({ length: Math.min(3,count) }, (_,i) => at!+(count-Math.min(3,count)+i)*interval)
  } else {
    while (at !== null && at <= now && count < 10_000) {
      recent.push(at); recent = recent.slice(-3); count++
      at = Trigger.nextFrom(trigger, at, timezone)
    }
    if (at !== null && at <= now) return { ...trigger, enabled: false, pausedReason: "missed: cron backlog exceeds 10000 slots; review required", missedCount: (trigger.missedCount ?? 0)+count, missedCountAtLeast: true, lastMissedAt: now }
  }
  const keep = policy === "catch-up" ? Math.min(3,count) : policy === "run-once" ? 1 : 0
  const skipped = count-keep
  return { ...trigger, nextAt: keep ? recent[recent.length-keep]! : Trigger.nextFrom(trigger, now, timezone), catchUpRemaining: keep || undefined,
    missedCount: (trigger.missedCount ?? 0)+skipped, ...(skipped ? { lastMissedAt: now } : {}) }
}
