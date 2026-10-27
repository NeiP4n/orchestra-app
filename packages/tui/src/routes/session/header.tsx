import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { AudioWave } from "../../component/audio-wave"
import { useData } from "../../context/data"
import { useTheme } from "../../context/theme"

export const IDLE_BANDS = [0.08, 0.12, 0.16, 0.20, 0.20, 0.16, 0.12, 0.08] as const

export const HEADER_ANIMATION_INTERVAL_MS = 33 // ~30 fps
export const DEFAULT_BAND_EPSILON = 0.01

export function areBandsEqual(
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
  epsilon = DEFAULT_BAND_EPSILON,
): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]! - b[i]!) > epsilon) return false
  }
  return true
}

/**
 * Throttles and deduplicates header equalizer updates to prevent excessive TUI repaints
 * during high-frequency token streaming and subagent activity.
 */
export class HeaderUpdateGovernor {
  private lastUpdateMs = 0
  private lastBands: number[] = []
  private updateCount = 0
  private skippedCount = 0

  constructor(readonly minIntervalMs: number = HEADER_ANIMATION_INTERVAL_MS) {}

  shouldUpdate(active: boolean, newBands: readonly number[], now: number = Date.now()): boolean {
    if (!active) {
      if (this.lastBands.length > 0 && areBandsEqual(this.lastBands, newBands)) {
        this.skippedCount++
        return false
      }
      this.lastBands = [...newBands]
      this.lastUpdateMs = now
      this.updateCount++
      return true
    }

    const elapsed = now - this.lastUpdateMs
    if (elapsed < this.minIntervalMs) {
      this.skippedCount++
      return false
    }

    if (this.lastBands.length > 0 && areBandsEqual(this.lastBands, newBands)) {
      this.skippedCount++
      return false
    }

    this.lastBands = [...newBands]
    this.lastUpdateMs = now
    this.updateCount++
    return true
  }

  get stats() {
    return {
      updates: this.updateCount,
      skipped: this.skippedCount,
    }
  }

  reset() {
    this.lastUpdateMs = 0
    this.lastBands = []
    this.updateCount = 0
    this.skippedCount = 0
  }
}

/**
 * Calculates 8-band audio equalizer energy levels.
 * When active (streaming response or subagents running), returns dynamic harmonic levels.
 * When idle, returns a calm resting baseline indicating readiness.
 */
export function calculateAudioBands(active: boolean, tick?: number): number[] {
  if (!active) {
    return [...IDLE_BANDS]
  }

  const t = tick !== undefined ? tick : Date.now() / 80

  // 8 frequency bands: from sub-bass to highs
  const baseWeights = [0.75, 0.85, 0.95, 0.80, 0.70, 0.85, 0.65, 0.50]

  return baseWeights.map((weight, i) => {
    // Dynamic multi-frequency harmonic modulation
    const primary = Math.sin(t * 0.35 + i * 0.7)
    const secondary = Math.cos(t * 0.6 - i * 1.1)
    const tertiary = Math.sin(t * 0.18 + i * 1.5)

    // Composite variation
    const mod = 0.22 * primary + 0.12 * secondary + 0.08 * tertiary
    const level = weight + mod
    return Math.max(0.12, Math.min(1.0, Number(level.toFixed(3))))
  })
}

export function SessionHeader(props: { sessionID: string }): JSX.Element {
  const data = useData()
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const [tick, setTick] = createSignal(0)

  const session = createMemo(() => data.session.get(props.sessionID))
  const isRunning = createMemo(() => data.session.status(props.sessionID) === "running")
  const activeSubagents = createMemo(() =>
    data.session.list().filter((s) => s.parentID === props.sessionID && data.session.status(s.id) === "running"),
  )
  const active = createMemo(() => isRunning() || activeSubagents().length > 0)

  createEffect(() => {
    if (!active()) return
    const interval = setInterval(() => {
      setTick((t) => (t + 1) % 10000)
    }, HEADER_ANIMATION_INTERVAL_MS)
    onCleanup(() => clearInterval(interval))
  })

  const rawBands = createMemo(() => calculateAudioBands(active(), active() ? tick() : undefined))
  const bands = createMemo<number[]>(() => rawBands(), [...IDLE_BANDS], { equals: areBandsEqual })

  const statusLabel = createMemo(() => {
    const subCount = activeSubagents().length
    if (subCount > 0) {
      return `${subCount} ${subCount === 1 ? "agent" : "agents"} running`
    }
    if (isRunning()) {
      return "Generating…"
    }
    return "Ready"
  })

  const title = createMemo(() => session()?.title || "Session")
  const isNarrow = createMemo(() => dimensions().width < 80)
  const compact = createMemo(() => dimensions().width < 50)

  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      justifyContent="space-between"
      alignItems="center"
    >
      <box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
        <Show when={!compact()}>
          <text fg={theme.text.muted} wrapMode="none" truncate>
            {title()}
          </text>
        </Show>
      </box>
      <box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
        <text fg={active() ? theme.text.feedback.info.base : theme.text.muted} wrapMode="none">
          {statusLabel()}
        </text>
        <AudioWave
          bands={bands()}
          height={1}
          scale={isNarrow() ? "compact" : "normal"}
          terminalWidth={dimensions().width}
          peakHold={true}
          enabled={true}
          color={active() ? theme.text.formfield.selected : theme.text.muted}
          peakColor={theme.text.feedback.warning.base}
        />
      </box>
    </box>
  )
}
