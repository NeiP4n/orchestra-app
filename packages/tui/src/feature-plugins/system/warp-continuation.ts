/** A chat that stopped on a rate limit is worth resuming only while the provider limit is still recent. */
export const WARP_CONTINUATION_WINDOW_MS = 30 * 60_000
/** Attempts older than this no longer count against a session, so a later limit can be resumed again. */
export const WARP_CONTINUATION_ATTEMPT_WINDOW_MS = 2 * 60 * 60_000
/** Enough resumes to ride out a limit that clears in a few minutes, without hammering the provider. */
export const WARP_CONTINUATION_MAX_ATTEMPTS = 8

type Entry = {
  recordedAt: number
  attempts: number[]
  claimed: boolean
  /** Stopped by a per-address cap: resuming from the same address is a request spent for nothing. */
  addressCap: boolean
}

/**
 * Tracks sessions that stopped on a provider rate limit, so one IP rotation can resume all of them
 * instead of only the chat that happened to fail first. Time is injected to keep the rules testable.
 */
export function createRateLimitContinuations(now: () => number = Date.now) {
  const entries = new Map<string, Entry>()

  const pruneAttempts = (entry: Entry) => {
    const current = now()
    entry.attempts = entry.attempts.filter((at) => current - at < WARP_CONTINUATION_ATTEMPT_WINDOW_MS)
    return entry
  }

  return {
    /** Remember that the session stopped on a rate limit; the latest failure replaces the older one. */
    record(sessionID: string, options: { readonly addressCap?: boolean } = {}) {
      const entry = pruneAttempts(entries.get(sessionID) ?? { recordedAt: 0, attempts: [], claimed: false, addressCap: false })
      entry.recordedAt = now()
      entry.claimed = false
      entry.addressCap = options.addressCap === true
      entries.set(sessionID, entry)
    },
    /**
     * Sessions that stopped on a rate limit inside the window and still have an attempt left. A chat
     * stopped by a per-address cap is due only once the exit address has actually changed.
     */
    due(options: { readonly addressChanged?: boolean } = {}) {
      const current = now()
      return [...entries]
        // Attempts that fell out of their window no longer count, otherwise a session that was resumed
        // twice long ago would stay excluded until the entry is replaced by a brand new failure.
        .map(([sessionID, entry]) => [sessionID, pruneAttempts(entry)] as const)
        .filter(
          ([, entry]) =>
            !entry.claimed &&
            (!entry.addressCap || options.addressChanged === true) &&
            current - entry.recordedAt <= WARP_CONTINUATION_WINDOW_MS &&
            entry.attempts.length < WARP_CONTINUATION_MAX_ATTEMPTS,
        )
        .sort((left, right) => left[1].recordedAt - right[1].recordedAt)
        .map(([sessionID]) => sessionID)
    },
    /** Reserve one automatic continuation; false when the session must stay stopped. */
    claim(sessionID: string) {
      const entry = entries.get(sessionID)
      if (!entry || entry.claimed) return false
      // A stale failure or an exhausted attempt window keeps its attempt history: deleting the entry
      // here would hand the session a fresh allowance and resume a provider that is still refusing.
      if (now() - entry.recordedAt > WARP_CONTINUATION_WINDOW_MS) return false
      if (pruneAttempts(entry).attempts.length >= WARP_CONTINUATION_MAX_ATTEMPTS) return false
      entry.claimed = true
      return true
    },
    /** Count a continuation the server accepted; the attempt is spent only once the prompt went out. */
    commit(sessionID: string) {
      const entry = entries.get(sessionID)
      // A failure recorded between claim and commit already replaced this continuation; spending an
      // attempt for it would charge the chat for a turn the queue no longer tracks.
      if (!entry?.claimed) return
      entry.attempts.push(now())
      // The claim stays: a sent continuation must wait for the provider's next failure instead of
      // being repeated by the following rotation.
    },
    /** Give a claim back untouched: nothing was sent, so the session keeps its full allowance. */
    release(sessionID: string) {
      const entry = entries.get(sessionID)
      if (entry) entry.claimed = false
    },
    /** Drop a session that no longer waits for a continuation: a user prompt, a finished turn, a subagent. */
    forget(sessionID: string) {
      entries.delete(sessionID)
    },
    clear() {
      entries.clear()
    },
  }
}
