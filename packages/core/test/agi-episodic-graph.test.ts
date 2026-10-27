import { describe, expect, test } from "bun:test"
import {
  EpisodicKnowledgeGraph,
  type EpisodicNode,
  type EpisodicEdge,
  type SessionHistoryTrace,
} from "../src/agi/memory-graph"

describe("EpisodicKnowledgeGraph Swarm Memory & Experience Distillation (AGI-005)", () => {
  test("1. Adds, retrieves, inspects and removes nodes across episodic types", () => {
    const graph = new EpisodicKnowledgeGraph()

    const goalNode: EpisodicNode = {
      id: "goal-1",
      type: "goal",
      context: "Implement resilient caching for offline CLI updates",
      tags: ["cli", "cache", "offline"],
      outcome: { status: "success" },
    }

    const actionNode: EpisodicNode = {
      id: "action-1",
      type: "action",
      context: "Store cached version payload to disk with TTL timestamp",
      tags: ["fs", "ttl", "cache"],
    }

    const invariantNode: EpisodicNode = {
      id: "inv-1",
      type: "invariant",
      context: "Never block the main loop on offline network checks",
      tags: ["safety", "performance", "offline"],
    }

    graph.addNode(goalNode).addNode(actionNode).addNode(invariantNode)

    expect(graph.hasNode("goal-1")).toBe(true)
    expect(graph.hasNode("action-1")).toBe(true)
    expect(graph.hasNode("inv-1")).toBe(true)
    expect(graph.hasNode("non-existent")).toBe(false)

    expect(graph.getNode("goal-1")?.type).toBe("goal")
    expect(graph.getNode("action-1")?.context).toContain("Store cached version")
    expect(graph.getAllNodes()).toHaveLength(3)

    // Remove node and ensure clean state
    const removed = graph.removeNode("action-1")
    expect(removed).toBe(true)
    expect(graph.hasNode("action-1")).toBe(false)
    expect(graph.getAllNodes()).toHaveLength(2)
  })

  test("2. Connects nodes with weighted semantic edges and enforces node existence", () => {
    const graph = new EpisodicKnowledgeGraph()

    graph.addNode({
      id: "goal-auth",
      type: "goal",
      context: "Authenticate swarm agent securely",
      tags: ["security", "auth"],
    })
    graph.addNode({
      id: "action-jwt",
      type: "action",
      context: "Verify HMAC-SHA256 bearer token signature",
      tags: ["jwt", "crypto"],
    })
    graph.addNode({
      id: "fail-expired",
      type: "failure_mode",
      context: "Token expiration timestamp exceeded",
      tags: ["jwt", "expiry", "error"],
    })

    const edge1: EpisodicEdge = {
      from: "goal-auth",
      to: "action-jwt",
      type: "depends_on",
      weight: 0.95,
    }

    const edge2: EpisodicEdge = {
      from: "action-jwt",
      to: "fail-expired",
      type: "causes",
      weight: 0.3,
    }

    graph.addEdge(edge1).addEdge(edge2)

    expect(graph.getEdges()).toHaveLength(2)
    expect(graph.getEdges({ from: "goal-auth" })).toHaveLength(1)
    expect(graph.getEdges({ type: "causes" })).toHaveLength(1)
    expect(graph.getEdges({ type: "causes" })[0]?.to).toBe("fail-expired")

    // Missing node throws error
    expect(() =>
      graph.addEdge({
        from: "ghost-node",
        to: "action-jwt",
        type: "refines",
        weight: 0.5,
      }),
    ).toThrow("Source node not found")
  })

  test("3. Traverses associative relationships across incoming and outgoing edges", () => {
    const graph = new EpisodicKnowledgeGraph()

    graph
      .addNode({ id: "n1", type: "goal", context: "Goal", tags: [] })
      .addNode({ id: "n2", type: "action", context: "Action", tags: [] })
      .addNode({ id: "n3", type: "success_pattern", context: "Pattern", tags: [] })

    graph
      .addEdge({ from: "n1", to: "n2", type: "depends_on", weight: 0.8 })
      .addEdge({ from: "n3", to: "n1", type: "refines", weight: 0.9 })

    // Outgoing from n1: n2
    const outFromN1 = graph.getConnectedNodes("n1", "out")
    expect(outFromN1.map((n) => n.id)).toEqual(["n2"])

    // Incoming to n1: n3
    const inToN1 = graph.getConnectedNodes("n1", "in")
    expect(inToN1.map((n) => n.id)).toEqual(["n3"])

    // Both directions for n1: n2 and n3
    const bothN1 = graph.getConnectedNodes("n1", "both")
    expect(bothN1.map((n) => n.id).sort()).toEqual(["n2", "n3"].sort())

    // Filtering by edge type
    const refinesOnly = graph.getConnectedNodes("n1", "both", "refines")
    expect(refinesOnly.map((n) => n.id)).toEqual(["n3"])
  })

  test("4. Distills heuristics and success patterns from session history with failure mitigations", () => {
    const graph = new EpisodicKnowledgeGraph()

    const sessionTrace: SessionHistoryTrace = {
      sessionId: "ses-101",
      goal: "Repair database lock contention under concurrency",
      success: true,
      tags: ["sqlite", "concurrency", "db"],
      lessonsLearned: [
        "Enable WAL mode before concurrent transactions",
        "Set busy_timeout to 5000ms",
      ],
      steps: [
        {
          action: "direct_write",
          success: false,
          error: "SQLITE_BUSY: database is locked",
          tags: ["sqlite", "lock"],
        },
        {
          action: "enable_wal_mode",
          success: true,
          tags: ["sqlite", "wal"],
        },
        {
          action: "configure_busy_timeout",
          success: true,
          tags: ["sqlite", "timeout"],
        },
        {
          action: "retry_write",
          success: true,
          tags: ["sqlite", "retry"],
        },
      ],
    }

    const distilled = graph.distillPattern(sessionTrace)

    // Pattern node created and indexed
    expect(distilled.patternNode.type).toBe("success_pattern")
    expect(distilled.patternNode.context).toContain("Repair database lock contention")
    expect(distilled.confidence).toBeGreaterThan(0.7)
    expect(graph.hasNode(distilled.patternNode.id)).toBe(true)

    // Goal node created
    expect(graph.hasNode("goal-ses-101")).toBe(true)

    // Failure mode node created for failed step
    const failNode = graph.getNode("fail-ses-101-direct_write")
    expect(failNode).toBeDefined()
    expect(failNode?.type).toBe("failure_mode")
    expect(failNode?.context).toContain("SQLITE_BUSY")

    // Edges verified: pattern -> goal (refines) and pattern -> failure (mitigates)
    const refinesEdge = graph.getEdges({
      from: distilled.patternNode.id,
      to: "goal-ses-101",
      type: "refines",
    })
    expect(refinesEdge).toHaveLength(1)

    const mitigatesEdge = graph.getEdges({
      from: distilled.patternNode.id,
      to: "fail-ses-101-direct_write",
      type: "mitigates",
    })
    expect(mitigatesEdge).toHaveLength(1)
    expect(mitigatesEdge[0]?.weight).toBeGreaterThan(0.7)
  })

  test("5. Performs hybrid search with tags, text lexical matching, vector cosine similarity and graph spreading", () => {
    const graph = new EpisodicKnowledgeGraph()

    // Add nodes with text, tags and embeddings
    graph.addNode({
      id: "node-p2p",
      type: "action",
      context: "Establish WebRTC peer-to-peer data channel between swarm nodes",
      tags: ["network", "p2p", "webrtc"],
      embedding: [0.9, 0.1, 0.05],
    })

    graph.addNode({
      id: "node-security",
      type: "invariant",
      context: "Mutual TLS encryption for swarm RPC communication",
      tags: ["security", "tls", "crypto"],
      embedding: [0.1, 0.95, 0.1],
    })

    graph.addNode({
      id: "node-gossip",
      type: "success_pattern",
      context: "Gossip protocol for state consensus and peer discovery",
      tags: ["network", "gossip", "consensus"],
      outcome: { status: "success" },
      embedding: [0.85, 0.15, 0.08],
    })

    // Connect node-p2p to node-gossip
    graph.addEdge({
      from: "node-gossip",
      to: "node-p2p",
      type: "depends_on",
      weight: 0.9,
    })

    // Query with embedding close to node-p2p and node-gossip
    const queryVector = [0.88, 0.12, 0.06]
    const results = graph.queryRelevantNodes("webrtc gossip swarm network", ["network"], 5, queryVector)

    expect(results.length).toBeGreaterThanOrEqual(2)

    // Top results should be p2p and gossip
    const topIds = results.slice(0, 2).map((r) => r.node.id)
    expect(topIds).toContain("node-p2p")
    expect(topIds).toContain("node-gossip")

    // The top result should have high score due to vector cosine + tag overlap + graph relation
    expect(results[0]?.score).toBeGreaterThan(1.5)
    expect(results[0]?.matchReasons.some((m) => m.includes("Cosine") || m.includes("Tag"))).toBe(true)
  })

  test("6. Serializes to JSON and restores identical graph structure", () => {
    const original = new EpisodicKnowledgeGraph()

    original.addNode({
      id: "a1",
      type: "goal",
      context: "Test serialization",
      tags: ["test", "json"],
      outcome: { status: "success", metrics: { speed: 100 } },
    })
    original.addNode({
      id: "a2",
      type: "action",
      context: "Execute benchmark",
      tags: ["perf"],
    })
    original.addEdge({
      from: "a1",
      to: "a2",
      type: "depends_on",
      weight: 0.85,
    })

    const serialized = original.toJSON()
    const restored = EpisodicKnowledgeGraph.fromJSON(serialized)

    expect(restored.getAllNodes()).toHaveLength(2)
    expect(restored.getEdges()).toHaveLength(1)
    expect(restored.getNode("a1")?.context).toBe("Test serialization")
    expect(restored.getNode("a1")?.outcome?.metrics?.speed).toBe(100)
    expect(restored.getEdges()[0]?.weight).toBe(0.85)
  })

  test("7. Serializes to binary format (EKG1 header) and deserializes with boundary validations", () => {
    const original = new EpisodicKnowledgeGraph()

    original.addNode({
      id: "bin-node-1",
      type: "invariant",
      context: "Binary serialization integrity",
      tags: ["binary", "fast-sync"],
    })
    original.addNode({
      id: "bin-node-2",
      type: "action",
      context: "Transmit Uint8Array payload over network channel",
      tags: ["network", "binary"],
    })
    original.addEdge({
      from: "bin-node-1",
      to: "bin-node-2",
      type: "causes",
      weight: 0.9,
    })

    const binaryBytes = original.toBinary()

    // Validate binary format header: "EKG1"
    expect(binaryBytes[0]).toBe(0x45) // 'E'
    expect(binaryBytes[1]).toBe(0x4b) // 'K'
    expect(binaryBytes[2]).toBe(0x47) // 'G'
    expect(binaryBytes[3]).toBe(0x31) // '1'

    const restored = EpisodicKnowledgeGraph.fromBinary(binaryBytes)

    expect(restored.getAllNodes()).toHaveLength(2)
    expect(restored.getNode("bin-node-1")?.tags).toContain("binary")
    expect(restored.getEdges()).toHaveLength(1)
    expect(restored.getEdges()[0]?.type).toBe("causes")

    // Boundary checks: corrupted header throws
    const corruptedBytes = new Uint8Array(binaryBytes)
    corruptedBytes[0] = 0x00
    expect(() => EpisodicKnowledgeGraph.fromBinary(corruptedBytes)).toThrow(
      "Invalid binary magic header",
    )

    // Buffer too small throws
    expect(() => EpisodicKnowledgeGraph.fromBinary(new Uint8Array([0x01, 0x02]))).toThrow(
      "buffer too small",
    )
  })
})
