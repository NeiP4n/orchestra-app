import type { ModelInfo } from "@orchestra/client"

export type ZenModelCheck =
  | { readonly state: "unchecked" | "checking" }
  | { readonly state: "ok"; readonly latencyMs: number }
  | { readonly state: "limit" | "error"; readonly detail: string }

export const ZEN_PROVIDER_ID = "opencode"
export const FALLBACK_FREE_PROVIDERS = ["kilo-free", "ollama", "local", "lmstudio", "llamacpp"] as const

function isZeroCost(model: ModelInfo) {
  if (!model.enabled || model.status === "deprecated") return false
  if (model.cost && model.cost.length > 0) {
    return model.cost.every((cost: { input: number }) => cost.input === 0)
  }
  // Local or zero-cost providers may have an empty cost array
  return true
}

/** Free models: zero cost, newest release first. Falls back to known free/local providers if opencode provider is absent. */
export function freeZenModels(models?: readonly ModelInfo[] | null): ModelInfo[] {
  if (!models || !Array.isArray(models) || models.length === 0) return []

  const zenModels = models.filter(
    (model) =>
      model.providerID === ZEN_PROVIDER_ID &&
      model.cost.length > 0 &&
      isZeroCost(model),
  )

  if (zenModels.length > 0) {
    return zenModels.toSorted((left, right) => (right.time?.released ?? 0) - (left.time?.released ?? 0))
  }

  const fallback = models.filter(
    (model) =>
      (FALLBACK_FREE_PROVIDERS as readonly string[]).includes(model.providerID) &&
      isZeroCost(model),
  )

  return fallback.toSorted((left, right) => (right.time?.released ?? 0) - (left.time?.released ?? 0))
}

/** A refusal for usage is told apart from a connection or model failure so the panel can say which. */
export function classifyFailure(message: string): ZenModelCheck {
  const detail = message.replace(/\s+/g, " ").trim().slice(0, 160) || "request failed"
  if (/free\s*usage\s*limit|usage limit|rate limit|quota|too many requests|\b429\b/i.test(message)) return { state: "limit", detail }
  return { state: "error", detail }
}
