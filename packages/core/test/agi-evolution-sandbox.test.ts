import { describe, expect, test } from "bun:test"
import {
  CodeMutator,
  EvolutionarySandbox,
  type CandidateSolution,
  type FitnessEvaluationResult,
  type FitnessFunction,
} from "../src/agi/evolution-sandbox"

describe("EvolutionarySandbox Algorithmic Mutation & Selection (AGI-009)", () => {
  test("1. CodeMutator applies various mutation strategies including constants and custom mutators", () => {
    const originalCode = `
      function computeThreshold(size) {
        const threshold = 100
        if (size > threshold) return true
        return false
      }
    `

    // Numeric tweak
    const numericMutated = CodeMutator.mutate(originalCode, "numeric_tweak")
    expect(numericMutated.type).toBe("numeric_tweak")
    expect(numericMutated.code).toBeDefined()

    // Branch swap
    const branchMutated = CodeMutator.mutate(originalCode, "branch_swap")
    expect(branchMutated.type).toBe("branch_swap")

    // Custom mutator
    const customMutator = (code: string) => code.replace("computeThreshold", "fastComputeThreshold")
    const customResult = CodeMutator.mutate(originalCode, undefined, [customMutator])
    expect(customResult.code).toBeDefined()
  })

  test("2. Evaluates candidate fitness and gracefully catches evaluation errors", async () => {
    const sandbox = new EvolutionarySandbox("const x = 42")
    const baseline = sandbox.getBaseline()

    const successFitnessFn: FitnessFunction = (candidate: CandidateSolution): FitnessEvaluationResult => {
      const isFortyTwo = candidate.code.includes("42")
      return {
        score: isFortyTwo ? 95 : 20,
        passed: true,
        metrics: {
          executionTimeMs: 1.5,
          memoryUsageBytes: 1024,
          testsPassed: isFortyTwo ? 10 : 2,
          testsTotal: 10,
          invariantsSatisfied: true,
        },
      }
    }

    const evaluated = await sandbox.evaluateCandidate(baseline, successFitnessFn)
    expect(evaluated.fitnessScore).toBe(95)
    expect(evaluated.metrics?.testsPassed).toBe(10)
    expect(evaluated.metrics?.invariantsSatisfied).toBe(true)

    // Faulty fitness function throwing defect
    const faultyFitnessFn: FitnessFunction = () => {
      throw new Error("Evaluation sandbox panic")
    }

    const failedCandidate = await sandbox.evaluateCandidate(baseline, faultyFitnessFn)
    expect(failedCandidate.fitnessScore).toBe(0)
    expect(failedCandidate.metrics?.invariantsSatisfied).toBe(false)
  })

  test("3. Performs tournament selection prioritizing higher-fitness candidates", () => {
    const sandbox = new EvolutionarySandbox("const base = 0")

    const candidates: CandidateSolution[] = [
      { id: "c1", code: "1", generation: 1, fitnessScore: 10, createdAt: 1 },
      { id: "c2", code: "2", generation: 1, fitnessScore: 50, createdAt: 1 },
      { id: "c3", code: "3", generation: 1, fitnessScore: 90, createdAt: 1 },
      { id: "c4", code: "4", generation: 1, fitnessScore: 20, createdAt: 1 },
    ]

    // Tournament with all candidates should always pick the absolute best (c3)
    const winner = sandbox.tournamentSelect(candidates, 4)
    expect(winner.id).toBe("c3")
    expect(winner.fitnessScore).toBe(90)
  })

  test("4. Runs multi-generation evolutionary loop with elitism and fitness improvement", async () => {
    // Optimization goal: find optimal buffer size closest to 8192
    const baseCode = "const bufferSize = 1024"
    const sandbox = new EvolutionarySandbox(baseCode)

    const fitnessFn: FitnessFunction = (candidate: CandidateSolution): FitnessEvaluationResult => {
      const match = candidate.code.match(/bufferSize\s*=\s*(\d+)/)
      const bufferSize = match ? parseInt(match[1]!, 10) : 1024

      // Closer to 8192 yields higher score, up to 100
      const distance = Math.abs(bufferSize - 8192)
      const score = Math.max(0, 100 - distance / 100)

      return {
        score,
        passed: true,
        metrics: {
          executionTimeMs: 2.0,
          memoryUsageBytes: bufferSize,
          testsPassed: 5,
          testsTotal: 5,
          invariantsSatisfied: true,
        },
      }
    }

    const customMutators = [
      (code: string) => code.replace(/bufferSize\s*=\s*\d+/, "bufferSize = 4096"),
      (code: string) => code.replace(/bufferSize\s*=\s*\d+/, "bufferSize = 8192"),
      (code: string) => code.replace(/bufferSize\s*=\s*\d+/, "bufferSize = 2048"),
    ]

    const result = await sandbox.runEvolution(
      {
        populationSize: 6,
        generations: 4,
        elitismCount: 2,
        mutationRate: 0.9,
        customMutators,
      },
      fitnessFn,
    )

    expect(result.generationsRun).toBeGreaterThanOrEqual(1)
    expect(result.finalPopulation.length).toBe(6)
    expect(result.history.length).toBeGreaterThanOrEqual(1)

    // The evolution should discover an improved solution
    expect(result.bestCandidate.fitnessScore).toBeGreaterThanOrEqual(result.baselineCandidate.fitnessScore)
    expect(result.improved).toBe(true)
  })

  test("5. Enforces anti-degradation protection: preserves baseline when all mutants degrade", async () => {
    const solidBaselineCode = "function optimal() { return 100 }"
    const sandbox = new EvolutionarySandbox(solidBaselineCode)

    // Baseline has score 80; every mutant is sabotaged with score 10
    const adversarialFitnessFn: FitnessFunction = (
      candidate: CandidateSolution,
    ): FitnessEvaluationResult => {
      const isBaseline = candidate.code === solidBaselineCode
      return {
        score: isBaseline ? 80 : 10,
        passed: true,
        metrics: {
          executionTimeMs: isBaseline ? 1.0 : 50.0,
          memoryUsageBytes: 256,
          testsPassed: isBaseline ? 10 : 1,
          testsTotal: 10,
          invariantsSatisfied: isBaseline,
        },
      }
    }

    const result = await sandbox.runEvolution(
      {
        populationSize: 5,
        generations: 3,
        elitismCount: 1,
        mutationRate: 1.0,
      },
      adversarialFitnessFn,
    )

    // Anti-degradation guard must guarantee baseline is returned as bestCandidate
    expect(result.improved).toBe(false)
    expect(result.bestCandidate.code).toBe(solidBaselineCode)
    expect(result.bestCandidate.fitnessScore).toBe(80)
  })
})
