import { describe, expect, test } from "bun:test"
import {
  MultiRoleConsensus,
  evaluateProposal,
  DEFAULT_QUORUM_THRESHOLD,
  DEFAULT_ROLE_WEIGHTS,
  type ConsensusVote,
  type Proposal,
} from "../src/agi/consensus"

describe("MultiRoleConsensus and critical decision falsification (AGI-003)", () => {
  const proposal: Proposal<{ plan: string }> = {
    id: "prop_opt_distributed_cache",
    title: "Implement distributed read-through cache for session history",
    payload: { plan: "Deploy Redis cluster with replication" },
  }

  test("1. Accepts proposal when weighted quorum meets or exceeds threshold (>= 0.75)", () => {
    expect(DEFAULT_ROLE_WEIGHTS.proposer).toBe(1.0)
    expect(DEFAULT_ROLE_WEIGHTS.critic).toBe(1.5)
    expect(DEFAULT_ROLE_WEIGHTS.security_auditor).toBe(2.0)
    expect(DEFAULT_ROLE_WEIGHTS.verifier).toBe(1.5)

    const votes: ConsensusVote[] = [
      { voterId: "agent_prop_1", role: "proposer", verdict: "approve" }, // weight 1.0
      { voterId: "agent_crit_1", role: "critic", verdict: "approve" }, // weight 1.5
      { voterId: "agent_sec_1", role: "security_auditor", verdict: "approve" }, // weight 2.0
      { voterId: "agent_ver_1", role: "verifier", verdict: "approve" }, // weight 1.5
    ]

    const result = evaluateProposal(proposal, votes)

    expect(result.proposalId).toBe("prop_opt_distributed_cache")
    expect(result.status).toBe("accepted")
    expect(result.ratio).toBe(1.0)
    expect(result.quorumThreshold).toBe(DEFAULT_QUORUM_THRESHOLD)
    expect(result.approvedWeight).toBe(6.0)
    expect(result.rejectedWeight).toBe(0)
    expect(result.breakdown).toHaveLength(4)
  })

  test("2. Rejects proposal when weighted quorum falls below 0.75", () => {
    const votes: ConsensusVote[] = [
      { voterId: "agent_prop_1", role: "proposer", verdict: "approve" }, // weight 1.0
      { voterId: "agent_crit_1", role: "critic", verdict: "reject", reason: "Memory consumption too high" }, // weight 1.5
      { voterId: "agent_sec_1", role: "security_auditor", verdict: "approve" }, // weight 2.0
      { voterId: "agent_ver_1", role: "verifier", verdict: "reject", reason: "Integration tests flaky" }, // weight 1.5
    ]

    // Approved: 1.0 + 2.0 = 3.0
    // Rejected: 1.5 + 1.5 = 3.0
    // Ratio = 3.0 / 6.0 = 0.5 < 0.75 -> rejected
    const result = evaluateProposal(proposal, votes)

    expect(result.status).toBe("rejected")
    expect(result.ratio).toBe(0.5)
    expect(result.approvedWeight).toBe(3.0)
    expect(result.rejectedWeight).toBe(3.0)
    expect(result.vetoReason).toBeUndefined()
    expect(result.falsificationReason).toBeUndefined()
  })

  test("3. Security auditor veto blocks proposal unconditionally regardless of quorum", () => {
    // 3 positive votes from other roles would give 4.0 / 4.0 = 100% approval without veto
    const votes: ConsensusVote[] = [
      { voterId: "agent_prop_1", role: "proposer", verdict: "approve" }, // 1.0
      { voterId: "agent_crit_1", role: "critic", verdict: "approve" }, // 1.5
      { voterId: "agent_ver_1", role: "verifier", verdict: "approve" }, // 1.5
      {
        voterId: "sec_auditor_alpha",
        role: "security_auditor",
        verdict: "reject",
        reason: "Unencrypted transport exposed to external ingress",
      }, // 2.0
    ]

    const result = evaluateProposal(proposal, votes)

    expect(result.status).toBe("vetoed")
    expect(result.vetoReason).toBe("Unencrypted transport exposed to external ingress")
    expect(result.vetoVoterId).toBe("sec_auditor_alpha")
    // Approved weight is 4.0, but status is strictly vetoed!
    expect(result.approvedWeight).toBe(4.0)
    expect(result.rejectedWeight).toBe(2.0)
  })

  test("4. Falsification counter-example from critic immediately marks proposal as falsified", () => {
    const votes: ConsensusVote[] = [
      { voterId: "agent_prop_1", role: "proposer", verdict: "approve" },
      { voterId: "agent_sec_1", role: "security_auditor", verdict: "approve" },
      { voterId: "agent_ver_1", role: "verifier", verdict: "approve" },
      {
        voterId: "agent_crit_falsifier",
        role: "critic",
        verdict: "reject",
        reason: "Boundary condition race creates corrupted state",
        counterExample: {
          description: "Deadlock reproduced under 100 concurrent workers",
          input: { concurrentThreads: 100, lockTimeoutMs: 50 },
          expected: "Consistent cache state",
          actual: "Deadlock with timeout after 50ms",
          reproducible: true,
        },
      },
    ]

    const result = evaluateProposal(proposal, votes)

    expect(result.status).toBe("falsified")
    expect(result.falsificationReason).toBe("Deadlock reproduced under 100 concurrent workers")
    expect(result.counterExample).toBeDefined()
    expect(result.counterExample?.reproducible).toBe(true)
    expect(result.counterExample?.input).toEqual({ concurrentThreads: 100, lockTimeoutMs: 50 })
  })

  test("5. Non-reproducible counter-example does not trigger automatic falsification", () => {
    const votes: ConsensusVote[] = [
      { voterId: "agent_prop_1", role: "proposer", verdict: "approve" }, // 1.0
      { voterId: "agent_sec_1", role: "security_auditor", verdict: "approve" }, // 2.0
      { voterId: "agent_ver_1", role: "verifier", verdict: "approve" }, // 1.5
      {
        voterId: "agent_crit_speculative",
        role: "critic",
        verdict: "reject",
        reason: "Theoretical glitch in network partitions",
        counterExample: {
          description: "Unconfirmed transient glitch",
          reproducible: false, // NOT reproducible!
        },
      }, // 1.5
    ]

    // Approved: 4.5
    // Rejected: 1.5
    // Ratio = 4.5 / 6.0 = 0.75 >= 0.75 threshold
    const result = evaluateProposal(proposal, votes)

    // Not falsified because counterExample.reproducible is false!
    expect(result.status).toBe("accepted")
    expect(result.ratio).toBe(0.75)
    expect(result.counterExample).toBeUndefined()
  })

  test("6. Correctly applies role weights, confidence factor, and handles abstain", () => {
    const consensus = new MultiRoleConsensus({
      quorumThreshold: 0.8,
      roleWeights: {
        proposer: 2.0,
        critic: 2.0,
        security_auditor: 3.0,
        verifier: 1.0,
      },
    })

    const votes: ConsensusVote[] = [
      // Proposer: weight 2.0, confidence 0.5 -> effectiveWeight 1.0
      { voterId: "p1", role: "proposer", verdict: "approve", confidence: 0.5 },
      // Verifier: weight 1.0, confidence 1.0 -> effectiveWeight 1.0
      { voterId: "v1", role: "verifier", verdict: "approve", confidence: 1.0 },
      // Security auditor abstains -> not in decisive quorum
      { voterId: "s1", role: "security_auditor", verdict: "abstain", confidence: 1.0 },
    ]

    const result = consensus.evaluateProposal(proposal, votes)

    expect(result.status).toBe("accepted")
    expect(result.quorumThreshold).toBe(0.8)
    expect(result.approvedWeight).toBe(2.0)
    expect(result.rejectedWeight).toBe(0)
    expect(result.ratio).toBe(1.0)

    const p1Breakdown = result.breakdown.find((b) => b.voterId === "p1")
    expect(p1Breakdown?.effectiveWeight).toBe(1.0)
    expect(p1Breakdown?.confidence).toBe(0.5)

    const s1Breakdown = result.breakdown.find((b) => b.voterId === "s1")
    expect(s1Breakdown?.verdict).toBe("abstain")
    expect(s1Breakdown?.effectiveWeight).toBe(3.0)
  })

  test("7. Priority order: falsification takes precedence over security veto", () => {
    const votes: ConsensusVote[] = [
      {
        voterId: "critic_1",
        role: "critic",
        verdict: "reject",
        counterExample: {
          description: "Proven mathematical falsification",
          reproducible: true,
        },
      },
      {
        voterId: "sec_1",
        role: "security_auditor",
        verdict: "reject",
        reason: "Security flaw",
      },
    ]

    const result = evaluateProposal(proposal, votes)
    // Falsification is the strongest epistemological counter-proof
    expect(result.status).toBe("falsified")
    expect(result.counterExample?.reproducible).toBe(true)
  })
})
