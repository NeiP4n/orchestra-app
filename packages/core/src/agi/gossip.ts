export * as SwarmGossip from "./gossip.js"

export type NodeID = string

export interface VectorClock {
  [nodeId: string]: number
}

export type PeerStatus = "alive" | "suspect" | "dead"

export interface PeerInfo {
  readonly id: NodeID
  readonly address: string
  reputationScore: number
  lastHeartbeat: number
  status: PeerStatus
  vectorClock: VectorClock
}

export interface GossipMessage<T = unknown> {
  readonly id: string
  readonly origin: NodeID
  readonly topic: string
  readonly data: T
  readonly version: number
  readonly vectorClock: VectorClock
  readonly timestamp: number
  hops: number
}

export interface GossipDigest {
  readonly nodeID: NodeID
  readonly vectorClock: VectorClock
  readonly messageVersions: Record<string, number>
  readonly timestamp: number
}

export interface SwarmGossipNodeOptions {
  readonly fanout?: number
  readonly suspectTimeoutMs?: number
  readonly deadTimeoutMs?: number
  readonly initialReputation?: number
}

export function mergeVectorClocks(a: VectorClock, b: VectorClock): VectorClock {
  const merged: VectorClock = { ...a }
  for (const [nodeId, time] of Object.entries(b)) {
    merged[nodeId] = Math.max(merged[nodeId] ?? 0, time)
  }
  return merged
}

export function compareVectorClocks(
  a: VectorClock,
  b: VectorClock,
): "greater" | "less" | "equal" | "concurrent" {
  let aGreater = false
  let bGreater = false

  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of allKeys) {
    const timeA = a[key] ?? 0
    const timeB = b[key] ?? 0
    if (timeA > timeB) aGreater = true
    if (timeB > timeA) bGreater = true
  }

  if (aGreater && !bGreater) return "greater"
  if (bGreater && !aGreater) return "less"
  if (!aGreater && !bGreater) return "equal"
  return "concurrent"
}

export class SwarmGossipNode {
  readonly id: NodeID
  readonly address: string
  reputationScore: number
  vectorClock: VectorClock = {}
  readonly peers: Map<NodeID, PeerInfo> = new Map()
  readonly messages: Map<string, GossipMessage> = new Map()

  readonly fanout: number
  readonly suspectTimeoutMs: number
  readonly deadTimeoutMs: number

  constructor(id: NodeID, address: string, options: SwarmGossipNodeOptions = {}) {
    this.id = id
    this.address = address
    this.fanout = options.fanout ?? 3
    this.suspectTimeoutMs = options.suspectTimeoutMs ?? 5_000
    this.deadTimeoutMs = options.deadTimeoutMs ?? 10_000
    this.reputationScore = options.initialReputation ?? 1.0
    this.vectorClock[this.id] = 0
  }

  registerPeer(peer: { id: NodeID; address: string; reputationScore?: number }): PeerInfo {
    if (peer.id === this.id) {
      throw new Error("Cannot register self as a peer")
    }
    const info: PeerInfo = {
      id: peer.id,
      address: peer.address,
      reputationScore: Math.min(1.0, Math.max(0.0, peer.reputationScore ?? 1.0)),
      lastHeartbeat: Date.now(),
      status: "alive",
      vectorClock: {},
    }
    this.peers.set(peer.id, info)
    return info
  }

  updatePeerHeartbeat(peerId: NodeID, timestamp = Date.now()): boolean {
    const peer = this.peers.get(peerId)
    if (!peer) return false
    peer.lastHeartbeat = timestamp
    peer.status = "alive"
    peer.reputationScore = Math.min(1.0, peer.reputationScore + 0.05)
    return true
  }

  checkNodeHealth(now = Date.now()): { suspect: NodeID[]; dead: NodeID[] } {
    const suspect: NodeID[] = []
    const dead: NodeID[] = []

    for (const peer of this.peers.values()) {
      const elapsed = now - peer.lastHeartbeat
      if (elapsed >= this.deadTimeoutMs) {
        if (peer.status !== "dead") {
          peer.status = "dead"
          peer.reputationScore = Math.max(0.0, peer.reputationScore - 0.5)
        }
        dead.push(peer.id)
      } else if (elapsed >= this.suspectTimeoutMs) {
        if (peer.status !== "suspect") {
          peer.status = "suspect"
          peer.reputationScore = Math.max(0.0, peer.reputationScore - 0.1)
        }
        suspect.push(peer.id)
      } else {
        peer.status = "alive"
      }
    }

    return { suspect, dead }
  }

  selectPeersForGossip(count = this.fanout): PeerInfo[] {
    const candidates = Array.from(this.peers.values()).filter((p) => p.status !== "dead")
    if (candidates.length <= count) {
      return candidates
    }

    // Weighted random selection based on reputationScore
    const scored = candidates.map((p) => ({
      peer: p,
      weight: Math.max(0.1, p.reputationScore) * (p.status === "alive" ? 1.0 : 0.5),
    }))

    const selected: PeerInfo[] = []
    const available = [...scored]

    while (selected.length < count && available.length > 0) {
      const totalWeight = available.reduce((acc, item) => acc + item.weight, 0)
      let randomVal = Math.random() * totalWeight
      let pickedIndex = 0

      for (let i = 0; i < available.length; i++) {
        randomVal -= available[i].weight
        if (randomVal <= 0) {
          pickedIndex = i
          break
        }
      }

      selected.push(available[pickedIndex].peer)
      available.splice(pickedIndex, 1)
    }

    return selected
  }

