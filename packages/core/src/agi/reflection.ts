import { Effect, Fiber, Scope } from "effect"

export type InferencePhase = "observe" | "hypothesize" | "propose_goals" | "refine"

export type GoalPriority = "critical" | "high" | "medium" | "background"

export const PRIORITY_WEIGHTS: Record<GoalPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  background: 1,
}

export interface SessionObservation {
  readonly sessionID: string
  readonly status: "idle" | "running" | "error" | "compacting"
  readonly tokenUsage: {
    readonly input: number
    readonly output: number
    readonly limit: number
  }
  readonly testResults?: {
    readonly passed: number
    readonly failed: number
    readonly total: number
  }
  readonly errorCount?: number
  readonly durationMs?: number
  readonly lastActivityTime?: number
}

export interface Hypothesis {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly confidence: number
  readonly category: "performance" | "reliability" | "budget" | "testing" | "architecture"
  readonly evidence: readonly string[]
  readonly createdAt: number
}

export interface ProposedGoal {
  readonly id: string
  readonly hypothesisId: string
  readonly title: string
  readonly description: string
  readonly priority: GoalPriority
  readonly estimatedEffort: "trivial" | "small" | "medium" | "large"
  readonly actionPlan: readonly string[]
  readonly status: "proposed" | "approved" | "rejected" | "executing" | "completed"
}

export interface ActiveInferenceState {
  readonly phase: InferencePhase
  readonly observations: readonly SessionObservation[]
  readonly hypotheses: readonly Hypothesis[]
  readonly proposedGoals: readonly ProposedGoal[]
  readonly cycleCount: number
  readonly lastCycleTimestamp: number
}

export interface ReflectionDaemonOptions {
  readonly intervalMs?: number
  readonly minConfidenceThreshold?: number
  readonly budgetWarningRatio?: number
  readonly budgetCriticalRatio?: number
  readonly observer?: () => Effect.Effect<readonly SessionObservation[]>
}

/**
 * Autonomous cognitive reflection daemon based on Active Inference.
 * Orchestrates a continuous cycle of:
 * Observe -> Hypothesize -> ProposeGoals -> Refine
 * to continuously monitor agent health, budget pressures, and test regressions.
 */
export class ReflectionDaemon {
  private _state: ActiveInferenceState = {
    phase: "observe",
    observations: [],
    hypotheses: [],
    proposedGoals: [],
    cycleCount: 0,
    lastCycleTimestamp: 0,
  }

  private _manualObservations: SessionObservation[] = []
  private _observer?: () => Effect.Effect<readonly SessionObservation[]>
  private _fiber?: Fiber.Fiber<void>
  private _running = false

  readonly intervalMs: number
  readonly minConfidenceThreshold: number
  readonly budgetWarningRatio: number
  readonly budgetCriticalRatio: number

  constructor(options: ReflectionDaemonOptions = {}) {
    this.intervalMs = Math.max(10, options.intervalMs ?? 5000)
    this.minConfidenceThreshold = options.minConfidenceThreshold ?? 0.5
    this.budgetWarningRatio = options.budgetWarningRatio ?? 0.85
    this.budgetCriticalRatio = options.budgetCriticalRatio ?? 0.95
    this._observer = options.observer
  }

  getState(): ActiveInferenceState {
    return this._state
  }

  isRunning(): boolean {
    return this._running
  }

  addObservation(observation: SessionObservation): void {
    this._manualObservations.push(observation)
  }

  setObserver(observer: () => Effect.Effect<readonly SessionObservation[]>): void {
    this._observer = observer
  }

  clear(): void {
    this._manualObservations = []
    this._state = {
      phase: "observe",
      observations: [],
      hypotheses: [],
      proposedGoals: [],
      cycleCount: 0,
      lastCycleTimestamp: 0,
    }
  }

