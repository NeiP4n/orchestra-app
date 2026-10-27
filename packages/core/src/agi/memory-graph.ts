export type EpisodicNodeType =
  | "goal"
  | "action"
  | "failure_mode"
  | "success_pattern"
  | "invariant"

export type EpisodicEdgeType =
  | "causes"
  | "mitigates"
  | "falsifies"
  | "depends_on"
  | "refines"

export type EpisodicOutcomeStatus = "success" | "failure" | "inconclusive"

export interface EpisodicOutcome {
  readonly status: EpisodicOutcomeStatus
  readonly metrics?: Readonly<Record<string, number>>
  readonly summary?: string
  readonly timestamp?: number
}

export interface EpisodicNode {
  readonly id: string
  readonly type: EpisodicNodeType
  readonly context: string
  readonly tags: ReadonlyArray<string>
  readonly embedding?: ReadonlyArray<number>
  readonly outcome?: EpisodicOutcome
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly createdAt?: number
}

export interface EpisodicEdge {
  readonly from: string
  readonly to: string
  readonly type: EpisodicEdgeType
  readonly weight: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SessionStepTrace {
  readonly id?: string
  readonly action: string
  readonly input?: unknown
  readonly output?: unknown
  readonly error?: string
  readonly success: boolean
  readonly tags?: ReadonlyArray<string>
  readonly durationMs?: number
}

export interface SessionHistoryTrace {
  readonly sessionId: string
  readonly goal: string
  readonly steps: ReadonlyArray<SessionStepTrace>
  readonly success: boolean
  readonly lessonsLearned?: ReadonlyArray<string>
  readonly tags?: ReadonlyArray<string>
}

export interface DistilledPatternResult {
  readonly patternNode: EpisodicNode
  readonly derivedEdges: ReadonlyArray<EpisodicEdge>
  readonly associatedNodes: ReadonlyArray<EpisodicNode>
  readonly confidence: number
}

export interface ScoredEpisodicNode {
  readonly node: EpisodicNode
  readonly score: number
  readonly matchReasons: ReadonlyArray<string>
  readonly connectedEdges: ReadonlyArray<EpisodicEdge>
}

export interface EpisodicGraphSerialized {
  readonly version: number
  readonly nodes: ReadonlyArray<EpisodicNode>
  readonly edges: ReadonlyArray<EpisodicEdge>
  readonly exportedAt: number
}

/**
 * Calculates cosine similarity between two vector embeddings.
 */
function cosineSimilarity(vecA: ReadonlyArray<number>, vecB: ReadonlyArray<number>): number {
  if (vecA.length === 0 || vecA.length !== vecB.length) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < vecA.length; i++) {
    const valA = vecA[i]!
    const valB = vecB[i]!
    dotProduct += valA * valB
    normA += valA * valA
    normB += valB * valB
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0
  return dotProduct / denominator
}

/**
 * Episodic Knowledge Graph representation for multi-agent swarm collective memory.
 */
export interface McpMemoryEntity {
  readonly name: string
  readonly entityType: string
  readonly observations: ReadonlyArray<string>
}

export interface McpMemoryRelation {
  readonly from: string
  readonly to: string
  readonly relationType: string
}

export interface McpMemoryGraph {
  readonly entities: ReadonlyArray<McpMemoryEntity>
  readonly relations: ReadonlyArray<McpMemoryRelation>
}

export class EpisodicKnowledgeGraph {
  private readonly nodes: Map<string, EpisodicNode> = new Map()
  private readonly edges: EpisodicEdge[] = []
  private readonly tagIndex: Map<string, Set<string>> = new Map()
  private readonly outEdges: Map<string, EpisodicEdge[]> = new Map()
  private readonly inEdges: Map<string, EpisodicEdge[]> = new Map()

  /**
   * Adds a node to the knowledge graph and indexes its tags.
   */
  addNode(node: EpisodicNode): this {
    if (this.nodes.has(node.id)) {
      this.removeNode(node.id)
    }

    const normalizedNode: EpisodicNode = {
      ...node,
      createdAt: node.createdAt ?? Date.now(),
      tags: node.tags.map((t) => t.toLowerCase().trim()),
    }

    this.nodes.set(normalizedNode.id, normalizedNode)

    for (const tag of normalizedNode.tags) {
      if (!this.tagIndex.has(tag)) {
        this.tagIndex.set(tag, new Set())
      }
      this.tagIndex.get(tag)!.add(normalizedNode.id)
    }

    return this
  }

