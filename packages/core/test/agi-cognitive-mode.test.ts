import { describe, expect, test } from "bun:test"
import {
  CognitiveModeGovernor,
  MODE_BUDGETS,
} from "../src/agi/cognitive-mode"

describe("CognitiveModeGovernor Dual-Process & Exploration Engine (AGI-006)", () => {
  test("initializes with reactive mode as default baseline", () => {
    const governor = new CognitiveModeGovernor()
    expect(governor.activeMode).toBe("reactive")
    expect(governor.deliberativeThreshold).toBe(0.6)
    expect(governor.exploratoryNoveltyThreshold).toBe(0.7)
    expect(governor.reactiveMaxComplexity).toBe(0.35)
  })

  test("defines distinct token and tree search allowances per mode", () => {
    expect(MODE_BUDGETS.reactive).toEqual({
      maxSearchDepth: 1,
      tokenMultiplier: 1.0,
      allowedBranches: 1,
    })
    expect(MODE_BUDGETS.deliberative).toEqual({
      maxSearchDepth: 5,
      tokenMultiplier: 2.5,
      allowedBranches: 3,
    })
    expect(MODE_BUDGETS.exploratory).toEqual({
      maxSearchDepth: 3,
      tokenMultiplier: 2.0,
      allowedBranches: 4,
    })
  })

  test("classifies simple trivial tasks as reactive mode with low complexity", () => {
    const governor = new CognitiveModeGovernor()
    const assessment = governor.assessComplexity("Fix typo in export comment", {
      fileCount: 1,
      treeDepth: 1,
    })

    expect(assessment.complexityScore).toBeLessThanOrEqual(0.35)
    expect(assessment.recommendedMode).toBe("reactive")
    expect(assessment.budgetAllowance.maxSearchDepth).toBe(1)
    expect(assessment.budgetAllowance.allowedBranches).toBe(1)

    governor.selectMode(assessment)
    expect(governor.activeMode).toBe("reactive")
  })

  test("classifies complex regression tasks as deliberative mode", () => {
    const governor = new CognitiveModeGovernor()
    const assessment = governor.assessComplexity(
      "Architect and refactor distributed consensus with flaky regression under high concurrency",
      {
        fileCount: 8,
        treeDepth: 4,
        hasRegressions: true,
        recentErrorCount: 2,
      },
    )

    expect(assessment.complexityScore).toBeGreaterThanOrEqual(0.6)
    expect(assessment.factors.regressions).toBe(0.8)
    expect(assessment.factors.errors).toBeGreaterThan(0)
    expect(assessment.recommendedMode).toBe("deliberative")
    expect(assessment.budgetAllowance.maxSearchDepth).toBe(5)
    expect(assessment.budgetAllowance.tokenMultiplier).toBe(2.5)

    governor.selectMode(assessment)
    expect(governor.activeMode).toBe("deliberative")
  })

  test("selects exploratory mode for high novelty and unconventional hypotheses", () => {
    const governor = new CognitiveModeGovernor()
    const assessment = governor.assessComplexity(
      "Explore and hypothesize novel gossip consensus topology across untrusted edge swarms",
      {
        noveltyRatio: 0.85,
        fileCount: 3,
      },
    )

    expect(assessment.noveltyScore).toBeGreaterThanOrEqual(0.7)
    expect(assessment.recommendedMode).toBe("exploratory")
    expect(assessment.budgetAllowance.allowedBranches).toBe(4)

    governor.selectMode(assessment)
    expect(governor.activeMode).toBe("exploratory")
  })

  test("escalates from reactive to deliberative upon validation errors or regressions", () => {
    const governor = new CognitiveModeGovernor()
    expect(governor.activeMode).toBe("reactive")

    // Escalation on validation error
    const esc1 = governor.escalateMode("reactive", "validation_error")
    expect(esc1.escalated).toBe(true)
    expect(esc1.newMode).toBe("deliberative")
    expect(governor.activeMode).toBe("deliberative")

    // Escalation on regression
    const esc2 = governor.escalateMode("reactive", "regression")
    expect(esc2.escalated).toBe(true)
    expect(esc2.newMode).toBe("deliberative")
  })

  test("escalates from deliberative to exploratory upon dead-ends or timeouts", () => {
    const governor = new CognitiveModeGovernor()
    governor.setMode("deliberative")

    // Dead-end triggers divergent exploratory mode
    const escDeadEnd = governor.escalateMode("deliberative", "dead_end")
    expect(escDeadEnd.escalated).toBe(true)
    expect(escDeadEnd.newMode).toBe("exploratory")
    expect(governor.activeMode).toBe("exploratory")

    // Timeout also triggers exploratory mode
    const escTimeout = governor.escalateMode("deliberative", "timeout")
    expect(escTimeout.escalated).toBe(true)
    expect(escTimeout.newMode).toBe("exploratory")

    // Validation error in deliberative mode stays in deliberative mode
    const escVal = governor.escalateMode("deliberative", "validation_error")
    expect(escVal.escalated).toBe(false)
    expect(escVal.newMode).toBe("deliberative")
  })

  test("exploratory mode remains at maximum depth when dead-ends continue", () => {
    const governor = new CognitiveModeGovernor()
    governor.setMode("exploratory")

    const esc = governor.escalateMode("exploratory", "dead_end")
    expect(esc.escalated).toBe(false)
    expect(esc.newMode).toBe("exploratory")
    expect(governor.activeMode).toBe("exploratory")
  })
})
