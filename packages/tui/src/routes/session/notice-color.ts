export type FeedbackRole = "error" | "warning" | "info" | "text" | "muted"

/**
 * Colour role of a subagent or shell completion notice. Red (the error role) is
 * only for a real failure: every other state, including a plain instruction or
 * system notice that has no state at all, gets info, warning or neutral.
 */
export function completionNoticeRole(input: { state: string | undefined; hovering: boolean }): FeedbackRole {
  if (input.state === "error") return "error"
  if (input.state === "cancelled") return "warning"
  if (input.hovering) return "text"
  return "info"
}

/** Colour role of an inline tool row: error only when the call failed and was not a user denial. */
export function toolRowRole(input: { permission: boolean; failed: boolean; hovering: boolean }): FeedbackRole {
  if (input.permission) return "warning"
  if (input.failed) return "error"
  if (input.hovering) return "text"
  return "muted"
}
