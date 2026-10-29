import { describe, expect, test } from "bun:test"
import { Federation } from "@orchestra/schema/federation"
import { Orchestra } from "@orchestra/schema/orchestra"

const a = Orchestra.ProjectID.make("prj_a")
const b = Orchestra.ProjectID.make("prj_b")

describe("trusted links between projects of one Society", () => {
  test("admit every kind of ticket, which the receiving Orchestrator then decides about", () => {
    const policy = Federation.trustedLinkPolicy(Federation.defaultPolicy(a), b)
    expect(Federation.isTrusted(policy, b)).toBe(true)
    for (const kind of ["question", "request", "contract"] as const)
      expect(Federation.admit(policy, { from: b, to: a, kind, chain: [b] }, 0)).toBeUndefined()
    // Questions need no decision at all; requests and contracts wait for the Orchestrator, not a person.
    expect(Federation.autoAnswers(policy, b, "question")).toBe(true)
    expect(Federation.autoAnswers(policy, b, "request")).toBe(false)
    expect(Federation.autoAnswers(policy, b, "contract")).toBe(false)
  })

  test("an ordinary link is not trusted and still sends requests and contracts to a person", () => {
    const policy = Federation.linkPolicy(Federation.defaultPolicy(a), b)
    expect(Federation.isTrusted(policy, b)).toBe(false)
    expect(Federation.autoAnswers(policy, b, "question")).toBe(false)
    expect(Federation.admit(policy, { from: b, to: a, kind: "request", chain: [b] }, 0)).toBe("kind-not-allowed")
  })

  test("trust is only for the linked peer", () => {
    const policy = Federation.trustedLinkPolicy(Federation.defaultPolicy(a), b)
    const stranger = Orchestra.ProjectID.make("prj_c")
    expect(Federation.isTrusted(policy, stranger)).toBe(false)
    expect(Federation.admit(policy, { from: stranger, to: a, kind: "question", chain: [stranger] }, 0)).toBe("no-grant")
  })
})
