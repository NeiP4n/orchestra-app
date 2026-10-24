import type { ModelInfo } from "@orchestra/client"

export type ZenModelCheck =
  | { readonly state: "unchecked" | "checking" }
  | { readonly state: "ok"; readonly latencyMs: number }
  | { readonly state: "limit" | "error"; readonly detail: string }

export const ZEN_PROVIDER_ID = "opencode"

/** Zen's free models: every price is zero. Newest release first, the order the model picker uses. */
export function freeZenModels(models: readonly ModelInfo[]) {
  return models
    .filter(
      (model) =>
        model.providerID === ZEN_PROVIDER_ID &&
        model.enabled &&
        model.status !== "deprecated" &&
        model.cost.length > 0 &&
        model.cost.every((cost) => cost.input === 0),
    )
    .toSorted((left, right) => right.time.released - left.time.released)
}

/** A refusal for usage is told apart from a connection or model failure so the panel can say which. */
export function classifyFailure(message: string): ZenModelCheck {
  const detail = message.replace(/\s+/g, " ").trim().slice(0, 160) || "request failed"
  if (/free\s*usage\s*limit|usage limit|rate limit|quota|too many requests|\b429\b/i.test(message)) return { state: "limit", detail }
  return { state: "error", detail }
}
