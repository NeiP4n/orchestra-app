import { tr } from "../../util/i18n"
/** Repeated provider/network failures from parallel agents should trigger one rotation, not a reconnect loop. */
export const AUTO_ROTATION_COOLDOWN_MS = 30_000
/** A provider that keeps refusing after several fresh addresses is not helped by more rotations. */
export const AUTO_ROTATION_LIMIT = 3
export const AUTO_ROTATION_LIMIT_WINDOW_MS = 10 * 60_000
/**
 * Measured on this network: a reconnect, a brand-new registration and four different tunnel
 * endpoints all returned the same WARP exit address. After a rotation that kept the address the
 * tunnel is left alone for this long, doubling with every further miss up to the ceiling.
 */
export const INEFFECTIVE_ROTATION_WINDOW_MS = 15 * 60_000
export const INEFFECTIVE_ROTATION_MAX_WINDOW_MS = 60 * 60_000

export type RotationDecision =
  | { run: true }
  | { run: false; reason: "cooldown"; retryIn: number }
  | { run: false; reason: "unchanged" | "limit"; until: number }

/**
 * Decides whether an automatic IP rotation may run now. Time is injected to keep the rules testable;
 * manual "Change IP" presses are recorded too, so they count against the same ceiling.
 */
export function createRotationGate(now: () => number = Date.now) {
  let times: number[] = []
  let unchangedUntil = 0
  let misses = 0

  return {
    decide(): RotationDecision {
      const current = now()
      if (current < unchangedUntil) return { run: false, reason: "unchanged", until: unchangedUntil }
      times = times.filter((at) => current - at < AUTO_ROTATION_LIMIT_WINDOW_MS)
      if (times.length >= AUTO_ROTATION_LIMIT) return { run: false, reason: "limit", until: times[0] + AUTO_ROTATION_LIMIT_WINDOW_MS }
      const retryIn = AUTO_ROTATION_COOLDOWN_MS - (current - (times.at(-1) ?? -Infinity))
      if (retryIn > 0) return { run: false, reason: "cooldown", retryIn }
      return { run: true }
    },
    /** A rotation went out; it counts against the ceiling whether or not it changes the address. */
    started() {
      times.push(now())
    },
    /** An unchanged address backs the tunnel off; a new one clears the backoff. */
    finished(changed: boolean) {
      if (changed) {
        misses = 0
        unchangedUntil = 0
        return
      }
      unchangedUntil = now() + Math.min(INEFFECTIVE_ROTATION_WINDOW_MS * 2 ** misses, INEFFECTIVE_ROTATION_MAX_WINDOW_MS)
      misses++
    },
  }
}

export type AutoRotationState =
  | { phase: "idle" }
  | { phase: "rotating"; at: number }
  | { phase: "changed"; at: number; from?: string; to?: string }
  | { phase: "paused"; at: number; reason: "unchanged" | "limit"; until: number }
  | { phase: "failed"; at: number; message: string }

/** The sidebar's one-line account of what Auto IP last did, so a switch is visible without a toast. */
export function describeAutoRotation(state: AutoRotationState, ru: boolean) {
  const clock = (at: number) => new Date(at).toLocaleTimeString(ru ? "ru-RU" : "en-GB", { hour: "2-digit", minute: "2-digit" })
  switch (state.phase) {
    case "idle":
      return ""
    case "rotating":
      return ru ? tr("changing IP…") : "changing IP…"
    case "changed":
      return `${state.from ?? "?"} → ${state.to ?? "?"} · ${clock(state.at)}`
    case "paused":
      if (state.reason === "unchanged") return ru ? tr("same IP, again at {time}", { time: clock(state.until) }) : `same IP, retry at ${clock(state.until)}`
      return ru ? tr("change limit, paused until {time}", { time: clock(state.until) }) : `rotation cap, paused until ${clock(state.until)}`
    case "failed":
      return ru ? tr("error · {time}", { time: clock(state.at) }) : `failed · ${clock(state.at)}`
  }
}
