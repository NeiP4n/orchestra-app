export * as SafetyGovernor from "./safety-governor.js"

export type Severity = "INFO" | "WARNING" | "VIOLATION" | "CRITICAL"

export interface SafetyIncident {
  readonly id: string
  readonly timestamp: number
  readonly severity: Severity
  readonly category: string
  readonly description: string
  readonly metadata?: Record<string, unknown>
  readonly actionBlocked: boolean
}

export interface SafetyInvariantConfig {
  maxContextBudget: number
  maxExecutionDepth: number
  forbiddenPathPatterns: (string | RegExp)[]
  maxNetworkFanout: number
  dataIntegrityCheck?: (state: unknown) => boolean
}

export interface ActionContext {
  readonly actionType: string
  readonly path?: string
  readonly depth?: number
  readonly tokensRequested?: number
  readonly fanout?: number
  readonly payload?: unknown
  readonly rollbackHook?: () => void | Promise<void>
}

export interface ValidationResult {
  readonly allowed: boolean
  readonly reason?: string
  readonly incident?: SafetyIncident
}

export type Interruptible = { interrupt: () => void } | AbortController

const DEFAULT_FORBIDDEN_PATTERNS: (string | RegExp)[] = [
  /\.env(\..+)?$/i,
  /\.ssh(\/|\\)/i,
  /id_rsa/i,
  /id_ed25519/i,
  /credentials(\.json|\.ini)?$/i,
  /\/etc\/shadow/i,
  /\/etc\/passwd/i,
  /service-local\.json$/i,
]

export class SwarmSafetyGovernor {
  private _isHalted = false
  private _haltReason?: string
  readonly invariants: SafetyInvariantConfig
  private incidents: SafetyIncident[] = []
  private rollbacks: (() => void | Promise<void>)[] = []
  private activeInterruptibles: Set<Interruptible> = new Set()

  constructor(invariants: Partial<SafetyInvariantConfig> = {}) {
    this.invariants = {
      maxContextBudget: invariants.maxContextBudget ?? 200_000,
      maxExecutionDepth: invariants.maxExecutionDepth ?? 10,
      forbiddenPathPatterns: invariants.forbiddenPathPatterns ?? [...DEFAULT_FORBIDDEN_PATTERNS],
      maxNetworkFanout: invariants.maxNetworkFanout ?? 10,
      dataIntegrityCheck: invariants.dataIntegrityCheck,
    }
  }

  get isHalted(): boolean {
    return this._isHalted
  }

  get haltReason(): string | undefined {
    return this._haltReason
  }

  updateInvariants(updates: Partial<SafetyInvariantConfig>): void {
    if (updates.maxContextBudget !== undefined) this.invariants.maxContextBudget = updates.maxContextBudget
    if (updates.maxExecutionDepth !== undefined) this.invariants.maxExecutionDepth = updates.maxExecutionDepth
    if (updates.forbiddenPathPatterns !== undefined) this.invariants.forbiddenPathPatterns = updates.forbiddenPathPatterns
    if (updates.maxNetworkFanout !== undefined) this.invariants.maxNetworkFanout = updates.maxNetworkFanout
    if (updates.dataIntegrityCheck !== undefined) this.invariants.dataIntegrityCheck = updates.dataIntegrityCheck
  }

  registerRollback(hook: () => void | Promise<void>): () => void {
    this.rollbacks.push(hook)
    return () => {
      const idx = this.rollbacks.indexOf(hook)
      if (idx !== -1) {
        this.rollbacks.splice(idx, 1)
      }
    }
  }

  registerInterruptible(item: Interruptible): () => void {
    this.activeInterruptibles.add(item)
    return () => {
      this.activeInterruptibles.delete(item)
    }
  }

