import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
export type FeedbackPhase = "idle" | "working" | "waiting" | "error" | "paused"
export interface FeedbackSource { id: string; phase: FeedbackPhase; token?: string }
export interface FeedbackEntry extends FeedbackSource { activatedAt?: number }
export function feedbackEntries(previous: readonly FeedbackEntry[], sources: readonly FeedbackSource[], now: number): FeedbackEntry[] {
  const before = new Map(previous.map((entry) => [entry.id, entry]))
  return sources.slice(0, 256).map((source) => {
    const old = before.get(source.id)
    const activated = old !== undefined && (old.phase !== source.phase || old.token !== source.token) && (source.phase === "working" || source.phase === "waiting")
    return { ...source, activatedAt: activated ? now : old?.activatedAt }
  })
}
export function feedbackFrame(entry: FeedbackEntry | undefined, now: number, motion: boolean) {
  const phase = entry?.phase ?? "idle"
  const flash = motion && (phase === "working" || phase === "waiting") && entry?.activatedAt !== undefined && now - entry.activatedAt < 750
  const pulse = motion && phase === "waiting" ? (Math.sin(now / 450) + 1) / 2 : 0
  return { phase, flash, pulse }
}
/** One clock per visible list, at most 4Hz; no idle timer, network polling or per-row timers. */
export function createStateFeedback(sources: () => readonly FeedbackSource[], motion: () => boolean) {
  const [entries, setEntries] = createSignal<FeedbackEntry[]>([])
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    const next = sources()
    const at = Date.now()
    setEntries(feedbackEntries(untrack(entries), next, at)); setNow(at)
  })
  createEffect(() => {
    const at = now()
    if (!motion() || !entries().some((entry) => entry.phase === "waiting" || feedbackFrame(entry, at, true).flash)) return
    const timer = setTimeout(() => setNow(Date.now()), 250)
    onCleanup(() => clearTimeout(timer))
  })
  return (id: string) => feedbackFrame(entries().find((entry) => entry.id === id), now(), motion())
}
export type StateFeedback = ReturnType<typeof feedbackFrame>
