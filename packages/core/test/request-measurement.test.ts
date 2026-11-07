import { describe, expect, test } from "bun:test"
import { SessionRequestMeasurement } from "@orchestra/core/session/request-measurement"

const begun = SessionRequestMeasurement.begin(SessionRequestMeasurement.empty, {
  measurementID: "m-1",
  sessionID: "ses-1",
  logicalRequestID: "lr-1",
  attemptID: "a-1",
  phase: "primary",
  providerID: "zen",
  modelID: "glm-4.6",
  startedAt: 1000,
  toolCount: 3,
  messageCount: 12,
})

describe("SessionRequestMeasurement.begin", () => {
  test("opens an attempt with unknowns as null, never as zero", () => {
    const attempt = SessionRequestMeasurement.attempt(begun, "a-1")
    expect(attempt?.outcome).toBe("unknown")
    expect(attempt?.endedAt).toBeNull()
    expect(attempt?.durationMs).toBeNull()
    expect(attempt?.retryOf).toBeNull()
    expect(attempt?.usage).toEqual({ input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null })
    expect(attempt?.cost).toEqual({ recordedUSD: null, estimatedUSD: null, source: "unknown" })
    expect(attempt?.goalID).toBeNull()
    expect(attempt?.taskID).toBeNull()
    expect(attempt?.role).toBeNull()
    expect(attempt?.attribution).toBe("unknown")
    expect(attempt?.sdkRetries).toBe("uncounted")
  })

  test("a retry keeps the logical request and names the attempt it retries", () => {
    const ledger = SessionRequestMeasurement.begin(begun, {
      measurementID: "m-2",
      sessionID: "ses-1",
      logicalRequestID: "lr-1",
      attemptID: "a-2",
      retryOf: "a-1",
      phase: "primary",
      providerID: "zen",
      modelID: "glm-4.6",
      startedAt: 2000,
      toolCount: 3,
      messageCount: 12,
    })
    const retry = SessionRequestMeasurement.attempt(ledger, "a-2")
    expect(retry?.logicalRequestID).toBe("lr-1")
    expect(retry?.attemptID).toBe("a-2")
    expect(retry?.retryOf).toBe("a-1")
    expect(SessionRequestMeasurement.attempt(ledger, "a-1")?.outcome).toBe("unknown")
  })
})