  logIncident(
    severity: Severity,
    category: string,
    description: string,
    metadata?: Record<string, unknown>,
    actionBlocked = false,
  ): SafetyIncident {
    const incident: SafetyIncident = {
      id: `inc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: Date.now(),
      severity,
      category,
      description,
      metadata,
      actionBlocked,
    }
    this.incidents.push(incident)
    return incident
  }

  validateAction(context: ActionContext): ValidationResult {
    if (this._isHalted) {
      const incident = this.logIncident(
        "CRITICAL",
        "emergency_halt",
        `Action '${context.actionType}' blocked: Swarm is in emergency halt state (${this._haltReason ?? "unknown"}).`,
        { actionType: context.actionType, path: context.path },
        true,
      )
      return {
        allowed: false,
        reason: `Swarm is halted: ${this._haltReason}`,
        incident,
      }
    }

    // 1. Path traversal & forbidden pattern check
    if (context.path) {
      const normalizedPath = context.path.replace(/\\/g, "/")
      for (const pattern of this.invariants.forbiddenPathPatterns) {
        const matches =
          typeof pattern === "string"
            ? normalizedPath.includes(pattern)
            : pattern.test(normalizedPath)

        if (matches) {
          const incident = this.logIncident(
            "VIOLATION",
            "forbidden_path",
            `Action '${context.actionType}' blocked: Access to forbidden path '${context.path}' matching '${String(pattern)}'.`,
            { path: context.path, pattern: String(pattern) },
            true,
          )
          return {
            allowed: false,
            reason: `Access to forbidden path: ${context.path}`,
            incident,
          }
        }
      }
    }

    // 2. Execution depth check
    if (context.depth !== undefined && context.depth > this.invariants.maxExecutionDepth) {
      const incident = this.logIncident(
        "VIOLATION",
        "recursion_depth_exceeded",
        `Action '${context.actionType}' blocked: Execution depth ${context.depth} exceeds limit ${this.invariants.maxExecutionDepth}.`,
        { depth: context.depth, limit: this.invariants.maxExecutionDepth },
        true,
      )
      return {
        allowed: false,
        reason: `Execution depth ${context.depth} exceeds limit ${this.invariants.maxExecutionDepth}`,
        incident,
      }
    }

    // 3. Token budget check
    if (context.tokensRequested !== undefined && context.tokensRequested > this.invariants.maxContextBudget) {
      const incident = this.logIncident(
        "VIOLATION",
        "context_budget_exceeded",
        `Action '${context.actionType}' blocked: Requested ${context.tokensRequested} tokens exceeds max context budget ${this.invariants.maxContextBudget}.`,
        { requested: context.tokensRequested, limit: this.invariants.maxContextBudget },
        true,
      )
      return {
        allowed: false,
        reason: `Context budget limit exceeded (${context.tokensRequested} > ${this.invariants.maxContextBudget})`,
        incident,
      }
    }

    // 4. Network fanout check
    if (context.fanout !== undefined && context.fanout > this.invariants.maxNetworkFanout) {
      const incident = this.logIncident(
        "WARNING",
        "network_fanout_exceeded",
        `Action '${context.actionType}' blocked: Network fanout ${context.fanout} exceeds limit ${this.invariants.maxNetworkFanout}.`,
        { fanout: context.fanout, limit: this.invariants.maxNetworkFanout },
        true,
      )
      return {
        allowed: false,
        reason: `Network fanout ${context.fanout} exceeds limit ${this.invariants.maxNetworkFanout}`,
        incident,
      }
    }

    // 5. Data integrity verification
    if (this.invariants.dataIntegrityCheck && context.payload !== undefined) {
      let isIntact = false
      try {
        isIntact = this.invariants.dataIntegrityCheck(context.payload)
      } catch (err) {
        isIntact = false
      }

      if (!isIntact) {
        const incident = this.logIncident(
          "CRITICAL",
          "data_integrity_violation",
          `Action '${context.actionType}' blocked: Data integrity verification failed. Initiating automatic rollback.`,
          { actionType: context.actionType },
          true,
        )
        // Automatic rollback triggered
        void this.rollbackAll()
        return {
          allowed: false,
          reason: "Data integrity verification failed: State rollback executed",
          incident,
        }
      }
    }

    // If rollback hook provided and action is approved, track it
    if (context.rollbackHook) {
      this.registerRollback(context.rollbackHook)
    }

    return { allowed: true }
  }

  async emergencyHalt(reason: string): Promise<void> {
    this._isHalted = true
    this._haltReason = reason

    this.logIncident(
      "CRITICAL",
      "kill_switch",
      `EMERGENCY HALT TRIGGERED: ${reason}. All swarm operations suspended and rollbacks initiated.`,
      { reason },
      true,
    )

    // 1. Interrupt all registered fibers / controllers
    for (const item of this.activeInterruptibles) {
      try {
        if ("abort" in item && typeof item.abort === "function") {
          item.abort()
        } else if ("interrupt" in item && typeof item.interrupt === "function") {
          item.interrupt()
        }
      } catch {
        // Continue interrupting remaining items
      }
    }
    this.activeInterruptibles.clear()

    // 2. Execute rollbacks in LIFO order
    await this.rollbackAll()
  }

  async rollbackAll(): Promise<number> {
    let executedCount = 0
    const hooks = [...this.rollbacks].reverse()
    this.rollbacks = []

    for (const hook of hooks) {
      try {
        await hook()
        executedCount++
      } catch {
        // Best effort rollback
      }
    }
    return executedCount
  }

  resume(): void {
    if (!this._isHalted) return
    this.logIncident("INFO", "system_resumed", `Swarm resumed from emergency halt (previous reason: ${this._haltReason}).`)
    this._isHalted = false
    this._haltReason = undefined
  }

  getIncidents(severityFilter?: Severity): ReadonlyArray<SafetyIncident> {
    if (!severityFilter) return [...this.incidents]
    return this.incidents.filter((i) => i.severity === severityFilter)
  }

  clearIncidents(): void {
    this.incidents = []
  }
}
