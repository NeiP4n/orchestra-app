export * as Quota from "./quota.js"

import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const QuotaStatus = Schema.Literals(["ok", "approaching_limit", "exceeded"]).annotate({
  identifier: "Quota.QuotaStatus",
  description: "Status of token quota relative to context window limit.",
})
export type QuotaStatus = typeof QuotaStatus.Type

export const DEFAULT_WARNING_THRESHOLD = 0.85

export interface TokenQuotaSpec extends Schema.Schema.Type<typeof TokenQuotaSpec> {}
export const TokenQuotaSpec = Schema.Struct({
  modelID: Schema.String,
  contextWindowLimit: Schema.Finite,
  spentTokens: Schema.Finite,
  remainingTokens: Schema.Finite,
  warningThreshold: Schema.Finite,
  status: QuotaStatus,
  utilization: Schema.Finite,
  message: Schema.optional(Schema.String),
}).annotate({
  identifier: "Quota.TokenQuotaSpec",
  description: "Specification and state of token quota for a given model.",
})

export class TokenQuotaExceededError extends Schema.TaggedError<TokenQuotaExceededError>()(
  "Quota.TokenQuotaExceededError",
  {
    modelID: Schema.String,
    contextWindowLimit: Schema.Finite,
    spentTokens: Schema.Finite,
    message: Schema.String,
  },
  { httpApiStatus: 429 },
) {}

export class InvalidQuotaInputError extends Schema.TaggedError<InvalidQuotaInputError>()(
  "Quota.InvalidQuotaInputError",
  {
    message: Schema.String,
    field: Schema.optional(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

export interface TokenQuotaInput {
  readonly modelID: string
  readonly contextWindowLimit: number
  readonly spentTokens: number
  readonly warningThreshold?: number
}

export function validateTokenQuotaInput(input: unknown): { readonly valid: boolean; readonly error?: string } {
  if (!input || typeof input !== "object") {
    return { valid: false, error: "Quota input must be an object" }
  }
  const candidate = input as Record<string, unknown>
  if (typeof candidate.modelID !== "string" || candidate.modelID.trim().length === 0) {
    return { valid: false, error: "modelID is required and must not be empty" }
  }
  if (
    typeof candidate.contextWindowLimit !== "number" ||
    !Number.isFinite(candidate.contextWindowLimit) ||
    candidate.contextWindowLimit <= 0
  ) {
    return { valid: false, error: "contextWindowLimit must be a positive number" }
  }
  if (
    typeof candidate.spentTokens !== "number" ||
    !Number.isFinite(candidate.spentTokens) ||
    candidate.spentTokens < 0
  ) {
    return { valid: false, error: "spentTokens must be a non-negative number" }
  }
  if (candidate.warningThreshold !== undefined) {
    if (
      typeof candidate.warningThreshold !== "number" ||
      !Number.isFinite(candidate.warningThreshold) ||
      candidate.warningThreshold <= 0 ||
      candidate.warningThreshold >= 1
    ) {
      return { valid: false, error: "warningThreshold must be a number between 0 and 1 exclusive" }
    }
  }
  return { valid: true }
}

export function calculateTokenQuota(input: TokenQuotaInput): TokenQuotaSpec {
  const modelID = input.modelID.trim()
  const contextWindowLimit = Math.max(0, input.contextWindowLimit)
  const spentTokens = Math.max(0, input.spentTokens)
  const threshold = input.warningThreshold ?? DEFAULT_WARNING_THRESHOLD
  const warningThreshold = Number.isFinite(threshold) && threshold > 0 && threshold < 1 ? threshold : DEFAULT_WARNING_THRESHOLD

  const remainingTokens = Math.max(0, contextWindowLimit - spentTokens)
  const utilization = contextWindowLimit > 0 ? Number((spentTokens / contextWindowLimit).toFixed(4)) : 1

  let status: QuotaStatus = "ok"
  let message: string | undefined

  if (spentTokens >= contextWindowLimit) {
    status = "exceeded"
    message = `Token quota exceeded: spent ${spentTokens} of ${contextWindowLimit} tokens.`
  } else if (utilization >= warningThreshold) {
    status = "approaching_limit"
    message = `Approaching token quota limit: ${(utilization * 100).toFixed(1)}% spent (${spentTokens}/${contextWindowLimit} tokens).`
  }

  return {
    modelID,
    contextWindowLimit,
    spentTokens,
    remainingTokens,
    warningThreshold,
    status,
    utilization,
    message,
  }
}

export function evaluateTokenQuota(input: TokenQuotaInput): {
  readonly spec: TokenQuotaSpec
  readonly valid: boolean
  readonly error?: string
} {
  const validation = validateTokenQuotaInput(input)
  if (!validation.valid) {
    const fallbackSpec: TokenQuotaSpec = {
      modelID: typeof input?.modelID === "string" ? input.modelID : "unknown",
      contextWindowLimit: typeof input?.contextWindowLimit === "number" ? Math.max(0, input.contextWindowLimit) : 0,
      spentTokens: typeof input?.spentTokens === "number" ? Math.max(0, input.spentTokens) : 0,
      remainingTokens: 0,
      warningThreshold: DEFAULT_WARNING_THRESHOLD,
      status: "exceeded",
      utilization: 1,
      message: validation.error,
    }
    return {
      spec: fallbackSpec,
      valid: false,
      error: validation.error,
    }
  }

  return {
    spec: calculateTokenQuota(input),
    valid: true,
  }
}

export const QuotaGroup = HttpApiGroup.make("quota")
  .add(
    HttpApiEndpoint.post("quota.check", "/api/quota/check", {
      payload: Schema.Struct({
        modelID: Schema.String,
        contextWindowLimit: Schema.Finite,
        spentTokens: Schema.Finite,
        warningThreshold: Schema.optional(Schema.Finite),
      }),
      success: TokenQuotaSpec,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "quota.check",
          summary: "Check model token quota",
          description: "Evaluate context window limit and calculate token quota status.",
        }),
      ),
  )