describe("SessionRequestMeasurement.finish", () => {
  const done = SessionRequestMeasurement.finish(begun, "a-1", {
    outcome: "completed",
    endedAt: 1600,
    usage: { input: 100, output: 40, reasoning: 0, cacheRead: 10, cacheWrite: 5 },
    cost: { recordedUSD: 0.0002, estimatedUSD: null, source: "provider" },
  })

  test("records the terminal state and computes the duration", () => {
    const attempt = SessionRequestMeasurement.attempt(done, "a-1")
    expect(attempt?.outcome).toBe("completed")
    expect(attempt?.endedAt).toBe(1600)
    expect(attempt?.durationMs).toBe(600)
    expect(attempt?.usage.input).toBe(100)
    expect(attempt?.usage.cacheRead).toBe(10)
    expect(attempt?.cost.recordedUSD).toBe(0.0002)
    expect(attempt?.cost.estimatedUSD).toBeNull()
  })

  test("a duplicate terminal event does not create a second record or change the first", () => {
    const twice = SessionRequestMeasurement.finish(done, "a-1", {
      outcome: "failed",
      endedAt: 9999,
      usage: { input: 999, output: 999, reasoning: 999, cacheRead: 999, cacheWrite: 999 },
      cost: { recordedUSD: 42, estimatedUSD: null, source: "provider" },
    })
    expect(twice).toBe(done)
    const attempt = SessionRequestMeasurement.attempt(twice, "a-1")
    expect(attempt?.outcome).toBe("completed")
    expect(attempt?.usage.input).toBe(100)
  })

  test("two parallel attempts never mix their terminal state", () => {
    const both = SessionRequestMeasurement.begin(begun, {
      measurementID: "m-2",
      sessionID: "ses-1",
      logicalRequestID: "lr-2",
      attemptID: "a-2",
      phase: "primary",
      providerID: "zen",
      modelID: "glm-4.6",
      startedAt: 1100,
      toolCount: 3,
      messageCount: 12,
    })
    const finished = SessionRequestMeasurement.finish(both, "a-2", {
      outcome: "failed",
      endedAt: 1500,
      usage: { input: 7, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: { recordedUSD: null, estimatedUSD: null, source: "unknown" },
    })
    expect(SessionRequestMeasurement.attempt(finished, "a-1")?.outcome).toBe("unknown")
    expect(SessionRequestMeasurement.attempt(finished, "a-2")?.outcome).toBe("failed")
    expect(SessionRequestMeasurement.attempt(finished, "a-2")?.durationMs).toBe(400)
  })

  test("finishing an unknown attempt leaves the ledger untouched", () => {
    expect(SessionRequestMeasurement.finish(begun, "a-zzz", { outcome: "completed", endedAt: 1 })).toBe(begun)
  })
})

describe("SessionRequestMeasurement.toLine", () => {
  test("serializes deterministically: the same attempt gives the same string", () => {
    const done = SessionRequestMeasurement.finish(begun, "a-1", { outcome: "completed", endedAt: 1600 })
    const attempt = SessionRequestMeasurement.attempt(done, "a-1")!
    expect(SessionRequestMeasurement.toLine(attempt)).toBe(SessionRequestMeasurement.toLine(attempt))
    expect(SessionRequestMeasurement.toLine(attempt)).toBe(JSON.stringify(JSON.parse(SessionRequestMeasurement.toLine(attempt))))
  })

  test("keeps null distinct from zero", () => {
    const done = SessionRequestMeasurement.finish(begun, "a-1", {
      outcome: "completed",
      endedAt: 1600,
      usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
    const parsed = JSON.parse(SessionRequestMeasurement.toLine(SessionRequestMeasurement.attempt(done, "a-1")!))
    expect(parsed.usage.input).toBe(0)
    expect(parsed.cost.recordedUSD).toBeNull()
    expect(parsed.endedAt).toBe(1600)
    const open = JSON.parse(SessionRequestMeasurement.toLine(SessionRequestMeasurement.attempt(begun, "a-1")!))
    expect(open.usage.input).toBeNull()
    expect(open.endedAt).toBeNull()
  })

  test("stray fields, secrets and text never reach the serialized line", () => {
    const canary = "sk-canarySECRET0123456789"
    const dirty = SessionRequestMeasurement.begin(SessionRequestMeasurement.empty, {
      measurementID: "m-9",
      sessionID: "ses-1",
      logicalRequestID: "lr-9",
      attemptID: "a-9",
      phase: "primary",
      providerID: "zen",
      modelID: "glm-4.6",
      startedAt: 1000,
      toolCount: 1,
      messageCount: 1,
      // Fields the contract does not have: a caller mistake must not leak.
      ...({ apiKey: canary, prompt: "show me the password", headers: { authorization: `Bearer ${canary}` } } as object),
    })
    const line = SessionRequestMeasurement.toLine(SessionRequestMeasurement.attempt(dirty, "a-9")!)
    expect(line).not.toContain(canary)
    expect(line).not.toContain("password")
    expect(line).not.toContain("prompt")
    expect(line).not.toContain("apiKey")
    expect(line).not.toContain("headers")
  })

  test("carries assignment attribution only when it is given, never derived", () => {
    const withAssignment = SessionRequestMeasurement.begin(SessionRequestMeasurement.empty, {
      measurementID: "m-3",
      sessionID: "ses-1",
      logicalRequestID: "lr-3",
      attemptID: "a-3",
      phase: "primary",
      providerID: "zen",
      modelID: "glm-4.6",
      startedAt: 1000,
      toolCount: 0,
      messageCount: 5,
      assignment: { goalID: "g-1", taskID: "t-1", role: "developer" },
    })
    const attempt = SessionRequestMeasurement.attempt(withAssignment, "a-3")!
    expect(attempt.attribution).toBe("assignment")
    expect(attempt.goalID).toBe("g-1")
    expect(attempt.role).toBe("developer")
    const parsed = JSON.parse(SessionRequestMeasurement.toLine(attempt))
    expect(parsed.goalID).toBe("g-1")
    expect(parsed.attribution).toBe("assignment")
  })
})
