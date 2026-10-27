export type CognitiveMode = "reactive" | "deliberative" | "exploratory"

export interface ContextMetrics {
  readonly fileCount?: number
  readonly treeDepth?: number
  readonly hasRegressions?: boolean
  readonly conflictingRequirements?: boolean
  readonly recentErrorCount?: number
  readonly noveltyRatio?: number
  readonly deadEndBranches?: number
}

export interface ComplexityFactors {
  readonly uncertainty: number
  readonly depth: number
  readonly regressions: number
  readonly conflicts: number
  readonly errors: number
}

export interface BudgetAllowance {
  readonly maxSearchDepth: number
  readonly tokenMultiplier: number
  readonly allowedBranches: number
}

export interface ComplexityAssessment {
  readonly complexityScore: number
  readonly noveltyScore: number
  readonly factors: ComplexityFactors
  readonly recommendedMode: CognitiveMode
  readonly budgetAllowance: BudgetAllowance
}

export interface GovernorConfig {
  readonly deliberativeThreshold?: number
  readonly exploratoryNoveltyThreshold?: number
  readonly reactiveMaxComplexity?: number
}

export const MODE_BUDGETS: Record<CognitiveMode, BudgetAllowance> = {
  reactive: {
    maxSearchDepth: 1,
    tokenMultiplier: 1.0,
    allowedBranches: 1,
  },
  deliberative: {
    maxSearchDepth: 5,
    tokenMultiplier: 2.5,
    allowedBranches: 3,
  },
  exploratory: {
    maxSearchDepth: 3,
    tokenMultiplier: 2.0,
    allowedBranches: 4,
  },
}

const UNCERTAINTY_KEYWORDS = [
  "investigate",
  "explore",
  "why",
  "architect",
  "design",
  "hypothesize",
  "unclear",
  "unknown",
  "intermittent",
  "flaky",
  "refactor",
  "optimize",
  "complex",
  "rethink",
  "distill",
  "gossip",
  "consensus",
]

const SIMPLICITY_KEYWORDS = [
  "rename",
  "typo",
  "fix line",
  "bump",
  "format",
  "export",
  "comment",
  "read",
  "print",
]

/**
 * Dynamic cognitive mode governor implementing Dual-Process Theory (System 1 vs System 2)
 * and Exploratory Search for autonomous agents.
 */
export class CognitiveModeGovernor {
  readonly deliberativeThreshold: number
  readonly exploratoryNoveltyThreshold: number
  readonly reactiveMaxComplexity: number

  private _activeMode: CognitiveMode = "reactive"

  constructor(config: GovernorConfig = {}) {
    this.deliberativeThreshold = config.deliberativeThreshold ?? 0.6
    this.exploratoryNoveltyThreshold = config.exploratoryNoveltyThreshold ?? 0.7
    this.reactiveMaxComplexity = config.reactiveMaxComplexity ?? 0.35
  }

  get activeMode(): CognitiveMode {
    return this._activeMode
  }

  setMode(mode: CognitiveMode): void {
    this._activeMode = mode
  }

