import { describe, expect, test } from "bun:test"
import {
  CyclicDependencyError,
  GoalDAG,
  GoalNotFoundError,
  PostConditionFailedError,
} from "../src/agi/goal-dag"

describe("GoalDAG Hierarchical Planner (AGI-002)", () => {
  test("computes correct topological sort order respecting prerequisites and priorities", () => {
    const dag = new GoalDAG()

    dag
      .addGoal({
        id: "goal-deploy",
        title: "Deploy system to production",
        preRequisites: ["goal-build", "goal-e2e"],
        priority: 10,
      })
      .addGoal({
        id: "goal-build",
        title: "Compile and bundle monorepo",
        preRequisites: ["goal-lint", "goal-typecheck"],
        priority: 20,
      })
      .addGoal({
        id: "goal-lint",
        title: "Run static linter",
        priority: 5,
      })
      .addGoal({
        id: "goal-typecheck",
        title: "Run TypeScript typecheck",
        priority: 15,
      })
      .addGoal({
        id: "goal-e2e",
        title: "Run Playwright E2E suite",
        preRequisites: ["goal-build"],
        priority: 10,
      })

    const order = dag.topologicalSort()

    // Prerequisites must strictly precede dependents
    expect(order.indexOf("goal-lint")).toBeLessThan(order.indexOf("goal-build"))
    expect(order.indexOf("goal-typecheck")).toBeLessThan(order.indexOf("goal-build"))
    expect(order.indexOf("goal-build")).toBeLessThan(order.indexOf("goal-deploy"))
    expect(order.indexOf("goal-e2e")).toBeLessThan(order.indexOf("goal-deploy"))

    // Typecheck had higher priority than lint among roots
    expect(order.indexOf("goal-typecheck")).toBeLessThan(order.indexOf("goal-lint"))
  })

  test("detects cyclic dependencies and throws CyclicDependencyError", () => {
    const dag = new GoalDAG()

    dag
      .addGoal({
        id: "task-A",
        title: "Task A",
        preRequisites: ["task-C"],
      })
      .addGoal({
        id: "task-B",
        title: "Task B",
        preRequisites: ["task-A"],
      })
      .addGoal({
        id: "task-C",
        title: "Task C",
        preRequisites: ["task-B"],
      })

    expect(() => dag.topologicalSort()).toThrow(CyclicDependencyError)

    try {
      dag.validateAcyclic()
      expect(true).toBeFalse() // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(CyclicDependencyError)
      const cycleError = err as CyclicDependencyError
      expect(cycleError.cycle.length).toBeGreaterThan(1)
    }
  })

  test("returns ready goals and unlocks downstream tasks as prerequisites complete", async () => {
    const dag = new GoalDAG()

    dag
      .addGoal({
        id: "init-db",
        title: "Initialize database schema",
        priority: 100,
      })
      .addGoal({
        id: "seed-cache",
        title: "Seed Redis cache",
        priority: 50,
      })
      .addGoal({
        id: "start-server",
        title: "Start HTTP API server",
        preRequisites: ["init-db", "seed-cache"],
        priority: 80,
      })

    // Initially both root tasks are ready, sorted by priority
    const initialReady = dag.getReadyGoals()
    expect(initialReady.map((g) => g.id)).toEqual(["init-db", "seed-cache"])

    // Completing init-db is not enough for start-server
    dag.markStarted("init-db")
    await dag.markCompleted("init-db", { tablesCreated: 12 })

    const midReady = dag.getReadyGoals()
    expect(midReady.map((g) => g.id)).toEqual(["seed-cache"])

    // Completing seed-cache unlocks start-server
    dag.markStarted("seed-cache")
    await dag.markCompleted("seed-cache", { keysLoaded: 500 })

    const finalReady = dag.getReadyGoals()
    expect(finalReady.map((g) => g.id)).toEqual(["start-server"])
  })

  test("cascades blocked status when prerequisite fails", async () => {
    const dag = new GoalDAG()

    dag
      .addGoal({
        id: "fetch-data",
        title: "Fetch remote dataset",
      })
      .addGoal({
        id: "process-data",
        title: "Process fetched data",
        preRequisites: ["fetch-data"],
      })
      .addGoal({
        id: "export-report",
        title: "Export final report",
        preRequisites: ["process-data"],
      })

    dag.markFailed("fetch-data", "Network timeout 504 Gateway")

    expect(dag.getGoal("fetch-data")?.status).toBe("failed")
    expect(dag.getGoal("process-data")?.status).toBe("blocked")
    expect(dag.getGoal("export-report")?.status).toBe("blocked")

    const progress = dag.getProgress()
    expect(progress.failed).toBe(1)
    expect(progress.blocked).toBe(2)
    expect(progress.hasFailures).toBeTrue()
    expect(progress.isComplete).toBeFalse()
  })

  test("validates postconditions on completion", async () => {
    const dag = new GoalDAG()

    dag.addGoal({
      id: "compile-binary",
      title: "Compile target binary",
      postConditions: [
        "binaryCreated",
        async (ctx: any) => ctx?.sizeBytes > 1024,
      ],
    })

    // Fails predicate if sizeBytes is too small
    await expect(
      dag.markCompleted("compile-binary", { binaryCreated: true, sizeBytes: 500 }),
    ).rejects.toThrow(PostConditionFailedError)

    // Fails property if binaryCreated is missing
    await expect(
      dag.markCompleted("compile-binary", { sizeBytes: 2048 }),
    ).rejects.toThrow(PostConditionFailedError)

    // Passes when all postconditions are met
    const completedNode = await dag.markCompleted("compile-binary", {
      binaryCreated: true,
      sizeBytes: 4096,
    })

    expect(completedNode.status).toBe("completed")
    expect(dag.getProgress().percentage).toBe(100)
    expect(dag.getProgress().isComplete).toBeTrue()
  })

  test("throws GoalNotFoundError when referencing missing goal IDs", () => {
    const dag = new GoalDAG()

    dag.addGoal({
      id: "orphan-task",
      title: "Orphan",
      preRequisites: ["non-existent-parent"],
    })

    expect(() => dag.topologicalSort()).toThrow(GoalNotFoundError)
    expect(() => dag.markStarted("unknown-goal")).toThrow(GoalNotFoundError)
  })
})
