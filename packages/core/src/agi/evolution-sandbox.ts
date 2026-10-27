export type CodeMutationType =
  | "numeric_tweak"
  | "branch_swap"
  | "structure_replace"
  | "heuristic_tune"
  | "custom"

export interface FitnessMetrics {
  readonly executionTimeMs: number
  readonly memoryUsageBytes: number
  readonly testsPassed: number
  readonly testsTotal: number
  readonly invariantsSatisfied: boolean
}

export interface FitnessEvaluationResult {
  readonly score: number
  readonly metrics: FitnessMetrics
  readonly passed: boolean
  readonly error?: string
}

export interface CandidateSolution {
  readonly id: string
  readonly code: string
  readonly parentId?: string
  readonly generation: number
  readonly fitnessScore: number
  readonly metrics?: FitnessMetrics
  readonly mutationType?: CodeMutationType
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly createdAt: number
}

export type FitnessFunction = (
  candidate: CandidateSolution,
) => Promise<FitnessEvaluationResult> | FitnessEvaluationResult

export interface EvolutionConfig {
  readonly populationSize?: number
  readonly generations?: number
  readonly elitismCount?: number
  readonly tournamentSize?: number
  readonly mutationRate?: number
  readonly targetFitness?: number
  readonly customMutators?: ReadonlyArray<(code: string) => string>
}

export interface EvolutionGenerationStats {
  readonly generation: number
  readonly bestScore: number
  readonly averageScore: number
  readonly bestCandidateId: string
}

export interface EvolutionRunResult {
  readonly bestCandidate: CandidateSolution
  readonly baselineCandidate: CandidateSolution
  readonly generationsRun: number
  readonly finalPopulation: ReadonlyArray<CandidateSolution>
  readonly history: ReadonlyArray<EvolutionGenerationStats>
  readonly improved: boolean
}

/**
 * Mutates source code according to genetic algorithms and heuristic strategies.
 */
export class CodeMutator {
  /**
   * Applies a specific or randomly selected code mutation strategy.
   */
  static mutate(
    code: string,
    strategy?: CodeMutationType,
    customMutators?: ReadonlyArray<(code: string) => string>,
  ): { code: string; type: CodeMutationType } {
    if (customMutators && customMutators.length > 0 && Math.random() < 0.3) {
      const mutator = customMutators[Math.floor(Math.random() * customMutators.length)]!
      return { code: mutator(code), type: "custom" }
    }

    const availableStrategies: CodeMutationType[] = [
      "numeric_tweak",
      "branch_swap",
      "structure_replace",
      "heuristic_tune",
    ]

    const selectedStrategy = strategy ?? availableStrategies[Math.floor(Math.random() * availableStrategies.length)]!

    switch (selectedStrategy) {
      case "numeric_tweak":
        return { code: this.mutateNumericConstants(code), type: "numeric_tweak" }
      case "branch_swap":
        return { code: this.mutateBranchOrder(code), type: "branch_swap" }
      case "structure_replace":
        return { code: this.mutateDataStructures(code), type: "structure_replace" }
      case "heuristic_tune":
        return { code: this.mutateHeuristics(code), type: "heuristic_tune" }
      case "custom":
        return { code, type: "custom" }
    }
  }

  /**
   * Perturbs numeric constants by scaling or jittering (+/- 10-50% or step adjustment).
   */
  private static mutateNumericConstants(code: string): string {
    // Match integer or float literals (excluding line numbers or identifiers)
    return code.replace(/\b(\d+(\.\d+)?)\b/g, (match, numStr) => {
      const num = parseFloat(numStr)
      if (num === 0) return (Math.random() > 0.5 ? 1 : 0).toString()
      // Scale by a factor between 0.7 and 1.4
      const factor = 0.7 + Math.random() * 0.7
      const perturbed = num >= 10 ? Math.round(num * factor) : parseFloat((num * factor).toFixed(2))
      return perturbed.toString()
    })
  }

  /**
   * Inverts or swaps conditional branches where applicable.
   */
  private static mutateBranchOrder(code: string): string {
    // Swap simple binary comparisons: > to >=, < to <=, === to !==
    if (code.includes("===") && Math.random() < 0.3) {
      return code.replace("===", "==")
    }
    if (code.includes(">") && !code.includes(">=") && Math.random() < 0.5) {
      return code.replace(">", ">=")
    }
    if (code.includes("<") && !code.includes("<=") && Math.random() < 0.5) {
      return code.replace("<", "<=")
    }
    return code
  }

