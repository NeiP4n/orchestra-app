import { Effect, Redacted, Schema, SchemaTransformation } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { AIError, QuotaExceededError } from "../schema/errors.js"
import { Auth } from "../route/auth.js"
import { Endpoint } from "../route/endpoint.js"
import { Framing } from "../route/framing.js"
import { Protocol } from "../route/protocol.js"
import { Route } from "../route/client.js"
import { Gemini } from "./gemini.js"
import { ProviderShared } from "./shared.js"
import { type LLMRequest, ProviderID } from "../schema/index.js"

const ADAPTER = "gemini-cloudcode"

export const DEFAULT_BASE_URL = "https://daily-cloudcode-pa.googleapis.com"
export const SANDBOX_BASE_URL = "https://daily-cloudcode-pa.sandbox.googleapis.com"
export const STREAM_PATH = "/v1internal:streamGenerateContent?alt=sse"
export const RETRIEVE_USER_QUOTA_SUMMARY_PATH = "/v1internal:retrieveUserQuotaSummary"
export const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels"

export const DEFAULT_HEADERS = {
  "User-Agent": "antigravity/1.20.4 windows/amd64",
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata": '{"ideType":"ANTIGRAVITY","platform":"WINDOWS","pluginType":"GEMINI"}',
} as const

export type OptionsInput = Gemini.OptionsInput & {
  readonly projectId?: string
  readonly project?: string
}

export type ProviderOptionsInput = OptionsInput

export const CloudCodeBody = Schema.Struct({
  project: Schema.String,
  model: Schema.String,
  request: Gemini.protocol.body.schema,
  userAgent: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  requestType: Schema.optional(Schema.String),
})
export type CloudCodeBody = Schema.Schema.Type<typeof CloudCodeBody>

export const CloudCodeEvent = Schema.fromJsonString(Schema.Unknown).pipe(
  Schema.decodeTo(
    Gemini.protocol.stream.event,
    SchemaTransformation.transform({
      decode: (u) => {
        if (typeof u === "object" && u !== null) {
          if ("response" in u && typeof u.response === "object" && u.response !== null) {
            return JSON.stringify(u.response)
          }
          return JSON.stringify(u)
        }
        return JSON.stringify(u)
      },
      encode: (s) => JSON.parse(s),
    }),
  ),
)

type QuotaCacheEntry = {
  readonly report: AntigravityQuotaReport
  readonly timestamp: number
}

const quotaCache = new Map<string, QuotaCacheEntry>()

export function recordQuotaReport(projectId: string, report: AntigravityQuotaReport) {
  quotaCache.set(projectId, { report, timestamp: Date.now() })
}

export function getCachedQuotaReport(projectId: string): AntigravityQuotaReport | undefined {
  const entry = quotaCache.get(projectId)
  if (!entry) return undefined
  if (entry.report.isExhausted) {
    if (entry.report.resetTime) {
      const resetMs = new Date(entry.report.resetTime).getTime()
      if (!Number.isNaN(resetMs) && Date.now() >= resetMs) {
        quotaCache.delete(projectId)
        return undefined
      }
    } else if (Date.now() - entry.timestamp > 18000 * 1000) {
      quotaCache.delete(projectId)
      return undefined
    }
    return entry.report
  }
  if (Date.now() - entry.timestamp > 60_000) {
    quotaCache.delete(projectId)
    return undefined
  }
  return entry.report
}

export function clearQuotaCache(projectId?: string) {
  if (projectId) {
    quotaCache.delete(projectId)
  } else {
    quotaCache.clear()
  }
}

const resolveProjectId = (request: LLMRequest) => {
  const options = request.providerOptions
  if (typeof options?.projectId === "string" && options.projectId.length > 0) return options.projectId
  if (typeof options?.project === "string" && options.project.length > 0) return options.project
  return (
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GOOGLE_ANTIGRAVITY_PROJECT ??
    process.env.GCP_PROJECT
  )
}

const fromRequest = Effect.fn("GeminiCloudCode.fromRequest")(function* (request: LLMRequest) {
  const projectId = resolveProjectId(request)
  if (!projectId) {
    return yield* ProviderShared.invalidRequest("Google Antigravity requires a projectId")
  }
  const cached = getCachedQuotaReport(projectId)
  if (cached?.isExhausted) {
    const resetMsg = cached.resetTime ? ` Resets at: ${cached.resetTime}.` : ""
    const windowMsg =
      cached.exhaustedBucket?.windowKind === "5h"
        ? " (5-hour window)"
        : cached.exhaustedBucket?.windowKind === "weekly"
          ? " (weekly window)"
          : ""
    return yield* Effect.fail(
      new AIError({
        reason: new QuotaExceededError({
          message: `Google Antigravity quota is exhausted${windowMsg}.${resetMsg} Requests paused until quota resets to prevent account suspension.`,
        }),
      }),
    )
  }
  const geminiBody = yield* Gemini.protocol.body.from(request)
  return {
    project: projectId,
    model: String(request.model.id),
    request: geminiBody,
  }
})

