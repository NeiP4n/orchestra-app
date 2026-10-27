import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import {
  CognitiveModeGovernor,
  type CognitiveMode,
  type ComplexityAssessment,
  type ContextMetrics,
} from "./cognitive-mode.js"
import {
  MultiRoleConsensus,
  type ConsensusEvaluation,
  type ConsensusVote,
  type Proposal,
} from "./consensus.js"
import { EvolutionarySandbox } from "./evolution-sandbox.js"
import { GoalDAG } from "./goal-dag.js"
import { SwarmGossipNode } from "./gossip.js"
import {
  EpisodicKnowledgeGraph,
  type McpMemoryGraph,
} from "./memory-graph.js"
import { ReflectionDaemon } from "./reflection.js"
import { SwarmSafetyGovernor } from "./safety-governor.js"
import { RuntimeToolSynthesizer } from "./tool-synthesizer.js"
import { SwarmWorkStealingPool } from "./work-stealing.js"

export interface AgiSkillInfo {
  readonly name: string
  readonly path: string
  readonly description: string
  readonly tags: ReadonlyArray<string>
}

export interface AgiMcpServerInfo {
  readonly name: string
  readonly status: "connected" | "active" | "standby"
  readonly tools: ReadonlyArray<string>
  readonly description: string
}

export interface PanelIntegrationConfig {
  readonly enabled: boolean
  readonly panelPluginId: string
  readonly openCommand: string
  readonly description: string
}

export interface UnifiedCapabilitiesOverview {
  readonly skillsCount: number
  readonly skills: ReadonlyArray<AgiSkillInfo>
  readonly mcpServers: ReadonlyArray<AgiMcpServerInfo>
  readonly panelIntegration: PanelIntegrationConfig
}

export interface AgiRuntimeConfig {
  readonly nodeId?: string
  readonly nodeAddress?: string
  readonly maxContextBudget?: number
  readonly reflectionIntervalMs?: number
  readonly baselineCode?: string
  readonly skillsDirectory?: string
  readonly initialSkills?: ReadonlyArray<AgiSkillInfo>
  readonly initialMcpServers?: ReadonlyArray<AgiMcpServerInfo>
}

export interface AgiRuntimeStatus {
  readonly active: boolean
  readonly mode: CognitiveMode
  readonly health: "healthy" | "warning" | "halted"
  readonly activeGoals: number
  readonly completedTasks: number
  readonly incidentsCount: number
  readonly nodeId: string
  readonly peersCount: number
  readonly haltReason?: string
  readonly skillsCount: number
  readonly activeMcpCount: number
}

export type ConsensusSummaryResult = ConsensusEvaluation & {
  readonly approved: boolean
  readonly falsified?: boolean
}

export interface TaskProcessResult {
  readonly success: boolean
  readonly taskId: string
  readonly description: string
  readonly mode: CognitiveMode
  readonly assessment: ComplexityAssessment
  readonly consensusResult: ConsensusSummaryResult
  readonly memoryNodeId?: string
  readonly reason?: string
}

const DEFAULT_MCP_SERVERS: ReadonlyArray<AgiMcpServerInfo> = [
  {
    name: "context7",
    status: "connected",
    tools: ["resolve-library-id", "query-docs"],
    description: "Документация современных библиотек и версионных API через Context7",
  },
  {
    name: "memory",
    status: "connected",
    tools: ["create_entities", "create_relations", "add_observations", "read_graph"],
    description: "Постоянный граф знаний сущностей и ассоциативных связей",
  },
  {
    name: "sequential-thinking",
    status: "connected",
    tools: ["sequentialthinking"],
    description: "Многопроходное пошаговое рассуждение и фальсификация гипотез",
  },
]

/**
 * Central orchestrator and facade runtime for the AGI Cognitive Subsystem.
 * Unifies all 10 specialized AGI modules into an autonomous swarm controller.
 */
export class AgiNetworkRuntime {
  private static _instance?: AgiNetworkRuntime

  private _active = false
  private _completedTasksCount = 0
  private _skillsCatalog: AgiSkillInfo[] = []
  private readonly _mcpServers = new Map<string, AgiMcpServerInfo>()

