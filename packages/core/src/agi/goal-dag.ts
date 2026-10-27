export type GoalStatus = "pending" | "ready" | "in_progress" | "completed" | "failed" | "blocked"

export type PostConditionPredicate = (context?: unknown) => boolean | Promise<boolean>
export type PostCondition = string | PostConditionPredicate

export interface GoalDefinition {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly preRequisites?: ReadonlyArray<string>
  readonly postConditions?: ReadonlyArray<PostCondition>
  readonly priority?: number
  readonly metadata?: Record<string, unknown>
}

export interface GoalNode extends GoalDefinition {
  status: GoalStatus
  evidence?: unknown
  failureReason?: string
  startedAt?: number
  completedAt?: number
}

export interface GoalDAGProgress {
  readonly total: number
  readonly completed: number
  readonly failed: number
  readonly inProgress: number
  readonly ready: number
  readonly pending: number
  readonly blocked: number
  readonly percentage: number
  readonly isComplete: boolean
  readonly hasFailures: boolean
}

export class CyclicDependencyError extends Error {
  readonly cycle: ReadonlyArray<string>
  constructor(cycle: ReadonlyArray<string>) {
    super(`Cyclic dependency detected in GoalDAG: ${cycle.join(" -> ")}`)
    this.name = "CyclicDependencyError"
    this.cycle = cycle
  }
}

export class GoalNotFoundError extends Error {
  constructor(public readonly goalId: string) {
    super(`Goal not found: ${goalId}`)
    this.name = "GoalNotFoundError"
  }
}

export class PostConditionFailedError extends Error {
  constructor(
    public readonly goalId: string,
    public readonly condition: string,
  ) {
    super(`Postcondition failed for goal "${goalId}": ${condition}`)
    this.name = "PostConditionFailedError"
  }
}

export class GoalDAG {
  private readonly nodes: Map<string, GoalNode> = new Map()
  private readonly dependents: Map<string, Set<string>> = new Map()

  addGoal(definition: GoalDefinition): this {
    if (this.nodes.has(definition.id)) {
      throw new Error(`Goal with ID "${definition.id}" already exists in the DAG`)
    }

    const preReqs = definition.preRequisites ?? []

    const node: GoalNode = {
      ...definition,
      preRequisites: preReqs,
      priority: definition.priority ?? 0,
      status: preReqs.length === 0 ? "ready" : "pending",
    }

    this.nodes.set(definition.id, node)

    // Register dependencies
    for (const pre of preReqs) {
      let set = this.dependents.get(pre)
      if (!set) {
        set = new Set()
        this.dependents.set(pre, set)
      }
      set.add(definition.id)
    }

    return this
  }

  getGoal(id: string): GoalNode | undefined {
    return this.nodes.get(id)
  }

  hasGoal(id: string): boolean {
    return this.nodes.has(id)
  }

  getAllGoals(): ReadonlyArray<GoalNode> {
    return Array.from(this.nodes.values())
  }

  topologicalSort(): ReadonlyArray<string> {
    const inDegree = new Map<string, number>()
    const adjList = new Map<string, string[]>()

    for (const [id] of this.nodes) {
      inDegree.set(id, 0)
      adjList.set(id, [])
    }

    for (const [id, node] of this.nodes) {
      const preReqs = node.preRequisites ?? []
      for (const pre of preReqs) {
        if (!this.nodes.has(pre)) {
          throw new GoalNotFoundError(pre)
        }
        adjList.get(pre)?.push(id)
        inDegree.set(id, (inDegree.get(id) ?? 0) + 1)
      }
    }

    // Kahn's algorithm
    const queue: string[] = []
    for (const [id, deg] of inDegree) {
      if (deg === 0) {
        queue.push(id)
      }
    }

    // Sort queue by priority descending initially
    queue.sort((a, b) => (this.nodes.get(b)?.priority ?? 0) - (this.nodes.get(a)?.priority ?? 0))

    const order: string[] = []

    while (queue.length > 0) {
      const current = queue.shift()!
      order.push(current)

      const neighbors = adjList.get(current) ?? []
      for (const neighbor of neighbors) {
        const newDeg = (inDegree.get(neighbor) ?? 0) - 1
        inDegree.set(neighbor, newDeg)
        if (newDeg === 0) {
          queue.push(neighbor)
          queue.sort((a, b) => (this.nodes.get(b)?.priority ?? 0) - (this.nodes.get(a)?.priority ?? 0))
        }
      }
    }

    if (order.length !== this.nodes.size) {
      const cycleNodes = this.findCycleNodes()
      throw new CyclicDependencyError(cycleNodes)
    }

    return order
  }

