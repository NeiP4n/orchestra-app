export * as SessionPlan from "./plan.js"

import { Option, Schema } from "effect"

// The two dials a Society's planner sets on a chat, and both live in the session metadata so the
// operator can change them from the sidebar and the planner can change them with the society_plan
// tool. The context threshold is where automatic compaction starts; the cache switch turns prompt
// caching off for a chat whose prefix is never reused.
export const CONTEXT_KEY = "compaction_threshold"
export const CACHE_KEY = "orchestra.cache"
// A chat's token budget, set by the Society's planner with society_plan
// apply: a field the code stores and checks, not a number buried in prose.
export const BUDGET_KEY = "orchestra.budget-tokens"

/** A token budget: a positive whole number of tokens, nothing else. */
export function parseBudget(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : undefined
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(/[,_\\s]/g, ""))
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
  return undefined
}

/**
 * A chat's context threshold. Tokens are absolute; a share of the model's window is what the planner can
 * decide without knowing which model ends up running a chat: 60% of a 200k window and 60% of a 1M one are
 * both "compact after this much conversation". A capped threshold combines the two, so a small window
 * still compacts proportionally while a huge one stops at a token ceiling.
 */
export type Threshold =
  | { readonly type: "tokens"; readonly tokens: number }
  | { readonly type: "percent"; readonly percent: number }
  | { readonly type: "capped"; readonly percent: number; readonly tokens: number }

const Capped = Schema.Struct({ percent: Schema.Finite, tokens: Schema.Finite })
const decodeCapped = Schema.decodeUnknownOption(Capped)

/** Reads a threshold: "60%" keeps a share of the window, anything else is a token count. */
export function parseThreshold(value: unknown): Threshold | undefined {
  if (typeof value === "string") {
    const percent = value.trim().toLowerCase().match(/^([0-9]+(?:\.[0-9]+)?)\s*%$/)
    if (percent) {
      const share = Number(percent[1])
      return Number.isFinite(share) && share > 0 && share <= 100
        ? { type: "percent", percent: share }
        : undefined
    }
  }
  // An explicit token object from the compaction policy.
  if (typeof value === "object" && value !== null && "tokens" in value && !("percent" in value)) {
    const tokens = parseContext((value as { tokens: unknown }).tokens)
    if (tokens !== undefined) return { type: "tokens", tokens }
  }
  // The object form is what the compaction policy writes: a share of the window with a token cap.
  const bounded = Option.getOrUndefined(decodeCapped(value))
  if (bounded !== undefined) {
    if (bounded.percent <= 0 || bounded.percent > 100 || bounded.tokens < 0) return undefined
    return { type: "capped", percent: bounded.percent, tokens: Math.round(bounded.tokens) }
  }
  const tokens = parseContext(value)
  return tokens === undefined ? undefined : { type: "tokens", tokens }
}

/** What a metadata value means in tokens for a given window; undefined leaves the model's own ceiling. */
export function thresholdTokens(value: unknown, window: number | undefined): number | undefined {
  const parsed = parseThreshold(value)
  if (parsed === undefined) return undefined
  if (parsed.type === "tokens") return parsed.tokens
  // A zero cap means the whole window, the same as a zero token count.
  if (parsed.type === "capped" && parsed.tokens === 0) return 0
  if (window === undefined || !Number.isFinite(window) || window <= 0) {
    return parsed.type === "capped" ? parsed.tokens : undefined
  }
  const share = Math.max(1, Math.round((window * parsed.percent) / 100))
  return parsed.type === "capped" ? Math.min(share, parsed.tokens) : share
}

/** A context threshold in tokens; 0 or less means the whole context window. */
export function parseContext(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined
  if (typeof value !== "string") return undefined
  const text = value.trim().toLowerCase().replace(/[,_\s]/g, "")
  if (!text) return undefined
  if (["0", "all", "max", "full", "none", "off", "весь", "весьлимит", "безлимита"].includes(text)) return 0
  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)([km])?$/)
  if (!match) return undefined
  const size = Number(match[1])
  if (!Number.isFinite(size)) return undefined
  const unit = match[2]
  return Math.round(size * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1))
}

/** The request cache policy this chat asked for; undefined keeps the provider default. */
export function cachePolicy(metadata: Record<string, unknown> | undefined): "none" | undefined {
  const value = metadata?.[CACHE_KEY]
  return value === false || value === "none" || value === "off" ? "none" : undefined
}