  /**
   * Retrieves a node by ID.
   */
  getNode(id: string): EpisodicNode | undefined {
    return this.nodes.get(id)
  }

  /**
   * Checks whether a node exists.
   */
  hasNode(id: string): boolean {
    return this.nodes.has(id)
  }

  /**
   * Removes a node along with all its incident edges and tag indexes.
   */
  removeNode(id: string): boolean {
    const node = this.nodes.get(id)
    if (!node) return false

    // Remove from tag index
    for (const tag of node.tags) {
      const set = this.tagIndex.get(tag)
      if (set) {
        set.delete(id)
        if (set.size === 0) this.tagIndex.delete(tag)
      }
    }

    // Remove incident edges
    for (let i = this.edges.length - 1; i >= 0; i--) {
      const edge = this.edges[i]!
      if (edge.from === id || edge.to === id) {
        this.edges.splice(i, 1)
      }
    }

    this.outEdges.delete(id)
    this.inEdges.delete(id)

    // Rebuild edge lookups for consistency
    this.rebuildEdgeLookups()

    return this.nodes.delete(id)
  }

  /**
   * Returns all nodes currently stored in the graph.
   */
  getAllNodes(): ReadonlyArray<EpisodicNode> {
    return Array.from(this.nodes.values())
  }

  /**
   * Adds a directed relationship edge between two existing nodes.
   */
  addEdge(edge: EpisodicEdge): this {
    if (!this.nodes.has(edge.from)) {
      throw new Error(`Source node not found in graph: ${edge.from}`)
    }
    if (!this.nodes.has(edge.to)) {
      throw new Error(`Target node not found in graph: ${edge.to}`)
    }

    const clampedWeight = Math.max(0, Math.min(1, edge.weight))
    const normalizedEdge: EpisodicEdge = {
      ...edge,
      weight: clampedWeight,
    }

    // Replace if exact edge already exists
    const existingIndex = this.edges.findIndex(
      (e) => e.from === edge.from && e.to === edge.to && e.type === edge.type,
    )
    if (existingIndex >= 0) {
      this.edges[existingIndex] = normalizedEdge
    } else {
      this.edges.push(normalizedEdge)
    }

    if (!this.outEdges.has(edge.from)) this.outEdges.set(edge.from, [])
    this.outEdges.get(edge.from)!.push(normalizedEdge)

    if (!this.inEdges.has(edge.to)) this.inEdges.set(edge.to, [])
    this.inEdges.get(edge.to)!.push(normalizedEdge)

    return this
  }

  /**
   * Filters edges by endpoints and edge type.
   */
  getEdges(filter?: {
    from?: string
    to?: string
    type?: EpisodicEdgeType
  }): ReadonlyArray<EpisodicEdge> {
    return this.edges.filter((e) => {
      if (filter?.from && e.from !== filter.from) return false
      if (filter?.to && e.to !== filter.to) return false
      if (filter?.type && e.type !== filter.type) return false
      return true
    })
  }

  /**
   * Finds connected adjacent nodes.
   */
  getConnectedNodes(
    nodeId: string,
    direction: "out" | "in" | "both" = "both",
    edgeType?: EpisodicEdgeType,
  ): ReadonlyArray<EpisodicNode> {
    const connectedIds = new Set<string>()

    if (direction === "out" || direction === "both") {
      const outList = this.outEdges.get(nodeId) || []
      for (const e of outList) {
        if (!edgeType || e.type === edgeType) connectedIds.add(e.to)
      }
    }

    if (direction === "in" || direction === "both") {
      const inList = this.inEdges.get(nodeId) || []
      for (const e of inList) {
        if (!edgeType || e.type === edgeType) connectedIds.add(e.from)
      }
    }

    return Array.from(connectedIds)
      .map((id) => this.nodes.get(id))
      .filter((n): n is EpisodicNode => n !== undefined)
  }