  private findCycleNodes(): string[] {
    const visited = new Map<string, number>() // 0: unvisited, 1: visiting, 2: visited
    const parent = new Map<string, string>()
    const cycle: string[] = []

    for (const [id] of this.nodes) {
      visited.set(id, 0)
    }

    const dfs = (u: string): boolean => {
      visited.set(u, 1)

      const node = this.nodes.get(u)
      const preReqs = node?.preRequisites ?? []

      for (const v of preReqs) {
        if (!this.nodes.has(v)) continue

        if (visited.get(v) === 1) {
          // Cycle found! Reconstruct
          cycle.push(v)
          let curr = u
          while (curr && curr !== v) {
            cycle.push(curr)
            curr = parent.get(curr) ?? ""
          }
          cycle.push(v)
          cycle.reverse()
          return true
        }

        if (visited.get(v) === 0) {
          parent.set(v, u)
          if (dfs(v)) return true
        }
      }

      visited.set(u, 2)
      return false
    }

    for (const [id] of this.nodes) {
      if (visited.get(id) === 0) {
        if (dfs(id)) return cycle
      }
    }

    return Array.from(this.nodes.keys())
  }

  validateAcyclic(): void {
    this.topologicalSort()
  }

  getReadyGoals(): ReadonlyArray<GoalNode> {
    const ready: GoalNode[] = []

    for (const node of this.nodes.values()) {
      if (node.status !== "pending" && node.status !== "ready") {
        continue
      }

      const preReqs = node.preRequisites ?? []
      const allPreReqsSatisfied = preReqs.every((preId) => {
        const preNode = this.nodes.get(preId)
        return preNode?.status === "completed"
      })

      if (allPreReqsSatisfied) {
        node.status = "ready"
        ready.push(node)
      }
    }

    // Sort ready goals by priority descending
    return ready.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  }

  markStarted(id: string): GoalNode {
    const node = this.nodes.get(id)
    if (!node) {
      throw new GoalNotFoundError(id)
    }

    node.status = "in_progress"
    node.startedAt = Date.now()
    return node
  }

  async markCompleted(id: string, evidence?: unknown): Promise<GoalNode> {
    const node = this.nodes.get(id)
    if (!node) {
      throw new GoalNotFoundError(id)
    }

    // Verify postConditions
    if (node.postConditions && node.postConditions.length > 0) {
      for (const cond of node.postConditions) {
        if (typeof cond === "function") {
          const result = await cond(evidence)
          if (!result) {
            throw new PostConditionFailedError(id, cond.name || "predicate returned false")
          }
        } else if (typeof cond === "string") {
          // If evidence is an object or array, check if string condition is present
          if (evidence && typeof evidence === "object") {
            const hasProperty = cond in (evidence as Record<string, unknown>)
            const hasArrayItem = Array.isArray(evidence) && evidence.includes(cond)
            if (!hasProperty && !hasArrayItem && (evidence as Record<string, unknown>)[cond] !== true) {
              throw new PostConditionFailedError(id, cond)
            }
          }
        }
      }
    }

    node.status = "completed"
    node.evidence = evidence
    node.completedAt = Date.now()

    // Update status of dependent goals whose prerequisites are now satisfied
    const dependents = this.dependents.get(id)
    if (dependents) {
      for (const depId of dependents) {
        const depNode = this.nodes.get(depId)
        if (depNode && depNode.status === "pending") {
          const preReqs = depNode.preRequisites ?? []
          const allSatisfied = preReqs.every((p) => this.nodes.get(p)?.status === "completed")
          if (allSatisfied) {
            depNode.status = "ready"
          }
        }
      }
    }

    return node
  }

  markFailed(id: string, reason: string): GoalNode {
    const node = this.nodes.get(id)
    if (!node) {
      throw new GoalNotFoundError(id)
    }

    node.status = "failed"
    node.failureReason = reason

    // Cascade "blocked" status to all downstream dependents
    this.cascadeBlocked(id)

    return node
  }

  private cascadeBlocked(failedId: string): void {
    const queue = [failedId]
    const visited = new Set<string>()

    while (queue.length > 0) {
      const current = queue.shift()!
      if (visited.has(current)) continue
      visited.add(current)

      const dependents = this.dependents.get(current)
      if (dependents) {
        for (const depId of dependents) {
          const depNode = this.nodes.get(depId)
          if (depNode && (depNode.status === "pending" || depNode.status === "ready")) {
            depNode.status = "blocked"
            depNode.failureReason = `Prerequisite "${current}" failed or blocked`
            queue.push(depId)
          }
        }
      }
    }
  }

  getProgress(): GoalDAGProgress {
    let completed = 0
    let failed = 0
    let inProgress = 0
    let ready = 0
    let pending = 0
    let blocked = 0

    for (const node of this.nodes.values()) {
      switch (node.status) {
        case "completed":
          completed++
          break
        case "failed":
          failed++
          break
        case "in_progress":
          inProgress++
          break
        case "ready":
          ready++
          break
        case "pending":
          pending++
          break
        case "blocked":
          blocked++
          break
      }
    }

    const total = this.nodes.size
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 100

    return {
      total,
      completed,
      failed,
      inProgress,
      ready,
      pending,
      blocked,
      percentage,
      isComplete: completed === total && total > 0,
      hasFailures: failed > 0 || blocked > 0,
    }
  }

  reset(): void {
    for (const node of this.nodes.values()) {
      const preReqs = node.preRequisites ?? []
      node.status = preReqs.length === 0 ? "ready" : "pending"
      node.evidence = undefined
      node.failureReason = undefined
      node.startedAt = undefined
      node.completedAt = undefined
    }
  }
}
