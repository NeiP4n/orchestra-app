export interface SwarmTask<T = unknown> {
  readonly id: string
  readonly payload: T
  readonly priority?: number
  readonly sourceNodeId: string
  assignedNodeId: string
  stolenCount: number
  readonly createdAt: number
}

export interface SwarmNodeConfig {
  readonly nodeId: string
  /**
   * Relative compute power weight of the node. Default: 1.0.
   * Higher capacity nodes are expected to handle more tasks and steal more aggressively.
   */
  readonly computeCapacity?: number
  readonly maxQueueSize?: number
}

export interface NodeMetrics {
  readonly nodeId: string
  readonly queueSize: number
  readonly computeCapacity: number
  readonly localTasksExecuted: number
  readonly tasksStolenFrom: number
  readonly tasksStolenBy: number
}

export interface PoolMetrics {
  readonly totalNodes: number
  readonly totalQueuedTasks: number
  readonly totalSteals: number
  readonly totalExecuted: number
  readonly nodes: ReadonlyArray<NodeMetrics>
}

/**
 * Thread-safe / Promise-safe Double-Ended Queue implementing Chase-Lev style operations.
 * - Owner pushes and pops from the bottom (LIFO order for execution locality)
 * - Remote thieves steal from the top (FIFO order to grab the oldest/coarsest work units)
 */
export class WorkDeque<T> {
  private items: SwarmTask<T>[] = []
  private lockPromise: Promise<void> = Promise.resolve()

  constructor(public readonly nodeId: string) {}

  private async withLock<R>(fn: () => R | Promise<R>): Promise<R> {
    let unlock: () => void
    const nextLock = new Promise<void>((resolve) => {
      unlock = resolve
    })
    const prevLock = this.lockPromise
    this.lockPromise = nextLock

    await prevLock
    try {
      return await fn()
    } finally {
      unlock!()
    }
  }

  get size(): number {
    return this.items.length
  }

  async push(task: SwarmTask<T>): Promise<void> {
    await this.withLock(() => {
      this.items.push(task)
    })
  }

  /**
   * Owner pops from bottom (LIFO)
   */
  async popBottom(): Promise<SwarmTask<T> | undefined> {
    return this.withLock(() => {
      return this.items.pop()
    })
  }

  /**
   * Remote thief steals from top (FIFO)
   */
  async stealTop(): Promise<SwarmTask<T> | undefined> {
    return this.withLock(() => {
      if (this.items.length === 0) {
        return undefined
      }
      return this.items.shift()
    })
  }

  async drain(): Promise<SwarmTask<T>[]> {
    return this.withLock(() => {
      const all = [...this.items]
      this.items = []
      return all
    })
  }
}

export class SwarmWorkStealingPool<T = unknown> {
  private readonly nodes: Map<string, { config: SwarmNodeConfig; deque: WorkDeque<T> }> = new Map()
  private readonly localExecuted: Map<string, number> = new Map()
  private readonly stolenFromCount: Map<string, number> = new Map()
  private readonly stolenByCount: Map<string, number> = new Map()
  private readonly claimedTasks: Set<string> = new Set()
  private totalStealsCount = 0

  registerNode(config: SwarmNodeConfig): this {
    if (this.nodes.has(config.nodeId)) {
      throw new Error(`Node "${config.nodeId}" already registered in SwarmWorkStealingPool`)
    }

    const normalizedConfig: SwarmNodeConfig = {
      nodeId: config.nodeId,
      computeCapacity: config.computeCapacity && config.computeCapacity > 0 ? config.computeCapacity : 1.0,
      maxQueueSize: config.maxQueueSize,
    }

    this.nodes.set(config.nodeId, {
      config: normalizedConfig,
      deque: new WorkDeque<T>(config.nodeId),
    })

    this.localExecuted.set(config.nodeId, 0)
    this.stolenFromCount.set(config.nodeId, 0)
    this.stolenByCount.set(config.nodeId, 0)

    return this
  }

  unregisterNode(nodeId: string): Promise<SwarmTask<T>[]> {
    const entry = this.nodes.get(nodeId)
    if (!entry) {
      return Promise.resolve([])
    }

    this.nodes.delete(nodeId)
    this.localExecuted.delete(nodeId)
    this.stolenFromCount.delete(nodeId)
    this.stolenByCount.delete(nodeId)

    return entry.deque.drain()
  }

  hasNode(nodeId: string): boolean {
    return this.nodes.has(nodeId)
  }

