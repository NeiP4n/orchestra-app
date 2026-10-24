import * as Warp from "@orchestra/core/warp"
import { isRateLimitError, isRateLimitText } from "../../util/session"

export type WarpConnectionState = Warp.State | "checking"
export type WarpStatus = { state: WarpConnectionState; details: string }

export const parseWarpStatus = Warp.parseStatus
export const warpCliUnavailable = Warp.unavailableStatus
export const warpStatusError = Warp.errorStatus


/** Detect a provider rate limit from the structured session error, with HTTP 429/text fallbacks. */
export function isRateLimitFailure(error: unknown): boolean {
  if (typeof error === "string") return isRateLimitText(error)
  if (!error || typeof error !== "object") return false
  const value = error as { type?: unknown; message?: unknown; status?: unknown; response?: { body?: unknown } }
  return isRateLimitError({
    type: typeof value.type === "string" ? value.type : "",
    message: typeof value.message === "string" ? value.message : undefined,
    status: typeof value.status === "number" ? value.status : undefined,
    response: typeof value.response?.body === "string" ? { body: value.response.body } : undefined,
  })
}


function failureDetails(error: unknown, depth = 0, seen = new Set<object>()): string {
  if (typeof error === "string" || typeof error === "number") return String(error)
  if (!error || typeof error !== "object" || depth > 5 || seen.has(error)) return ""
  seen.add(error)
  const value = error as {
    type?: unknown
    code?: unknown
    message?: unknown
    status?: unknown
    response?: { body?: unknown; status?: unknown }
    cause?: unknown
    error?: unknown
  }
  return [
    value.type,
    value.code,
    value.message,
    value.status,
    value.response?.status,
    value.response?.body,
    failureDetails(value.cause, depth + 1, seen),
    failureDetails(value.error, depth + 1, seen),
  ].filter((part) => part !== undefined && part !== null).join(" ")
}

/**
 * Zen's free tier caps requests per IP address until the daily reset (HTTP 429 FreeUsageLimitError).
 * Older core builds rewrote the message, so stored failures with that wording are still recognized.
 */
export function isAddressCapFailure(error: unknown): boolean {
  return /freeusagelimiterror|free tier counts requests per IP address/i.test(failureDetails(error))
}

/** Auto IP handles rate limits and transient network failures such as ECONNREFUSED. */
export function isAutoRotationFailure(error: unknown): boolean {
  if (isRateLimitFailure(error)) return true
  const details = failureDetails(error)
  return /\b(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|ECONNABORTED|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|ERR_SOCKET|ERR_NETWORK|FETCH_FAILED|CONNECTION_REFUSED|CONNECTION_RESET|SOCKET_HANG_UP)\b|connection refused|unable to connect|failed to fetch|fetch failed|network(?:\s+request)? failed|socket hang up|connect(?:ion)? (?:timed? ?out|timeout)/i.test(details)
}