  disseminateMessage<T>(topic: string, data: T, customId?: string): GossipMessage<T> {
    this.vectorClock[this.id] = (this.vectorClock[this.id] ?? 0) + 1
    const id = customId ?? `${this.id}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`

    const existing = this.messages.get(id)
    const version = existing ? existing.version + 1 : 1

    const message: GossipMessage<T> = {
      id,
      origin: this.id,
      topic,
      data,
      version,
      vectorClock: { ...this.vectorClock },
      timestamp: Date.now(),
      hops: 0,
    }

    this.messages.set(id, message as unknown as GossipMessage)
    return message
  }

  receiveMessage(
    message: GossipMessage,
    fromPeerId?: NodeID,
  ): { accepted: boolean; reason?: string } {
    if (fromPeerId) {
      this.updatePeerHeartbeat(fromPeerId)
    }

    const existing = this.messages.get(message.id)
    if (!existing) {
      // First time seeing this message
      const acceptedMsg: GossipMessage = { ...message, hops: message.hops + 1 }
      this.messages.set(message.id, acceptedMsg)
      this.vectorClock = mergeVectorClocks(this.vectorClock, message.vectorClock)
      return { accepted: true }
    }

    // Version & vector clock conflict resolution
    const comparison = compareVectorClocks(message.vectorClock, existing.vectorClock)

    if (comparison === "greater" || message.version > existing.version) {
      // Incoming message is strictly newer
      const acceptedMsg: GossipMessage = { ...message, hops: message.hops + 1 }
      this.messages.set(message.id, acceptedMsg)
      this.vectorClock = mergeVectorClocks(this.vectorClock, message.vectorClock)
      return { accepted: true }
    }

    if (comparison === "concurrent") {
      // Conflict tie-breaking: prefer higher version, then higher timestamp, then lexicographical origin
      const isNewer =
        message.version > existing.version ||
        (message.version === existing.version && message.timestamp > existing.timestamp) ||
        (message.version === existing.version &&
          message.timestamp === existing.timestamp &&
          message.origin > existing.origin)

      if (isNewer) {
        const acceptedMsg: GossipMessage = { ...message, hops: message.hops + 1 }
        this.messages.set(message.id, acceptedMsg)
        this.vectorClock = mergeVectorClocks(this.vectorClock, message.vectorClock)
        return { accepted: true, reason: "conflict_resolved_favor_incoming" }
      }
      return { accepted: false, reason: "conflict_resolved_favor_existing" }
    }

    return { accepted: false, reason: "message_stale_or_equal" }
  }

  digest(): GossipDigest {
    const messageVersions: Record<string, number> = {}
    for (const [id, msg] of this.messages.entries()) {
      messageVersions[id] = msg.version
    }

    return {
      nodeID: this.id,
      vectorClock: { ...this.vectorClock },
      messageVersions,
      timestamp: Date.now(),
    }
  }

  reconcileAntiEntropy(
    remoteDigest: GossipDigest,
    getMessage: (id: string) => GossipMessage | undefined = (id) => this.messages.get(id),
  ): { neededMessageIds: string[]; offeredMessages: GossipMessage[] } {
    const neededMessageIds: string[] = []
    const offeredMessages: GossipMessage[] = []

    // 1. Check messages they have that we need
    for (const [msgId, remoteVersion] of Object.entries(remoteDigest.messageVersions)) {
      const localMsg = this.messages.get(msgId)
      if (!localMsg || localMsg.version < remoteVersion) {
        neededMessageIds.push(msgId)
      }
    }

    // 2. Check messages we have that they lack or have older versions of
    for (const [msgId, localMsg] of this.messages.entries()) {
      const remoteVersion = remoteDigest.messageVersions[msgId]
      if (remoteVersion === undefined || remoteVersion < localMsg.version) {
        const fullMsg = getMessage(msgId)
        if (fullMsg) {
          offeredMessages.push(fullMsg)
        }
      }
    }

    return { neededMessageIds, offeredMessages }
  }

  mergeState(remoteMessages: ReadonlyArray<GossipMessage>, fromPeerId?: NodeID): number {
    let acceptedCount = 0
    for (const msg of remoteMessages) {
      const res = this.receiveMessage(msg, fromPeerId)
      if (res.accepted) {
        acceptedCount++
      }
    }
    return acceptedCount
  }

  gossipRound(allNodesMap: Map<NodeID, SwarmGossipNode>): number {
    const peers = this.selectPeersForGossip()
    let sentCount = 0

    for (const peer of peers) {
      const targetNode = allNodesMap.get(peer.id)
      if (!targetNode || peer.status === "dead") continue

      // Anti-entropy step: exchange digests
      const myDigest = this.digest()
      const { neededMessageIds, offeredMessages } = targetNode.reconcileAntiEntropy(myDigest)

      // Send offered messages to target
      if (offeredMessages.length > 0) {
        targetNode.mergeState(offeredMessages, this.id)
        sentCount += offeredMessages.length
      }

      // Supply messages requested by target
      if (neededMessageIds.length > 0) {
        const neededMsgs = neededMessageIds
          .map((id) => this.messages.get(id))
          .filter((m): m is GossipMessage => m !== undefined)
        targetNode.mergeState(neededMsgs, this.id)
        sentCount += neededMsgs.length
      }
    }

    return sentCount
  }
}