  async pushTask(
    nodeId: string,
    payloadOrTask: T | SwarmTask<T>,
    options?: { id?: string; priority?: number },
  ): Promise<SwarmTask<T>> {
    const entry = this.nodes.get(nodeId)
    if (!entry) {
      throw new Error(`Node "${nodeId}" not found in SwarmWorkStealingPool`)
    }

    if (entry.config.maxQueueSize && entry.deque.size >= entry.config.maxQueueSize) {
      throw new Error(`Node "${nodeId}" queue is full (max: ${entry.config.maxQueueSize})`)
    }

    let task: SwarmTask<T>
    if (
      typeof payloadOrTask === "object" &&
      payloadOrTask !== null &&
      "id" in payloadOrTask &&
      "sourceNodeId" in payloadOrTask
    ) {
      task = payloadOrTask as SwarmTask<T>
    } else {
      task = {
        id: options?.id ?? `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        payload: payloadOrTask as T,
        priority: options?.priority ?? 0,
        sourceNodeId: nodeId,
        assignedNodeId: nodeId,
        stolenCount: 0,
        createdAt: Date.now(),
      }
    }

    await entry.deque.push(task)
    return task
  }

  /**
   * Pulls next task for execution by a node.
   * 1. Attempts local LIFO take from own deque
   * 2. If local deque empty, attempts work-stealing from remote peers
   */
  async popTask(nodeId: string): Promise<SwarmTask<T> | undefined> {
    const entry = this.nodes.get(nodeId)
    if (!entry) {
      throw new Error(`Node "${nodeId}" not found in SwarmWorkStealingPool`)
    }

    // 1. Local pop (LIFO)
    const local = await entry.deque.popBottom()
    if (local) {
      this.claimedTasks.add(local.id)
      this.localExecuted.set(nodeId, (this.localExecuted.get(nodeId) ?? 0) + 1)
      return local
    }

    // 2. Steal from remote nodes (FIFO)
    return this.steal(nodeId)
  }

  /**
   * Attempts to steal a task from a heavily loaded peer.
   * Victims are prioritized by their relative load (queueSize / computeCapacity).
   */
  async steal(thiefNodeId: string): Promise<SwarmTask<T> | undefined> {
    const thief = this.nodes.get(thiefNodeId)
    if (!thief) {
      throw new Error(`Thief node "${thiefNodeId}" not registered`)
    }

    // Identify victim candidates sorted by normalized workload descending
    const candidates = Array.from(this.nodes.entries())
      .filter(([id, e]) => id !== thiefNodeId && e.deque.size > 0)
      .map(([id, e]) => ({
        id,
        deque: e.deque,
        loadFactor: e.deque.size / (e.config.computeCapacity ?? 1.0),
      }))
      .sort((a, b) => b.loadFactor - a.loadFactor)

    for (const candidate of candidates) {
      const stolen = await candidate.deque.stealTop()
      if (stolen) {
        // Guaranteed single ownership
        if (this.claimedTasks.has(stolen.id)) {
          continue // Already claimed, advance
        }
        this.claimedTasks.add(stolen.id)

        stolen.assignedNodeId = thiefNodeId
        stolen.stolenCount++

        this.totalStealsCount++
        this.stolenByCount.set(thiefNodeId, (this.stolenByCount.get(thiefNodeId) ?? 0) + 1)
        this.stolenFromCount.set(candidate.id, (this.stolenFromCount.get(candidate.id) ?? 0) + 1)

        return stolen
      }
    }

    return undefined
  }

  getNodeMetrics(nodeId: string): NodeMetrics {
    const entry = this.nodes.get(nodeId)
    if (!entry) {
      throw new Error(`Node "${nodeId}" not found`)
    }

    return {
      nodeId,
      queueSize: entry.deque.size,
      computeCapacity: entry.config.computeCapacity ?? 1.0,
      localTasksExecuted: this.localExecuted.get(nodeId) ?? 0,
      tasksStolenFrom: this.stolenFromCount.get(nodeId) ?? 0,
      tasksStolenBy: this.stolenByCount.get(nodeId) ?? 0,
    }
  }

  getPoolMetrics(): PoolMetrics {
    const nodesMetrics = Array.from(this.nodes.keys()).map((id) => this.getNodeMetrics(id))
    const totalQueued = nodesMetrics.reduce((acc, n) => acc + n.queueSize, 0)
    const totalExecuted = Array.from(this.localExecuted.values()).reduce((acc, v) => acc + v, 0) +
      Array.from(this.stolenByCount.values()).reduce((acc, v) => acc + v, 0)

    return {
      totalNodes: this.nodes.size,
      totalQueuedTasks: totalQueued,
      totalSteals: this.totalStealsCount,
      totalExecuted,
      nodes: nodesMetrics,
    }
  }
}

export { SwarmWorkStealingPool as SwarmWorkStealingQueue }

