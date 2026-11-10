export * as ToolRecommendation from "./tool-recommendation.js"

/** Recommendation only. This module has no execution, install, credential, permission or
 * configuration dependencies. Callers must supply live eligibility and task-scoped evidence.
 * Transport success is not verified task success: legacy mcp-rating rows cannot supply it. */
export interface Candidate {
  id: string
  available: boolean
  paid: boolean
  needsKey: boolean
  readOnly: boolean
}
export interface Scope {
  projectID: string
  role: string
  capability: string
}
export interface Metrics extends Scope {
  toolID: string
  attempts: number
  /** Outcome checked by the task's verifier, not merely an HTTP/MCP response. */
  verifiedSuccesses: number
  /** Every attempt, including failed ones, contributes to latency and output totals. */
  totalLatencyMs: number
  totalOutputTokens: number
  /** Unknown is never zero. Cost cannot be inferred from tokens. */
  totalCostUsd: number | null
  firstAt: number
  lastAt: number
}
export interface Input extends Scope {
  candidates: readonly Candidate[]
  allowedToolIDs: ReadonlySet<string>
  metrics: readonly Metrics[]
  currentToolID?: string
  now: number
  /** Consecutive ordinal within this exact scope, supplied by a durable caller. */
  decisionOrdinal: number
  /** Off by default. If requested, at most one recommendation per ten decisions. */
  exploration?: boolean
}
export interface Evidence {
  attempts: number
  verifiedSuccesses: number
  successLowerBound: number
  meanLatencyMs: number
  meanOutputTokens: number
  meanCostUsd: number | null
}
export interface Result {
  mode: "recommendation-only"
  kind: "ranked" | "exploration" | "insufficient-evidence" | "no-eligible-tool"
  recommendedToolID?: string
  ranked: readonly { toolID: string; score: number; evidence: Evidence }[]
  approvalRequired: readonly { toolID: string; reason: "paid" | "new-key" | "paid-and-new-key" }[]
  excluded: readonly { toolID: string; reason: "not-allowed" | "unavailable" }[]
}
export const MIN_ATTEMPTS = 5
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const integer = (v: number) => Number.isSafeInteger(v) && v >= 0
const number = (v: number) => Number.isFinite(v) && v >= 0
function valid(m: Metrics, input: Input) {
  return (
    m.projectID === input.projectID &&
    m.role === input.role &&
    m.capability === input.capability &&
    integer(m.attempts) &&
    m.attempts > 0 &&
    integer(m.verifiedSuccesses) &&
    m.verifiedSuccesses <= m.attempts &&
    integer(m.totalLatencyMs) &&
    integer(m.totalOutputTokens) &&
    (m.totalCostUsd === null || number(m.totalCostUsd)) &&
    integer(m.firstAt) &&
    integer(m.lastAt) &&
    m.firstAt <= m.lastAt &&
    m.lastAt <= input.now &&
    // An all-time aggregate with one recent call is not a recent-window aggregate.
    m.firstAt >= input.now - MAX_AGE_MS
  )
}
/** 95% Wilson lower bound: small perfect samples do not masquerade as certainty. */
export function successLowerBound(successes: number, attempts: number) {
  if (!integer(attempts) || !attempts || !integer(successes) || successes > attempts)
    throw Error("Invalid outcome counts.")
  const z = 1.96,
    p = successes / attempts,
    z2 = z * z
  return (p + z2 / (2 * attempts) - z * Math.sqrt((p * (1 - p) + z2 / (4 * attempts)) / attempts)) / (1 + z2 / attempts)
}
export function recommend(input: Input): Result {
  if (
    !input.projectID.trim() ||
    !input.role.trim() ||
    !input.capability.trim() ||
    !integer(input.now) ||
    !integer(input.decisionOrdinal) ||
    input.decisionOrdinal < 1 ||
    input.candidates.length > 200 ||
    input.metrics.length > 2000 ||
    new Set(input.candidates.map((row) => row.id)).size !== input.candidates.length ||
    input.candidates.some(
      (row) =>
        !/^[A-Za-z0-9_@.:/-]{1,160}$/.test(row.id) ||
        [row.available, row.paid, row.needsKey, row.readOnly].some((v) => typeof v !== "boolean"),
    )
  )
    throw Error("Invalid recommendation input.")
  const result: Result = {
    mode: "recommendation-only",
    kind: "no-eligible-tool",
    ranked: [],
    approvalRequired: [],
    excluded: [],
  }
  const eligible: Candidate[] = [],
    excluded: Result["excluded"][number][] = [],
    approvalRequired: Result["approvalRequired"][number][] = []
  for (const row of input.candidates) {
    if (!input.allowedToolIDs.has(row.id)) {
      excluded.push({ toolID: row.id, reason: "not-allowed" })
      continue
    }
    if (row.paid || row.needsKey) {
      approvalRequired.push({
        toolID: row.id,
        reason: row.paid && row.needsKey ? "paid-and-new-key" : row.paid ? "paid" : "new-key",
      })
      continue
    }
    if (!row.available) {
      excluded.push({ toolID: row.id, reason: "unavailable" })
      continue
    }
    eligible.push(row)
  }
  const rows = new Map<string, Metrics[]>(),
    ambiguous = new Set<string>()
  for (const row of input.metrics) {
    if (row.projectID !== input.projectID || row.role !== input.role || row.capability !== input.capability) continue
    // Duplicate aggregates could double count the same calls. Refuse the tool's evidence,
    // rather than choosing the most flattering row or merging unproven disjoint windows.
    if (rows.has(row.toolID)) ambiguous.add(row.toolID)
    rows.set(row.toolID, [row])
  }
  const scored = eligible
    .flatMap((tool) => {
      const m = rows.get(tool.id)?.[0]
      if (!m || ambiguous.has(tool.id) || !valid(m, input) || m.attempts < MIN_ATTEMPTS) return []
      const evidence: Evidence = {
        attempts: m.attempts,
        verifiedSuccesses: m.verifiedSuccesses,
        successLowerBound: successLowerBound(m.verifiedSuccesses, m.attempts),
        meanLatencyMs: m.totalLatencyMs / m.attempts,
        meanOutputTokens: m.totalOutputTokens / m.attempts,
        meanCostUsd: m.totalCostUsd === null ? null : m.totalCostUsd / m.attempts,
      }
      // Fixed policy weights, not measured facts: reliability dominates, with bounded
      // latency/output penalties. No hidden cost reward for unreported/unknown dollars.
      const score =
        evidence.successLowerBound * 100 -
        5 * (evidence.meanLatencyMs / (evidence.meanLatencyMs + 5000)) -
        5 * (evidence.meanOutputTokens / (evidence.meanOutputTokens + 4000))
      return [{ toolID: tool.id, score, evidence }]
    })
    .sort((a, b) => b.score - a.score || a.toolID.localeCompare(b.toolID))
  Object.assign(result, { ranked: scored, excluded, approvalRequired })
  if (!eligible.length) return result
  result.kind = scored.length ? "ranked" : "insufficient-evidence"
  result.recommendedToolID =
    scored[0]?.toolID ?? (eligible.some((row) => row.id === input.currentToolID) ? input.currentToolID : undefined)
  if (input.exploration && input.decisionOrdinal % 10 === 0) {
    const alternatives = eligible
      .filter(
        (tool) =>
          tool.readOnly &&
          tool.id !== result.recommendedToolID &&
          tool.id !== input.currentToolID &&
          !ambiguous.has(tool.id) &&
          (!rows.has(tool.id) || valid(rows.get(tool.id)![0], input)),
      )
      .filter((tool) => {
        const m = rows.get(tool.id)?.[0]
        return !m || m.attempts < MIN_ATTEMPTS
      })
      .sort(
        (a, b) => (rows.get(a.id)?.[0].attempts ?? 0) - (rows.get(b.id)?.[0].attempts ?? 0) || a.id.localeCompare(b.id),
      )
    if (alternatives.length) {
      result.kind = "exploration"
      result.recommendedToolID = alternatives[(input.decisionOrdinal / 10 - 1) % alternatives.length].id
    }
  }
  return result
}