  /**
   * Swaps collections and algorithmic structures (e.g. Array.includes -> Set.has hints).
   */
  private static mutateDataStructures(code: string): string {
    if (code.includes(".indexOf(")) {
      return code.replace(/\.indexOf\(([^)]+)\)\s*>=?\s*0/g, ".includes($1)")
    }
    if (code.includes("new Array()")) {
      return code.replace("new Array()", "[]")
    }
    return code
  }

  /**
   * Tweaks heuristic parameters, batch sizes or caching thresholds.
   */
  private static mutateHeuristics(code: string): string {
    if (code.includes("limit") || code.includes("threshold") || code.includes("batch")) {
      return code.replace(/\b(limit|threshold|batchSize)\s*:\s*(\d+)/g, (_match, key, val) => {
        const newVal = Math.max(1, Math.round(parseInt(val, 10) * (0.8 + Math.random() * 0.5)))
        return `${key}: ${newVal}`
      })
    }
    return this.mutateNumericConstants(code)
  }
}

/**
 * Isolated Evolutionary Sandbox for autonomous algorithmic optimization, mutation, and selection.
 */
export class EvolutionarySandbox {
  private population: CandidateSolution[] = []
  private readonly baseline: CandidateSolution
  private currentGeneration = 0

  constructor(baselineCode: string, baselineMetadata?: Record<string, unknown>) {
    this.baseline = {
      id: "baseline-0",
      code: baselineCode,
      generation: 0,
      fitnessScore: 0,
      metadata: baselineMetadata,
      createdAt: Date.now(),
    }
    this.population = [this.baseline]
  }

  /**
   * Returns the original immutable baseline solution.
   */
  getBaseline(): CandidateSolution {
    return this.baseline
  }

  /**
   * Returns the current generation index.
   */
  getCurrentGeneration(): number {
    return this.currentGeneration
  }

  /**
   * Returns the current active candidate population.
   */
  getPopulation(): ReadonlyArray<CandidateSolution> {
    return [...this.population]
  }

  /**
   * Returns the highest-scoring candidate in the current population.
   */
  getBestCandidate(): CandidateSolution {
    if (this.population.length === 0) return this.baseline
    return this.population.reduce((best, curr) =>
      curr.fitnessScore > best.fitnessScore ? curr : best,
    )
  }

  /**
   * Adds an explicitly created candidate to the population.
   */
  addCandidate(candidate: CandidateSolution): this {
    this.population.push(candidate)
    return this
  }

  /**
   * Generates a mutated candidate from a parent solution.
   */
  mutateCandidate(
    parent: CandidateSolution,
    strategy?: CodeMutationType,
    customMutators?: ReadonlyArray<(code: string) => string>,
  ): CandidateSolution {
    const { code: mutatedCode, type: actualType } = CodeMutator.mutate(
      parent.code,
      strategy,
      customMutators,
    )

    return {
      id: `cand-gen${this.currentGeneration + 1}-${Math.random().toString(36).slice(2, 8)}`,
      code: mutatedCode,
      parentId: parent.id,
      generation: this.currentGeneration + 1,
      fitnessScore: 0,
      mutationType: actualType,
      createdAt: Date.now(),
    }
  }

  /**
   * Evaluates a candidate using the supplied fitness function.
   */
  async evaluateCandidate(
    candidate: CandidateSolution,
    fitnessFn: FitnessFunction,
  ): Promise<CandidateSolution> {
    try {
      const evaluation = await fitnessFn(candidate)
      return {
        ...candidate,
        fitnessScore: evaluation.passed ? Math.max(0, evaluation.score) : 0,
        metrics: evaluation.metrics,
      }
    } catch {
      return {
        ...candidate,
        fitnessScore: 0,
        metrics: {
          executionTimeMs: Number.POSITIVE_INFINITY,
          memoryUsageBytes: Number.POSITIVE_INFINITY,
          testsPassed: 0,
          testsTotal: 1,
          invariantsSatisfied: false,
        },
      }
    }
  }

