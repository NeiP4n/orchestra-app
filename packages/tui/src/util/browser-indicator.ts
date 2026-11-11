import { RGBA } from "@opentui/core"
import { contrastRatio } from "../theme/system"

// Browser liveness is green, independent of the theme's three semantic hue scales.
const runningGreens = ["#4ade80", "#22c55e", "#86efac", "#bbf7d0", "#dcfce7", "#f0fdf4", "#15803d", "#14532d", "#052e16", "#001005", "#000301"].map(RGBA.fromHex)
export function browserRunningColor(background: RGBA) {
  return runningGreens.find((color) => contrastRatio(color, background) >= 4.5)
    ?? runningGreens.reduce((best, color) => contrastRatio(color, background) > contrastRatio(best, background) ? color : best)
}

export type ChromePhase = "starting" | "running" | "stopping" | "stopped" | "error" | "checking"
export function browserIndicator(operation: { phase: Exclude<ChromePhase, "checking">; reason?: string } | undefined, verified: boolean | undefined, compact = false) {
  const phase: ChromePhase = operation && ["starting", "stopping", "error"].includes(operation.phase)
    ? operation.phase : verified === undefined ? "checking" : verified ? "running" : "stopped"
  const glyph = { starting: "◐", stopping: "◐", running: "●", stopped: "○", error: "✖", checking: "◌" }[phase]
  const label = { starting: "запуск", stopping: "остановка", running: compact ? "вкл" : "работает", stopped: compact ? "выкл" : "остановлен", error: "ошибка", checking: "проверка" }[phase]
  return { phase, glyph, label, reason: phase === "error" ? operation?.reason : undefined }
}
