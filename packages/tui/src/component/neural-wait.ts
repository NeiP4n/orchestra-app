// The approval wait ◐: a Session whose decision (a question or a permission) is still open.
// Pure helpers so the rules are testable without a canvas.

// A wait the user never resolved still ends: the same safety timeout a tool bridge in wait has.
export const WAIT_TIMEOUT_MS = 30_000
// One glyph flip every this many milliseconds.
export const WAIT_FLIP_MS = 450

export type Waiting = Map<string, { since: number; pending: number }>

// An ask opens (or deepens) a wait; an answer closes one request, and the last answer ends it.
export function waitSignal(waiting: Waiting, kind: string, sessionID: string, now: number) {
  if (kind === "ask") {
    const current = waiting.get(sessionID)
    waiting.set(sessionID, { since: current?.since ?? now, pending: (current?.pending ?? 0) + 1 })
    return
  }
  if (kind !== "answer") return
  const current = waiting.get(sessionID)
  if (!current) return
  if (current.pending <= 1) waiting.delete(sessionID)
  else waiting.set(sessionID, { since: current.since, pending: current.pending - 1 })
}

export function expireWaiting(waiting: Waiting, now: number) {
  waiting.forEach((value, sessionID) => {
    if (now - value.since >= WAIT_TIMEOUT_MS) waiting.delete(sessionID)
  })
}

// The glyph alternates so the meaning survives without color (monochrome themes, no truecolor).
export function waitGlyph(elapsed: number) {
  return Math.floor(Math.max(0, elapsed) / WAIT_FLIP_MS) % 2 === 0 ? "◐" : "◑"
}

// Whether the effect applies at all: it is opt-in.
export function functionalEffectsEnabled(experimental: Readonly<Record<string, boolean>> | undefined) {
  return experimental?.neural_functional_effects === true
}
