import { describe, expect, test } from "bun:test"
import { SessionAffinity } from "@orchestra/core/session/affinity"

type Session = Parameters<typeof SessionAffinity.gateway>[0]

const session = (input: { id: string; parentID?: string; fork?: { sessionID: string } }) =>
  input as unknown as Session

// What Zen's free-tier gateway accepts in `x-opencode-session`: ses_ + 12 lowercase hex + 14 alnum.
const GATE_SHAPE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const STANDARD = "ses_" + "0123456789abcdef".repeat(4)

describe("session affinity gateway token", () => {
  test("passes an OpenCode-shaped session id through unchanged", () => {
    expect(SessionAffinity.gateway(session({ id: STANDARD }))).toBe(STANDARD)
    // Children and forks keep sharing the id they already shared.
    expect(SessionAffinity.gateway(session({ id: "ses_" + "a1b2".repeat(16), parentID: STANDARD }))).toBe(STANDARD)
  })

  test("presents a group chat's derived id in the shape the free-tier gate accepts", () => {
    const token = SessionAffinity.gateway(session({ id: "ses_group_1mg1qwf" }))
    expect(token).toMatch(GATE_SHAPE)
    expect(token).not.toBe("ses_group_1mg1qwf")
    // Stable for the whole conversation, so the provider keeps routing it to one cache,
    // and distinct per group so two chats never share routing.
    expect(SessionAffinity.gateway(session({ id: "ses_group_1mg1qwf" }))).toBe(token)
    expect(SessionAffinity.gateway(session({ id: "ses_group_zzzzzz999999" }))).not.toBe(token)
  })

  test("a child of a group chat sends the same token as its group chat", () => {
    const chat = SessionAffinity.gateway(session({ id: "ses_group_1mg1qwf" }))
    const child = session({ id: "ses_" + "f00d".repeat(16), parentID: "ses_group_1mg1qwf" })
    expect(SessionAffinity.gateway(child)).toBe(chat)
  })

  test("the raw affinity id stays available for anything that needs the real session", () => {
    expect(String(SessionAffinity.get(session({ id: "ses_group_1mg1qwf" })))).toBe("ses_group_1mg1qwf")
  })
})
