export * as OutcomeLedger from "./outcome-ledger.js"

import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { KV } from "../kv.js"
import type { ToolRecommendation } from "../tool-recommendation.js"

export interface Scope {
  projectID: string
  role: string
  capability: string
}
export interface Attempt {
  id: string
  taskID: string
  toolID: string
  at: number
  latencyMs: number
  outputTokens: number
  costUsd: number | null
}
export interface Verification {
  /** Identity of the internal acceptance/test/operator check, not a worker's completion claim. */
  id: string
  source: "test" | "acceptance" | "operator"
  outcome: "passed" | "failed"
  at: number
}
interface State {
  version: 1
  scope: Scope
  attempts: (Attempt & { verification?: Verification })[]
  decisions: Record<string, number>
  ordinal: number
}
export const WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const MAX_ROWS = 10000
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_@.:/-]{1,160}$/.test(value)
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
function scopeValid(value: Scope) {
  return id(value.projectID) && id(value.role) && id(value.capability)
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function validAttempt(row: Attempt) {
  return (
    !!row &&
    id(row.id) &&
    id(row.taskID) &&
    id(row.toolID) &&
    nonnegative(row.at) &&
    nonnegative(row.latencyMs) &&
    nonnegative(row.outputTokens) &&
    (row.costUsd === null || (typeof row.costUsd === "number" && Number.isFinite(row.costUsd) && row.costUsd >= 0))
  )
}
function validVerification(row: Verification) {
  return (
    !!row &&
    id(row.id) &&
    ["test", "acceptance", "operator"].includes(row.source) &&
    ["passed", "failed"].includes(row.outcome) &&
    nonnegative(row.at)
  )
}
function read(raw: KV.Value | undefined, scope: Scope): State {
  scope = { projectID: scope.projectID, role: scope.role, capability: scope.capability }
  if (raw === undefined) return { version: 1, scope: { ...scope }, attempts: [], decisions: {}, ordinal: 0 }
  const row = raw as unknown as State
  if (
    !row ||
    row.version !== 1 ||
    !equal(row.scope, scope) ||
    !Array.isArray(row.attempts) ||
    row.attempts.length > MAX_ROWS ||
    !row.decisions ||
    typeof row.decisions !== "object" ||
    Array.isArray(row.decisions) ||
    Object.keys(row.decisions).length > MAX_ROWS ||
    !nonnegative(row.ordinal) ||
    row.attempts.some(
      (a) =>
        !validAttempt(a) ||
        (a.verification !== undefined && (!validVerification(a.verification) || a.verification.at < a.at)),
    ) ||
    new Set(row.attempts.map((a) => a.id)).size !== row.attempts.length ||
    Object.entries(row.decisions).some(
      ([key, ordinal]) => !/^[a-f0-9]{64}$/.test(key) || !nonnegative(ordinal) || ordinal < 1 || ordinal > row.ordinal,
    )
  )
    throw Error("Outcome ledger is damaged; no recommendation evidence was used.")
  return structuredClone(row)
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const serialize = (value: State): KV.Value => JSON.parse(JSON.stringify(value))
/** Internal persistence API. Not a model tool: no input flag can turn a transport return or a
 * worker report into verified success. The accepting verifier calls verify after its own check.
 * No prompts, tool arguments/results, secrets or transcript content are stored. */
export function make(kv: Pick<KV.Interface, "get" | "atomicUpdate">) {
  const key = (scope: Scope) => {
    if (!scopeValid(scope)) throw Error("Invalid outcome scope.")
    return "orchestra/capability-outcomes/v1/" + digest([scope.projectID, scope.role, scope.capability])
  }
  return {
    record: (scope: Scope, attempt: Attempt) =>
      Effect.suspend(() => {
        if (!validAttempt(attempt)) return Effect.fail(new Error("Invalid outcome attempt."))
        // Project only the allowlisted facts, never serialize caller extras.
        const fact: Attempt = {
          id: attempt.id,
          taskID: attempt.taskID,
          toolID: attempt.toolID,
          at: attempt.at,
          latencyMs: attempt.latencyMs,
          outputTokens: attempt.outputTokens,
          costUsd: attempt.costUsd,
        }
        return kv
          .atomicUpdate(key(scope), (raw) => {
            const state = read(raw, scope),
              existing = state.attempts.find((row) => row.id === fact.id)
            if (existing) {
              const { verification: _, ...original } = existing
              if (!equal(original, fact)) throw Error("Outcome attempt ID already has different facts.")
              return serialize(state)
            }
            if (state.attempts.length >= MAX_ROWS)
              throw Error("Outcome ledger is full; archive before recording more attempts.")
            state.attempts.push(fact)
            return serialize(state)
          })
          .pipe(Effect.asVoid)
      }),
    verify: (scope: Scope, attemptID: string, verification: Verification) =>
      Effect.suspend(() => {
        if (!id(attemptID) || !validVerification(verification))
          return Effect.fail(new Error("Invalid outcome verification."))
        const fact: Verification = {
          id: verification.id,
          source: verification.source,
          outcome: verification.outcome,
          at: verification.at,
        }
        return kv
          .atomicUpdate(key(scope), (raw) => {
            const state = read(raw, scope),
              attempt = state.attempts.find((row) => row.id === attemptID)
            if (!attempt || fact.at < attempt.at)
              throw Error("Verification needs its original attempt and a valid time.")
            if (attempt.verification && !equal(attempt.verification, fact))
              throw Error("Verification is immutable; conflicting evidence requires review.")
            attempt.verification = fact
            return serialize(state)
          })
          .pipe(Effect.asVoid)
      }),
    nextDecision: (scope: Scope, decisionID: string) =>
      Effect.suspend(() => {
        if (!id(decisionID)) return Effect.fail(new Error("Invalid recommendation decision ID."))
        const decision = digest(decisionID)
        return kv
          .atomicUpdate(key(scope), (raw) => {
            const state = read(raw, scope)
            if (Object.hasOwn(state.decisions, decision)) return serialize(state)
            if (Object.keys(state.decisions).length >= MAX_ROWS || state.ordinal >= Number.MAX_SAFE_INTEGER)
              throw Error("Recommendation decision ledger is full; archive before continuing.")
            state.decisions[decision] = ++state.ordinal
            return serialize(state)
          })
          .pipe(Effect.map((raw) => read(raw, scope).decisions[decision]))
      }),
    metrics: (scope: Scope, now: number) =>
      Effect.suspend(() => {
        if (!nonnegative(now)) return Effect.fail(new Error("Invalid evidence time."))
        return kv.get(key(scope)).pipe(
          Effect.map((raw) => {
            const state = read(raw, scope),
              metrics = new Map<string, ToolRecommendation.Metrics>()
            let unverified = 0
            for (const row of state.attempts) {
              if (row.at < now - WINDOW_MS || row.at > now) continue
              if (!row.verification || row.verification.at > now) unverified++
              const value = metrics.get(row.toolID) ?? {
                ...scope,
                toolID: row.toolID,
                attempts: 0,
                verifiedSuccesses: 0,
                totalLatencyMs: 0,
                totalOutputTokens: 0,
                totalCostUsd: 0,
                firstAt: row.at,
                lastAt: row.at,
              }
              value.attempts++
              value.verifiedSuccesses +=
                row.verification && row.verification.at <= now && row.verification.outcome === "passed" ? 1 : 0
              value.totalLatencyMs += row.latencyMs
              value.totalOutputTokens += row.outputTokens
              value.totalCostUsd =
                value.totalCostUsd === null || row.costUsd === null ? null : value.totalCostUsd + row.costUsd
              value.firstAt = Math.min(value.firstAt, row.at)
              value.lastAt = Math.max(value.lastAt, row.at)
              metrics.set(row.toolID, value)
            }
            return { metrics: [...metrics.values()], unverified }
          }),
        )
      }),
  }
}
