export * as BrowserBudget from "./budget.js"
/** A profile contains several Chromium OS processes. This is a profile budget, not a PID count. */
export const MAX_ACTIVE_PROFILES = 1
export function requireRoom(active: number) {
  if (active >= MAX_ACTIVE_PROFILES) throw new Error("Browser safety limit: one Orchestra Chrome profile at a time. Close the running Orchestra browser before opening another. Saved sessions and logins are not deleted.")
}
