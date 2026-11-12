import { errorMessage } from "./error"
export const SERVER_UPDATE_HINT = "Cleanup is unavailable on this server. Update and restart the background server and TUI."
export function cleanupErrorMessage(error: unknown, t: (text: string) => string) {
  const status = error && typeof error === "object" ? (error as { cause?: { status?: number } }).cause?.status : undefined
  const message = errorMessage(error)
  return status === 404 || /UnexpectedStatus:\s*404/.test(message) ? t(SERVER_UPDATE_HINT) : message
}
