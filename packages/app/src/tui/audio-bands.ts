// TUI routes/session/header.tsx, including the quiet baseline and harmonics.
export const TUI_IDLE_BANDS = [0.08, 0.12, 0.16, 0.2, 0.2, 0.16, 0.12, 0.08] as const

export function tuiAudioBands(active: boolean, tick: number) {
  if (!active) return [...TUI_IDLE_BANDS]
  const weights = [0.75, 0.85, 0.95, 0.8, 0.7, 0.85, 0.65, 0.5]

  return weights.map((weight, i) => {
    const primary = Math.sin(tick * 0.35 + i * 0.7)
    const secondary = Math.cos(tick * 0.6 - i * 1.1)
    const tertiary = Math.sin(tick * 0.18 + i * 1.5)
    const mod = 0.22 * primary + 0.12 * secondary + 0.08 * tertiary
    const level = weight + mod

    return Math.max(0.12, Math.min(1.0, Number(level.toFixed(3))))
  })
}