  /**
   * Executes a single discrete Active Inference cycle:
   * 1. Observe: collects observations
   * 2. Hypothesize: infers root causes and risks
   * 3. ProposeGoals: formulates prioritized mitigation goals
   * 4. Refine: orders and deduplicates actionable goals
   */
  tick(): Effect.Effect<ActiveInferenceState> {
    const self = this
    return Effect.gen(function* () {
      const now = Date.now()

      // Phase 1: Observe
      let dynamicObs: readonly SessionObservation[] = []
      if (self._observer) {
        dynamicObs = yield* self._observer().pipe(
          Effect.catch(() => Effect.succeed<readonly SessionObservation[]>([])),
        )
      }
      const observations = [...self._manualObservations, ...dynamicObs]
      self._state = { ...self._state, phase: "observe", observations }

      // Phase 2: Hypothesize
      const hypotheses: Hypothesis[] = []
      let hypCounter = 1

      for (const obs of observations) {
        const totalUsed = obs.tokenUsage.input + obs.tokenUsage.output
        const limit = obs.tokenUsage.limit
        const ratio = limit > 0 ? totalUsed / limit : 0

        // Context budget hypotheses
        if (ratio >= self.budgetCriticalRatio) {
          hypotheses.push({
            id: `hyp-${now}-${hypCounter++}`,
            title: `Critical Context Ceiling Exhaustion in Session ${obs.sessionID}`,
            description: `Session consumed ${(ratio * 100).toFixed(1)}% of token limit (${totalUsed}/${limit}). Imminent crash without compaction.`,
            confidence: 0.98,
            category: "budget",
            evidence: [`Session ${obs.sessionID} usage: ${totalUsed}/${limit} tokens`],
            createdAt: now,
          })
        } else if (ratio >= self.budgetWarningRatio) {
          hypotheses.push({
            id: `hyp-${now}-${hypCounter++}`,
            title: `High Context Pressure in Session ${obs.sessionID}`,
            description: `Session consumed ${(ratio * 100).toFixed(1)}% of token limit. Proactive compaction recommended.`,
            confidence: 0.85,
            category: "budget",
            evidence: [`Session ${obs.sessionID} usage: ${totalUsed}/${limit} tokens`],
            createdAt: now,
          })
        }

        // Test failure hypotheses
        if (obs.testResults && obs.testResults.failed > 0) {
          hypotheses.push({
            id: `hyp-${now}-${hypCounter++}`,
            title: `Test Suite Regression Detected in Session ${obs.sessionID}`,
            description: `${obs.testResults.failed} test(s) failed out of ${obs.testResults.total}. Invariant contract violated.`,
            confidence: 0.95,
            category: "testing",
            evidence: [`${obs.testResults.failed}/${obs.testResults.total} tests failed`],
            createdAt: now,
          })
        }

        // Execution error cascade
        if ((obs.errorCount && obs.errorCount > 0) || obs.status === "error") {
          hypotheses.push({
            id: `hyp-${now}-${hypCounter++}`,
            title: `Error Cascade in Session ${obs.sessionID}`,
            description: `Encountered ${obs.errorCount ?? 1} execution error(s). Circuit breaker or retry intervention needed.`,
            confidence: 0.9,
            category: "reliability",
            evidence: [`Session status: ${obs.status}, errors: ${obs.errorCount ?? 1}`],
            createdAt: now,
          })
        }

        // Execution latency stall
        if (obs.status === "running" && obs.durationMs && obs.durationMs > 30000) {
          hypotheses.push({
            id: `hyp-${now}-${hypCounter++}`,
            title: `Long-Running Execution Bottleneck in Session ${obs.sessionID}`,
            description: `Session running for ${Math.round(obs.durationMs / 1000)}s without reaching idle state.`,
            confidence: 0.72,
            category: "performance",
            evidence: [`Duration: ${obs.durationMs}ms`],
            createdAt: now,
          })
        }
      }

      // Filter by confidence threshold
      const validHypotheses = hypotheses.filter((h) => h.confidence >= self.minConfidenceThreshold)
      self._state = { ...self._state, phase: "hypothesize", hypotheses: validHypotheses }

      // Phase 3: Propose Goals
      const proposedGoals: ProposedGoal[] = []
      let goalCounter = 1

      for (const h of validHypotheses) {
        if (h.category === "budget") {
          const isCritical = h.confidence >= 0.9
          proposedGoals.push({
            id: `goal-${now}-${goalCounter++}`,
            hypothesisId: h.id,
            title: isCritical ? "Emergency Session Compaction" : "Schedule Proactive Context Compaction",
            description: h.description,
            priority: isCritical ? "critical" : "high",
            estimatedEffort: "small",
            actionPlan: [
              "Trigger compaction with summarize or native strategy",
              "Verify post-compaction budget leaves sufficient margin",
            ],
            status: "proposed",
          })
        } else if (h.category === "testing") {
          proposedGoals.push({
            id: `goal-${now}-${goalCounter++}`,
            hypothesisId: h.id,
            title: "Diagnose and Fix Failing Test Regressions",
            description: h.description,
            priority: "critical",
            estimatedEffort: "medium",
            actionPlan: [
              "Identify failing assertions from test runner output",
              "Apply localized bug fix without touching unrelated code",
              "Verify regression test suite passes cleanly",
            ],
            status: "proposed",
          })
        } else if (h.category === "reliability") {
          proposedGoals.push({
            id: `goal-${now}-${goalCounter++}`,
            hypothesisId: h.id,
            title: "Isolate Fault and Trip Circuit Breaker",
            description: h.description,
            priority: "high",
            estimatedEffort: "small",
            actionPlan: [
              "Inspect tool execution failure logs",
              "Trip circuit breaker on unhealthy external dependency",
              "Resume session with fallback options",
            ],
            status: "proposed",
          })
        } else if (h.category === "performance") {
          proposedGoals.push({
            id: `goal-${now}-${goalCounter++}`,
            hypothesisId: h.id,
            title: "Profile Hot Execution Loop and Release Stalled Fibers",
            description: h.description,
            priority: "medium",
            estimatedEffort: "medium",
            actionPlan: [
              "Check fiber execution stack",
              "Verify speculative tool execution boundaries",
              "Release lock or abort deadlocked fiber",
            ],
            status: "proposed",
          })
        }
      }

      self._state = { ...self._state, phase: "propose_goals", proposedGoals }

      // Phase 4: Refine
      // Sort goals by priority descending (critical > high > medium > background)
      const refinedGoals = [...proposedGoals].sort((a, b) => {
        const weightA = PRIORITY_WEIGHTS[a.priority] ?? 0
        const weightB = PRIORITY_WEIGHTS[b.priority] ?? 0
        return weightB - weightA
      })

      const nextCycle = self._state.cycleCount + 1
      self._state = {
        phase: "refine",
        observations,
        hypotheses: validHypotheses,
        proposedGoals: refinedGoals,
        cycleCount: nextCycle,
        lastCycleTimestamp: now,
      }

      return self._state
    })
  }