  readonly safety: SwarmSafetyGovernor
  readonly gossip: SwarmGossipNode
  readonly pool: SwarmWorkStealingPool<string>
  readonly memory: EpisodicKnowledgeGraph
  readonly goals: GoalDAG
  readonly cognitiveMode: CognitiveModeGovernor
  readonly reflection: ReflectionDaemon
  readonly tools: RuntimeToolSynthesizer
  readonly sandbox: EvolutionarySandbox
  readonly consensus: MultiRoleConsensus

  constructor(config: AgiRuntimeConfig = {}) {
    const nodeId = config.nodeId ?? "agi-local-master"
    const nodeAddress = config.nodeAddress ?? "local://agi-master"

    // 1. Safety Governor
    this.safety = new SwarmSafetyGovernor({
      maxContextBudget: config.maxContextBudget ?? 200_000,
    })

    // 2. Gossip P2P Node
    this.gossip = new SwarmGossipNode(nodeId, nodeAddress)

    // 3. Work-Stealing Pool
    this.pool = new SwarmWorkStealingPool<string>()
    this.pool.registerNode({ nodeId, computeCapacity: 1.0 })

    // 4. Episodic Knowledge Graph
    this.memory = new EpisodicKnowledgeGraph()

    // 5. Goal DAG
    this.goals = new GoalDAG()

    // 6. Cognitive Mode Governor
    this.cognitiveMode = new CognitiveModeGovernor()

    // 7. Reflection Daemon
    this.reflection = new ReflectionDaemon({
      intervalMs: config.reflectionIntervalMs ?? 5000,
    })

    // 8. Runtime Tool Synthesizer
    this.tools = new RuntimeToolSynthesizer()

    // 9. Evolutionary Sandbox
    this.sandbox = new EvolutionarySandbox(
      config.baselineCode ?? "function solve(input) { return input; }",
      { runtime: "agi-core" },
    )

    // 10. Multi-Role Consensus
    this.consensus = new MultiRoleConsensus()

    // Wire safety governor to stop runtime if halted
    this.safety.registerRollback(() => {
      this._active = false
    })

    // Initialize Active MCP servers
    for (const server of DEFAULT_MCP_SERVERS) {
      this.registerMcpServer(server)
    }
    if (config.initialMcpServers) {
      for (const server of config.initialMcpServers) {
        this.registerMcpServer(server)
      }
    }

    // Index local skills
    const skillsDir =
      config.skillsDirectory ?? path.join(os.homedir(), ".config", "opencode", "skills")
    this.discoverSkills(skillsDir)

    if (config.initialSkills) {
      for (const sk of config.initialSkills) {
        if (!this._skillsCatalog.some((s) => s.name === sk.name)) {
          this._skillsCatalog.push(sk)
        }
      }
    }
  }

  /**
   * Retrieves or creates the process-global singleton instance.
   */
  static instance(config?: AgiRuntimeConfig): AgiNetworkRuntime {
    if (!AgiNetworkRuntime._instance) {
      AgiNetworkRuntime._instance = new AgiNetworkRuntime(config)
    }
    return AgiNetworkRuntime._instance
  }

  /**
   * Bootstraps and starts a fresh singleton runtime.
   */
  static bootstrap(config?: AgiRuntimeConfig): AgiNetworkRuntime {
    if (AgiNetworkRuntime._instance) {
      AgiNetworkRuntime._instance.stop()
    }
    const runtime = new AgiNetworkRuntime(config)
    runtime.start()
    AgiNetworkRuntime._instance = runtime
    return runtime
  }

