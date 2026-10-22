/**
 * Durable suppression marker for Sessions whose automatic restart budget is exhausted.
 * Explicit user input/resume clears the marker; background startup recovery respects it.
 */
export const resumeBlockedKey = (sessionID: string) => `session/restart-blocked/${sessionID}`
