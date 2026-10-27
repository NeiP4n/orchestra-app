import { describe, expect, test } from "bun:test"
import { SwarmWorkStealingPool, WorkDeque } from "../src/agi/work-stealing"

describe("SwarmWorkStealingPool (AGI-007)", () => {
  test("WorkDeque follows LIFO for owner pop and FIFO for thief steal", async () => {
    const deque = new WorkDeque<string>("node-1")

    await deque.push({
      id: "t1",
      payload: "task-1",
      sourceNodeId: "node-1",
      assignedNodeId: "node-1",
      stolenCount: 0,
      createdAt: 100,
    })
    await deque.push({
      id: "t2",
      payload: "task-2",
      sourceNodeId: "node-1",
      assignedNodeId: "node-1",
      stolenCount: 0,
      createdAt: 200,
    })
    await deque.push({
      id: "t3",
      payload: "task-3",
      sourceNodeId: "node-1",
      assignedNodeId: "node-1",
      stolenCount: 0,
      createdAt: 300,
    })

    // Thief steals from top (oldest FIFO: t1)
    const stolen = await deque.stealTop()
    expect(stolen?.id).toBe("t1")

    // Owner pops from bottom (newest LIFO: t3)
    const local = await deque.popBottom()
    expect(local?.id).toBe("t3")

    // Remaining is t2
    expect(deque.size).toBe(1)
    const last = await deque.popBottom()
    expect(last?.id).toBe("t2")
    expect(deque.size).toBe(0)
  })

  test("simulates 4 nodes with uneven load and balances via work-stealing", async () => {
    const pool = new SwarmWorkStealingPool<{ jobName: string }>()

    pool
      .registerNode({ nodeId: "worker-0", computeCapacity: 1.0 })
      .registerNode({ nodeId: "worker-1", computeCapacity: 1.0 })
      .registerNode({ nodeId: "worker-2", computeCapacity: 2.0 }) // High capacity
      .registerNode({ nodeId: "worker-3", computeCapacity: 0.5 }) // Low capacity

    // Enqueue 20 tasks exclusively onto worker-0
    for (let i = 0; i < 20; i++) {
      await pool.pushTask("worker-0", { jobName: `job-${i}` }, { id: `task-${i}` })
    }

    expect(pool.getNodeMetrics("worker-0").queueSize).toBe(20)
    expect(pool.getNodeMetrics("worker-1").queueSize).toBe(0)

    // Worker-1 (idle) steals from worker-0
    const stolenTask1 = await pool.popTask("worker-1")
    expect(stolenTask1).toBeDefined()
    expect(stolenTask1?.assignedNodeId).toBe("worker-1")
    expect(stolenTask1?.sourceNodeId).toBe("worker-0")
    expect(stolenTask1?.stolenCount).toBe(1)

    // Worker-2 (idle, high computeCapacity) also steals
    const stolenTask2 = await pool.popTask("worker-2")
    expect(stolenTask2).toBeDefined()
    expect(stolenTask2?.assignedNodeId).toBe("worker-2")
    expect(stolenTask2?.id).not.toBe(stolenTask1?.id)

    // Worker-0 processes a local task (LIFO: newest)
    const localTask = await pool.popTask("worker-0")
    expect(localTask?.id).toBe("task-19")
    expect(localTask?.assignedNodeId).toBe("worker-0")
    expect(localTask?.stolenCount).toBe(0)

    const poolMetrics = pool.getPoolMetrics()
    expect(poolMetrics.totalSteals).toBe(2)
    expect(poolMetrics.totalExecuted).toBe(3)
  })

  test("guarantees zero duplicate execution under concurrent stealing", async () => {
    const pool = new SwarmWorkStealingPool<number>()

    pool
      .registerNode({ nodeId: "node-heavy" })
      .registerNode({ nodeId: "node-thief-A" })
      .registerNode({ nodeId: "node-thief-B" })
      .registerNode({ nodeId: "node-thief-C" })

    const totalTasks = 30
    for (let i = 0; i < totalTasks; i++) {
      await pool.pushTask("node-heavy", i, { id: `concurrent-task-${i}` })
    }

    const executedIds: string[] = []

    // Concurrently drain all tasks across all 4 workers
    const workers = ["node-heavy", "node-thief-A", "node-thief-B", "node-thief-C"]

    const drainWorker = async (wId: string) => {
      while (true) {
        const task = await pool.popTask(wId)
        if (!task) break
        executedIds.push(task.id)
      }
    }

    await Promise.all(workers.map((w) => drainWorker(w)))

    // Assert: Every task executed exactly once
    expect(executedIds.length).toBe(totalTasks)
    const uniqueIds = new Set(executedIds)
    expect(uniqueIds.size).toBe(totalTasks)

    const metrics = pool.getPoolMetrics()
    expect(metrics.totalQueuedTasks).toBe(0)
    expect(metrics.totalSteals).toBeGreaterThan(0)
  })

  test("prioritizes victim node with highest loadFactor (queue / capacity)", async () => {
    const pool = new SwarmWorkStealingPool<string>()

    pool
      .registerNode({ nodeId: "node-a", computeCapacity: 1.0 })
      .registerNode({ nodeId: "node-b", computeCapacity: 10.0 }) // High capacity, 5 tasks -> load 0.5
      .registerNode({ nodeId: "thief", computeCapacity: 1.0 })

    // Node A gets 3 tasks with capacity 1.0 -> loadFactor 3.0
    await pool.pushTask("node-a", "a-1")
    await pool.pushTask("node-a", "a-2")
    await pool.pushTask("node-a", "a-3")

    // Node B gets 4 tasks with capacity 10.0 -> loadFactor 0.4
    await pool.pushTask("node-b", "b-1")
    await pool.pushTask("node-b", "b-2")
    await pool.pushTask("node-b", "b-3")
    await pool.pushTask("node-b", "b-4")

    // Thief should steal from Node A because its loadFactor (3.0) is much higher than Node B (0.4)
    const stolen = await pool.popTask("thief")
    expect(stolen?.sourceNodeId).toBe("node-a")
  })
})