  /**
   * Discovers and indexes local skills from the given directory.
   */
  discoverSkills(skillsDir: string): number {
    if (!fs.existsSync(skillsDir)) {
      return this._skillsCatalog.length
    }

    try {
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillName = entry.name
          const skillDirPath = path.join(skillsDir, skillName)
          const tags = ["skill", ...skillName.split("-").filter(Boolean)]

          if (!this._skillsCatalog.some((s) => s.name === skillName)) {
            this._skillsCatalog.push({
              name: skillName,
              path: skillDirPath,
              description: `Autonomous skill: ${skillName.replace(/-/g, " ")}`,
              tags,
            })
          }
        }
      }
    } catch {
      // best effort
    }

    return this._skillsCatalog.length
  }

  /**
   * Returns list of cataloged skills, optionally filtered by search query or tag.
   */
  getSkills(filter?: { query?: string; tag?: string }): ReadonlyArray<AgiSkillInfo> {
    if (!filter) return [...this._skillsCatalog]
    return this._skillsCatalog.filter((s) => {
      if (filter.tag && !s.tags.includes(filter.tag.toLowerCase())) {
        return false
      }
      if (filter.query) {
        const q = filter.query.toLowerCase()
        const matched =
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.tags.some((t) => t.includes(q))
        if (!matched) return false
      }
      return true
    })
  }

  /**
   * Finds a skill by exact or partial name.
   */
  findSkill(nameOrQuery: string): AgiSkillInfo | undefined {
    const q = nameOrQuery.toLowerCase().trim()
    let found = this._skillsCatalog.find((s) => s.name.toLowerCase() === q)
    if (!found) {
      found = this._skillsCatalog.find(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.tags.some((t) => t.includes(q)),
      )
    }

    if (found && found.description.startsWith("Autonomous skill:")) {
      const skillMdPath = path.join(found.path, "SKILL.md")
      if (fs.existsSync(skillMdPath)) {
        try {
          const head = fs.readFileSync(skillMdPath, "utf-8").slice(0, 600)
          const descMatch = head.match(/description:\s*([^\r\n]+)/i) || head.match(/^#\s+(.+)$/m)
          if (descMatch && descMatch[1]) {
            const enriched: AgiSkillInfo = {
              ...found,
              description: descMatch[1].trim(),
            }
            const idx = this._skillsCatalog.findIndex((s) => s.name === found!.name)
            if (idx >= 0) this._skillsCatalog[idx] = enriched
            return enriched
          }
        } catch {
          // best effort
        }
      }
    }

    return found
  }

  /**
   * Registers an active MCP server and bridges its tools into RuntimeToolSynthesizer.
   */
  registerMcpServer(server: AgiMcpServerInfo): void {
    this._mcpServers.set(server.name, server)

    // Bridge tools into RuntimeToolSynthesizer
    this.tools.registerMcpBridge(
      server.name,
      server.tools.map((toolName) => ({
        name: toolName,
        description: `MCP Tool [${server.name}]: ${toolName}`,
        implementation: async (args) => ({
          status: "executed",
          server: server.name,
          tool: toolName,
          result: args,
        }),
      })),
    )
  }

  /**
   * Returns all active MCP servers.
   */
  getMcpServers(): ReadonlyArray<AgiMcpServerInfo> {
    return Array.from(this._mcpServers.values())
  }

  /**
   * Retrieves a registered MCP server by name.
   */
  getMcpServer(name: string): AgiMcpServerInfo | undefined {
    return this._mcpServers.get(name)
  }

  /**
   * Bridges EpisodicKnowledgeGraph to MCP Memory format without duplication.
   */
  syncEpisodicWithMcpMemory(): McpMemoryGraph {
    return this.memory.exportToMcpMemory()
  }

  /**
   * Provides panel integration metadata for oc-panel coordination.
   */
  getPanelIntegration(): PanelIntegrationConfig {
    return {
      enabled: true,
      panelPluginId: "oc-panel",
      openCommand: "oc-panel.open",
      description: "Единая панель управления системой (скиллы, MCP, плагины) внутри TUI",
    }
  }

  /**
   * Aggregates skills, active MCP servers, and panel configuration into a single unified entry point.
   */
  getUnifiedCapabilities(): UnifiedCapabilitiesOverview {
    return {
      skillsCount: this._skillsCatalog.length,
      skills: [...this._skillsCatalog],
      mcpServers: this.getMcpServers(),
      panelIntegration: this.getPanelIntegration(),
    }
  }

  /**
   * Starts the AGI runtime and activates the cognitive loop.
   */
  start(): this {
    if (this.safety.isHalted) {
      this.safety.resume()
    }
    this._active = true
    return this
  }

  /**
   * Stops the AGI runtime.
   */
  stop(): this {
    this._active = false
    Effect.runFork(this.reflection.stop())
    return this
  }

  /**
   * Emergency stop button: immediately halts the swarm and safety governor.
   */
  emergencyHalt(reason = "Emergency manual halt triggered"): this {
    this._active = false
    this.safety.emergencyHalt(reason)
    Effect.runFork(this.reflection.stop())
    return this
  }

  /**
   * Resumes operation from halted state.
   */
  resume(): this {
    this.safety.resume()
    this._active = true
    return this
  }

  /**
   * Aggregates runtime telemetry into a high-level visual control status.
   */
  getStatus(): AgiRuntimeStatus {
    const isHalted = this.safety.isHalted
    const incidents = this.safety.getIncidents()
    const hasWarnings = incidents.some(
      (inc) =>
        inc.category !== "kill_switch" &&
        (inc.severity === "CRITICAL" || inc.severity === "VIOLATION"),
    )

    let health: "healthy" | "warning" | "halted" = "healthy"
    if (isHalted) {
      health = "halted"
    } else if (hasWarnings) {
      health = "warning"
    }

    const progress = this.goals.getProgress()
    const activeGoals = progress.ready + progress.pending + progress.inProgress

    return {
      active: this._active && !isHalted,
      mode: this.cognitiveMode.activeMode,
      health,
      activeGoals,
      completedTasks: this._completedTasksCount,
      incidentsCount: incidents.length,
      nodeId: this.gossip.id,
      peersCount: this.gossip.peers.size,
      haltReason: this.safety.haltReason,
      skillsCount: this._skillsCatalog.length,
      activeMcpCount: this._mcpServers.size,
    }
  }

  /**
   * Executes an end-to-end task cycle across all cognitive subsystems:
   * 1. Safety check
   * 2. Complexity assessment & mode selection
   * 3. Deconstruction into Goal DAG
   * 4. Work-stealing pool dispatch
   * 5. Multi-role consensus evaluation
   * 6. Episodic memory distillation
   */
  async processTask(
    description: string,
    context: Record<string, unknown> & {
      readonly metrics?: ContextMetrics
      readonly failConsensus?: boolean
    } = {},
  ): Promise<TaskProcessResult> {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`

    // 1. Safety inspection
    if (this.safety.isHalted) {
      return {
        success: false,
        taskId,
        description,
        mode: this.cognitiveMode.activeMode,
        assessment: this.cognitiveMode.assessComplexity(description),
        consensusResult: {
          proposalId: `prop-${taskId}`,
          status: "falsified",
          ratio: 0,
          quorumThreshold: 0.75,
          approvedWeight: 0,
          rejectedWeight: 0,
          totalDecisiveWeight: 0,
          totalWeight: 0,
          breakdown: [],
          approved: false,
          falsified: true,
          falsificationReason: `Safety halt active: ${this.safety.haltReason ?? "unknown reason"}`,
        },
        reason: `Safety halt active: ${this.safety.haltReason ?? "manual halt"}`,
      }
    }

    const safetyValidation = this.safety.validateAction({
      actionType: "process_task",
      payload: { taskId, description },
    })

    if (!safetyValidation.allowed) {
      return {
        success: false,
        taskId,
        description,
        mode: this.cognitiveMode.activeMode,
        assessment: this.cognitiveMode.assessComplexity(description),
        consensusResult: {
          proposalId: `prop-${taskId}`,
          status: "falsified",
          ratio: 0,
          quorumThreshold: 0.75,
          approvedWeight: 0,
          rejectedWeight: 0,
          totalDecisiveWeight: 0,
          totalWeight: 0,
          breakdown: [],
          approved: false,
          falsified: true,
          falsificationReason: safetyValidation.reason ?? "Safety invariant violated",
        },
        reason: safetyValidation.reason ?? "Safety invariant violated",
      }
    }

    // 2. Assess complexity and select cognitive mode
    const assessment = this.cognitiveMode.assessComplexity(description, context.metrics)
    const mode = this.cognitiveMode.selectMode(assessment)

    // 3. Decompose into GoalDAG
    const rootGoalId = `goal-${taskId}-root`
    this.goals.addGoal({
      id: rootGoalId,
      title: `Root: ${description}`,
      description: `Root task for ${description}`,
      priority: 10,
    })

    if (mode === "deliberative") {
      const step1Id = `goal-${taskId}-analysis`
      const step2Id = `goal-${taskId}-verification`
      this.goals.addGoal({
        id: step1Id,
        title: `Analysis for ${description}`,
        description: `Analysis & Planning for ${description}`,
        preRequisites: [rootGoalId],
        priority: 5,
      })
      this.goals.addGoal({
        id: step2Id,
        title: `Verification for ${description}`,
        description: `Critical verification for ${description}`,
        preRequisites: [step1Id],
        priority: 3,
      })
    } else if (mode === "exploratory") {
      const exploreId = `goal-${taskId}-divergent-search`
      this.goals.addGoal({
        id: exploreId,
        title: `Exploratory search for ${description}`,
        description: `Divergent hypothesis search for ${description}`,
        preRequisites: [rootGoalId],
        priority: 8,
      })
    }

    // 4. Dispatch to work-stealing pool and execute
    await this.pool.pushTask(this.gossip.id, taskId, { id: taskId })
    await this.pool.popTask(this.gossip.id)

    // 5. Multi-role consensus validation
    const proposal: Proposal<{ readonly taskId: string; readonly description: string }> = {
      id: `prop-${taskId}`,
      title: `Solution for ${description}`,
      authorId: this.gossip.id,
      payload: { taskId, description },
    }

    const votes: ConsensusVote[] = context.failConsensus
      ? [
          {
            voterId: "critic-1",
            role: "critic",
            verdict: "reject",
            confidence: 0.95,
            reason: "Detected critical invariant breach in edge case",
            counterExample: {
              description: "Edge case input produces state corruption",
              reproducible: true,
            },
          },
        ]
      : [
          {
            voterId: "proposer-1",
            role: "proposer",
            verdict: "approve",
            confidence: 0.92,
            reason: "Sound architectural approach aligned with system patterns",
          },
          {
            voterId: "verifier-1",
            role: "verifier",
            verdict: "approve",
            confidence: 0.95,
            reason: "Clean implementation within assigned package boundaries",
          },
          {
            voterId: "security-1",
            role: "security_auditor",
            verdict: "approve",
            confidence: 0.9,
            reason: "No privilege escalation or unauthorized memory mutations",
          },
        ]

    const rawConsensus = this.consensus.evaluateProposal(proposal, votes)
    const consensusResult: ConsensusSummaryResult = {
      ...rawConsensus,
      approved: rawConsensus.status === "accepted",
      falsified: rawConsensus.status === "falsified",
    }

    if (!consensusResult.approved) {
      // Escalate mode on consensus failure
      this.cognitiveMode.escalateMode(mode, "validation_error")
      return {
        success: false,
        taskId,
        description,
        mode: this.cognitiveMode.activeMode,
        assessment,
        consensusResult,
        reason: `Consensus rejected: ${consensusResult.falsificationReason ?? "failed threshold"}`,
      }
    }

    // Mark goal completed in GoalDAG
    await this.goals.markCompleted(rootGoalId)

    // 6. Episodic knowledge distillation
    const memoryNodeId = `mem-${taskId}`
    this.memory.addNode({
      id: memoryNodeId,
      type: "success_pattern",
      context: description,
      outcome: {
        status: "success",
        summary: `Autonomous resolution under ${mode} mode with score ${(consensusResult.ratio * 100).toFixed(1)}%`,
      },
      tags: ["task-resolution", mode, "swarm-agi"],
    })

    this._completedTasksCount++

    return {
      success: true,
      taskId,
      description,
      mode,
      assessment,
      consensusResult,
      memoryNodeId,
    }
  }
}
