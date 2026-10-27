import { describe, expect, test } from "bun:test"
import {
  compareVectorClocks,
  mergeVectorClocks,
  SwarmGossipNode,
} from "../src/agi/gossip.js"

describe("Swarm P2P Gossip Protocol", () => {
  test("compares and merges vector clocks correctly", () => {
    const vcA = { node1: 2, node2: 1 }
    const vcB = { node1: 1, node2: 1 }
    expect(compareVectorClocks(vcA, vcB)).toBe("greater")
    expect(compareVectorClocks(vcB, vcA)).toBe("less")

    const vcC = { node1: 1, node2: 2 }
    expect(compareVectorClocks(vcA, vcC)).toBe("concurrent")

    const vcEqual = { node1: 2, node2: 1 }
    expect(compareVectorClocks(vcA, vcEqual)).toBe("equal")

    const merged = mergeVectorClocks(vcA, vcC)
    expect(merged).toEqual({ node1: 2, node2: 2 })
  })

  test("tracks peer heartbeats and detects suspect and dead nodes", () => {
    const node = new SwarmGossipNode("node-master", "127.0.0.1:8000", {
      suspectTimeoutMs: 100,
      deadTimeoutMs: 200,
    })

    node.registerPeer({ id: "peer-1", address: "127.0.0.1:8001" })
    node.registerPeer({ id: "peer-2", address: "127.0.0.1:8002" })

    const start = Date.now()

    // Initially alive
    const initialHealth = node.checkNodeHealth(start)
    expect(initialHealth.suspect.length).toBe(0)
    expect(initialHealth.dead.length).toBe(0)

    // After 120ms: suspect
    const suspectHealth = node.checkNodeHealth(start + 120)
    expect(suspectHealth.suspect).toContain("peer-1")
    expect(node.peers.get("peer-1")?.status).toBe("suspect")

    // Update heartbeat for peer-1
    node.updatePeerHeartbeat("peer-1", start + 150)
    expect(node.peers.get("peer-1")?.status).toBe("alive")

    // After 250ms from start: peer-2 should be dead, peer-1 still alive/suspect
    const deadHealth = node.checkNodeHealth(start + 250)
    expect(deadHealth.dead).toContain("peer-2")
    expect(node.peers.get("peer-2")?.status).toBe("dead")
    expect(node.peers.get("peer-2")?.reputationScore).toBeLessThan(1.0)
  })

  test("achieves convergence across a 5-node swarm network", () => {
    const nodes: SwarmGossipNode[] = [
      new SwarmGossipNode("node-1", "10.0.0.1:9001", { fanout: 2 }),
      new SwarmGossipNode("node-2", "10.0.0.2:9002", { fanout: 2 }),
      new SwarmGossipNode("node-3", "10.0.0.3:9003", { fanout: 2 }),
      new SwarmGossipNode("node-4", "10.0.0.4:9004", { fanout: 2 }),
      new SwarmGossipNode("node-5", "10.0.0.5:9005", { fanout: 2 }),
    ]

    const allNodesMap = new Map<string, SwarmGossipNode>()
    for (const node of nodes) {
      allNodesMap.set(node.id, node)
    }

    // Connect peers in partial ring/mesh topology: each connects to 2 neighbors
    for (let i = 0; i < nodes.length; i++) {
      const next1 = nodes[(i + 1) % nodes.length]
      const next2 = nodes[(i + 2) % nodes.length]
      nodes[i].registerPeer({ id: next1.id, address: next1.address })
      nodes[i].registerPeer({ id: next2.id, address: next2.address })
    }

    // Node 1 originates a swarm task message
    const msg = nodes[0].disseminateMessage("swarm:task", {
      mission: "optimize_core",
      priority: "high",
    }, "mission-alpha")
    expect(msg.id).toBe("mission-alpha")

    expect(nodes[0].messages.has("mission-alpha")).toBe(true)
    expect(nodes[1].messages.has("mission-alpha")).toBe(false)

    // Run gossip rounds until all nodes converge
    const maxRounds = 10
    let converged = false

    for (let round = 0; round < maxRounds; round++) {
      for (const node of nodes) {
        node.gossipRound(allNodesMap)
      }
      converged = nodes.every((n) => n.messages.has("mission-alpha"))
      if (converged) break
    }

    expect(converged).toBe(true)

    // Check that all nodes have the exact payload and version
    for (const node of nodes) {
      const received = node.messages.get("mission-alpha")
      expect(received).toBeDefined()
      expect(received?.data).toEqual({ mission: "optimize_core", priority: "high" })
      expect(received?.version).toBe(1)
      expect(node.vectorClock["node-1"]).toBeGreaterThanOrEqual(1)
    }
  })

  test("resolves concurrent conflicts using vector clocks and deterministic tie-breaking", () => {
    const nodeA = new SwarmGossipNode("node-A", "10.0.0.1:9001")
    const nodeB = new SwarmGossipNode("node-B", "10.0.0.2:9002")
    expect(nodeB.id).toBe("node-B")

    // Concurrent versions of message with same id
    const baseTime = Date.now()
    const msgA = {
      id: "state-key-1",
      origin: "node-A",
      topic: "config",
      data: { value: "versionA" },
      version: 1,
      vectorClock: { "node-A": 1, "node-B": 0 },
      timestamp: baseTime + 10,
      hops: 0,
    }

    const msgB = {
      id: "state-key-1",
      origin: "node-B",
      topic: "config",
      data: { value: "versionB" },
      version: 1,
      vectorClock: { "node-A": 0, "node-B": 1 },
      timestamp: baseTime + 20, // newer timestamp wins tie-breaker
      hops: 0,
    }

    nodeA.receiveMessage(msgA)
    expect(nodeA.messages.get("state-key-1")?.data).toEqual({ value: "versionA" })

    // Node A receives concurrent msgB with newer timestamp
    const res = nodeA.receiveMessage(msgB)
    expect(res.accepted).toBe(true)
    expect(nodeA.messages.get("state-key-1")?.data).toEqual({ value: "versionB" })
  })

  test("performs anti-entropy reconciliation via state digests", () => {
    const node1 = new SwarmGossipNode("node-1", "10.0.0.1:9001")
    const node2 = new SwarmGossipNode("node-2", "10.0.0.2:9002")

    node1.disseminateMessage("topic-1", "data-1", "msg-1")
    node1.disseminateMessage("topic-2", "data-2", "msg-2")

    node2.disseminateMessage("topic-3", "data-3", "msg-3")

    const digest1 = node1.digest()
    const reconciliation = node2.reconcileAntiEntropy(digest1)

    // node2 needs msg-1 and msg-2 from node1
    expect(reconciliation.neededMessageIds).toContain("msg-1")
    expect(reconciliation.neededMessageIds).toContain("msg-2")
    // node2 offers msg-3 to node1
    expect(reconciliation.offeredMessages.map((m) => m.id)).toContain("msg-3")
  })
})
