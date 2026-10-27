import { parseColor, RGBA, type ColorInput } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"

export const GLITCH_CHARS = ["░", "▒", "▓", "§", "⚡", "!"] as const
export const GLITCH_DURATION = 300

export const HARMONIC_EMERALD = RGBA.fromInts(16, 185, 129)
export const HARMONIC_GOLD = RGBA.fromInts(245, 158, 11)
export const HARMONIC_DURATION = 1000

export const clamp = (value: number) => Math.max(0, Math.min(1, value))
export const smootherstep = (value: number) => {
  const x = clamp(value)
  return x * x * x * (x * (x * 6 - 15) + 10)
}

export const coast = (value: number) => {
  const clamped = clamp(value)
  const ramp = 0.2
  if (clamped < ramp) return (clamped * clamped) / (2 * ramp * (1 - ramp))
  if (clamped > 1 - ramp) return 1 - ((1 - clamped) * (1 - clamped)) / (2 * ramp * (1 - ramp))
  return (clamped - ramp / 2) / (1 - ramp)
}

export function glitchText(text: string, progress: number, seed = 0): string {
  if (progress <= 0 || progress >= 1 || text.length === 0) {
    return text
  }

  const intensity = (1 - progress) * (0.4 + 0.6 * Math.sin(progress * Math.PI))
  const chars = Array.from(text)

  return chars
    .map((char, index) => {
      if (char === "\n" || char === "\r" || char === "\t") return char
      const hash = Math.sin(index * 1337.13 + progress * 987.65 + seed * 42.42) * 10000
      const rand = hash - Math.floor(hash)

      if (rand < intensity * 0.75) {
        const glitchIdx = Math.floor(rand * 100) % GLITCH_CHARS.length
        return GLITCH_CHARS[glitchIdx]!
      }
      return char
    })
    .join("")
}

export type HarmonicWaveSample = {
  emerald: number
  gold: number
  total: number
  color: RGBA
}

export function sampleHarmonicWave(
  index: number,
  totalLength: number,
  progress: number,
): HarmonicWaveSample {
  if (totalLength <= 0 || progress <= 0 || progress >= 1) {
    return {
      emerald: 0,
      gold: 0,
      total: 0,
      color: RGBA.fromValues(0, 0, 0, 0),
    }
  }

  const head1 = totalLength * 0.15
  const tail1 = totalLength * 0.4
  const front1 = -head1 + coast(progress) * (totalLength + head1 + tail1)
  const dist1 = front1 - index
  const emeraldIntensity =
    dist1 < 0
      ? smootherstep(Math.max(0, 1 + dist1 / head1))
      : smootherstep(Math.max(0, 1 - dist1 / tail1))

  const head2 = totalLength * 0.2
  const tail2 = totalLength * 0.5
  const p2 = clamp((progress - 0.15) / 0.85)
  const front2 = -head2 + coast(p2) * (totalLength + head2 + tail2)
  const dist2 = front2 - index
  const goldIntensity =
    progress < 0.15
      ? 0
      : dist2 < 0
        ? smootherstep(Math.max(0, 1 + dist2 / head2))
        : smootherstep(Math.max(0, 1 - dist2 / tail2))

  const envelope = Math.sin(progress * Math.PI)
  const em = emeraldIntensity * envelope
  const gd = goldIntensity * envelope
  const total = Math.min(1, em + gd)

  const r = HARMONIC_EMERALD.r * em + HARMONIC_GOLD.r * gd
  const g = HARMONIC_EMERALD.g * em + HARMONIC_GOLD.g * gd
  const b = HARMONIC_EMERALD.b * em + HARMONIC_GOLD.b * gd
  const a = total

  return {
    emerald: em,
    gold: gd,
    total,
    color: RGBA.fromValues(r, g, b, a),
  }
}

function resolveColor(input: RGBA | ColorInput | undefined, fallback: RGBA): RGBA {
  if (!input) return fallback
  if (input instanceof RGBA) return input
  return parseColor(input)
}

