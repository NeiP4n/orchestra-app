import { expect, test } from "bun:test"
import { ToolRecommendation as R } from "../src/tool-recommendation"
const now = Date.parse("2026-11-10T14:30:00Z")
const scope = { projectID: "prj_test", role: "orchestrator", capability: "code-search" }
const candidate = (id: string): R.Candidate => ({ id, available: true, paid: false, needsKey: false, readOnly: true })
const metric = (toolID: string, extra: Partial<R.Metrics> = {}): R.Metrics => ({
  ...scope,
  toolID,
  attempts: 100,
  verifiedSuccesses: 95,
  totalLatencyMs: 100000,
  totalOutputTokens: 20000,
  totalCostUsd: null,
  firstAt: now - 10000,
  lastAt: now - 1,
  ...extra,
})
const input = (extra: Partial<R.Input> = {}): R.Input => ({
  ...scope,
  now,
  decisionOrdinal: 1,
  candidates: [candidate("grep"), candidate("symbols")],
  allowedToolIDs: new Set(["grep", "symbols"]),
  metrics: [metric("grep"), metric("symbols", { verifiedSuccesses: 70 })],
  currentToolID: "grep",
  ...extra,
})
test("ranks verified task results and exposes real metrics, never infers cost or execution", () => {
  const result = R.recommend(input())
  expect(result.kind).toBe("ranked")
  expect(result.mode).toBe("recommendation-only")
  expect(result.recommendedToolID).toBe("grep")
  expect(result.ranked[0].evidence).toMatchObject({
    attempts: 100,
    verifiedSuccesses: 95,
    meanLatencyMs: 1000,
    meanOutputTokens: 200,
    meanCostUsd: null,
  })
  expect(result).not.toHaveProperty("execute")
  expect(result).not.toHaveProperty("switch")
})
test("allowlist and live eligibility outrank any score; paid/new keys always require request", () => {
  const candidates = [
    candidate("grep"),
    { ...candidate("symbols"), paid: true },
    candidate("forbidden"),
    { ...candidate("key"), needsKey: true },
    { ...candidate("offline"), available: false },
  ]
  const result = R.recommend(
    input({
      candidates,
      allowedToolIDs: new Set(["grep", "symbols", "key", "offline"]),
      metrics: candidates.map((c) => metric(c.id, { verifiedSuccesses: 100 })),
      exploration: true,
      decisionOrdinal: 10,
    }),
  )
  expect(result.recommendedToolID).toBe("grep")
  expect(result.approvalRequired).toEqual([
    { toolID: "symbols", reason: "paid" },
    { toolID: "key", reason: "new-key" },
  ])
  expect(result.excluded).toEqual([
    { toolID: "forbidden", reason: "not-allowed" },
    { toolID: "offline", reason: "unavailable" },
  ])
  expect(result.ranked.map((r) => r.toolID)).toEqual(["grep"])
})
test("small perfect samples do not defeat substantial verified evidence", () => {
  const result = R.recommend(
    input({ metrics: [metric("grep"), metric("symbols", { attempts: 5, verifiedSuccesses: 5 })] }),
  )
  expect(result.recommendedToolID).toBe("grep")
  expect(R.successLowerBound(5, 5)).toBeLessThan(R.successLowerBound(95, 100))
})
for (const change of [
  { verifiedSuccesses: 101 },
  { attempts: NaN },
  { totalLatencyMs: Infinity },
  { totalOutputTokens: -1 },
  { totalCostUsd: -0.1 },
  { lastAt: now + 1 },
  { firstAt: now - R.MAX_AGE_MS - 1 },
  { firstAt: now, lastAt: now - 1 },
  { role: "worker" },
  { projectID: "prj_other" },
  { capability: "web-search" },
])
  test("invalid/stale/cross-scope evidence never enters ranking: " + JSON.stringify(change), () => {
    const result = R.recommend(input({ metrics: [metric("grep", change)], currentToolID: undefined }))
    expect(result.ranked).toEqual([])
    expect(result.recommendedToolID).toBeUndefined()
    expect(result.kind).toBe("insufficient-evidence")
  })
test("duplicate aggregates are ambiguous even if one claims perfect results", () => {
  expect(
    R.recommend(
      input({ metrics: [metric("grep"), metric("grep", { verifiedSuccesses: 100 })], currentToolID: undefined }),
    ).ranked,
  ).toEqual([])
})
test("no evidence preserves only an eligible current tool and never invents a winner", () => {
  expect(R.recommend(input({ metrics: [] })).recommendedToolID).toBe("grep")
  expect(R.recommend(input({ metrics: [], currentToolID: "foreign" })).recommendedToolID).toBeUndefined()
  expect(R.recommend(input({ allowedToolIDs: new Set() })).kind).toBe("no-eligible-tool")
})
test("exploration is opt-in, read-only, within allowlist and capped at one slot in ten", () => {
  const calls = Array.from({ length: 100 }, (_, i) =>
    R.recommend(input({ metrics: [metric("grep")], decisionOrdinal: i + 1, exploration: true })),
  )
  expect(calls.filter((r) => r.kind === "exploration")).toHaveLength(10)
  expect(calls.filter((r) => r.kind === "exploration").every((r) => r.recommendedToolID === "symbols")).toBe(true)
  expect(R.recommend(input({ metrics: [metric("grep")], decisionOrdinal: 10 })).kind).toBe("ranked")
  expect(
    R.recommend(
      input({
        metrics: [metric("grep")],
        decisionOrdinal: 10,
        exploration: true,
        candidates: [candidate("grep"), { ...candidate("symbols"), readOnly: false }],
      }),
    ).kind,
  ).toBe("ranked")
})
test("same inputs are stable and no input state is modified", () => {
  const data = input(),
    before = JSON.stringify(data)
  expect(R.recommend(data)).toEqual(R.recommend(data))
  expect(JSON.stringify(data)).toBe(before)
})
test("rejects duplicate candidates and invalid ordinals rather than silently resetting exploration budget", () => {
  expect(() => R.recommend(input({ decisionOrdinal: 0 }))).toThrow()
  expect(() => R.recommend(input({ candidates: [candidate("grep"), candidate("grep")] }))).toThrow()
})
test("equal reliability prefers measured latency/output efficiency, cost remains measured metadata not inferred billing", () => {
  const result = R.recommend(
    input({
      metrics: [
        metric("grep", { totalLatencyMs: 900000, totalOutputTokens: 900000, totalCostUsd: 2 }),
        metric("symbols", { totalLatencyMs: 100000, totalOutputTokens: 10000, totalCostUsd: 0 }),
      ],
    }),
  )
  expect(result.recommendedToolID).toBe("symbols")
  expect(result.ranked.find((row) => row.toolID === "grep")?.evidence.meanCostUsd).toBe(0.02)
})
test("failed attempts stay in efficiency denominator and boolean flags are not coerced", () => {
  const result = R.recommend(
    input({
      metrics: [metric("grep", { attempts: 10, verifiedSuccesses: 5, totalLatencyMs: 50000, totalOutputTokens: 3000 })],
    }),
  )
  expect(result.ranked[0].evidence.meanLatencyMs).toBe(5000)
  expect(result.ranked[0].evidence.meanOutputTokens).toBe(300)
  expect(() => R.recommend(input({ candidates: [{ ...candidate("grep"), paid: undefined as never }] }))).toThrow()
})
