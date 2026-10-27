import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  PRIORITY_WEIGHTS,
  ReflectionDaemon,
  type SessionObservation,
} from "../src/agi/reflection"

describe("AGI ReflectionDaemon Active Inference Core (AGI-001)", () => {
  test("initializes with default settings and idle state", () => {
    const daemon = new ReflectionDaemon()
    expect(daemon.isRunning()).toBe(false)
    expect(daemon.intervalMs).toBe(5000)
    expect(daemon.minConfidenceThreshold).toBe(0.5)

    const state = daemon.getState()
    expect(state.phase).toBe("observe")
    expect(state.cycleCount).toBe(0)
    expect(state.hypotheses).toEqual([])
    expect(state.proposedGoals).toEqual([])
  })

  test("runs single discrete tick through active inference phases", async () => {
    const daemon = new ReflectionDaemon()
    daemon.addObservation({
      sessionID: "ses-test-1",
      status: "idle",
      tokenUsage: { input: 5000, output: 1000, limit: 100000 },
    })

    const finalState = await Effect.runPromise(daemon.tick())
    expect(finalState.phase).toBe("refine")
    expect(finalState.cycleCount).toBe(1)
    expect(finalState.observations.length).toBe(1)
  })

  test("generates critical budget hypothesis and emergency compaction goal when near ceiling", async () => {
    const daemon = new ReflectionDaemon({
      budgetCriticalRatio: 0.95,
      budgetWarningRatio: 0.85,
    })

    daemon.addObservation({
      sessionID: "ses-budget-critical",
      status: "running",
      tokenUsage: { input: 96000, output: 1000, limit: 100000 }, // 97% > 95%
    })

    const state = await Effect.runPromise(daemon.tick())
    expect(state.hypotheses.length).toBe(1)
    const hyp = state.hypotheses[0]!
    expect(hyp.category).toBe("budget")
    expect(hyp.confidence).toBeGreaterThanOrEqual(0.95)
    expect(hyp.title).toContain("Critical Context Ceiling")

    expect(state.proposedGoals.length).toBe(1)
    const goal = state.proposedGoals[0]!
    expect(goal.priority).toBe("critical")
    expect(goal.title).toContain("Emergency Session Compaction")
    expect(goal.status).toBe("proposed")
    expect(goal.actionPlan.length).toBeGreaterThan(0)
  })

  test("generates high priority proactive compaction goal for warning budget ratio", async () => {
    const daemon = new ReflectionDaemon()
    daemon.addObservation({
      sessionID: "ses-budget-warning",
      status: "running",
      tokenUsage: { input: 87000, output: 1000, limit: 100000 }, // 88%
    })

    const state = await Effect.runPromise(daemon.tick())
    expect(state.hypotheses.length).toBe(1)
    expect(state.hypotheses[0]!.category).toBe("budget")
    expect(state.proposedGoals.length).toBe(1)
    expect(state.proposedGoals[0]!.priority).toBe("high")
    expect(state.proposedGoals[0]!.title).toContain("Proactive")
  })

  test("detects test regressions and generates critical fix goals", async () => {
    const daemon = new ReflectionDaemon()
    daemon.addObservation({
      sessionID: "ses-tests",
      status: "idle",
      tokenUsage: { input: 10000, output: 2000, limit: 100000 },
      testResults: { passed: 9, failed: 2, total: 11 },
    })

    const state = await Effect.runPromise(daemon.tick())
    const testHyp = state.hypotheses.find((h) => h.category === "testing")
    expect(testHyp).toBeDefined()
    expect(testHyp!.confidence).toBeGreaterThanOrEqual(0.9)

    const fixGoal = state.proposedGoals.find((g) => g.priority === "critical")
    expect(fixGoal).toBeDefined()
    expect(fixGoal!.title).toContain("Test Regressions")
  })

  test("detects error cascades and performance stalls, sorting goals by priority", async () => {
    const daemon = new ReflectionDaemon()

    // 1. Error cascade (high)
    daemon.addObservation({
      sessionID: "ses-error",
      status: "error",
      tokenUsage: { input: 1000, output: 500, limit: 50000 },
      errorCount: 3,
    })

    // 2. Performance stall (medium)
    daemon.addObservation({
      sessionID: "ses-stall",
      status: "running",
      tokenUsage: { input: 2000, output: 500, limit: 50000 },
      durationMs: 45000,
    })

    // 3. Test failure (critical)
    daemon.addObservation({
      sessionID: "ses-regress",
      status: "idle",
      tokenUsage: { input: 1000, output: 200, limit: 50000 },
      testResults: { passed: 5, failed: 1, total: 6 },
    })

    const state = await Effect.runPromise(daemon.tick())
    expect(state.hypotheses.length).toBe(3)
    expect(state.proposedGoals.length).toBe(3)

    // Verify ordering: critical first, then high, then medium
    const priorities = state.proposedGoals.map((g) => g.priority)
    expect(priorities).toEqual(["critical", "high", "medium"])
    expect(PRIORITY_WEIGHTS[priorities[0]!]).toBeGreaterThanOrEqual(PRIORITY_WEIGHTS[priorities[1]!])
    expect(PRIORITY_WEIGHTS[priorities[1]!]).toBeGreaterThanOrEqual(PRIORITY_WEIGHTS[priorities[2]!])
  })

  test("supports dynamic observer callback and clear()", async () => {
    const daemon = new ReflectionDaemon()
    daemon.setObserver(() =>
      Effect.succeed<readonly SessionObservation[]>([
        {
          sessionID: "dynamic-ses-1",
          status: "running",
          tokenUsage: { input: 98000, output: 1000, limit: 100000 },
        },
      ]),
    )

    const state = await Effect.runPromise(daemon.tick())
    expect(state.observations.length).toBe(1)
    expect(state.observations[0]!.sessionID).toBe("dynamic-ses-1")

    daemon.clear()
    const cleared = daemon.getState()
    expect(cleared.observations).toEqual([])
    expect(cleared.hypotheses).toEqual([])
    expect(cleared.proposedGoals).toEqual([])
    expect(cleared.cycleCount).toBe(0)
  })

  test("manages daemon lifecycle with startFork and stop", async () => {
    const daemon = new ReflectionDaemon({ intervalMs: 20 })
    expect(daemon.isRunning()).toBe(false)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* daemon.startFork()
        expect(daemon.isRunning()).toBe(true)

        // Wait a small amount for at least 1-2 ticks
        yield* Effect.sleep("60 millis")
        expect(daemon.getState().cycleCount).toBeGreaterThanOrEqual(1)

        yield* daemon.stop()
        expect(daemon.isRunning()).toBe(false)
      }),
    )
  })

  test("gracefully terminates on Scope finalizer closing", async () => {
    const daemon = new ReflectionDaemon({ intervalMs: 20 })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* daemon.start()
          expect(daemon.isRunning()).toBe(true)
          yield* Effect.sleep("50 millis")
          expect(daemon.getState().cycleCount).toBeGreaterThanOrEqual(1)
        }),
      ),
    )

    // Scope closing should have invoked finalizer and stopped daemon
    expect(daemon.isRunning()).toBe(false)
  })
})
