import { parseColor, RGBA, Renderable, type ColorInput, type OptimizedBuffer, type RenderableOptions, type RenderContext } from "@opentui/core"
import { extend } from "@opentui/solid"
import { createMemo, type JSX } from "solid-js"

/**
 * 9 levels of pseudo-graphic audio blocks:
 * 0: space (empty)
 * 1..8: lower 1/8 to full block [ ▂▃▄▅▆▇█]
 */
export const WAVE_BLOCKS = [" ", " ", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const
export const PEAK_MARKER = "▔"

export const ATTACK_TIME = 40
export const DECAY_TIME = 380
export const PEAK_HOLD_TIME = 260
export const PEAK_DECAY_TIME = 450

export type BandBallistics = {
  current: number
  peak: number
  peakHoldClock: number
}

export function createBandBallistics(initial = 0): BandBallistics {
  const clamped = Math.max(0, Math.min(1, initial))
  return {
    current: clamped,
    peak: clamped,
    peakHoldClock: 0,
  }
}

export function stepBandBallistics(
  state: BandBallistics,
  target: number,
  deltaMs: number,
  options?: {
    attackMs?: number
    decayMs?: number
    peakHoldMs?: number
    peakDecayMs?: number
  },
): BandBallistics {
  const attackMs = options?.attackMs ?? ATTACK_TIME
  const decayMs = options?.decayMs ?? DECAY_TIME
  const peakHoldMs = options?.peakHoldMs ?? PEAK_HOLD_TIME
  const peakDecayMs = options?.peakDecayMs ?? PEAK_DECAY_TIME

  const clampedTarget = Math.max(0, Math.min(1, target))
  let current = state.current

  if (clampedTarget > current) {
    current = Math.min(clampedTarget, current + deltaMs / attackMs)
  } else if (clampedTarget < current) {
    current = Math.max(clampedTarget, current - deltaMs / decayMs)
  }

  let peak = state.peak
  let peakHoldClock = state.peakHoldClock

  if (current >= peak) {
    peak = current
    peakHoldClock = peakHoldMs
  } else {
    let decayTime = deltaMs
    if (peakHoldClock > 0) {
      if (deltaMs <= peakHoldClock) {
        peakHoldClock -= deltaMs
        decayTime = 0
      } else {
        decayTime = deltaMs - peakHoldClock
        peakHoldClock = 0
      }
    }
    if (decayTime > 0) {
      peak = Math.max(current, peak - decayTime / peakDecayMs)
    }
  }

  return { current, peak, peakHoldClock }
}

export type AudioWaveScale = "compact" | "normal" | "wide"

export interface FormatAudioWaveOptions {
  readonly ballistics?: readonly BandBallistics[]
  readonly height?: number
  readonly scale?: AudioWaveScale
  readonly peakHold?: boolean
}

export function scaleAudioBands(bands: readonly number[], scale: AudioWaveScale = "normal"): number[] {
  if (scale === "normal" || bands.length === 0) return [...bands]

  if (scale === "compact") {
    // Compact mode for narrow viewports (<80 columns): downsamples bands by pairwise max
    const result: number[] = []
    for (let i = 0; i < bands.length; i += 2) {
      if (i + 1 < bands.length) {
        result.push(Math.max(bands[i]!, bands[i + 1]!))
      } else {
        result.push(bands[i]!)
      }
    }
    return result
  }

  if (scale === "wide") {
    // Wide mode: double horizontal resolution per band
    const result: number[] = []
    for (let i = 0; i < bands.length; i++) {
      result.push(bands[i]!, bands[i]!)
    }
    return result
  }

  return [...bands]
}

export function formatAudioWaveString(
  bands: readonly number[],
  ballisticsOrOptions?: readonly BandBallistics[] | FormatAudioWaveOptions,
  options?: FormatAudioWaveOptions,
): string {
  let ballistics: readonly BandBallistics[] | undefined
  let opts: FormatAudioWaveOptions = {}

  if (Array.isArray(ballisticsOrOptions)) {
    ballistics = ballisticsOrOptions
    if (options) opts = options
  } else if (ballisticsOrOptions) {
    opts = ballisticsOrOptions as FormatAudioWaveOptions
    ballistics = opts.ballistics
  }

  const scale = opts.scale ?? "normal"
  const height = Math.max(1, opts.height ?? 1)
  const effectiveBands = scaleAudioBands(bands, scale)

  if (height === 1) {
    return effectiveBands
      .map((target, idx) => {
        const level = ballistics?.[idx]?.current ?? target
        const clamped = Math.max(0, Math.min(1, level))
        const blockIndex = Math.round(clamped * 8)
        return WAVE_BLOCKS[blockIndex] ?? " "
      })
      .join("")
  }

  const rows: string[] = []
  const totalSublevels = height * 8

  for (let row = 0; row < height; row++) {
    const rowFromBottom = height - 1 - row
    const rowBottomSub = rowFromBottom * 8
    const rowTopSub = (rowFromBottom + 1) * 8

    let line = ""
    for (let col = 0; col < effectiveBands.length; col++) {
      const b = ballistics?.[col]
      const current = b?.current ?? effectiveBands[col] ?? 0
      const peak = opts.peakHold && b ? b.peak : current

      const activeSub = Math.round(Math.max(0, Math.min(1, current)) * totalSublevels)
      const peakSub = Math.round(Math.max(0, Math.min(1, peak)) * totalSublevels)
      const peakRow = Math.max(0, Math.min(height - 1, Math.floor((peakSub - 1) / 8)))

      let char = " "
      if (activeSub >= rowTopSub) {
        char = WAVE_BLOCKS[8]
      } else if (activeSub > rowBottomSub) {
        const rem = Math.max(1, Math.min(7, activeSub - rowBottomSub))
        char = WAVE_BLOCKS[rem]
      } else if (opts.peakHold && peakSub > 0 && rowFromBottom === peakRow) {
        char = PEAK_MARKER
      }
      line += char
    }
    rows.push(line)
  }

  return rows.join("\n")
}

export type AudioWaveOptions = RenderableOptions<AudioWaveRenderable> & {
  bands?: number[]
  height?: number
  scale?: AudioWaveScale
  color?: RGBA
  peakColor?: RGBA
  backgroundColor?: RGBA
  peakHold?: boolean
  enabled?: boolean
}

export class AudioWaveRenderable extends Renderable {
  private _bands: number[] = []
  private _ballistics: BandBallistics[] = []
  private _scale: AudioWaveScale = "normal"
  private _color: RGBA
  private _peakColor: RGBA
  private _backgroundColor: RGBA
  private _peakHold: boolean
  private _enabled: boolean

  constructor(ctx: RenderContext, options: AudioWaveOptions = {}) {
    super(ctx, {
      ...options,
      height: options.height ?? 1,
      live: options.enabled ?? true,
    })
    this._scale = options.scale ?? "normal"
    this._enabled = options.enabled ?? true
    this._peakHold = options.peakHold ?? true
    this._color = options.color ?? RGBA.fromInts(16, 185, 129) // emerald
    this._peakColor = options.peakColor ?? RGBA.fromInts(245, 158, 11) // gold
    this._backgroundColor = options.backgroundColor ?? RGBA.fromValues(0, 0, 0, 0)
    if (options.bands) {
      this.bands = options.bands
    }
  }

  get scale(): AudioWaveScale {
    return this._scale
  }

  set scale(value: AudioWaveScale) {
    if (this._scale === value) return
    this._scale = value
    this.requestRender()
  }

  get bands() {
    return this._bands
  }

  set bands(values: number[]) {
    this._bands = values
    while (this._ballistics.length < values.length) {
      this._ballistics.push(createBandBallistics(0))
    }
    if (this._ballistics.length > values.length) {
      this._ballistics.length = values.length
    }
    this.requestRender()
  }

  get ballistics() {
    return this._ballistics
  }

  set color(value: RGBA) {
    if (value.equals(this._color)) return
    this._color = value
    this.requestRender()
  }

  set peakColor(value: RGBA) {
    if (value.equals(this._peakColor)) return
    this._peakColor = value
    this.requestRender()
  }

  set peakHold(value: boolean) {
    if (this._peakHold === value) return
    this._peakHold = value
    this.requestRender()
  }

  set enabled(value: boolean) {
    if (this._enabled === value) return
    this._enabled = value
    this.live = value
    this.requestRender()
  }

  step(deltaMs: number) {
    for (let i = 0; i < this._bands.length; i++) {
      this._ballistics[i] = stepBandBallistics(this._ballistics[i]!, this._bands[i] ?? 0, deltaMs)
    }
  }

  protected override onUpdate(deltaTime: number): void {
    if (!this.live || !this._enabled) return
    const dt = Math.min(deltaTime, 100)
    this.step(dt)
    this.requestRender()
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (!this.visible || this.isDestroyed || this.width <= 0 || this.height <= 0) return
    const effectiveBands = scaleAudioBands(this._bands, this._scale)
    const bandCount = effectiveBands.length
    if (bandCount === 0) return

    const H = this.height
    const W = this.width

    for (let col = 0; col < W; col++) {
      const bandIdx = Math.min(bandCount - 1, Math.floor((col * bandCount) / W))
      const b = this._ballistics[bandIdx] ?? {
        current: effectiveBands[bandIdx] ?? 0,
        peak: effectiveBands[bandIdx] ?? 0,
        peakHoldClock: 0,
      }
      const current = b.current
      const peak = this._peakHold ? b.peak : current

      const totalSublevels = H * 8
      const activeSublevels = Math.round(current * totalSublevels)
      const peakSublevel = Math.round(peak * totalSublevels)
      const peakRowFromBottom = Math.max(0, Math.min(H - 1, Math.floor((peakSublevel - 1) / 8)))

      for (let row = 0; row < H; row++) {
        const rowFromBottom = H - 1 - row
        const rowBottomSub = rowFromBottom * 8
        const rowTopSub = (rowFromBottom + 1) * 8

        let char = " "
        let fg = this._color

        if (activeSublevels >= rowTopSub) {
          char = WAVE_BLOCKS[8]
          fg = this._color
        } else if (activeSublevels > rowBottomSub) {
          const rem = Math.max(1, Math.min(7, activeSublevels - rowBottomSub))
          char = WAVE_BLOCKS[rem]
          fg = this._color
        } else if (this._peakHold && peakSublevel > 0 && rowFromBottom === peakRowFromBottom) {
          char = PEAK_MARKER
          fg = this._peakColor
        }

        const screenX = this.screenX + col
        const screenY = this.screenY + row
        if (char !== " ") {
          buffer.setCell(screenX, screenY, char, fg, this._backgroundColor)
        }
      }
    }
  }
}

extend({ audio_wave: AudioWaveRenderable })

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    audio_wave: typeof AudioWaveRenderable
  }
}

