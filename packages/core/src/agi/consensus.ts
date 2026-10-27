export type ConsensusRole = "proposer" | "critic" | "security_auditor" | "verifier"

export interface CounterExample {
  readonly description: string
  readonly input?: unknown
  readonly expected?: unknown
  readonly actual?: unknown
  readonly reproducible: boolean
}

export type Verdict = "approve" | "reject" | "abstain"

export interface ConsensusVote {
  readonly voterId: string
  readonly role: ConsensusRole
  readonly verdict: Verdict
  readonly confidence?: number
  readonly reason?: string
  readonly counterExample?: CounterExample
}

export interface Proposal<T = unknown> {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly payload?: T
  readonly authorId?: string
}

export type ConsensusStatus = "accepted" | "rejected" | "vetoed" | "falsified"

export interface ConsensusOptions {
  /**
   * Quorum threshold ratio required to accept a proposal.
   * Default: 0.75 (75% of decisive weighted votes must be 'approve').
   */
  readonly quorumThreshold?: number

  /**
   * Custom weights assigned to specific roles during voting calculation.
   */
  readonly roleWeights?: Partial<Record<ConsensusRole, number>>

  /**
   * Default weight for unconfigured roles. Default: 1.0.
   */
  readonly defaultWeight?: number
}

export interface VoteBreakdown {
  readonly voterId: string
  readonly role: ConsensusRole
  readonly verdict: Verdict
  readonly weight: number
  readonly effectiveWeight: number
  readonly confidence: number
}

export interface ConsensusEvaluation {
  readonly proposalId: string
  readonly status: ConsensusStatus
  readonly ratio: number
  readonly quorumThreshold: number
  readonly approvedWeight: number
  readonly rejectedWeight: number
  readonly totalDecisiveWeight: number
  readonly totalWeight: number
  readonly vetoReason?: string
  readonly vetoVoterId?: string
  readonly falsificationReason?: string
  readonly counterExample?: CounterExample
  readonly breakdown: ReadonlyArray<VoteBreakdown>
}

export const DEFAULT_QUORUM_THRESHOLD = 0.75

export const DEFAULT_ROLE_WEIGHTS: Record<ConsensusRole, number> = {
  proposer: 1.0,
  critic: 1.5,
  security_auditor: 2.0,
  verifier: 1.5,
}

/**
 * Evaluates a proposal against multi-role consensus votes with:
 * 1. Falsification check (reproducible counter-examples immediately falsify proposal).
 * 2. Security auditor veto (negative security verdict vetoes proposal regardless of quorum).
 * 3. Weighted quorum calculation (ratio >= quorumThreshold for acceptance).
 */
export function evaluateProposal<T = unknown>(
  proposal: Proposal<T>,
  votes: ReadonlyArray<ConsensusVote>,
  options?: ConsensusOptions,
): ConsensusEvaluation {
  const quorumThreshold = options?.quorumThreshold ?? DEFAULT_QUORUM_THRESHOLD
  const roleWeights = { ...DEFAULT_ROLE_WEIGHTS, ...options?.roleWeights }
  const defaultWeight = options?.defaultWeight ?? 1.0

  let approvedWeight = 0
  let rejectedWeight = 0
  let totalWeight = 0

  const breakdown: VoteBreakdown[] = []

  for (const vote of votes) {
    const rawWeight = roleWeights[vote.role] ?? defaultWeight
    const confidence =
      typeof vote.confidence === "number" && !isNaN(vote.confidence)
        ? Math.max(0, Math.min(1, vote.confidence))
        : 1.0
    const effectiveWeight = rawWeight * confidence

    breakdown.push({
      voterId: vote.voterId,
      role: vote.role,
      verdict: vote.verdict,
      weight: rawWeight,
      effectiveWeight,
      confidence,
    })

    totalWeight += effectiveWeight

    if (vote.verdict === "approve") {
      approvedWeight += effectiveWeight
    } else if (vote.verdict === "reject") {
      rejectedWeight += effectiveWeight
    }
  }

  const totalDecisiveWeight = approvedWeight + rejectedWeight
  const ratio = totalDecisiveWeight > 0 ? approvedWeight / totalDecisiveWeight : 0

  // 1. Critical Falsification Check:
  // If a critic (or any rejecting vote) supplies a reproducible counter-example, proposal is falsified.
  const falsifyingVote = votes.find(
    (v) => (v.role === "critic" || v.verdict === "reject") && v.counterExample?.reproducible === true,
  )

  if (falsifyingVote && falsifyingVote.counterExample) {
    return {
      proposalId: proposal.id,
      status: "falsified",
      ratio,
      quorumThreshold,
      approvedWeight,
      rejectedWeight,
      totalDecisiveWeight,
      totalWeight,
      falsificationReason:
        falsifyingVote.counterExample.description ||
        falsifyingVote.reason ||
        "Falsified by reproducible counter-example",
      counterExample: falsifyingVote.counterExample,
      breakdown,
    }
  }

  // 2. Security Auditor Veto Check:
  // Any negative verdict from security_auditor vetoes the proposal unconditionally.
  const securityVetoVote = votes.find(
    (v) => v.role === "security_auditor" && v.verdict === "reject",
  )

  if (securityVetoVote) {
    return {
      proposalId: proposal.id,
      status: "vetoed",
      ratio,
      quorumThreshold,
      approvedWeight,
      rejectedWeight,
      totalDecisiveWeight,
      totalWeight,
      vetoReason: securityVetoVote.reason || "Security auditor issued a veto",
      vetoVoterId: securityVetoVote.voterId,
      breakdown,
    }
  }

  // 3. Weighted Quorum Check:
  const status: ConsensusStatus = ratio >= quorumThreshold ? "accepted" : "rejected"

  return {
    proposalId: proposal.id,
    status,
    ratio,
    quorumThreshold,
    approvedWeight,
    rejectedWeight,
    totalDecisiveWeight,
    totalWeight,
    breakdown,
  }
}

/**
 * MultiRoleConsensus coordinator class.
 */
export class MultiRoleConsensus {
  constructor(readonly options?: ConsensusOptions) {}

  evaluateProposal<T = unknown>(
    proposal: Proposal<T>,
    votes: ReadonlyArray<ConsensusVote>,
  ): ConsensusEvaluation {
    return evaluateProposal(proposal, votes, this.options)
  }
}
