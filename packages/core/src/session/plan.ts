export * as SessionPlan from "./plan.js"

// The two dials a Society's planner sets on a chat, and both live in the session metadata so the
// operator can change them from the sidebar and the planner can change them with the society_plan
// tool. The context threshold is where automatic compaction starts; the cache switch turns prompt
// caching off for a chat whose prefix is never reused.
export const CONTEXT_KEY = "compaction_threshold"
export const CACHE_KEY = "orchestra.cache"

/**
 * A chat's context threshold. Tokens are absolute; a share of the model's window is what the planner can
 * decide without knowing which model ends up running a chat: 60% of a 200k window and 60% of a 1M one are
 * both "compact after this much conversation".
 */
export type Threshold =
  | { readonly type: "tokens"; readonly tokens: number }
  | { readonly type: "percent"; readonly percent: number }

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
  const tokens = parseContext(value)
  return tokens === undefined ? undefined : { type: "tokens", tokens }
}

/** What a metadata value means in tokens for a given window; undefined leaves the model's own ceiling. */
export function thresholdTokens(value: unknown, window: number | undefined): number | undefined {
  const parsed = parseThreshold(value)
  if (parsed === undefined) return undefined
  if (parsed.type === "tokens") return parsed.tokens
  if (window === undefined || !Number.isFinite(window) || window <= 0) return undefined
  return Math.max(1, Math.round((window * parsed.percent) / 100))
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