  /**
   * Starts background daemon loop tied to an Effect Scope.
   * Gracefully terminates when Scope closes.
   */
  start(): Effect.Effect<void, never, Scope.Scope> {
    const self = this
    return Effect.gen(function* () {
      if (self._running) return
      self._running = true

      const loop = Effect.gen(function* () {
        while (self._running) {
          yield* self.tick().pipe(
            Effect.catch(() => Effect.void),
          )
          yield* Effect.sleep(`${self.intervalMs} millis`)
        }
      })

      const fiber = yield* Effect.forkScoped(loop)
      self._fiber = fiber

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          self._running = false
          self._fiber = undefined
        }),
      )
    })
  }

  /**
   * Starts background daemon loop directly, returning runtime fiber for external control.
   */
  startFork(): Effect.Effect<Fiber.Fiber<void>> {
    const self = this
    return Effect.gen(function* () {
      if (self._running && self._fiber) {
        return self._fiber
      }
      self._running = true

      const loop = Effect.gen(function* () {
        while (self._running) {
          yield* self.tick().pipe(
            Effect.catch(() => Effect.void),
          )
          yield* Effect.sleep(`${self.intervalMs} millis`)
        }
      })

      const fiber = yield* Effect.forkChild(loop)
      self._fiber = fiber
      return fiber
    })
  }

  /**
   * Stops background loop and interrupts running fiber.
   */
  stop(): Effect.Effect<void> {
    const self = this
    return Effect.gen(function* () {
      self._running = false
      if (self._fiber) {
        yield* Fiber.interrupt(self._fiber)
        self._fiber = undefined
      }
    })
  }
}
