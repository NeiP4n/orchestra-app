import type { BrowserSchedule } from "@orchestra/core/browser/schedule"

const clock = (at: number) => new Date(at).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
})

/** Waking the Orchestrator is not a successful page read. Keep those states distinct. */
export function scheduleLine(status: BrowserSchedule.Status, now: number) {
  const last = status.lastCheckedAt === undefined ? "never" : clock(status.lastCheckedAt)
  const next = !status.enabled || status.nextAt === null ? "none" :
    status.nextAt <= now ? `due (${clock(status.nextAt)})` : clock(status.nextAt)
  const state = !status.enabled ? "paused" : status.phase === "dispatched" ? "awaiting BrowserAgent" :
    status.phase === "checked" ? "page read completed" : status.phase === "checking" ? "reading page" : status.phase
  return `Read-only check ${status.triggerID}: ${state} | last read: ${last} | next: ${next}`
}
