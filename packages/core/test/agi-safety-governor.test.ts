import { describe, expect, test } from "bun:test"
import {
  type ActionContext,
  SwarmSafetyGovernor,
} from "../src/agi/safety-governor.js"

describe("SwarmSafetyGovernor Security & Invariant Enforcement", () => {
  test("blocks access to forbidden paths and secret credentials", () => {
    const governor = new SwarmSafetyGovernor()

    const forbiddenActions: ActionContext[] = [
      { actionType: "read_file", path: "/workspace/.env" },
      { actionType: "read_file", path: "C:\\Users\\Isako\\.ssh\\id_rsa" },
      { actionType: "write_file", path: "/app/config/credentials.json" },
      { actionType: "read_file", path: "/etc/shadow" },
      { actionType: "read_file", path: "~/.config/opencode/service-local.json" },
    ]

    for (const action of forbiddenActions) {
      const result = governor.validateAction(action)
      expect(result.allowed).toBe(false)
      expect(result.incident).toBeDefined()
      expect(result.incident?.severity).toBe("VIOLATION")
      expect(result.incident?.actionBlocked).toBe(true)
    }

    const safeAction: ActionContext = {
      actionType: "read_file",
      path: "packages/core/src/index.ts",
    }
    expect(governor.validateAction(safeAction).allowed).toBe(true)
  })

  test("enforces execution depth, token budget and network fanout limits", () => {
    const governor = new SwarmSafetyGovernor({
      maxExecutionDepth: 5,
      maxContextBudget: 100_000,
      maxNetworkFanout: 4,
    })

    // Depth limit
    const deepAction: ActionContext = { actionType: "subtask_spawn", depth: 8 }
    const deepResult = governor.validateAction(deepAction)
    expect(deepResult.allowed).toBe(false)
    expect(deepResult.reason).toContain("Execution depth 8 exceeds limit 5")

    const shallowAction: ActionContext = { actionType: "subtask_spawn", depth: 3 }
    expect(governor.validateAction(shallowAction).allowed).toBe(true)

    // Token budget limit
    const hugePromptAction: ActionContext = { actionType: "llm_query", tokensRequested: 150_000 }
    const promptResult = governor.validateAction(hugePromptAction)
    expect(promptResult.allowed).toBe(false)
    expect(promptResult.reason).toContain("Context budget limit exceeded")

    const normalPromptAction: ActionContext = { actionType: "llm_query", tokensRequested: 50_000 }
    expect(governor.validateAction(normalPromptAction).allowed).toBe(true)

    // Fanout limit
    const broadCastAction: ActionContext = { actionType: "gossip_broadcast", fanout: 10 }
    const fanoutResult = governor.validateAction(broadCastAction)
    expect(fanoutResult.allowed).toBe(false)
    expect(fanoutResult.incident?.severity).toBe("WARNING")
  })

  test("triggers data integrity check and automatic state rollback", async () => {
    let state = { count: 10, valid: true }
    const governor = new SwarmSafetyGovernor({
      dataIntegrityCheck: (payload: unknown) => {
        const item = payload as { valid: boolean }
        return Boolean(item?.valid)
      },
    })

    // Register a mutation with rollback hook
    governor.validateAction({
      actionType: "mutate_state",
      payload: { valid: true },
      rollbackHook: () => {
        state = { count: 10, valid: true }
      },
    })

    state.count = 20

    // Next action violates integrity
    const badAction: ActionContext = {
      actionType: "corrupt_mutate",
      payload: { valid: false },
    }

    const result = governor.validateAction(badAction)
    expect(result.allowed).toBe(false)
    expect(result.incident?.severity).toBe("CRITICAL")
    expect(result.incident?.category).toBe("data_integrity_violation")

    // State should have rolled back
    expect(state.count).toBe(10)
  })

  test("executes emergency halt kill-switch, interrupts fibers and blocks subsequent actions", async () => {
    const governor = new SwarmSafetyGovernor()

    let fiberAborted = false
    const controller = new AbortController()
    controller.signal.addEventListener("abort", () => {
      fiberAborted = true
    })

    governor.registerInterruptible(controller)

    let rolledBackA = false
    let rolledBackB = false
    governor.registerRollback(() => {
      rolledBackA = true
    })
    governor.registerRollback(() => {
      rolledBackB = true
    })

    expect(governor.isHalted).toBe(false)

    // Trigger emergency halt
    await governor.emergencyHalt("Critical anomaly detected")

    expect(governor.isHalted).toBe(true)
    expect(governor.haltReason).toBe("Critical anomaly detected")
    expect(fiberAborted).toBe(true)
    expect(rolledBackA).toBe(true)
    expect(rolledBackB).toBe(true)

    // Any subsequent action is strictly rejected
    const testAction: ActionContext = { actionType: "read_file", path: "src/file.ts" }
    const blockedResult = governor.validateAction(testAction)
    expect(blockedResult.allowed).toBe(false)
    expect(blockedResult.reason).toContain("Swarm is halted")
    expect(blockedResult.incident?.severity).toBe("CRITICAL")

    // Resume system
    governor.resume()
    expect(governor.isHalted).toBe(false)
    expect(governor.validateAction(testAction).allowed).toBe(true)
  })

  test("filters incidents by severity", () => {
    const governor = new SwarmSafetyGovernor()

    governor.logIncident("INFO", "audit", "system initialized")
    governor.logIncident("WARNING", "perf", "high memory usage")
    governor.logIncident("VIOLATION", "policy", "unauthorized attempt", undefined, true)
    governor.logIncident("CRITICAL", "security", "privilege escalation", undefined, true)

    expect(governor.getIncidents().length).toBe(4)
    expect(governor.getIncidents("VIOLATION").length).toBe(1)
    expect(governor.getIncidents("CRITICAL").length).toBe(1)
    expect(governor.getIncidents("INFO").length).toBe(1)
  })
})