function resolveRgba(color: RGBA | ColorInput | undefined, fallback: RGBA): RGBA {
  if (!color) return fallback
  if (color instanceof RGBA) return color
  return parseColor(color)
}

export type AudioWaveProps = {
  bands: number[]
  height?: number
  width?: number | "auto" | `${number}%`
  scale?: AudioWaveScale
  terminalWidth?: number
  color?: RGBA | ColorInput
  peakColor?: RGBA | ColorInput
  backgroundColor?: RGBA | ColorInput
  peakHold?: boolean
  enabled?: boolean
}

export function AudioWave(props: AudioWaveProps): JSX.Element {
  const defaultEmerald = RGBA.fromInts(16, 185, 129)
  const defaultGold = RGBA.fromInts(245, 158, 11)
  const defaultBg = RGBA.fromValues(0, 0, 0, 0)

  const activeColor = createMemo(() => resolveRgba(props.color, defaultEmerald))
  const activePeakColor = createMemo(() => resolveRgba(props.peakColor, defaultGold))
  const activeBg = createMemo(() => resolveRgba(props.backgroundColor, defaultBg))

  const activeScale = createMemo<AudioWaveScale>(() => {
    if (props.scale) return props.scale
    if (props.terminalWidth !== undefined && props.terminalWidth < 80) return "compact"
    return "normal"
  })

  const computedHeight = createMemo(() => {
    if (typeof props.height === "number") return props.height
    return 1
  })

  const computedWidth = createMemo(() => {
    if (props.width !== undefined) return props.width
    return scaleAudioBands(props.bands, activeScale()).length
  })

  return (
    <audio_wave
      bands={props.bands}
      scale={activeScale()}
      height={computedHeight()}
      width={computedWidth()}
      color={activeColor()}
      peakColor={activePeakColor()}
      backgroundColor={activeBg()}
      peakHold={props.peakHold ?? true}
      enabled={props.enabled ?? true}
    />
  )
}
