import { describe, expect, test } from "bun:test"
import { AgiNetworkRuntime } from "../src/agi/runtime"

describe("AgiNetworkRuntime Central Coordinator (AGI-011)", () => {
  test("initializes and links all 10 AGI subsystems in singleton", () => {
    const runtime = AgiNetworkRuntime.instance()

    // All 10 modules instantiated
    expect(runtime.safety).toBeDefined()
    expect(runtime.gossip).toBeDefined()
    expect(runtime.pool).toBeDefined()
    expect(runtime.memory).toBeDefined()
    expect(runtime.goals).toBeDefined()
    expect(runtime.cognitiveMode).toBeDefined()
    expect(runtime.reflection).toBeDefined()
    expect(runtime.tools).toBeDefined()
    expect(runtime.sandbox).toBeDefined()
    expect(runtime.consensus).toBeDefined()

    const status = runtime.getStatus()
    expect(status.nodeId).toBe("agi-local-master")
    expect(status.health).toBe("healthy")
  })

  test("bootstrap resets runtime with custom configuration and starts active state", () => {
    const runtime = AgiNetworkRuntime.bootstrap({
      nodeId: "custom-swarm-lead",
      maxContextBudget: 150_000,
      reflectionIntervalMs: 2000,
    })

    expect(runtime.gossip.id).toBe("custom-swarm-lead")
    expect(runtime.safety.invariants.maxContextBudget).toBe(150_000)

    const status = runtime.getStatus()
    expect(status.active).toBe(true)
    expect(status.nodeId).toBe("custom-swarm-lead")
  })

  test("handles start, stop, emergency halt and resume lifecycle in one click", () => {
    const runtime = new AgiNetworkRuntime({ nodeId: "control-test-node" })

    // 1. Initial stop
    runtime.stop()
    expect(runtime.getStatus().active).toBe(false)

    // 2. Start
    runtime.start()
    expect(runtime.getStatus().active).toBe(true)
    expect(runtime.getStatus().health).toBe("healthy")

    // 3. Emergency halt (red button)
    runtime.emergencyHalt("Critical anomaly detected")
    const haltedStatus = runtime.getStatus()
    expect(haltedStatus.active).toBe(false)
    expect(haltedStatus.health).toBe("halted")
    expect(haltedStatus.haltReason).toBe("Critical anomaly detected")

    // 4. Resume
    runtime.resume()
    const resumedStatus = runtime.getStatus()
    expect(resumedStatus.active).toBe(true)
    expect(resumedStatus.health).toBe("healthy")
  })

  test("processes complete autonomous task through complexity, DAG, consensus and memory", async () => {
    const runtime = new AgiNetworkRuntime({ nodeId: "worker-node-1" })
    runtime.start()

    const initialTasks = runtime.getStatus().completedTasks

    const result = await runtime.processTask(
      "Refactor distributed consensus gossip serialization with high integrity",
      {
        metrics: {
          fileCount: 4,
          treeDepth: 2,
        },
      },
    )

    expect(result.success).toBe(true)
    expect(result.taskId).toBeDefined()
    expect(result.assessment).toBeDefined()
    expect(result.consensusResult.approved).toBe(true)
    expect(result.memoryNodeId).toBeDefined()

    // Verify stored in EpisodicKnowledgeGraph
    const memNode = runtime.memory.getNode(result.memoryNodeId!)
    expect(memNode).toBeDefined()
    expect(memNode!.tags).toContain("task-resolution")

    // Verify completed counter incremented
    expect(runtime.getStatus().completedTasks).toBe(initialTasks + 1)
  })

  test("rejects task processing when emergency halt is active", async () => {
    const runtime = new AgiNetworkRuntime({ nodeId: "halt-node" })
    runtime.emergencyHalt("Swarm safety lock active")

    const result = await runtime.processTask("Trivial task while halted")
    expect(result.success).toBe(false)
    expect(result.reason).toContain("Safety halt active")
  })

  test("escalates cognitive mode when consensus fails and rejects task", async () => {
    const runtime = new AgiNetworkRuntime({ nodeId: "consensus-fail-node" })
    runtime.start()

    // Start in reactive mode
    runtime.cognitiveMode.setMode("reactive")

    const result = await runtime.processTask("Potentially flawed proposal", {
      failConsensus: true,
    })

    expect(result.success).toBe(false)
    expect(result.reason).toContain("Consensus rejected")
    expect(result.consensusResult.falsified).toBe(true)

    // Should have escalated from reactive to deliberative
    expect(runtime.cognitiveMode.activeMode).toBe("deliberative")
  })

  describe("System Capabilities & MCP Unification (AGI-014)", () => {
    test("discovers and indexes 331 local skills from config directory", () => {
      const runtime = new AgiNetworkRuntime()
      const status = runtime.getStatus()

      expect(status.skillsCount).toBe(331)
      expect(runtime.getSkills().length).toBe(331)

      // Test skill search and query filtering
      const codeSkills = runtime.getSkills({ query: "code" })
      expect(codeSkills.length).toBeGreaterThan(0)

      const exactSkill = runtime.findSkill("clean-code")
      expect(exactSkill).toBeDefined()
      expect(exactSkill?.name).toBe("clean-code")
      expect(exactSkill?.tags).toContain("skill")
    })

    test("integrates active MCP servers and bridges their tools without duplication", async () => {
      const runtime = new AgiNetworkRuntime()
      const mcpServers = runtime.getMcpServers()

      expect(mcpServers.length).toBe(3)
      const names = mcpServers.map((s) => s.name)
      expect(names).toContain("context7")
      expect(names).toContain("memory")
      expect(names).toContain("sequential-thinking")

      // MCP tools are bridged into RuntimeToolSynthesizer
      const context7Tool = runtime.tools.getTool("context7_resolve-library-id")
      expect(context7Tool).toBeDefined()
      expect(context7Tool?.tags).toContain("mcp")
      expect(context7Tool?.tags).toContain("context7")

      const memoryTool = runtime.tools.getTool("memory_create_entities")
      expect(memoryTool).toBeDefined()

      const seqTool = runtime.tools.getTool("sequential-thinking_sequentialthinking")
      expect(seqTool).toBeDefined()

      // Execute bridged MCP tool
      const execResult = await runtime.tools.executeTool("context7_resolve-library-id", {
        libraryName: "react",
        query: "hooks",
      })
      expect(execResult.success).toBe(true)
    })

    test("bridges EpisodicKnowledgeGraph with MCP memory bidirectional format", () => {
      const runtime = new AgiNetworkRuntime()

      // Add episodic memory
      runtime.memory.addNode({
        id: "node-test-1",
        type: "success_pattern",
        context: "Optimized distributed consensus with gossip",
        tags: ["consensus", "gossip"],
        outcome: {
          status: "success",
          summary: "Latency reduced by 40%",
        },
      })
      runtime.memory.addNode({
        id: "node-test-2",
        type: "goal",
        context: "High-throughput gossip consensus",
        tags: ["goal"],
      })
      runtime.memory.addEdge({
        from: "node-test-1",
        to: "node-test-2",
        type: "refines",
        weight: 0.9,
      })

      // Export to MCP Memory
      const mcpExport = runtime.syncEpisodicWithMcpMemory()
      expect(mcpExport.entities.length).toBeGreaterThanOrEqual(2)
      const entity = mcpExport.entities.find((e) => e.name === "node-test-1")
      expect(entity).toBeDefined()
      expect(entity?.entityType).toBe("success_pattern")
      expect(entity?.observations.some((o) => o.includes("Optimized distributed consensus"))).toBe(true)

      expect(mcpExport.relations.some((r) => r.from === "node-test-1" && r.to === "node-test-2")).toBe(true)

      // Test importing back from MCP memory into a fresh graph
      const importedGraph = new AgiNetworkRuntime().memory.importFromMcpMemory(mcpExport)
      const restoredNode = importedGraph.getNode("node-test-1")
      expect(restoredNode).toBeDefined()
      expect(restoredNode?.type).toBe("success_pattern")
    })

    test("provides unified capabilities overview with oc-panel coordination link", () => {
      const runtime = new AgiNetworkRuntime()
      const overview = runtime.getUnifiedCapabilities()

      expect(overview.skillsCount).toBe(331)
      expect(overview.mcpServers.length).toBe(3)
      expect(overview.panelIntegration.enabled).toBe(true)
      expect(overview.panelIntegration.panelPluginId).toBe("oc-panel")
      expect(overview.panelIntegration.openCommand).toBe("oc-panel.open")

      const status = runtime.getStatus()
      expect(status.skillsCount).toBe(331)
      expect(status.activeMcpCount).toBe(3)
    })

    test("supports registering autonomous skills as dynamic tools", async () => {
      const runtime = new AgiNetworkRuntime()
      const skillTool = runtime.tools.registerSkillAsTool(
        "systematic-debugging",
        "Autonomous systematic debugging skill",
        async (args) => ({ status: "debugged", rootCause: "Off-by-one error", args }),
      )

      expect(skillTool.name).toBe("skill_systematic_debugging")
      expect(skillTool.tags).toContain("skill")

      const res = await runtime.tools.executeTool("skill_systematic_debugging", { file: "test.ts" })
      expect(res.success).toBe(true)
      expect((res.data as any).rootCause).toBe("Off-by-one error")
    })
  })
})
