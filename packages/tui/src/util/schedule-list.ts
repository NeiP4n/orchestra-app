import type { ScheduleView } from "@orchestra/core/schedule-view"
import type { BrowserSchedule } from "@orchestra/core/browser/schedule"
const clock = (at: number) => new Date(at).toLocaleString()
export function scheduleDetails(item: ScheduleView.Item, status?: BrowserSchedule.Status): string[] {
  return [
    `${item.kind} · ${item.enabled ? "active" : "paused"}`,
    ...(item.kind === "browser" ? [
      `Watcher: ${!item.enabled ? "off" : status?.watcher ?? "off"}`,
      `Last event: ${status?.lastEventAt === undefined ? "none verified" : clock(status.lastEventAt)}`,
    ] : []),
    `Next: ${item.nextAt === null ? item.kind === "browser" && item.enabled ? "page event" : "none" : clock(item.nextAt)}`,
    `Last result: ${status ? status.phase === "checked" ? "page read completed" : status.phase === "info" ? "title/URL only" : status.phase : item.lastFiredAt === undefined ? "not run" : "dispatched (result unverified)"}`,
    ...(status?.lastCheckedAt === undefined ? [] : [`Last read: ${clock(status.lastCheckedAt)}`]),
    ...(item.pausedReason ? [item.pausedReason] : []),
  ]
}
