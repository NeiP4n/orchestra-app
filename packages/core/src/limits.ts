// Orchestra imposes no limits of its own by default. Setting ORCHESTRA_ENFORCE_LIMITS=1 restores
// the configured ceilings (agent steps, mode steps, tool execution timeouts).
// Provider-side limits (rate limits, context windows) are not ours to lift and are handled by
// retry and compaction instead.
export const enforced = (env: Record<string, string | undefined> = process.env) =>
  env.ORCHESTRA_ENFORCE_LIMITS === "1" || env.ORCHESTRA_ENFORCE_LIMITS === "true"

/** Smallest configured ceiling, or undefined when none applies. */
export const steps = (
  ceilings: ReadonlyArray<number | undefined>,
  env: Record<string, string | undefined> = process.env,
) => {
  if (!enforced(env)) return undefined
  const defined = ceilings.filter((ceiling) => ceiling !== undefined)
  return defined.length === 0 ? undefined : Math.min(...defined)
}

// Largest delay setTimeout accepts (about 24.8 days); clients that treat an omitted timeout
// as "use the library default" need a concrete number to mean "effectively none".
export const UNBOUNDED_MS = 2 ** 31 - 1

/** Explicit configuration always wins; the fallback applies only while limits are enforced. */
export const timeout = (
  configured: number | undefined,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
) => {
  if (configured !== undefined) return configured
  return enforced(env) ? fallback : UNBOUNDED_MS
}

export * as Limits from "./limits.js"
