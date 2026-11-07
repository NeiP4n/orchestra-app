/**
 * Read-only probe of a running Orchestra server: `GET /health` (public)
 * and, when a password is given, `GET /api/info` with Basic auth.
 * Only GETs, nothing is written, nothing is restarted, no session is
 * touched — the probe is safe to run against the live server at any
 * time. A server that answers at all counts as reachable; a reachable
 * server that answers unhealthy still FAILS the probe (that is the
 * point of a smoke test), while an unreachable server is a skip, not
 * a failure — the caller decides that from `isServerReachable`.
 */

export interface LiveSmokeResult {
  readonly origin: string
  readonly health: { readonly status: number; readonly body: unknown }
  readonly info?: { readonly status: number; readonly hasPid: boolean }
}

const get = async (origin: string, pathname: string, options?: { password?: string; timeoutMs?: number }) => {
  const headers: Record<string, string> = {}
  if (options?.password !== undefined) headers.authorization = `Basic ${btoa(`opencode:${options.password}`)}`
  return fetch(new URL(pathname, origin), {
    headers,
    signal: AbortSignal.timeout(options?.timeoutMs ?? 5000),
  })
}

/** True when the server answers HTTP at all (any status) — false on connection refused, timeout, or DNS failure. */
export const isServerReachable = async (origin: string, timeoutMs = 2000): Promise<boolean> => {
  try {
    await get(origin, "/health", { timeoutMs })
    return true
  } catch {
    return false
  }
}

/**
 * Probes a reachable server read-only. Throws a plain Error naming the
 * failed check when the server is unhealthy (`/health` is not 200 with
 * `status: "ok"`, or `/api/info` is not 200 with a `pid`).
 */
export const probeLiveServer = async (
  origin: string,
  options?: { password?: string; timeoutMs?: number },
): Promise<LiveSmokeResult> => {
  const healthResponse = await get(origin, "/health", options)
  const healthBody: unknown = await healthResponse.json().catch(() => undefined)
  if (healthResponse.status !== 200)
    throw new Error(`live smoke: GET ${origin}/health answered ${healthResponse.status}, expected 200`)
  if (typeof healthBody !== "object" || healthBody === null || (healthBody as { status?: unknown }).status !== "ok")
    throw new Error(`live smoke: GET ${origin}/health answered 200 but its body has no status "ok"`)
  const result: LiveSmokeResult = { origin, health: { status: healthResponse.status, body: healthBody } }
  if (options?.password === undefined) return result
  const infoResponse = await get(origin, "/api/info", options)
  const infoBody: unknown = await infoResponse.json().catch(() => undefined)
  if (infoResponse.status !== 200)
    throw new Error(`live smoke: GET ${origin}/api/info answered ${infoResponse.status}, expected 200`)
  const hasPid =
    typeof infoBody === "object" && infoBody !== null && typeof (infoBody as { pid?: unknown }).pid === "number"
  if (!hasPid) throw new Error(`live smoke: GET ${origin}/api/info answered 200 but its body has no pid`)
  return { ...result, info: { status: infoResponse.status, hasPid } }
}
