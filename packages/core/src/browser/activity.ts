export type BrowserPhase = "starting" | "running" | "stopping" | "stopped" | "error"
export type BrowserState = { phase: BrowserPhase; reason?: string }
const states = new Map<string, BrowserState>()
const listeners = new Set<(id: string, state: BrowserState) => void>()
export const get = (id: string) => states.get(id)
export function set(id: string, state: BrowserState) {
  states.set(id, state)
  for (const listener of listeners) listener(id, state)
}
export function subscribe(listener: (id: string, state: BrowserState) => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Port closure alone does not prove that a managed Chrome process has exited. */
export async function verifyStopped(input: {
  portAlive(): Promise<boolean>
  pidAlive(): boolean
  sleep(ms: number): Promise<void>
  attempts?: number
}) {
  for (let i = 0; i < (input.attempts ?? 20); i++) {
    if (!(await input.portAlive()) && !input.pidAlive()) return
    await input.sleep(100)
  }
  throw new Error("Chrome ещё работает: PID или CDP-порт не завершён. Остановка не подтверждена.")
}