  /**
   * Distills persistent heuristics and success patterns from session execution history traces.
   */
  distillPattern(sessionHistory: SessionHistoryTrace): DistilledPatternResult {
    const goalNodeId = `goal-${sessionHistory.sessionId}`
    const goalNode: EpisodicNode = {
      id: goalNodeId,
      type: "goal",
      context: sessionHistory.goal,
      tags: sessionHistory.tags ?? ["distilled", "goal"],
      outcome: {
        status: sessionHistory.success ? "success" : "failure",
        timestamp: Date.now(),
      },
    }
    this.addNode(goalNode)

    const associatedNodes: EpisodicNode[] = [goalNode]
    const derivedEdges: EpisodicEdge[] = []

    const successfulSteps = sessionHistory.steps.filter((s) => s.success)
    const failedSteps = sessionHistory.steps.filter((s) => !s.success)

    // Register failure modes if any occurred during execution
    for (const failedStep of failedSteps) {
      const failureNodeId = `fail-${sessionHistory.sessionId}-${failedStep.action}`
      const failureNode: EpisodicNode = {
        id: failureNodeId,
        type: "failure_mode",
        context: failedStep.error || `Action failed: ${failedStep.action}`,
        tags: [...(failedStep.tags ?? []), "failure", failedStep.action],
        outcome: {
          status: "failure",
          summary: failedStep.error,
          timestamp: Date.now(),
        },
      }
      this.addNode(failureNode)
      associatedNodes.push(failureNode)

      const edge: EpisodicEdge = {
        from: goalNodeId,
        to: failureNodeId,
        type: "causes",
        weight: 0.8,
      }
      this.addEdge(edge)
      derivedEdges.push(edge)
    }

    // Formulate a distilled success pattern if the overall session or majority of steps succeeded
    const isOverallSuccess = sessionHistory.success || successfulSteps.length > failedSteps.length
    const actionSequence = successfulSteps.map((s) => s.action).join(" -> ")

    const patternNodeId = `pat-${sessionHistory.sessionId}-${Date.now().toString(36)}`
    const patternSummary = isOverallSuccess
      ? `Effective pattern for "${sessionHistory.goal}": [${actionSequence}]`
      : `Partial recovery heuristic for "${sessionHistory.goal}"`

    const combinedTags = Array.from(
      new Set([
        ...(sessionHistory.tags ?? []),
        ...successfulSteps.flatMap((s) => s.tags ?? []),
        "pattern",
        sessionHistory.success ? "success" : "partial",
      ]),
    )

    const confidence = isOverallSuccess
      ? Math.min(1, 0.6 + (successfulSteps.length / Math.max(1, sessionHistory.steps.length)) * 0.4)
      : 0.4

    const patternNode: EpisodicNode = {
      id: patternNodeId,
      type: "success_pattern",
      context: patternSummary,
      tags: combinedTags,
      outcome: {
        status: isOverallSuccess ? "success" : "inconclusive",
        metrics: {
          confidence,
          stepCount: sessionHistory.steps.length,
          successCount: successfulSteps.length,
        },
        summary: sessionHistory.lessonsLearned?.join("; ") ?? patternSummary,
        timestamp: Date.now(),
      },
      metadata: {
        sessionId: sessionHistory.sessionId,
        actionSequence,
        lessonsLearned: sessionHistory.lessonsLearned ?? [],
      },
    }

    this.addNode(patternNode)
    associatedNodes.push(patternNode)

    // Connect pattern to goal with refines
    const goalPatternEdge: EpisodicEdge = {
      from: patternNodeId,
      to: goalNodeId,
      type: "refines",
      weight: confidence,
    }
    this.addEdge(goalPatternEdge)
    derivedEdges.push(goalPatternEdge)

    // If failure modes existed, mark the pattern as mitigating them
    for (const failedStep of failedSteps) {
      const failureNodeId = `fail-${sessionHistory.sessionId}-${failedStep.action}`
      const mitigateEdge: EpisodicEdge = {
        from: patternNodeId,
        to: failureNodeId,
        type: "mitigates",
        weight: Math.min(1, confidence + 0.1),
      }
      this.addEdge(mitigateEdge)
      derivedEdges.push(mitigateEdge)
    }

    return {
      patternNode,
      derivedEdges,
      associatedNodes,
      confidence,
    }
  }