export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: CloudCodeBody,
    from: fromRequest,
  },
  sanitizer: "gemini",
  stream: {
    event: CloudCodeEvent,
    initial: Gemini.protocol.stream.initial,
    step: Gemini.protocol.stream.step,
    onHalt: Gemini.protocol.stream.onHalt,
  },
})

export const route = Route.make({
  id: ADAPTER,
  provider: ProviderID.make("google-antigravity"),
  providerMetadataKey: "antigravity",
  protocol,
  endpoint: Endpoint.path(STREAM_PATH, {
    baseURL: DEFAULT_BASE_URL,
  }),
  auth: Auth.none,
  framing: Framing.sse,
  headers: () => ({ ...DEFAULT_HEADERS }),
})

// --- Quota Types & Schema ---

export const QuotaRemaining = Schema.Struct({
  remainingFraction: Schema.optional(Schema.Number),
  remainingPercentage: Schema.optional(Schema.Number),
})

export const QuotaBucketRaw = Schema.Struct({
  bucketId: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  remaining: Schema.optional(QuotaRemaining),
  remainingFraction: Schema.optional(Schema.Number),
  resetTime: Schema.optional(Schema.String),
})

export const QuotaGroupRaw = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  buckets: Schema.optional(Schema.Array(QuotaBucketRaw)),
})

export const UserQuotaSummaryRaw = Schema.Struct({
  groups: Schema.optional(Schema.Array(QuotaGroupRaw)),
})

export const ModelQuotaInfoRaw = Schema.Struct({
  remainingFraction: Schema.optional(Schema.Number),
  remainingPercentage: Schema.optional(Schema.Number),
  resetTime: Schema.optional(Schema.String),
})

export const AvailableModelItemRaw = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  quotaInfo: Schema.optional(
    Schema.Union([ModelQuotaInfoRaw, Schema.Array(ModelQuotaInfoRaw)]),
  ),
  quotaInfos: Schema.optional(Schema.Array(ModelQuotaInfoRaw)),
})

export const AvailableModelsRaw = Schema.Struct({
  models: Schema.optional(Schema.Record(Schema.String, AvailableModelItemRaw)),
})

export type AntigravityWindowKind = "5h" | "weekly" | "unknown"

export type AntigravityQuotaBucket = {
  readonly bucketId?: string
  readonly displayName?: string
  readonly window?: string
  readonly windowKind: AntigravityWindowKind
  readonly remainingFraction: number
  readonly resetTime?: string
}

export type AntigravityQuotaGroup = {
  readonly family: "gemini" | "claude-gpt" | "other"
  readonly displayName: string
  readonly buckets: readonly AntigravityQuotaBucket[]
}

export type AntigravityQuotaReport = {
  readonly groups: readonly AntigravityQuotaGroup[]
  readonly isExhausted: boolean
  readonly exhaustedBucket?: AntigravityQuotaBucket
  readonly resetTime?: string
  readonly source: "retrieveUserQuotaSummary" | "fetchAvailableModels"
}

export class AntigravityQuotaExceededError extends Schema.TaggedError<AntigravityQuotaExceededError>()(
  "AI.Error.AntigravityQuotaExceeded",
  {
    message: Schema.String,
    resetTime: Schema.optional(Schema.String),
    windowKind: Schema.optional(Schema.Literals(["5h", "weekly", "unknown"])),
    bucketId: Schema.optional(Schema.String),
    groupName: Schema.optional(Schema.String),
  },
) {}

export class AntigravityQuotaRetrievalError extends Schema.TaggedError<AntigravityQuotaRetrievalError>()(
  "AI.Error.AntigravityQuotaRetrieval",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
  },
) {}

function classifyWindowKind(windowStr: string): AntigravityWindowKind {
  const lower = windowStr.toLowerCase()
  if (lower.includes("18000") || lower.includes("5h") || lower.includes("five")) return "5h"
  if (lower.includes("604800") || lower.includes("week") || lower.includes("7d")) return "weekly"
  return "unknown"
}

