export * as BrowserBudget from "./budget.js"
/** A profile contains several Chromium OS processes. This is a profile budget, not a PID count. */
export const MAX_ACTIVE_PROFILES = 1
export function requireRoom(active: number) {
  if (active >= MAX_ACTIVE_PROFILES) throw new Error("Browser safety limit: one Orchestra Chrome profile at a time. Close the running Orchestra browser before opening another. Saved sessions and logins are not deleted.")
}

export function requireStopped(pid: number, probe: (pid: number) => "alive" | "dead" | "unknown") {
  if (probe(pid) !== "dead") throw new Error("Browser safety limit: a managed Chrome process is still alive or cannot be checked, even though CDP is not answering. No new Chrome was started. Stop Orchestra's browser first; never kill an unrelated Chrome process.")
}

/** A stale port file must never identify a different browser which reused its TCP port. */
export function matchesEndpoint(value: unknown, expectedPath: string): boolean {
  try {
    const endpoint = new URL((value as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl)
    return endpoint.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) && endpoint.pathname === expectedPath
  } catch { return false }
}
export class LimitError extends Error {
  constructor(readonly sessionID: string, readonly sessionName: string, readonly reason: "cdp" | "pid" | "record") {
    const detail = reason === "cdp" ? "Chrome этой сессии отвечает" : reason === "pid" ? "процесс ещё работает или его состояние не удалось проверить" : "не удалось прочитать запись процесса"
    super(`Ограничение безопасности: «${sessionName}» (${sessionID}): ${detail}. Откройте эту сессию в «Браузерах» и закройте её Chrome. Сессия и логины сохранятся. Обход: ORCHESTRA_BROWSER_LIMIT=off перед запуском Orchestra (риск нагрузки на ПК).`)
    this.name = "BrowserLimitError"
  }
}
