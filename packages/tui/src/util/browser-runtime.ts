// The Browser tab runs its Chrome through the shared runtime in core, so the chat agent's browser tool
// acts in the very same Chrome (one per browser session, on its own profile, never the operator's own).
import { BrowserRuntime } from "@orchestra/core/browser/runtime"

export const {
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
  reload,
} = BrowserRuntime