function classifyFamily(groupName: string): "gemini" | "claude-gpt" | "other" {
  const lower = groupName.toLowerCase()
  if (lower.includes("gemini")) return "gemini"
  if (lower.includes("claude") || lower.includes("gpt") || lower.includes("3p")) return "claude-gpt"
  return "other"
}

function extractRemainingFraction(bucket: {
  remaining?: { remainingFraction?: number; remainingPercentage?: number }
  remainingFraction?: number
}): number {
  if (bucket.remaining?.remainingFraction !== undefined) return bucket.remaining.remainingFraction
  if (bucket.remainingFraction !== undefined) return bucket.remainingFraction
  if (bucket.remaining?.remainingPercentage !== undefined) return bucket.remaining.remainingPercentage / 100
  return 1.0
}

export function parseQuotaSummaryResponse(body: unknown): AntigravityQuotaReport {
  const decoded = Schema.decodeUnknownSync(UserQuotaSummaryRaw)(body)
  const rawGroups = decoded.groups ?? []
  const groups: AntigravityQuotaGroup[] = []
  let isExhausted = false
  let exhaustedBucket: AntigravityQuotaBucket | undefined
  let earliestResetTime: string | undefined

  for (const group of rawGroups) {
    const groupName = group.displayName ?? group.description ?? "Unknown Group"
    const family = classifyFamily(groupName)
    const rawBuckets = group.buckets ?? []
    const buckets: AntigravityQuotaBucket[] = []

    for (const rawBucket of rawBuckets) {
      const windowStr = `${rawBucket.window ?? ""} ${rawBucket.bucketId ?? ""} ${rawBucket.displayName ?? ""}`
      const windowKind = classifyWindowKind(windowStr)
      const remainingFraction = extractRemainingFraction(rawBucket)
      const bucket: AntigravityQuotaBucket = {
        bucketId: rawBucket.bucketId,
        displayName: rawBucket.displayName,
        window: rawBucket.window,
        windowKind,
        remainingFraction,
        resetTime: rawBucket.resetTime,
      }
      buckets.push(bucket)

      if (remainingFraction <= 0) {
        isExhausted = true
        if (!exhaustedBucket) {
          exhaustedBucket = bucket
        }
      }

      if (rawBucket.resetTime) {
        if (!earliestResetTime || rawBucket.resetTime < earliestResetTime) {
          earliestResetTime = rawBucket.resetTime
        }
      }
    }

    groups.push({
      family,
      displayName: groupName,
      buckets,
    })
  }

  const resetTime = exhaustedBucket?.resetTime ?? earliestResetTime

  return {
    groups,
    isExhausted,
    exhaustedBucket,
    resetTime,
    source: "retrieveUserQuotaSummary",
  }
}

export function parseAvailableModelsResponse(body: unknown): AntigravityQuotaReport {
  const decoded = Schema.decodeUnknownSync(AvailableModelsRaw)(body)
  const rawModels = decoded.models ?? {}
  const geminiBuckets: AntigravityQuotaBucket[] = []
  const claudeBuckets: AntigravityQuotaBucket[] = []
  let isExhausted = false
  let exhaustedBucket: AntigravityQuotaBucket | undefined
  let earliestResetTime: string | undefined

  for (const [modelId, item] of Object.entries(rawModels)) {
    const list: Schema.Schema.Type<typeof ModelQuotaInfoRaw>[] = []
    const quotaInfo = item.quotaInfo
    if (quotaInfo) {
      if (Array.isArray(quotaInfo)) {
        for (const entry of quotaInfo as readonly Schema.Schema.Type<typeof ModelQuotaInfoRaw>[]) {
          list.push(entry)
        }
      } else {
        list.push(quotaInfo as Schema.Schema.Type<typeof ModelQuotaInfoRaw>)
      }
    }
    if (item.quotaInfos) {
      list.push(...item.quotaInfos)
    }

    for (const info of list) {
      const remainingFraction = extractRemainingFraction(info)
      const bucket: AntigravityQuotaBucket = {
        bucketId: modelId,
        displayName: item.displayName ?? modelId,
        windowKind: "unknown",
        remainingFraction,
        resetTime: info.resetTime,
      }

      const lower = modelId.toLowerCase()
      if (lower.includes("gemini")) {
        geminiBuckets.push(bucket)
      } else if (lower.includes("claude") || lower.includes("gpt")) {
        claudeBuckets.push(bucket)
      }

      if (remainingFraction <= 0) {
        isExhausted = true
        if (!exhaustedBucket) {
          exhaustedBucket = bucket
        }
      }

      if (info.resetTime) {
        if (!earliestResetTime || info.resetTime < earliestResetTime) {
          earliestResetTime = info.resetTime
        }
      }
    }
  }

  const groups: AntigravityQuotaGroup[] = []
  if (geminiBuckets.length > 0) {
    groups.push({ family: "gemini", displayName: "Gemini Models", buckets: geminiBuckets })
  }
  if (claudeBuckets.length > 0) {
    groups.push({ family: "claude-gpt", displayName: "Claude and GPT models", buckets: claudeBuckets })
  }

  const resetTime = exhaustedBucket?.resetTime ?? earliestResetTime

  return {
    groups,
    isExhausted,
    exhaustedBucket,
    resetTime,
    source: "fetchAvailableModels",
  }
}

