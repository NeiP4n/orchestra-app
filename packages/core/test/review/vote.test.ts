import { describe, expect, test } from "bun:test"
import { ReviewVote } from "@orchestra/core/review/vote"

const ballot = () => {
  const opened = ReviewVote.openBallot({ question: "Use SQLite or Postgres for the journal?" })
  if (!opened.ok) throw new Error(opened.message)
  return opened.value
}

describe("ReviewVote", () => {
  test("a vote with a test weighs more than an opinion-only vote", () => {
    let current = ballot()
    const opinion = ReviewVote.castVote(current, { voter: "alice", position: "for", evidence: [{ kind: "opinion", ref: "I like it" }] })
    if (!opinion.ok) throw new Error(opinion.message)
    current = opinion.value
    const tested = ReviewVote.castVote(current, {
      voter: "bob",
      position: "against",
      evidence: [{ kind: "test", ref: "journal-bench.test.ts: write throughput 3x" }],
    })
    if (!tested.ok) throw new Error(tested.message)
    current = tested.value
    expect(current.votes.find((vote) => vote.voter === "alice")?.weight).toBe(1)
    expect(current.votes.find((vote) => vote.voter === "bob")?.weight).toBe(3)
    expect(ReviewVote.tally(current).winner).toBe("against")
  })

  test("only the best evidence counts: five documents never outvote one test", () => {
    let current = ballot()
    const docs = ReviewVote.castVote(current, {
      voter: "alice",
      position: "for",
      evidence: [
        { kind: "document", ref: "doc 1" },
        { kind: "document", ref: "doc 2" },
        { kind: "document", ref: "doc 3" },
        { kind: "document", ref: "doc 4" },
        { kind: "document", ref: "doc 5" },
      ],
    })
    if (!docs.ok) throw new Error(docs.message)
    expect(docs.value.votes[0].weight).toBe(2)
  })

  test("a re-vote replaces the earlier vote", () => {
    let current = ballot()
    const first = ReviewVote.castVote(current, { voter: "alice", position: "for" })
    if (!first.ok) throw new Error(first.message)
    const second = ReviewVote.castVote(first.value, { voter: "alice", position: "against" })
    if (!second.ok) throw new Error(second.message)
    expect(second.value.votes).toHaveLength(1)
    expect(second.value.votes[0].position).toBe("against")
  })

  test("evidence with an empty reference is refused", () => {
    const cast = ReviewVote.castVote(ballot(), {
      voter: "alice",
      position: "for",
      evidence: [{ kind: "test", ref: "   " }],
    })
    expect(cast.ok).toBe(false)
  })

  test("a tie is recorded as a tie, never silently broken", () => {
    let current = ballot()
    for (const [voter, position] of [["alice", "for"], ["bob", "against"]] as const) {
      const cast = ReviewVote.castVote(current, { voter, position })
      if (!cast.ok) throw new Error(cast.message)
      current = cast.value
    }
    const decided = ReviewVote.decide(current)
    if (!decided.ok) throw new Error(decided.message)
    expect(decided.value.tally.winner).toBe("tie")
    expect(decided.value.outcome).toContain("Tied")
  })

  test("selectJury excludes interested parties and replays the same seed", () => {
    const candidates = ["alice", "bob", "carol", "dave", "erin"]
    const first = ReviewVote.selectJury({ candidates, interested: ["alice"], seed: 42 })
    const second = ReviewVote.selectJury({ candidates, interested: ["alice"], seed: 42 })
    if (!first.ok || !second.ok) throw new Error("jury selection failed")
    expect(first.value).toEqual(second.value)
    expect(first.value).toHaveLength(3)
    expect(first.value).not.toContain("alice")
    const other = ReviewVote.selectJury({ candidates, interested: ["alice"], seed: 7 })
    if (!other.ok) throw new Error("jury selection failed")
    expect(other.value).not.toEqual(first.value)
  })

  test("selectJury refuses when fewer than three are eligible", () => {
    const jury = ReviewVote.selectJury({ candidates: ["alice", "bob"], interested: [], seed: 1 })
    expect(jury.ok).toBe(false)
  })

  test("a jury decision needs all three jurors' votes", () => {
    const jury = ReviewVote.selectJury({ candidates: ["alice", "bob", "carol", "dave"], interested: [], seed: 3 })
    if (!jury.ok) throw new Error(jury.message)
    let current = ballot()
    const cast = ReviewVote.castVote(current, { voter: jury.value[0], position: "for" })
    if (!cast.ok) throw new Error(cast.message)
    current = cast.value
    expect(ReviewVote.decide(current, { jury: jury.value }).ok).toBe(false)
    for (const member of jury.value.slice(1)) {
      const vote = ReviewVote.castVote(current, { voter: member, position: "for" })
      if (!vote.ok) throw new Error(vote.message)
      current = vote.value
    }
    const decided = ReviewVote.decide(current, { jury: jury.value })
    if (!decided.ok) throw new Error(decided.message)
    expect(decided.value.outcome).toContain("Jury decided for")
    expect(decided.value.jury).toEqual(jury.value)
  })
})
