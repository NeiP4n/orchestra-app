// The Browser tab runs its Chrome through the shared runtime in core, so the chat agent's browser tool
// acts in the very same Chrome (one per browser session, on its own profile, never the operator's own).
import { BrowserSchedule } from "@orchestra/core/browser/schedule"
import { BrowserRuntime } from "@orchestra/core/browser/runtime"

// Local operational status reads do not poll the website or Chrome.
export const scheduleStatus = BrowserSchedule.forSession

export const {
  browserResources,
  profileRunning,
  browserLimitDetails,
  closeBlockedBrowser,
  open,
  isOpen,
  deleteProfile,
  go,
  read,
  close,
  closeAll,
  publishSelection,
  publishSessions,
  trace,
  leases,
  agentCursor,
  setLease,
  releaseOperatorLeases,
  watch,
  unwatch,
  tabs,
  selectTab,
  newTab,
  closeTab,
  history,
  relaunch,
  mouse,
  key,
  isWindowed,
  modeOf,
  captureProblemOf,
  captureAttemptOf,
  captureRetrying,
  reload,
} = BrowserRuntime

// A control lease left by a killed run would lock the agents out of the session; the tab that starts now owns none.
try {
  BrowserRuntime.releaseOperatorLeases()
} catch {
  // The state folder may not exist yet: there is nothing to release.
}