export function assertQuotaAvailable(report: AntigravityQuotaReport): Effect.Effect<void, AntigravityQuotaExceededError> {
  if (report.isExhausted) {
    const bucket = report.exhaustedBucket
    const resetTimeMsg = report.resetTime ? ` Resets at: ${report.resetTime}.` : ""
    const windowMsg =
      bucket?.windowKind === "5h"
        ? " (5-hour window)"
        : bucket?.windowKind === "weekly"
          ? " (weekly window)"
          : ""
    return Effect.fail(
      new AntigravityQuotaExceededError({
        message: `Google Antigravity quota exhausted${windowMsg}.${resetTimeMsg} Requests paused until quota resets to prevent account suspension.`,
        resetTime: report.resetTime,
        windowKind: bucket?.windowKind,
        bucketId: bucket?.bucketId,
        groupName: bucket?.displayName,
      }),
    )
  }
  return Effect.void
}

export const retrieveQuota = Effect.fn("GeminiCloudCode.retrieveQuota")(function* (options: {
  readonly http: HttpClient.HttpClient
  readonly accessToken: string | Redacted.Redacted<string>
  readonly projectId?: string
  readonly baseURL?: string
}) {
  const token = Redacted.isRedacted(options.accessToken)
    ? Redacted.value(options.accessToken)
    : options.accessToken
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL
  const body = { project: options.projectId ?? "" }

  const makeRequest = (path: string) =>
    HttpClientRequest.post(`${baseURL}${path}`).pipe(
      HttpClientRequest.setHeaders({
        ...DEFAULT_HEADERS,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      }),
      HttpClientRequest.bodyJsonUnsafe(body),
    )

  // 1. Try retrieveUserQuotaSummary
  const summaryAttempt: AntigravityQuotaReport | undefined = yield* options.http
    .execute(makeRequest(RETRIEVE_USER_QUOTA_SUMMARY_PATH))
    .pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? response.json.pipe(
              Effect.map((json) => parseQuotaSummaryResponse(json)),
              Effect.mapError(() => new AntigravityQuotaRetrievalError({ message: "Invalid JSON response" })),
            )
          : Effect.fail(
              new AntigravityQuotaRetrievalError({
                message: "retrieveUserQuotaSummary non-2xx",
                status: response.status,
              }),
            ),
      ),
      Effect.catch(() => Effect.succeed(undefined)),
    )

  if (summaryAttempt && summaryAttempt.groups.length > 0) {
    if (options.projectId) recordQuotaReport(options.projectId, summaryAttempt)
    return summaryAttempt
  }

  // 2. Fallback to fetchAvailableModels
  const modelsAttempt = yield* options.http.execute(makeRequest(FETCH_AVAILABLE_MODELS_PATH)).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? response.json.pipe(
            Effect.map((json) => parseAvailableModelsResponse(json)),
            Effect.mapError(() => new AntigravityQuotaRetrievalError({ message: "Invalid JSON response" })),
          )
        : Effect.fail(
            new AntigravityQuotaRetrievalError({
              message: "fetchAvailableModels non-2xx",
              status: response.status,
            }),
          ),
    ),
    Effect.catch((error) =>
      Effect.fail(
        new AntigravityQuotaRetrievalError({
          message: "Failed to retrieve Antigravity quota from both summary and models endpoints",
          status: error instanceof AntigravityQuotaRetrievalError ? error.status : undefined,
        }),
      ),
    ),
  )

  if (options.projectId) recordQuotaReport(options.projectId, modelsAttempt)
  return modelsAttempt
})

export * as GeminiCloudCode from "./gemini-cloudcode.js"