  /**
   * Assesses the cognitive complexity of a task based on prompt formulation and ambient context metrics.
   */
  assessComplexity(taskDescription: string, metrics: ContextMetrics = {}): ComplexityAssessment {
    const text = taskDescription.toLowerCase()

    // 1. Uncertainty factor: keyword analysis & length
    let uncertainty = 0.2
    for (const kw of UNCERTAINTY_KEYWORDS) {
      if (text.includes(kw)) uncertainty += 0.2
    }
    for (const kw of SIMPLICITY_KEYWORDS) {
      if (text.includes(kw)) uncertainty -= 0.15
    }
    if (taskDescription.length > 500) uncertainty += 0.2
    if (taskDescription.includes("?")) uncertainty += 0.1
    uncertainty = Math.max(0.0, Math.min(1.0, uncertainty))

    // 2. Depth factor: file count and tree depth
    let depth = 0.1
    if (metrics.fileCount !== undefined) {
      depth += Math.min(0.5, (metrics.fileCount / 8) * 0.5)
    }
    if (metrics.treeDepth !== undefined) {
      depth += Math.min(0.4, (metrics.treeDepth / 5) * 0.4)
    }
    depth = Math.max(0.0, Math.min(1.0, depth))

    // 3. Regressions factor
    const regressions = metrics.hasRegressions ? 0.8 : 0.0

    // 4. Conflicting requirements factor
    const conflicts = metrics.conflictingRequirements ? 0.7 : 0.0

    // 5. Execution errors factor
    const errorCount = metrics.recentErrorCount ?? 0
    const errors = Math.min(1.0, errorCount * 0.35)

    // Nonlinear composite complexity score calculation
    const rawComplexity =
      uncertainty * 0.35 +
      depth * 0.25 +
      regressions * 0.2 +
      conflicts * 0.1 +
      errors * 0.1

    const complexityScore = Number(Math.max(0.0, Math.min(1.0, rawComplexity)).toFixed(3))

    // Novelty score
    const noveltyScore = Number(
      Math.max(
        0.0,
        Math.min(
          1.0,
          metrics.noveltyRatio !== undefined
            ? metrics.noveltyRatio
            : (metrics.deadEndBranches ? 0.5 : 0.0) + uncertainty * 0.3,
        ),
      ).toFixed(3),
    )

    const factors: ComplexityFactors = {
      uncertainty: Number(uncertainty.toFixed(3)),
      depth: Number(depth.toFixed(3)),
      regressions,
      conflicts,
      errors: Number(errors.toFixed(3)),
    }

    // Determine mode
    let recommendedMode: CognitiveMode = "reactive"
    if (metrics.hasRegressions || metrics.conflictingRequirements || complexityScore >= this.deliberativeThreshold) {
      recommendedMode =
        metrics.noveltyRatio !== undefined && metrics.noveltyRatio >= this.exploratoryNoveltyThreshold
          ? "exploratory"
          : "deliberative"
    } else if (noveltyScore >= this.exploratoryNoveltyThreshold) {
      recommendedMode = "exploratory"
    } else if (complexityScore <= this.reactiveMaxComplexity) {
      recommendedMode = "reactive"
    } else {
      // Intermediate zone: defaults to deliberative if any errors or depth, else reactive
      recommendedMode = depth > 0.4 || errors > 0 ? "deliberative" : "reactive"
    }

    const budgetAllowance = this.getBudgetForMode(recommendedMode)

    return {
      complexityScore,
      noveltyScore,
      factors,
      recommendedMode,
      budgetAllowance,
    }
  }

  /**
   * Applies the assessment to select and set the active cognitive mode.
   */
  selectMode(assessment: ComplexityAssessment): CognitiveMode {
    this._activeMode = assessment.recommendedMode
    return this._activeMode
  }

  /**
   * Dynamically escalates cognitive mode when errors, dead-ends, or regressions occur during execution.
   */
  escalateMode(
    currentMode: CognitiveMode,
    reason: "validation_error" | "dead_end" | "timeout" | "regression",
  ): { readonly newMode: CognitiveMode; readonly reason: string; readonly escalated: boolean } {
    if (currentMode === "reactive") {
      this._activeMode = "deliberative"
      return {
        newMode: "deliberative",
        reason: `Escalated from reactive to deliberative due to ${reason}`,
        escalated: true,
      }
    }

    if (currentMode === "deliberative") {
      if (reason === "dead_end" || reason === "timeout") {
        this._activeMode = "exploratory"
        return {
          newMode: "exploratory",
          reason: `Escalated from deliberative to exploratory due to ${reason}`,
          escalated: true,
        }
      }
      return {
        newMode: "deliberative",
        reason: `Retained deliberative mode under ${reason}`,
        escalated: false,
      }
    }

    return {
      newMode: "exploratory",
      reason: `Already at highest exploratory search mode; retaining under ${reason}`,
      escalated: false,
    }
  }

  getBudgetForMode(mode: CognitiveMode): BudgetAllowance {
    return MODE_BUDGETS[mode] ?? MODE_BUDGETS.reactive
  }
}
