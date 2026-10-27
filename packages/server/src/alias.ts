import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"

/**
 * Normalizes legacy `/api/opencode/*` routes to canonical `/api/orchestra/*`
 * (or matching core service routes) for transparent backwards compatibility with older clients.
 */
export function rewriteLegacyApiPath(url: string): string {
  const prefix = "/api/opencode"
  if (!url.startsWith(prefix)) return url

  const remainder = url.slice(prefix.length)
  if (remainder === "" || remainder === "/") return "/api/orchestra"

  if (remainder.startsWith("/pty/") || remainder === "/pty") {
    return `/api${remainder}`
  }
  if (remainder.startsWith("/experimental/") || remainder === "/experimental") {
    return `/api${remainder}`
  }
  if (remainder.startsWith("/event") || remainder.startsWith("/session") || remainder.startsWith("/model")) {
    return `/api${remainder}`
  }
  return `/api/orchestra${remainder}`
}

export function aliasRequest(request: HttpServerRequest.HttpServerRequest): HttpServerRequest.HttpServerRequest {
  const rewrittenUrl = rewriteLegacyApiPath(request.url)
  if (rewrittenUrl === request.url) return request
  return request.modify({ url: rewrittenUrl })
}

export const legacyRouteAlias = <A, E, R>(
  httpApp: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | HttpServerRequest.HttpServerRequest> =>
  Effect.updateService(httpApp, HttpServerRequest.HttpServerRequest, (request) => {
    const rewritten = rewriteLegacyApiPath(request.url)
    return rewritten === request.url ? request : request.modify({ url: rewritten })
  })