export type DissonanceGlitchProps = {
  text: string
  active?: boolean
  duration?: number
  color?: RGBA | ColorInput
  glitchColor?: RGBA | ColorInput
  onComplete?: () => void
}

export function DissonanceGlitch(props: DissonanceGlitchProps): JSX.Element {
  const renderer = useRenderer()
  const duration = () => props.duration ?? GLITCH_DURATION
  const [elapsed, setElapsed] = createSignal(0)
  const [isAnimating, setIsAnimating] = createSignal(false)

  const normalColor = createMemo(() => resolveColor(props.color, RGBA.fromInts(229, 231, 235)))
  const badColor = createMemo(() => resolveColor(props.glitchColor, RGBA.fromInts(239, 68, 68)))

  createEffect(() => {
    if (props.active) {
      setElapsed(0)
      setIsAnimating(true)
    } else {
      setIsAnimating(false)
      setElapsed(0)
    }
  })

  createEffect(() => {
    if (!isAnimating()) return
    let prev = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      const delta = now - prev
      prev = now
      setElapsed((cur) => {
        const next = cur + delta
        if (next >= duration()) {
          clearInterval(timer)
          setIsAnimating(false)
          props.onComplete?.()
          renderer.requestRender()
          return duration()
        }
        renderer.requestRender()
        return next
      })
    }, 16)

    onCleanup(() => {
      clearInterval(timer)
    })
  })

  const progress = () => (isAnimating() ? clamp(elapsed() / duration()) : 0)
  const renderedText = createMemo(() => (isAnimating() ? glitchText(props.text, progress(), elapsed()) : props.text))
  const currentColor = createMemo(() => (isAnimating() ? badColor() : normalColor()))

  return (
    <text fg={currentColor()} wrapMode="none">
      {renderedText()}
    </text>
  )
}

export type HarmonicFlashProps = {
  active?: boolean
  duration?: number
  width?: number
  onComplete?: () => void
  children?: JSX.Element
}

export function HarmonicFlash(props: HarmonicFlashProps): JSX.Element {
  const renderer = useRenderer()
  const duration = () => props.duration ?? HARMONIC_DURATION
  const [elapsed, setElapsed] = createSignal(0)
  const [isAnimating, setIsAnimating] = createSignal(false)

  createEffect(() => {
    if (props.active) {
      setElapsed(0)
      setIsAnimating(true)
    } else {
      setIsAnimating(false)
      setElapsed(0)
    }
  })

  createEffect(() => {
    if (!isAnimating()) return
    let prev = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      const delta = now - prev
      prev = now
      setElapsed((cur) => {
        const next = cur + delta
        if (next >= duration()) {
          clearInterval(timer)
          setIsAnimating(false)
          props.onComplete?.()
          renderer.requestRender()
          return duration()
        }
        renderer.requestRender()
        return next
      })
    }, 16)

    onCleanup(() => {
      clearInterval(timer)
    })
  })

  const progress = () => (isAnimating() ? clamp(elapsed() / duration()) : 0)
  const width = () => props.width ?? 40

  const waveSamples = createMemo(() => {
    if (!isAnimating()) return []
    const w = width()
    const p = progress()
    const items: HarmonicWaveSample[] = []
    for (let i = 0; i < w; i++) {
      items.push(sampleHarmonicWave(i, w, p))
    }
    return items
  })

  return (
    <box flexDirection="column">
      <Show when={isAnimating()}>
        <box height={1} flexDirection="row">
          <For each={waveSamples()}>
            {(sample) => (
              <text fg={sample.color} wrapMode="none">
                {sample.total > 0.05 ? "━" : " "}
              </text>
            )}
          </For>
        </box>
      </Show>
      {props.children}
      <Show when={isAnimating()}>
        <box height={1} flexDirection="row">
          <For each={waveSamples()}>
            {(sample) => (
              <text fg={sample.color} wrapMode="none">
                {sample.total > 0.05 ? "━" : " "}
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