  /**
   * Hybrid semantic, associative and graph query to retrieve relevant episodic knowledge nodes.
   */
  queryRelevantNodes(
    query: string,
    tags?: ReadonlyArray<string>,
    limit = 10,
    embedding?: ReadonlyArray<number>,
  ): ReadonlyArray<ScoredEpisodicNode> {
    const queryTokens = query
      .toLowerCase()
      .split(/[\s,._-]+/)
      .filter((t) => t.length > 2)

    const normalizedTags = (tags ?? []).map((t) => t.toLowerCase().trim())
    const candidateScores = new Map<
      string,
      {
        score: number
        matchReasons: string[]
        directMatch: boolean
      }
    >()

    // 1. Tag & Lexical Keyword matching
    for (const node of Array.from(this.nodes.values())) {
      let score = 0
      const matchReasons: string[] = []

      // Tag overlap (Jaccard-like score)
      if (normalizedTags.length > 0) {
        const matchingTags = node.tags.filter((t) => normalizedTags.includes(t))
        if (matchingTags.length > 0) {
          const tagScore = (matchingTags.length / Math.max(node.tags.length, normalizedTags.length)) * 2.0
          score += tagScore
          matchReasons.push(`Tag match: [${matchingTags.join(", ")}] (+${tagScore.toFixed(2)})`)
        }
      }

      // Keyword token overlap in context
      const nodeText = `${node.id} ${node.context} ${node.type}`.toLowerCase()
      let tokenHits = 0
      for (const token of queryTokens) {
        if (nodeText.includes(token)) {
          tokenHits++
        }
      }

      if (tokenHits > 0) {
        const lexicalScore = (tokenHits / Math.max(1, queryTokens.length)) * 1.5
        score += lexicalScore
        matchReasons.push(`Lexical hits: ${tokenHits}/${queryTokens.length} tokens (+${lexicalScore.toFixed(2)})`)
      }

      // Semantic Embedding Cosine Similarity
      if (embedding && node.embedding && node.embedding.length > 0) {
        const sim = cosineSimilarity(embedding, node.embedding)
        if (sim > 0.4) {
          const embScore = sim * 2.5
          score += embScore
          matchReasons.push(`Cosine similarity: ${(sim * 100).toFixed(1)}% (+${embScore.toFixed(2)})`)
        }
      }

      // Success patterns get higher baseline trust priority
      if (node.type === "success_pattern" && node.outcome?.status === "success") {
        score += 0.3
        matchReasons.push("Success pattern boost (+0.30)")
      }

      if (score > 0) {
        candidateScores.set(node.id, {
          score,
          matchReasons,
          directMatch: true,
        })
      }
    }

    // 2. Graph Spreading Activation along edges
    const directMatches = Array.from(candidateScores.keys())
    for (const directId of directMatches) {
      const parentScore = candidateScores.get(directId)!.score
      const outList = this.outEdges.get(directId) || []
      const inList = this.inEdges.get(directId) || []

      const neighbors = [
        ...outList.map((e) => ({ targetId: e.to, edge: e })),
        ...inList.map((e) => ({ targetId: e.from, edge: e })),
      ]

      for (const { targetId, edge } of neighbors) {
        const propagationFactor = 0.5 * edge.weight
        const propagatedScore = parentScore * propagationFactor

        if (propagatedScore > 0.2) {
          const existing = candidateScores.get(targetId)
          if (existing) {
            existing.score += propagatedScore
            existing.matchReasons.push(
              `Graph relation (${edge.type} via ${directId}): +${propagatedScore.toFixed(2)}`,
            )
          } else {
            candidateScores.set(targetId, {
              score: propagatedScore,
              matchReasons: [
                `Graph propagation (${edge.type} via ${directId}, weight ${edge.weight}): +${propagatedScore.toFixed(2)}`,
              ],
              directMatch: false,
            })
          }
        }
      }
    }

    // 3. Format and rank results
    const rankedResults: ScoredEpisodicNode[] = []
    for (const [nodeId, scoreData] of Array.from(candidateScores.entries())) {
      const node = this.nodes.get(nodeId)
      if (!node) continue

      const connectedEdges = this.getEdges({ from: nodeId }).concat(this.getEdges({ to: nodeId }))

      rankedResults.push({
        node,
        score: Math.round(scoreData.score * 1000) / 1000,
        matchReasons: scoreData.matchReasons,
        connectedEdges,
      })
    }

    return rankedResults.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /**
   * Serializes the knowledge graph into JSON representation.
   */
  toJSON(): EpisodicGraphSerialized {
    return {
      version: 1,
      nodes: Array.from(this.nodes.values()),
      edges: [...this.edges],
      exportedAt: Date.now(),
    }
  }

  /**
   * Restores an EpisodicKnowledgeGraph instance from serialized JSON.
   */
  static fromJSON(data: EpisodicGraphSerialized | string): EpisodicKnowledgeGraph {
    const parsed: EpisodicGraphSerialized =
      typeof data === "string" ? (JSON.parse(data) as EpisodicGraphSerialized) : data

    const graph = new EpisodicKnowledgeGraph()
    for (const node of parsed.nodes) {
      graph.addNode(node)
    }
    for (const edge of parsed.edges) {
      graph.addEdge(edge)
    }
    return graph
  }

  /**
   * Serializes the knowledge graph into binary payload (UTF-8 binary buffer with header).
   */
  toBinary(): Uint8Array {
    const jsonStr = JSON.stringify(this.toJSON())
    const encoder = new TextEncoder()
    const encodedPayload = encoder.encode(jsonStr)

    // Binary format:
    // Magic: "EKG1" (4 bytes)
    // Payload length: Uint32 (4 bytes)
    // UTF-8 JSON payload
    const totalLength = 8 + encodedPayload.length
    const buffer = new Uint8Array(totalLength)

    buffer[0] = 0x45 // 'E'
    buffer[1] = 0x4b // 'K'
    buffer[2] = 0x47 // 'G'
    buffer[3] = 0x31 // '1'

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    view.setUint32(4, encodedPayload.length, false) // Big-endian

    buffer.set(encodedPayload, 8)
    return buffer
  }

  /**
   * Deserializes binary payload into EpisodicKnowledgeGraph instance.
   */
  static fromBinary(bytes: Uint8Array): EpisodicKnowledgeGraph {
    if (bytes.length < 8) {
      throw new Error("Invalid binary format: buffer too small for EpisodicKnowledgeGraph header")
    }

    // Verify magic header
    if (
      bytes[0] !== 0x45 ||
      bytes[1] !== 0x4b ||
      bytes[2] !== 0x47 ||
      bytes[3] !== 0x31
    ) {
      throw new Error("Invalid binary magic header for EpisodicKnowledgeGraph")
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const payloadLength = view.getUint32(4, false)

    if (bytes.length < 8 + payloadLength) {
      throw new Error(`Incomplete binary payload: expected ${payloadLength} bytes, found ${bytes.length - 8}`)
    }

    const payloadBytes = bytes.subarray(8, 8 + payloadLength)
    const decoder = new TextDecoder()
    const jsonStr = decoder.decode(payloadBytes)

    return EpisodicKnowledgeGraph.fromJSON(jsonStr)
  }

  /**
   * Bridges EpisodicKnowledgeGraph to external MCP memory graph format.
   */
  exportToMcpMemory(): McpMemoryGraph {
    const entities: McpMemoryEntity[] = Array.from(this.nodes.values()).map((n) => ({
      name: n.id,
      entityType: n.type,
      observations: [
        n.context,
        ...(n.outcome?.summary ? [`outcome: ${n.outcome.summary}`] : []),
        ...(n.tags.length > 0 ? [`tags: ${n.tags.join(", ")}`] : []),
      ],
    }))

    const relations: McpMemoryRelation[] = this.edges.map((e) => ({
      from: e.from,
      to: e.to,
      relationType: e.type,
    }))

    return { entities, relations }
  }

  /**
   * Imports entities and relations from external MCP memory server.
   */
  importFromMcpMemory(mcpGraph: McpMemoryGraph): this {
    for (const ent of mcpGraph.entities) {
      const type: EpisodicNodeType =
        ent.entityType === "goal" ||
        ent.entityType === "action" ||
        ent.entityType === "failure_mode" ||
        ent.entityType === "success_pattern" ||
        ent.entityType === "invariant"
          ? ent.entityType
          : "action"

      this.addNode({
        id: ent.name,
        type,
        context: ent.observations[0] ?? ent.name,
        tags: ["mcp-memory", type],
        outcome: {
          status: "success",
          summary: ent.observations.slice(1).join("; "),
        },
      })
    }

    for (const rel of mcpGraph.relations) {
      const edgeType: EpisodicEdgeType =
        rel.relationType === "causes" ||
        rel.relationType === "mitigates" ||
        rel.relationType === "falsifies" ||
        rel.relationType === "depends_on" ||
        rel.relationType === "refines"
          ? rel.relationType
          : "depends_on"

      this.addEdge({
        from: rel.from,
        to: rel.to,
        type: edgeType,
        weight: 1.0,
      })
    }

    return this
  }

  private rebuildEdgeLookups(): void {
    this.outEdges.clear()
    this.inEdges.clear()
    for (const edge of this.edges) {
      if (!this.outEdges.has(edge.from)) this.outEdges.set(edge.from, [])
      this.outEdges.get(edge.from)!.push(edge)

      if (!this.inEdges.has(edge.to)) this.inEdges.set(edge.to, [])
      this.inEdges.get(edge.to)!.push(edge)
    }
  }
}
