/**
 * Model discovery for API providers and custom endpoints.
 *
 * One job: ask an endpoint which models it serves, through the
 * OpenAI-compatible `GET {baseURL}/models` convention, and report the
 * outcome as data — including the failure modes — so callers can offer
 * manual model entry instead of treating "no /models API" as an error.
 *
 * Security contract: the API key and custom header values travel in the
 * request only. They never appear in results, error messages or logs.
 * The base URL passes the shared SSRF gate before the key is attached:
 * a private, loopback or unresolvable address never sees the key.
 */
import { Ssrf } from "./tool/ssrf.js"
export interface DiscoveredModel {
  readonly id: string
  readonly name?: string
}

export type DiscoveryError =
  | { readonly kind: "invalid-url"; readonly message: string }
  | { readonly kind: "auth"; readonly status: number; readonly message: string }
  | { readonly kind: "http"; readonly status: number; readonly message: string }
  | { readonly kind: "unsupported"; readonly message: string }
  | { readonly kind: "network"; readonly message: string }
  | { readonly kind: "timeout"; readonly message: string }

export type DiscoveryResult =
  | { readonly ok: true; readonly models: readonly DiscoveredModel[]; readonly latencyMs: number }
  | { readonly ok: false; readonly error: DiscoveryError; readonly models: readonly [] }

/** The endpoint answered at all — an unsupported /models API still proves reachability. */
export const reachable = (result: DiscoveryResult): boolean =>
  result.ok || result.error.kind === "unsupported" || result.error.kind === "auth" || result.error.kind === "http"

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000

/**
 * Validates and normalizes a base URL. Only http(s) is accepted, embedded
 * credentials are rejected (keys belong in the credential store), and the
 * result has no trailing slash so paths join deterministically.
 */
export function validateBaseURL(input: string): { ok: true; url: string } | { ok: false; message: string } {
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, message: "Base URL is empty" }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, message: "Base URL is not a valid URL" }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { ok: false, message: "Base URL must use http or https" }
  if (parsed.username || parsed.password)
    return { ok: false, message: "Base URL must not embed credentials; store the API key as a credential" }
  parsed.hash = ""
  parsed.search = ""
  return { ok: true, url: parsed.toString().replace(/\/+$/, "") }
}

export function modelsURL(baseURL: string): string {
  return baseURL.endsWith("/models") ? baseURL : `${baseURL}/models`
}

/**
 * Parses a /models response. Accepts the OpenAI shape ({data: [{id}]}),
 * a {models: [...]} wrapper, and bare arrays of ids or {id} objects.
 * Duplicate ids collapse to their first occurrence. Returns undefined
 * when the payload carries no recognizable model list.
 */
export function parseModels(payload: unknown): DiscoveredModel[] | undefined {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : undefined
  if (!list) return undefined
  const seen = new Set<string>()
  const models: DiscoveredModel[] = []
  for (const entry of list) {
    const id = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.id === "string" ? entry.id : undefined
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = isRecord(entry) && typeof entry.name === "string" && entry.name !== id ? entry.name : undefined
    models.push(name ? { id, name } : { id })
  }
  return models
}

export interface DiscoverInput {
  readonly baseURL: string
  readonly apiKey?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * Fetches the model list. Never throws: every outcome — success, auth
 * failure, timeout, unreachable host, an endpoint without a /models API —
 * is a value the caller can present and act on.
 */
export async function discoverModels(
  input: DiscoverInput,
  fetchFn: FetchLike = fetch,
): Promise<DiscoveryResult> {
  const valid = validateBaseURL(input.baseURL)
  if (!valid.ok) return { ok: false, models: [], error: { kind: "invalid-url", message: valid.message } }
  // The gate runs before the key is attached to any header: a private, loopback, link-local or
  // unresolvable base URL is refused here, so the saved credential never leaves the process
  // towards an address the operator did not vet as public.
  try {
    await Ssrf.assertPublicUrlPromise(valid.url)
  } catch (error) {
    return {
      ok: false,
      models: [],
      error: { kind: "invalid-url", message: error instanceof Error ? error.message : String(error) },
    }
  }
  const headers: Record<string, string> = { accept: "application/json", ...input.headers }
  if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`
  const started = Date.now()
  let response: Response
  try {
    response = await fetchFn(modelsURL(valid.url), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
      return { ok: false, models: [], error: { kind: "timeout", message: "The endpoint did not answer in time" } }
    return {
      ok: false,
      models: [],
      error: { kind: "network", message: "The endpoint could not be reached (network error)" },
    }
  }
  const latencyMs = Date.now() - started
  if (response.status === 401 || response.status === 403)
    return {
      ok: false,
      models: [],
      error: { kind: "auth", status: response.status, message: "The endpoint rejected the API key" },
    }
  if (response.status === 404 || response.status === 405)
    return {
      ok: false,
      models: [],
      error: {
        kind: "unsupported",
        message: "This endpoint does not expose a model list; add model IDs manually",
      },
    }
  if (!response.ok)
    return {
      ok: false,
      models: [],
      error: { kind: "http", status: response.status, message: `The endpoint answered HTTP ${response.status}` },
    }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return {
      ok: false,
      models: [],
      error: { kind: "unsupported", message: "The endpoint's model list was not JSON; add model IDs manually" },
    }
  }
  const models = parseModels(payload)
  if (!models)
    return {
      ok: false,
      models: [],
      error: {
        kind: "unsupported",
        message: "The endpoint's model list has an unrecognized shape; add model IDs manually",
      },
    }
  return { ok: true, models, latencyMs }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