  /**
   * Selects a parent candidate via Tournament Selection.
   */
  tournamentSelect(
    pool: ReadonlyArray<CandidateSolution>,
    tournamentSize = 3,
  ): CandidateSolution {
    if (pool.length === 0) return this.baseline
    const k = Math.min(tournamentSize, pool.length)
    if (k <= 0) return this.baseline
    if (k === pool.length) {
      return pool.reduce((best, curr) => (curr.fitnessScore > best.fitnessScore ? curr : best), pool[0]!)
    }

    const available = Array.from({ length: pool.length }, (_, i) => i)
    const indices: number[] = []
    for (let i = 0; i < k; i++) {
      const pick = Math.floor(Math.random() * available.length)
      indices.push(available[pick]!)
      available.splice(pick, 1)
    }

    let bestSample = pool[indices[0]!]!
    for (let i = 1; i < indices.length; i++) {
      const contestant = pool[indices[i]!]!
      if (contestant.fitnessScore > bestSample.fitnessScore) {
        bestSample = contestant
      }
    }
    return bestSample
  }

  /**
   * Runs the evolutionary loop over multiple generations with elitism, tournament selection,
   * mutation and anti-degradation baseline fallback.
   */
  async runEvolution(
    config: EvolutionConfig,
    fitnessFn: FitnessFunction,
  ): Promise<EvolutionRunResult> {
    const populationSize = Math.max(2, config.populationSize ?? 10)
    const generations = Math.max(1, config.generations ?? 5)
    const elitismCount = Math.min(populationSize - 1, Math.max(1, config.elitismCount ?? 2))
    const tournamentSize = Math.max(2, config.tournamentSize ?? 3)
    const mutationRate = config.mutationRate ?? 0.8
    const targetFitness = config.targetFitness ?? Number.POSITIVE_INFINITY

    // 1. Evaluate baseline first to establish ground truth
    const evaluatedBaseline = await this.evaluateCandidate(this.baseline, fitnessFn)
    const baselineScore = evaluatedBaseline.fitnessScore

    // Initialize initial population by mutating baseline if population is empty or has only baseline
    const initialCandidates: CandidateSolution[] = [evaluatedBaseline]
    for (let i = 1; i < populationSize; i++) {
      const mutated = this.mutateCandidate(this.baseline, undefined, config.customMutators)
      const evaluated = await this.evaluateCandidate(mutated, fitnessFn)
      initialCandidates.push(evaluated)
    }

    this.population = initialCandidates
    const history: EvolutionGenerationStats[] = []

    // 2. Generation Iteration Loop
    for (let gen = 1; gen <= generations; gen++) {
      this.currentGeneration = gen

      // Sort current population descending by fitness
      this.population.sort((a, b) => b.fitnessScore - a.fitnessScore)

      const bestOfGen = this.population[0]!
      const totalScore = this.population.reduce((sum, c) => sum + c.fitnessScore, 0)
      const avgScore = totalScore / this.population.length

      history.push({
        generation: gen,
        bestScore: bestOfGen.fitnessScore,
        averageScore: Math.round(avgScore * 100) / 100,
        bestCandidateId: bestOfGen.id,
      })

      // Check if target fitness reached
      if (bestOfGen.fitnessScore >= targetFitness) {
        break
      }

      // If this is the last generation, do not produce new offspring
      if (gen === generations) break

      // 3. Selection & Elitism
      const nextGenPopulation: CandidateSolution[] = []

      // Keep top elite candidates verbatim
      for (let e = 0; e < elitismCount && e < this.population.length; e++) {
        nextGenPopulation.push(this.population[e]!)
      }

      // Generate remaining candidates via Tournament Selection and Mutation
      while (nextGenPopulation.length < populationSize) {
        const parent = this.tournamentSelect(this.population, tournamentSize)
        let child = parent

        if (Math.random() < mutationRate) {
          child = this.mutateCandidate(parent, undefined, config.customMutators)
        }

        const evaluatedChild = await this.evaluateCandidate(child, fitnessFn)
        nextGenPopulation.push(evaluatedChild)
      }

      this.population = nextGenPopulation
    }

    // Sort final population
    this.population.sort((a, b) => b.fitnessScore - a.fitnessScore)
    const currentBest = this.population[0]!

    // 4. Anti-Degradation Guard:
    // If no candidate achieved fitness higher than the baseline, preserve the original baseline
    const improved = currentBest.fitnessScore > baselineScore
    const finalBest = improved ? currentBest : evaluatedBaseline

    return {
      bestCandidate: finalBest,
      baselineCandidate: evaluatedBaseline,
      generationsRun: this.currentGeneration,
      finalPopulation: [...this.population],
      history,
      improved,
    }
  }
}
