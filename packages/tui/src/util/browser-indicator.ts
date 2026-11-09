export type ChromePhase = "starting" | "running" | "stopping" | "stopped" | "error" | "checking"
export function browserIndicator(operation: { phase: Exclude<ChromePhase, "checking">; reason?: string } | undefined, verified: boolean | undefined, compact = false) {
  const phase: ChromePhase = operation && ["starting", "stopping", "error"].includes(operation.phase)
    ? operation.phase : verified === undefined ? "checking" : verified ? "running" : "stopped"
  const glyph = { starting: "◐", stopping: "◐", running: "●", stopped: "○", error: "✖", checking: "◌" }[phase]
  const label = { starting: "запуск", stopping: "остановка", running: compact ? "вкл" : "работает", stopped: compact ? "выкл" : "остановлен", error: "ошибка", checking: "проверка" }[phase]
  return { phase, glyph, label, reason: phase === "error" ? operation?.reason : undefined }
}
