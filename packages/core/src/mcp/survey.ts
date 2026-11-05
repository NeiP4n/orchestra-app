export * as McpSurvey from "./survey.js"

// The MCP fleet survey: proof the Orchestrator looked at the fleet before
// dispatching (stamped by `mcp_manager inspect` under
// `orchestra:mcp-survey`). A survey used to be valid for the whole session,
// so a fleet that changed mid-session — a server died, a new one was
// installed — kept being dispatched against for hours on stale knowledge.
// The stamp now carries a TTL: after it lapses the sessions tool refuses
// the dispatch until the fleet is surveyed again. Fifteen minutes is long
// enough that a normal planning burst does not re-survey on every dispatch,
// and short enough that a dead server is noticed within one work session.

/** How long one fleet survey stays fresh. */
export const SURVEY_TTL_MS = 15 * 60 * 1000

/** Session metadata key carrying the survey stamp (kept in step with the sessions tool). */
export const SURVEY_METADATA_KEY = "orchestra:mcp-survey"

export interface Survey {
  /** When the survey ran (epoch milliseconds). */
  readonly at: number
  /** Configured servers seen by the survey. */
  readonly configured: number
  /** Installable catalog servers seen by the survey. */
  readonly catalog: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Read the survey stamp out of a session's metadata; undefined when never surveyed or malformed. */
export function parseSurvey(metadata: Record<string, unknown> | undefined): Survey | undefined {
  const raw = metadata?.[SURVEY_METADATA_KEY]
  if (!isRecord(raw)) return undefined
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return undefined
  if (typeof raw.configured !== "number" || typeof raw.catalog !== "number") return undefined
  return { at: raw.at, configured: raw.configured, catalog: raw.catalog }
}

/** True when the session carries a survey stamp younger than the TTL. */
export function isFresh(metadata: Record<string, unknown> | undefined, now = Date.now()): boolean {
  const survey = parseSurvey(metadata)
  if (!survey) return false
  return now - survey.at >= 0 && now - survey.at < SURVEY_TTL_MS
}
