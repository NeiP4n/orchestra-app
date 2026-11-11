import { expect, test } from "bun:test"
import { BrowserBridge } from "../src/browser/bridge.js"

const list = [
  { id: "brw_a", name: "Browser 1", project: "/p", chat: "ses_a" },
  { id: "brw_b", name: "Browser 2", project: "/p", chat: "ses_b" },
  { id: "brw_c", name: "Browser 3", project: "/p" },
]

test("the published session list keeps the BrowserAgent chat of each browser session", () => {
  expect(BrowserBridge.parseSessions(JSON.stringify(list))).toEqual(list)
  expect(BrowserBridge.parseSessions(JSON.stringify([{ id: "x", name: "n", project: "/p", chat: 5 }]))).toEqual([
    { id: "x", name: "n", project: "/p" },
  ])
})

test("a BrowserAgent chat owns exactly the session that names it", () => {
  expect(BrowserBridge.ownedBy(list, "ses_b")?.id).toBe("brw_b")
  expect(BrowserBridge.ownedBy(list, "ses_other")).toBeUndefined()
})

test("a BrowserAgent acts only in its own session; other agents are left to the lease rules", () => {
  const agent = BrowserBridge.BROWSER_AGENT
  expect(BrowserBridge.agentRefusal(list, "brw_a", "ses_a", agent)).toBeUndefined()
  expect(BrowserBridge.agentRefusal(list, "brw_b", "ses_a", agent)).toContain("another BrowserAgent")
  expect(BrowserBridge.agentRefusal(list, "brw_b", "ses_a", agent)).toContain("brw_a")
  expect(BrowserBridge.agentRefusal(list, "brw_c", "ses_a", agent)).toBeUndefined()
  expect(BrowserBridge.agentRefusal(list, "brw_b", "ses_a", "team-developer")).toBeUndefined()
})
