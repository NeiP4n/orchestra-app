import { describe, expect, test } from "bun:test"
import { Federation } from "@orchestra/schema/federation"
import { Orchestra } from "@orchestra/schema/orchestra"

const a = Orchestra.ProjectID.make("prj_a")
const b = Orchestra.ProjectID.make("prj_b")

describe("trusted links between projects of one Society", () => {
  test("accept every kind of ticket from the peer without a person", () => {
    const policy = Federation.trustedLinkPolicy(Federation.defaultPolicy(a), b)
    for (const kind of ["question", "request", "contract"] as const) {
      expect(Federation.autoAnswers(policy, b, kind)).toBe(true)
      expect(Federation.admit(policy, { from: b, to: a, kind, chain: [b] }, 0)).toBeUndefined()
    }
  })

  test("an ordinary link still sends requests and contracts to a person", () => {
    const policy = Federation.linkPolicy(Federation.defaultPolicy(a), b)
    expect(Federation.autoAnswers(policy, b, "question")).toBe(false)
    expect(Federation.admit(policy, { from: b, to: a, kind: "request", chain: [b] }, 0)).toBe("kind-not-allowed")
  })

  test("trust is only for the linked peer", () => {
    const policy = Federation.trustedLinkPolicy(Federation.defaultPolicy(a), b)
    const stranger = Orchestra.ProjectID.make("prj_c")
    expect(Federation.autoAnswers(policy, stranger, "question")).toBe(false)
    expect(Federation.admit(policy, { from: stranger, to: a, kind: "question", chain: [stranger] }, 0)).toBe("no-grant")
  })
})
