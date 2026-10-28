import { RGBA } from "@opentui/core"
import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { useTheme } from "../context/theme"
import { useConfig } from "../config"
import {
  bayerDitherRow,
  pixelStreamWave,
  sculkSonicWave,
  SCULK_PIXEL_RAMP,
  SCULK_SONIC_RINGS,
} from "../ui/dither"

/**
 * Minecraft Deep Dark & Sculk Palette:
 * Bio-luminescent soul cyan, abyssal teal, shrieker resonance rings, and ancient bone ivory.
 */
export const SCULK_PALETTE = {
  voidDark: RGBA.fromHex("#010c14"),
  abyssalTeal: RGBA.fromHex("#031d28"),
  deepNavy: RGBA.fromHex("#052431"),
  tendrilDark: RGBA.fromHex("#093d4f"),
  tendrilMuted: RGBA.fromHex("#1a5663"),
  soulCyan: RGBA.fromHex("#00e5ff"),
  shriekerAqua: RGBA.fromHex("#1fc2d9"),
  soulGlow: RGBA.fromHex("#5df9de"),
  catalystBone: RGBA.fromHex("#eedcaa"),
  boneIvory: RGBA.fromHex("#d6e3c9"),
  xpSpark: RGBA.fromHex("#38ef7d"),
} as const

/**
 * Sculk Shrieker & Sensor Sonic Resonance Spinner:
 * Replaces generic dot spinners with living Minecraft Sculk resonance rings.
 */
export function SculkResonanceSpinner(props: {
  children?: JSX.Element
  color?: RGBA
  accent?: RGBA
  title?: string
}) {
  const theme = useTheme()
  const config = useConfig().data
  const [frame, setFrame] = createSignal(0)

  const activeColor = () => props.color ?? SCULK_PALETTE.soulCyan
  const boneColor = () => props.accent ?? SCULK_PALETTE.boneIvory

  createEffect(() => {
    if (!(config.animations ?? true)) return
    // Throttled to ~12.5 FPS (80ms) for high performance and zero frame drops
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % 16)
    }, 80)
    onCleanup(() => clearInterval(timer))
  })

  const ringGlyph = createMemo(() => {
    const f = frame()
    const idx = f % SCULK_SONIC_RINGS.length
    return SCULK_SONIC_RINGS[idx]
  })

  const vibrationParticles = createMemo(() => {
    const f = frame()
    const p1 = f % 2 === 0 ? "·" : " "
    const p2 = f % 3 === 0 ? "✧" : "·"
    return `${p1}${ringGlyph()}${p2}`
  })

  return (
    <Show
      when={config.animations ?? true}
      fallback={
        <box flexDirection="row" gap={1}>
          <text fg={activeColor()}>◎</text>
          <Show when={props.children}>
            <text fg={activeColor()}>{props.children}</text>
          </Show>
        </box>
      }
    >
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={boneColor()}>{vibrationParticles()}</text>
        <Show when={props.children}>
          <text fg={activeColor()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}

/**
 * Pixelated Stream Wave Tail:
 * Displays shimmering Sculk tendrils and pixel dithering at the front of an active streaming response.
 */
export function SculkPixelStreamTail(props: {
  active: boolean
  width?: number
  label?: string
}) {
  const config = useConfig().data
  const [frame, setFrame] = createSignal(0)
  const width = props.width ?? 10

  createEffect(() => {
    if (!props.active || !(config.animations ?? true)) return
    // 60ms interval (~16 FPS) during active streaming, zero overhead when done
    const timer = setInterval(() => {
      setFrame((f) => f + 1)
    }, 60)
    onCleanup(() => clearInterval(timer))
  })

  const wave = createMemo(() => {
    if (!props.active) return ""
    return pixelStreamWave(frame(), width, { tendrilDensity: 0.75, glowMode: true })
  })

  return (
    <Show when={props.active}>
      <box flexDirection="row" gap={1} paddingTop={0} paddingBottom={0} flexShrink={0}>
        <text fg={SCULK_PALETTE.tendrilDark}>╶─</text>
        <text fg={SCULK_PALETTE.soulCyan}>{wave()}</text>
        <Show when={props.label}>
          <text fg={SCULK_PALETTE.shriekerAqua}> {props.label}</text>
        </Show>
        <text fg={SCULK_PALETTE.boneIvory}>⚡</text>
      </box>
    </Show>
  )
}

/**
 * Sculk Catalyst Dithered Progress / Budget Bar:
 * Displays a beautifully dithered bar with bone accents and soul cyan graduation.
 */
export function SculkCatalystBar(props: {
  current: number
  total: number
  width?: number
  label?: string
  showPercent?: boolean
}) {
  const width = Math.max(8, props.width ?? 20)
  const ratio = () => (props.total > 0 ? Math.min(1, Math.max(0, props.current / props.total)) : 0)
  const percent = () => Math.round(ratio() * 100)

  const dithered = createMemo(() => {
    return bayerDitherRow(ratio(), width, { ramp: SCULK_PIXEL_RAMP })
  })

  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <Show when={props.label}>
        <text fg={SCULK_PALETTE.boneIvory}>{props.label}: </text>
      </Show>
      <text fg={SCULK_PALETTE.tendrilDark}>[</text>
      <text fg={SCULK_PALETTE.soulCyan}>{dithered()}</text>
      <text fg={SCULK_PALETTE.tendrilDark}>]</text>
      <Show when={props.showPercent ?? true}>
        <text fg={SCULK_PALETTE.shriekerAqua}> {percent()}%</text>
      </Show>
    </box>
  )
}

/**
 * Sculk Resonance Vibration Monitor:
 * Compact status bar / HUD widget that visualizes active neural resonance & frequency.
 */
export function SculkResonanceMonitor(props: {
  active?: boolean
  energy?: number
}) {
  const config = useConfig().data
  const [frame, setFrame] = createSignal(0)
  const active = () => props.active ?? true
  const energy = () => Math.min(1, Math.max(0, props.energy ?? 0.3))

  createEffect(() => {
    if (!active() || !(config.animations ?? true)) return
    // Dynamic throttling: fast when busy, sleepy when quiet
    const interval = energy() > 0.5 ? 60 : 120
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % 24)
    }, interval)
    onCleanup(() => clearInterval(timer))
  })

  const wave = createMemo(() => {
    const f = frame()
    const idx = f % SCULK_SONIC_RINGS.length
    const ditherRamp = bayerDitherRow(energy(), 4, { row: 0, ramp: SCULK_PIXEL_RAMP })
    return `${SCULK_SONIC_RINGS[idx]} ${ditherRamp}`
  })

  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <text fg={SCULK_PALETTE.shriekerAqua}>sculk</text>
      <text fg={SCULK_PALETTE.soulCyan}>{wave()}</text>
    </box>
  )
}
